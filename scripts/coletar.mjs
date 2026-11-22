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
import {
  limpar, titulo, semAcento, nomesCategorias, categoria, curto,
  facilidade, ultimaAlteracao, nivelFacil, mudancas,
} from "./lib/regras.mjs";

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

// coleta anterior (publicada no próprio site): base para detectar novas e alteradas e para cobrir falhas
const anterior = new Map();
let historicoAnterior = {};
let temHistoricoAnterior = false;
async function carregarAnterior() {
  const base = process.env.ANTERIOR_DIR; // teste local: pasta com cache.json.gz e historico.json
  if (!SITE_URL && !base) return;
  const ler = async (nome) => {
    if (base) return readFile(path.join(base, nome));
    const r = await fetch(`${SITE_URL}/data/${nome}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  try {
    const antigos = JSON.parse(gunzipSync(await ler("cache.json.gz")).toString("utf8"));
    for (const x of antigos) anterior.set(x.numeroControlePNCP, x);
    console.log(`Coleta anterior: ${anterior.size} registros`);
  } catch (e) { console.log(`Sem coleta anterior (${e.message}).`); }
  try { historicoAnterior = JSON.parse((await ler("historico.json")).toString("utf8")); temHistoricoAnterior = true; }
  catch (e) { console.log(`Sem histórico anterior (${e.message}).`); }
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
  if (parcial && anterior.size) {
    const tem = new Set(registros.map((x) => x.numeroControlePNCP));
    for (const x of anterior.values()) {
      if (!tem.has(x.numeroControlePNCP)) { registros.push(x); tem.add(x.numeroControlePNCP); reaproveitados++; }
    }
    console.log(`Reaproveitados da coleta anterior: ${reaproveitados}`);
  }
  return registros;
}

// ---------- montagem ----------
async function main() {
  await carregarAnterior();
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

  // histórico de novidades e alterações (guarda 60 dias)
  const hojeISO = new Date(agora.getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  const limiteHist = new Date(agora.getTime() - 60 * 86400e3).toISOString().slice(0, 10);
  const historico = {};
  let nNovas = 0, nAlteradas = 0;
  for (const r of lista) {
    const id = r.numeroControlePNCP;
    const h = (historicoAnterior[id] || []).filter((e) => e.d >= limiteHist);
    const add = (k, t, d = hojeISO) => { if (!h.some((e) => e.d === d && e.t === t)) h.push({ d, k, t }); };
    const p = anterior.get(id);
    const m = p ? mudancas(p, r) : [];
    m.forEach(([k, t]) => add(k, t));
    if (m.length) nAlteradas++;
    if (!p && anterior.size) { add("nova", "Apareceu no PNCP"); nNovas++; }
    // ainda sem histórico (primeira vez): usa a data de atualização informada pelo próprio PNCP
    if (!temHistoricoAnterior && !h.length && r.dataAtualizacaoGlobal && r.dataPublicacaoPncp &&
        Date.parse(r.dataAtualizacaoGlobal) - Date.parse(r.dataPublicacaoPncp) > 86400e3) {
      add("edital", "O órgão atualizou a publicação depois de divulgá-la", r.dataAtualizacaoGlobal.slice(0, 10));
    }
    if (h.length) historico[id] = h.sort((a, b) => a.d.localeCompare(b.d)).slice(-20);
  }
  console.log(`Novas: ${nNovas} · alteradas nesta coleta: ${nAlteradas}`);

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
      ultimaAlteracao(historico[r.numeroControlePNCP]),
      (historico[r.numeroControlePNCP] || []).find((e) => e.k === "nova")?.d || "",
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
      historico: historico[r.numeroControlePNCP] || [],
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
    colunas: ["id", "uf", "municipio", "orgao", "objeto", "modalidade", "valor", "encerramento", "categoria", "srp", "publicacao", "esfera", "facilidade", "alterada", "nova"],
    modalidades,
    categorias: nomesCategorias,
    linhas,
  }));
  for (const [uf, det] of Object.entries(porUF)) {
    await writeFile(path.join(OUT, "uf", `${uf}.json`), JSON.stringify(det));
  }
  // coleta bruta guardada no próprio site: a próxima execução usa para cobrir páginas que falharem
  await writeFile(path.join(OUT, "cache.json.gz"), gzipSync(JSON.stringify(lista)));
  await writeFile(path.join(OUT, "historico.json"), JSON.stringify(historico));
  await writeFile(path.join(OUT, "meta.json"), JSON.stringify({
    gerado, parcial, total: linhas.length, brutos: brutos.length, reaproveitados, novas: nNovas, alteradas: nAlteradas, porUF: contagemUF, erros,
    duracao: decorrido(),
  }, null, 2));
  console.log(`Pronto: ${linhas.length} licitações em aberto (de ${brutos.length} registros recebidos).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
