// Coleta todas as licitações com recebimento de propostas em aberto no PNCP
// (Portal Nacional de Contratações Públicas) e gera os arquivos de dados do site.
//
// Uso:  node scripts/coletar.mjs            -> baixa da API oficial
//       FIXTURE=amostra.json node scripts/coletar.mjs   -> usa um arquivo local (teste)
//
// Saída: site/data/index.json  (lista compacta, carregada na abertura)
//        site/data/uf/XX.json  (detalhes completos por estado, carregados ao clicar)
//        site/data/meta.json   (data da atualização e totais)

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

const API = "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta";
const TAMANHO = 50;          // máximo aceito pela API
const PARALELO = 4;          // requisições simultâneas (o PNCP oscila com mais que isso)
const OUT = path.resolve("site/data");
// Estados coletados (Sudeste). Para mudar, ajuste a variável UFS no workflow, ex.: "SP,RJ,MG,ES,PR".
const UFS = (process.env.UFS || "SP,RJ,MG,ES").split(",").map((u) => u.trim().toUpperCase()).filter(Boolean);

// ---------- utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

const INICIO = Date.now();
const LIMITE_MS = (Number(process.env.TEMPO_MAX_MIN) || 50) * 60000; // para de pedir páginas novas depois disso
const decorrido = () => `${Math.round((Date.now() - INICIO) / 1000)}s`;
let parcial = false;
const erros = {};            // contagem de erros por tipo, gravada no meta.json
const contagemUF = {};       // esperado x recebido por estado, gravado no meta.json
let reaproveitados = 0;
// modalidades do PNCP: dividir a consulta por elas deixa cada lista curta (páginas "fundas" são as que mais falham)
const MODALIDADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
// endereço público do site, de onde lemos a coleta anterior para cobrir falhas
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

async function baixarPagina({ uf, mod, pagina }, dataFinal, tentativas = 4) {
  const url = `${API}?dataFinal=${dataFinal}&uf=${uf}${mod ? `&codigoModalidadeContratacao=${mod}` : ""}&pagina=${pagina}&tamanhoPagina=${TAMANHO}`;
  for (let t = 1; t <= tentativas; t++) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(45000) });
      if (r.status === 204) return { data: [], totalPaginas: 0, totalRegistros: 0 };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      const tipo = e.name === "TimeoutError" ? "tempo esgotado" : e.message;
      erros[tipo] = (erros[tipo] || 0) + 1;
      if (t === tentativas) { console.error(`${uf}/mod ${mod} página ${pagina} falhou: ${tipo}`); return null; }
      await sleep(2000 * t * t + Math.random() * 1000);
    }
  }
  return null;
}

async function coletarTudo() {
  if (process.env.FIXTURE) {
    const j = JSON.parse(await readFile(process.env.FIXTURE, "utf8"));
    return Array.isArray(j) ? j : j.data;
  }
  // propostas que encerram em até ~5 anos (credenciamentos costumam ser longos)
  const fim = new Date();
  fim.setFullYear(fim.getFullYear() + 5);
  const dataFinal = ymd(fim);

  const registros = [];
  const fila = [];
  let total = 0, feitas = 0;

  // 1) total esperado por estado (consulta sem modalidade, só a 1ª página)
  for (const uf of UFS) {
    const j = await baixarPagina({ uf, pagina: 1 }, dataFinal, 8);
    contagemUF[uf] = { esperado: j ? j.totalRegistros : null, recebido: 0 };
    console.log(`${uf}: ${j ? j.totalRegistros : "?"} registros esperados (${decorrido()})`);
  }
  // 2) primeira página de cada estado x modalidade; o resto vai para a fila
  const primeiras = UFS.flatMap((uf) => MODALIDADES.map((mod) => ({ uf, mod, pagina: 1 })));
  const semPrimeira = [];
  async function abrirParticao(t) {
    const j = await baixarPagina(t, dataFinal, 6);
    if (!j) { semPrimeira.push(t); return; }
    const paginas = j.totalPaginas || 0;
    if (!paginas) return;
    registros.push(...(j.data || []));
    total += paginas; feitas++;
    for (let p = 2; p <= paginas; p++) fila.push({ uf: t.uf, mod: t.mod, pagina: p });
  }
  for (let i = 0; i < primeiras.length; i += PARALELO) await Promise.all(primeiras.slice(i, i + PARALELO).map(abrirParticao));
  for (const t of semPrimeira.splice(0)) await abrirParticao(t); // segunda chance, uma de cada vez
  if (semPrimeira.length) parcial = true;
  console.log(`Partições abertas: ${feitas} com dados, ${fila.length} páginas na fila (${decorrido()})`);

  // 3) demais páginas, em rodadas; o que falhar volta para a próxima rodada com pausa maior
  async function rodada(lista, tentativas) {
    const falhas = [];
    async function trabalhador() {
      while (lista.length) {
        if (Date.now() - INICIO > LIMITE_MS) { parcial = true; return; }
        const t = lista.shift();
        const j = await baixarPagina(t, dataFinal, tentativas);
        if (j) { registros.push(...(j.data || [])); feitas++; }
        else falhas.push(t);
        if (feitas % 50 === 0) console.log(`  ${feitas}/${total} páginas · ${registros.length} registros · ${decorrido()}`);
      }
    }
    await Promise.all(Array.from({ length: PARALELO }, trabalhador));
    return falhas.concat(lista);
  }
  let faltando = await rodada(fila, 3);
  for (let r = 1; r <= 5 && faltando.length && Date.now() - INICIO < LIMITE_MS; r++) {
    console.log(`Rodada ${r + 1}: tentando de novo ${faltando.length} páginas…`);
    await sleep(15000 * r);
    faltando = await rodada(faltando, 4);
  }
  if (faltando.length) parcial = true;
  console.log(`Coleta: ${feitas}/${total} páginas, ${registros.length} registros em ${decorrido()}${parcial ? " (PARCIAL)" : ""}`);
  if (total && feitas < total * 0.5) throw new Error("Menos da metade das páginas veio. Abortando para não publicar dados muito incompletos.");

  // 4) se algo faltou, reaproveita da coleta anterior o que ainda está aberto
  if (parcial && SITE_URL) {
    try {
      const r = await fetch(`${SITE_URL}/data/cache.json.gz`, { signal: AbortSignal.timeout(60000) });
      if (r.ok) {
        const antigos = JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8"));
        const tem = new Set(registros.map((x) => x.numeroControlePNCP));
        for (const x of antigos) {
          if (!tem.has(x.numeroControlePNCP)) { registros.push(x); tem.add(x.numeroControlePNCP); reaproveitados++; }
        }
        console.log(`Reaproveitados da coleta anterior: ${reaproveitados}`);
      } else console.log(`Sem coleta anterior para reaproveitar (HTTP ${r.status}).`);
    } catch (e) { console.log(`Não deu para ler a coleta anterior: ${e.message}`); }
  }
  return registros;
}

// ---------- limpeza de texto ----------
function limpar(t) {
  if (!t) return "";
  let s = String(t).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  s = s.replace(/^\[[^\]]{2,60}\]\s*[-–:]\s*/, ""); // "[Portal de Compras Públicas] - "
  s = s.replace(/^(objeto|do objeto)\s*[:.-]\s*/i, "");
  const letras = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const maius = s.replace(/[^A-ZÀ-Þ]/g, "");
  if (letras.length > 20 && maius.length / letras.length > 0.7) {
    // TEXTO TODO EM MAIÚSCULAS -> frase normal, preservando siglas curtas conhecidas
    const siglas = /\b(SUS|UBS|UPA|CAPS|SAMU|PSF|ESF|CRAS|CREAS|EPI|EPIs|TI|GLP|ART|CNPJ|CPF|ME|EPP|MEI|SRP|LTDA|ABNT|NBR|CBUQ|LED|SEMED|SEMSA|INSS|FGTS|ETP|TR|ARP)\b/g;
    const guarda = [];
    s = s.replace(siglas, (m) => { guarda.push(m); return `\u0000${guarda.length - 1}\u0000`; });
    s = s.toLowerCase().replace(/(^|[.!?]\s+|\n)([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => guarda[i]);
    s = s.replace(/\b([a-z]{2})\/(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)\b/gi,
      (m, a, uf) => `${a}/${uf.toUpperCase()}`);
    s = s.replace(/\b(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to|br)-(\d{2,3})\b/gi, (m, uf, n) => `${uf.toUpperCase()}-${n}`);
  }
  return s;
}

function titulo(nome) {
  if (!nome) return "";
  const pequenas = new Set(["de", "da", "do", "das", "dos", "e", "em", "para", "a", "o"]);
  const n = String(nome).trim().replace(/\s+/g, " ");
  if (n !== n.toUpperCase()) return n;
  return n.toLowerCase().split(" ").map((w, i, a) => (i > 0 && i < a.length - 1 && pequenas.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

const semAcento = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// ---------- categorias (palavras-chave no objeto) ----------
const CATEGORIAS = [
  ["Tecnologia", /software|sistemas? (de gestao|informatizad|de informac)|informatica|computador|tecnologia da informacao|\bti\b|internet|link de dados|licencas? de uso|notebook|impressora|telefonia|nuvem/],
  ["Saúde", /medic|hospital|saude|farmac|odontol|enfermag|exames?\b|analises clinicas|laboratorio de analises|ambulat|cirurg|\bsus\b|clinic|ortes|protes|fisioter|psicolog/],
  ["Obras e engenharia", /\bobras?\b|paviment|construc|reforma|engenharia|drenagem|asfalt|edifica|recapeamento|calcament|terraplen|ponte|saneamento/],
  ["Alimentação", /aliment|merenda|refeic|lanche|hortifrut|carnes?\b|panificac|genero alimenticio|cesta basica/],
  ["Veículos e transporte", /veiculo|combustiv|pneu|transporte|onibus|frota|automot|caminhao|ambulancia|maquinas? pesadas|motocicleta|lubrificant/],
  ["Limpeza e conservação", /limpeza|higien|conservacao|zeladoria|jardinagem|rocada|coleta de residuos|lixo|dedetiz/],
  ["Educação", /escola|educac|pedagog|ensino|didatic|material escolar|uniforme escolar|creche/],
  ["Eventos e cultura", /evento|\bshows?\b|festa|festival|cultur|artist|palco|sonorizac|iluminacao cenica|carnaval|rodeio/],
  ["Equipamentos e mobiliário", /mobiliar|moveis|equipamento|eletrodomest|ar condicionado|climatiz/],
  ["Materiais de consumo", /material de expediente|materiais? de consumo|papelaria|expediente|copa e cozinha|material de construcao|material eletrico|material hidraulico/],
  ["Serviços profissionais", /consultoria|assessoria|auditoria|advocac|juridic|contabil|capacitac|treinamento|publicidade|vigilancia|seguranca patrimonial/],
];
const nomesCategorias = [...CATEGORIAS.map((c) => c[0]), "Outros"];
function categoria(texto) {
  const t = semAcento(texto || "");
  const i = CATEGORIAS.findIndex(([, re]) => re.test(t));
  return i === -1 ? CATEGORIAS.length : i;
}

function curto(s, n) {
  if (s.length <= n) return s;
  const corte = s.slice(0, n);
  const esp = corte.lastIndexOf(" ");
  return (esp > n * 0.6 ? corte.slice(0, esp) : corte).replace(/[,;:\s]+$/, "") + "…";
}

// ---------- facilidade: dá para atender sem grande estrutura? ----------
// Estimativa por regras simples (valor, modalidade, área e palavras do objeto). Nota de 0 a 100.
// O que pesa contra: atividades que pedem licença, registro em conselho, equipe técnica ou estrutura própria.
const EXIGE = [
  [/extintor|combate a incendio|prevencao (e combate )?(a|de) incendio|\bavcb\b|\bclcb\b|brigad(a|ista)|hidrante|sprinkler|para-?raios|\bspda\b|bombeiro/, "Prevenção de incêndio (exige empresa credenciada no Corpo de Bombeiros)"],
  [/\bgas(es)?\b|\bglp\b|gas liquefeito|botij|oxigenio|gases medicinais|nitrogenio/, "Gás (exige autorização da ANP e transporte especial)"],
  [/combustive|gasolina|diesel|etanol|lubrificante/, "Combustíveis (exige autorização da ANP)"],
  [/\bmedic(o|a|os|as|amentos?|inal|inais|ina)\b|medicament|hospital|saude|farmac|enferm|odontol|clinic|ambulat|laborator|exames?\b|cirurg|\bsus\b|\bubs\b|\bupa\b|\bopme\b|ortes|protes|fisioter|psicolog|nutricion|vacina|hemodial|instrumental|insumos? (hospitalar|medic)|correlato/, "Área da saúde (licença da Vigilância Sanitária/Anvisa ou profissionais habilitados)"],
  [/(?<!mao de )\bobras?\b|engenharia|paviment|construc|edifica|terraplen|drenagem|recapeamento|saneamento|reforma (de|do|da|predial)|manutencao predial/, "Obra ou engenharia (responsável técnico com registro no CREA/CAU)"],
  [/mao de obra|dedicacao exclusiva|postos? de trabalho|terceiriz|servicos? (continuos? )?de limpeza|limpeza (e conservacao|predial|urbana)|portaria|recepcionista|copeir|zeladoria/, "Mão de obra dedicada (funcionários contratados para o órgão)"],
  [/manutencao (preventiva |corretiva |preventiva e corretiva )?(de |do |dos |da |das |em )?(\w+ )?(ar[- ]condicionado|aparelhos de ar|climatiz|refrigerac|elevador|gerador|subestac|nobreak|rede eletrica|instalacoes eletricas)|\bpmoc\b/, "Manutenção técnica (técnico habilitado; ar-condicionado costuma exigir PMOC com engenheiro)"],
  [/vigilancia|seguranca patrimonial|monitoramento eletronico/, "Vigilância (autorização da Polícia Federal)"],
  [/coleta de (lixo|residuos)|residuos (solidos|de saude)|aterro|dedetiz|desratiz|controle de pragas|limpeza de fossa/, "Resíduos ou controle de pragas (licença ambiental ou sanitária)"],
  [/transporte escolar|transporte de (passageiros|pacientes|alunos)|fretamento|onibus|ambulancia|remocao/, "Transporte de pessoas (frota e motoristas habilitados)"],
  [/locacao de (maquinas|veiculos|equipamentos pesados)|maquinas pesadas|caminh(ao|oes)|retroescavadeira|motoniveladora/, "Máquinas ou veículos pesados"],
  [/refeic(ao|oes) (prontas|preparadas)|alimentacao preparada|marmitex|cozinha industrial|merenda escolar preparada/, "Refeições preparadas (cozinha com alvará sanitário)"],
  [/consultoria|assessoria|auditoria|advocac|juridic|contabil|pericia|elaboracao de projetos?|georreferenc|topograf/, "Serviço técnico especializado (profissional com registro em conselho)"],
  [/\bcrea\b|\bcau\b|\bcrm\b|\bcrf\b|\bcrmv\b|\bcrq\b|responsavel tecnico|licenca ambiental|alvara sanitario|licenca sanitaria|anvisa/, "O texto já cita registro em conselho ou licença específica"],
  [/(pessoas? juridicas?|empresas?) (especializadas?|habilitadas?|credenciadas?)|especializada em/, "Pede empresa especializada (costuma exigir atestados de capacidade técnica)"],
];
// O que pesa a favor: compra de produtos comuns, que dá para revender ou produzir sem equipe técnica.
const ACESSIVEL = [
  [/grafic|impress(o|os|ao) (de|grafic)|banner|faixas?\b|folder|panfleto|cartaz|adesivo|placas? (de sinaliz|de identific|indicativ)|plotag|carimbo|envelope|cartao de visita|convite|apostila|encaderna/, "Serviço gráfico (produção simples, sem licença específica)", 22, true],
  [/instrumentos? musica|instrumentos? de (sopro|percussao|corda)|fanfarra|banda marcial|violao|teclado musical|bateria musical/, "Instrumentos musicais (revenda de produtos)", 22],
  [/ferramenta|instrumentos? de (medicao|precisao|desenho)|trena|paquimetro|multimetro/, "Ferramentas ou instrumentos (revenda de produtos)", 20],
  [/material de expediente|papelaria|materia(l|is) de (consumo|escritorio|limpeza|higiene)|copa e cozinha|descartave|utensilio/, "Materiais comuns de consumo", 20],
  [/brinde|camiseta|uniforme|fardamento|bandeira|trofeu|medalha|bone|squeeze|caneca|mochila|bolsa/, "Itens personalizados ou confecção", 20, true],
  [/material (esportivo|pedagogico|didatico|escolar)|brinquedo|jogos? educativ|livros?\b|kit escolar/, "Materiais escolares, esportivos ou livros", 18],
  [/mobili|moveis|cadeira|mesa\b|armario|eletrodomest|eletroeletronic|equipamentos? de informatica|notebook|computador|impressora|tablet|ar condicionado|ventilador|bebedouro/, "Revenda de equipamentos ou móveis", 14],
  [/genero alimenticio|hortifrut|cesta basica|lanche|coffee break|agua mineral|cafe\b|acucar/, "Fornecimento de alimentos industrializados", 10],
  [/decorac|ornament|natal|flores|arranjo/, "Decoração", 12, true],
];
function facilidade(r) {
  let nota = 50;
  const motivos = [];
  const t = semAcento(`${r.objetoCompra || ""} ${r.informacaoComplementar || ""}`);
  const v = typeof r.valorTotalEstimado === "number" && r.valorTotalEstimado > 1 ? r.valorTotalEstimado : null;
  const m = semAcento(r.modalidadeNome || "");

  // 1) o que é: algo que exige licença/estrutura?
  const exigencias = EXIGE.filter(([re]) => re.test(t)).slice(0, 3);
  for (const [, txt] of exigencias) motivos.push(["ruim", txt]);
  if (exigencias.length) nota -= 18 + 6 * (exigencias.length - 1);

  // 2) se não exige, é um produto comum?
  if (!exigencias.length) {
    // serviços (manutenção, instalação, locação…) só contam como fáceis se forem gráficos, confecção ou decoração
    const ehServico = /^\s*(\[[^\]]*\]\s*-?\s*)?(registro de precos?.{0,40})?(contratac|prestac|servic|manutenc|instalac|locac)/.test(t) && !/(aquisic|fornecimento|compra) de/.test(t.slice(0, 120));
    const ac = ACESSIVEL.find(([re, , , servicoOk]) => re.test(t) && (!ehServico || servicoOk));
    if (ac) { nota += ac[2]; motivos.push(["bom", ac[1]]); }
    else if (/^\s*(\[[^\]]*\]\s*-?\s*)?(registro de precos?.{0,40})?(aquisic|compra|fornecimento)/.test(t)) {
      nota += 10; motivos.push(["bom", "Compra de produtos (basta fornecer, sem equipe técnica)"]);
    } else if (ehServico || /servic|contratac|prestac/.test(t)) {
      nota -= 6; motivos.push(["neutro", "Prestação de serviço (confira no edital se pede equipe ou atestados)"]);
    }
  }

  // 3) modalidade
  if (/credenciamento/.test(m)) { nota -= 22; motivos.push(["ruim", "Credenciamento: costuma pedir habilitação específica, documentação extensa e contrato de longo prazo"]); }
  else if (/dispensa/.test(m)) { nota += 14; motivos.push(["bom", "Dispensa: processo simples e rápido"]); }
  else if (/pregao/.test(m)) { nota += 4; motivos.push(["neutro", "Pregão: disputa por preço com documentação padrão"]); }
  else if (/concorrencia/.test(m)) { nota -= 15; motivos.push(["ruim", "Concorrência: modalidade de contratações complexas"]); }
  else if (/inexigibilidade/.test(m)) { nota -= 30; motivos.push(["ruim", "Inexigibilidade: normalmente já tem fornecedor definido"]); }
  else if (/dialogo|pre-?qualificacao|manifestacao/.test(m)) { nota -= 15; motivos.push(["ruim", "Modalidade com seleção prévia de empresas"]); }
  else if (/leilao/.test(m)) { nota -= 10; motivos.push(["neutro", "Leilão: o órgão está vendendo bens, não comprando"]); }

  // 4) valor
  if (v == null) motivos.push(["neutro", "Valor estimado não divulgado"]);
  else if (v <= 80000) { nota += 18; motivos.push(["bom", "Valor até R$ 80 mil (faixa em que a lei costuma reservar a disputa a micro e pequenas empresas)"]); }
  else if (v <= 500000) { nota += 8; motivos.push(["bom", "Valor moderado (até R$ 500 mil)"]); }
  else if (v <= 3000000) motivos.push(["neutro", "Valor médio (até R$ 3 milhões)"]);
  else if (v <= 15000000) { nota -= 15; motivos.push(["ruim", "Valor alto (acima de R$ 3 milhões costuma exigir garantia e capacidade financeira)"]); }
  else { nota -= 25; motivos.push(["ruim", "Valor muito alto (acima de R$ 15 milhões)"]); }

  if (r.srp) { nota += 4; motivos.push(["bom", "Registro de preços: entregas sob demanda, em lotes menores"]); }

  // atividade que por natureza pede licença ou estrutura nunca passa de "Exige estrutura"
  if (exigencias.length) nota = Math.min(nota, 35);
  // credenciamento nunca passa de "Moderada"
  if (/credenciamento/.test(m)) nota = Math.min(nota, 45);

  nota = Math.max(0, Math.min(100, Math.round(nota)));
  // motivos: primeiro os que pesam contra, depois a favor, depois neutros
  const ordem = { ruim: 0, bom: 1, neutro: 2 };
  motivos.sort((a, b) => ordem[a[0]] - ordem[b[0]]);
  return { nota, motivos };
}
const nivelFacil = (n) => (n >= 65 ? "Acessível" : n >= 40 ? "Moderada" : "Exige estrutura");

// ---------- montagem ----------
async function main() {
  const brutos = await coletarTudo();
  const agora = new Date();
  // início do dia em Brasília: mantém o que encerra hoje
  const hojeBR = new Date(new Date(agora.getTime() - 3 * 3600e3).toISOString().slice(0, 10) + "T00:00:00");

  const vistos = new Set();
  const lista = [];
  for (const r of brutos) {
    const id = r.numeroControlePNCP;
    if (!id || vistos.has(id)) continue;
    if (!r.dataEncerramentoProposta) continue;
    if (!UFS.includes(r.unidadeOrgao?.ufSigla)) continue;
    if (new Date(r.dataEncerramentoProposta) < hojeBR) continue;
    vistos.add(id);
    lista.push(r);
    const u = r.unidadeOrgao.ufSigla;
    (contagemUF[u] ||= { esperado: null, recebido: 0 }).recebido++;
  }
  lista.sort((a, b) => a.dataEncerramentoProposta.localeCompare(b.dataEncerramentoProposta));

  const modalidades = [];
  const modIdx = (nome) => {
    const n = nome || "Não informada";
    let i = modalidades.indexOf(n);
    if (i === -1) { modalidades.push(n); i = modalidades.length - 1; }
    return i;
  };

  const linhas = [];
  const porUF = {};
  for (const r of lista) {
    const u = r.unidadeOrgao || {};
    const o = r.orgaoEntidade || {};
    const uf = u.ufSigla || "BR";
    const objeto = limpar(r.objetoCompra);
    const orgao = titulo(o.razaoSocial);
    const unidade = titulo(u.nomeUnidade);
    const cat = categoria(r.objetoCompra + " " + (r.informacaoComplementar || ""));
    const fac = facilidade(r);
    const valor = typeof r.valorTotalEstimado === "number" && r.valorTotalEstimado > 1 ? Math.round(r.valorTotalEstimado * 100) / 100 : null;

    linhas.push([
      r.numeroControlePNCP,
      uf,
      titulo(u.municipioNome),
      curto(orgao, 70),
      curto(objeto, 180),
      modIdx(r.modalidadeNome),
      valor,
      r.dataEncerramentoProposta.slice(0, 16),
      cat,
      r.srp ? 1 : 0,
      (r.dataPublicacaoPncp || "").slice(0, 10),
      o.esferaId || "",
      fac.nota,
    ]);

    (porUF[uf] ||= {})[r.numeroControlePNCP] = {
      objeto,
      info: limpar(r.informacaoComplementar),
      orgao,
      cnpj: o.cnpj,
      unidade: unidade && !/^unidade unica$/i.test(semAcento(unidade)) ? unidade : "",
      municipio: titulo(u.municipioNome),
      uf,
      ufNome: u.ufNome,
      ano: r.anoCompra,
      seq: r.sequencialCompra,
      numero: r.numeroCompra,
      processo: r.processo,
      modalidade: r.modalidadeNome,
      disputa: r.modoDisputaNome,
      instrumento: r.tipoInstrumentoConvocatorioNome,
      amparo: r.amparoLegal ? { nome: r.amparoLegal.nome, descricao: r.amparoLegal.descricao } : null,
      situacao: r.situacaoCompraNome,
      srp: !!r.srp,
      valor,
      abertura: r.dataAberturaProposta,
      encerramento: r.dataEncerramentoProposta,
      publicacao: r.dataPublicacaoPncp,
      atualizacao: r.dataAtualizacaoGlobal || r.dataAtualizacao,
      linkOrigem: r.linkSistemaOrigem || null,
      linkEletronico: r.linkProcessoEletronico || null,
      plataforma: r.usuarioNome,
      esfera: o.esferaId,
      poder: o.poderId,
      categoria: nomesCategorias[cat],
      facil: { nota: fac.nota, nivel: nivelFacil(fac.nota), motivos: fac.motivos },
    };
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, "uf"), { recursive: true });
  const gerado = agora.toISOString();
  await writeFile(path.join(OUT, "index.json"), JSON.stringify({
    gerado,
    parcial,
    ufs: UFS,
    total: linhas.length,
    colunas: ["id", "uf", "municipio", "orgao", "objeto", "modalidade", "valor", "encerramento", "categoria", "srp", "publicacao", "esfera", "facilidade"],
    modalidades,
    categorias: nomesCategorias,
    linhas,
  }));
  for (const [uf, det] of Object.entries(porUF)) {
    await writeFile(path.join(OUT, "uf", `${uf}.json`), JSON.stringify(det));
  }
  // coleta bruta guardada no próprio site: a próxima execução usa para cobrir páginas que falharem
  await writeFile(path.join(OUT, "cache.json.gz"), gzipSync(JSON.stringify(lista)));
  await writeFile(path.join(OUT, "meta.json"), JSON.stringify({
    gerado, parcial, total: linhas.length, brutos: brutos.length, reaproveitados, porUF: contagemUF, erros,
    duracao: decorrido(),
  }, null, 2));
  console.log(`Pronto: ${linhas.length} licitações em aberto (de ${brutos.length} registros recebidos).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
