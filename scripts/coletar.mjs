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

const API = "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta";
const TAMANHO = 50;          // máximo aceito pela API
const PARALELO = 6;          // requisições simultâneas
const OUT = path.resolve("site/data");

// ---------- utilidades ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function baixarPagina(pagina, dataFinal, tentativa = 1) {
  const url = `${API}?dataFinal=${dataFinal}&pagina=${pagina}&tamanhoPagina=${TAMANHO}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60000) });
    if (r.status === 204) return { data: [], totalPaginas: 0 };
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (tentativa >= 6) {
      console.error(`Página ${pagina} falhou de vez: ${e.message}`);
      return null;
    }
    await sleep(1500 * tentativa * tentativa);
    return baixarPagina(pagina, dataFinal, tentativa + 1);
  }
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

  const primeira = await baixarPagina(1, dataFinal);
  if (!primeira) throw new Error("Não foi possível acessar a API do PNCP.");
  const total = primeira.totalPaginas || 1;
  console.log(`PNCP: ${primeira.totalRegistros} registros em ${total} páginas`);

  const registros = [...(primeira.data || [])];
  const falhas = [];
  let proxima = 2;
  async function trabalhador() {
    while (proxima <= total) {
      const p = proxima++;
      const j = await baixarPagina(p, dataFinal);
      if (j) registros.push(...(j.data || []));
      else falhas.push(p);
      if (p % 100 === 0) console.log(`  ${p}/${total} páginas`);
    }
  }
  await Promise.all(Array.from({ length: PARALELO }, trabalhador));
  if (falhas.length > total * 0.05) {
    throw new Error(`Muitas páginas falharam (${falhas.length}). Abortando para não publicar dados incompletos.`);
  }
  if (falhas.length) console.warn(`Aviso: ${falhas.length} páginas não vieram: ${falhas.join(", ")}`);
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

const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

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
    if (new Date(r.dataEncerramentoProposta) < hojeBR) continue;
    vistos.add(id);
    lista.push(r);
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
    };
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, "uf"), { recursive: true });
  const gerado = agora.toISOString();
  await writeFile(path.join(OUT, "index.json"), JSON.stringify({
    gerado,
    total: linhas.length,
    colunas: ["id", "uf", "municipio", "orgao", "objeto", "modalidade", "valor", "encerramento", "categoria", "srp", "publicacao", "esfera"],
    modalidades,
    categorias: nomesCategorias,
    linhas,
  }));
  for (const [uf, det] of Object.entries(porUF)) {
    await writeFile(path.join(OUT, "uf", `${uf}.json`), JSON.stringify(det));
  }
  await writeFile(path.join(OUT, "meta.json"), JSON.stringify({ gerado, total: linhas.length, brutos: brutos.length }, null, 2));
  console.log(`Pronto: ${linhas.length} licitações em aberto (de ${brutos.length} registros recebidos).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
