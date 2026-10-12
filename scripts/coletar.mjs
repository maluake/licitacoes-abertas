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
const EXIGE = [
  [/\bobras?\b|engenharia|paviment|construc|edifica|terraplen|drenagem|recapeamento|saneamento/, "Obra ou serviço de engenharia (pede responsável técnico, equipe e equipamentos)"],
  [/mao de obra|dedicacao exclusiva|postos? de trabalho|terceiriz/, "Mão de obra dedicada (exige funcionários contratados para o órgão)"],
  [/vigilancia|seguranca patrimonial/, "Vigilância (atividade com autorização da Polícia Federal)"],
  [/coleta de (lixo|residuos)|residuos solidos|aterro/, "Coleta de resíduos (frota e licenças ambientais)"],
  [/transporte escolar|transporte de passageiros|fretamento|onibus/, "Transporte de pessoas (frota e motoristas habilitados)"],
  [/hospitalar|plantao|plantoes|\buti\b|hemodialise|cirurg|exames? de imagem|tomografia|ressonancia/, "Serviço de saúde especializado (estrutura clínica e profissionais habilitados)"],
  [/locacao de (maquinas|veiculos|equipamentos pesados)|maquinas pesadas|caminh(ao|oes)/, "Máquinas ou veículos pesados"],
  [/combustive|gas liquefeito|\bglp\b/, "Combustíveis (exige autorização da ANP)"],
  [/medicament|farmac/, "Medicamentos (exige licença sanitária e autorização da Anvisa)"],
];
const ACESSIVEL = [
  [/material de expediente|papelaria|materia(l|is) de (consumo|limpeza|escritorio)|copa e cozinha|descartave/, "Fornecimento de materiais comuns"],
  [/brinde|camiseta|uniforme|fardamento|bandeira|trofeu|medalha/, "Itens personalizados ou confecção"],
  [/grafic|impress(o|ao) de|banner|placas? de sinaliz/, "Serviços gráficos"],
  [/consultoria|assessoria|capacitac|treinamento|palestra|curso/, "Serviço intelectual (consultoria ou treinamento)"],
  [/software|licenca|sistema informatizado|site|aplicativo|suporte tecnico/, "Tecnologia ou software"],
  [/genero alimenticio|aliment|lanche|coffee break|hortifrut|cesta basica/, "Fornecimento de alimentos"],
  [/evento|show|apresentac|artist|sonorizac|decorac/, "Eventos ou apresentações"],
  [/mobili|eletrodomest|equipamentos? de informatica|notebook|computador|ar condicionado/, "Revenda de equipamentos"],
];
function facilidade(r, catNome) {
  let nota = 50;
  const motivos = [];
  const t = semAcento(`${r.objetoCompra || ""} ${r.informacaoComplementar || ""}`);
  const v = typeof r.valorTotalEstimado === "number" && r.valorTotalEstimado > 1 ? r.valorTotalEstimado : null;
  const m = semAcento(r.modalidadeNome || "");

  if (v == null) motivos.push(["neutro", "Valor estimado não divulgado"]);
  else if (v <= 80000) { nota += 25; motivos.push(["bom", "Valor até R$ 80 mil (faixa em que a lei costuma reservar a disputa a micro e pequenas empresas)"]); }
  else if (v <= 500000) { nota += 12; motivos.push(["bom", "Valor moderado (até R$ 500 mil)"]); }
  else if (v <= 3000000) { motivos.push(["neutro", "Valor médio (até R$ 3 milhões)"]); }
  else if (v <= 15000000) { nota -= 18; motivos.push(["ruim", "Valor alto (acima de R$ 3 milhões costuma exigir garantia e capacidade financeira)"]); }
  else { nota -= 30; motivos.push(["ruim", "Valor muito alto (acima de R$ 15 milhões)"]); }

  if (/dispensa/.test(m)) { nota += 15; motivos.push(["bom", "Dispensa: processo simples e rápido"]); }
  else if (/credenciamento/.test(m)) { nota += 8; motivos.push(["bom", "Credenciamento: sem disputa de preço, basta cumprir os requisitos"]); }
  else if (/pregao/.test(m)) { nota += 4; motivos.push(["neutro", "Pregão: disputa por preço com documentação padrão"]); }
  else if (/concorrencia/.test(m)) { nota -= 15; motivos.push(["ruim", "Concorrência: modalidade de contratações complexas"]); }
  else if (/inexigibilidade/.test(m)) { nota -= 30; motivos.push(["ruim", "Inexigibilidade: normalmente já tem fornecedor definido"]); }
  else if (/dialogo|pre-?qualificacao/.test(m)) { nota -= 15; motivos.push(["ruim", "Modalidade com seleção prévia de empresas"]); }

  let exige = 0;
  for (const [re, txt] of EXIGE) if (re.test(t) && exige < 2) { nota -= 20; exige++; motivos.push(["ruim", txt]); }
  if (!exige) {
    const ac = ACESSIVEL.find(([re]) => re.test(t));
    if (ac) { nota += 12; motivos.push(["bom", ac[1]]); }
  }
  if (r.srp) { nota += 4; motivos.push(["bom", "Registro de preços: entregas sob demanda, em lotes menores"]); }
  if (exige) nota = Math.min(nota, 35); // atividade que por natureza pede estrutura própria

  nota = Math.max(0, Math.min(100, Math.round(nota)));
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
    const fac = facilidade(r, nomesCategorias[cat]);
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
