"use strict";

const UFS = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
  PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};
const ESFERAS = { M: "Municipal", E: "Estadual", F: "Federal", D: "Distrital", N: "Não informada" };
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const POR_PAGINA = 60;

const $ = (s) => document.getElementById(s);
const el = {
  status: $("status"), q: $("q"), uf: $("f-uf"), cat: $("f-cat"), mod: $("f-mod"), prazo: $("f-prazo"),
  valor: $("f-valor"), esfera: $("f-esfera"), ordem: $("f-ordem"), contagem: $("contagem"), limpar: $("limpar"),
  lista: $("lista"), vazio: $("vazio"), mais: $("mais"),
  painel: $("painel"), fundo: $("painel-fundo"), corpo: $("p-corpo"), eyebrow: $("p-eyebrow"), fechar: $("fechar"),
};

let base = null;          // index.json
let linhas = [];          // objetos de linha
let filtradas = [];
let mostrando = 0;
const cacheUF = {};
let ultimoFoco = null;

// ---------- formatação ----------
const semAcento = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
const brlCurto = (v) => {
  if (v >= 1e9) return `R$ ${(v / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} bi`;
  if (v >= 1e6) return `R$ ${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (v >= 1e4) return `R$ ${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`;
  return brl.format(v);
};
// datas do PNCP vêm no horário de Brasília, sem fuso: tratamos tudo como "relógio de Brasília"
const tBR = (s) => Date.parse(s.length <= 10 ? s + "T00:00:00Z" : s + (s.length === 16 ? ":00Z" : "Z"));
const agoraBR = () => Date.now() - 3 * 3600e3;
const diaIdx = (ms) => Math.floor(ms / 86400000);
function diasRestantes(enc) { return diaIdx(tBR(enc)) - diaIdx(agoraBR()); }
function dataHora(s) {
  if (!s) return "—";
  const d = new Date(tBR(s));
  const dd = String(d.getUTCDate()).padStart(2, "0"), mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0"), mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}` + (s.length > 10 ? ` às ${hh}:${mi}` : "");
}
function textoFalta(dias) {
  if (dias <= 0) return "encerra hoje";
  if (dias === 1) return "encerra amanhã";
  return `faltam ${dias.toLocaleString("pt-BR")} dias`;
}
function classeFalta(dias) { return dias <= 2 ? "urg" : dias <= 7 ? "breve" : ""; }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- carga ----------
async function carregar() {
  el.lista.innerHTML = Array.from({ length: 8 }, () => '<li class="esqueleto"></li>').join("");
  try {
    const r = await fetch("data/index.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(r.status);
    base = await r.json();
  } catch (e) {
    el.lista.innerHTML = "";
    el.status.textContent = "Não foi possível carregar os dados. Recarregue a página em alguns instantes.";
    return;
  }
  linhas = base.linhas.map((l) => ({
    id: l[0], uf: l[1], municipio: l[2], orgao: l[3], objeto: l[4], mod: l[5], valor: l[6],
    enc: l[7], cat: l[8], srp: l[9], pub: l[10], esfera: l[11],
    busca: semAcento(`${l[4]} ${l[3]} ${l[2]} ${l[1]} ${UFS[l[1]] || ""}`),
  }));
  const gerado = new Date(base.gerado);
  el.status.innerHTML = `<b>${base.total.toLocaleString("pt-BR")}</b> licitações com propostas abertas · atualizado em ${gerado.toLocaleDateString("pt-BR")} às ${gerado.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;

  const contaUF = {};
  linhas.forEach((l) => (contaUF[l.uf] = (contaUF[l.uf] || 0) + 1));
  Object.keys(UFS).sort((a, b) => UFS[a].localeCompare(UFS[b])).forEach((uf) => {
    if (contaUF[uf]) el.uf.add(new Option(`${UFS[uf]} (${contaUF[uf].toLocaleString("pt-BR")})`, uf));
  });
  base.categorias.forEach((c, i) => el.cat.add(new Option(c, i)));
  base.modalidades.map((m, i) => [m, i]).sort((a, b) => a[0].localeCompare(b[0])).forEach(([m, i]) => el.mod.add(new Option(m, i)));

  restaurarFiltros();
  aplicar();
  abrirDoEndereco();
}

// ---------- filtros ----------
const CAMPOS = ["q", "uf", "cat", "mod", "prazo", "valor", "esfera", "ordem"];
function salvarFiltros() {
  try { localStorage.setItem("filtros", JSON.stringify(Object.fromEntries(CAMPOS.map((c) => [c, el[c].value])))); } catch (e) {}
}
function restaurarFiltros() {
  try {
    const f = JSON.parse(localStorage.getItem("filtros") || "{}");
    CAMPOS.forEach((c) => {
      if (f[c] == null) return;
      if (el[c].tagName === "SELECT" && ![...el[c].options].some((o) => o.value === f[c])) return;
      el[c].value = f[c];
    });
  } catch (e) {}
}

function aplicar() {
  const termos = semAcento(el.q.value.trim()).split(/\s+/).filter(Boolean);
  const uf = el.uf.value, cat = el.cat.value, mod = el.mod.value, esfera = el.esfera.value;
  const prazo = el.prazo.value, valor = el.valor.value;
  let vmin = null, vmax = null;
  if (valor && valor !== "sem") { const [a, b] = valor.split("-"); vmin = +a; vmax = b ? +b : Infinity; }
  const hoje = diaIdx(agoraBR());

  filtradas = linhas.filter((l) => {
    if (uf && l.uf !== uf) return false;
    if (cat !== "" && l.cat !== +cat) return false;
    if (mod !== "" && l.mod !== +mod) return false;
    if (esfera && l.esfera !== esfera) return false;
    if (valor === "sem" && l.valor != null) return false;
    if (vmin != null && (l.valor == null || l.valor < vmin || l.valor >= vmax)) return false;
    if (prazo) {
      const d = diaIdx(tBR(l.enc)) - hoje;
      if (prazo === "31+" ? d <= 30 : d > +prazo) return false;
    }
    for (const t of termos) if (!l.busca.includes(t)) return false;
    return true;
  });

  const o = el.ordem.value;
  if (o === "valor") filtradas.sort((a, b) => (b.valor ?? -1) - (a.valor ?? -1));
  else if (o === "recentes") filtradas.sort((a, b) => b.pub.localeCompare(a.pub) || a.enc.localeCompare(b.enc));
  else filtradas.sort((a, b) => a.enc.localeCompare(b.enc));

  ["uf", "cat", "mod", "prazo", "valor", "esfera"].forEach((c) => el[c].classList.toggle("ativo", el[c].value !== ""));
  const temFiltro = termos.length || ["uf", "cat", "mod", "prazo", "valor", "esfera"].some((c) => el[c].value !== "");
  el.limpar.hidden = !temFiltro;
  const soma = filtradas.reduce((s, l) => s + (l.valor || 0), 0);
  el.contagem.textContent = temFiltro
    ? `${filtradas.length.toLocaleString("pt-BR")} encontradas · ${brlCurto(soma)} em valor estimado`
    : `Mostrando todas · ${brlCurto(soma)} em valor estimado`;

  el.lista.innerHTML = "";
  mostrando = 0;
  maisItens();
  el.vazio.hidden = filtradas.length > 0;
  salvarFiltros();
}

function linhaHTML(l) {
  const d = new Date(tBR(l.enc));
  const dias = diasRestantes(l.enc);
  const modNome = base.modalidades[l.mod];
  return `<li class="item" tabindex="0" data-id="${esc(l.id)}">
    <div class="prazo">
      <div class="dia">${d.getUTCDate()} ${MESES[d.getUTCMonth()]}</div>
      <div class="mes">${d.getUTCFullYear()}</div>
      <span class="falta ${classeFalta(dias)}">${textoFalta(dias)}</span>
    </div>
    <div class="meio">
      <p class="objeto">${esc(l.objeto)}</p>
      <p class="orgao"><b>${esc(l.orgao)}</b> · ${esc(l.municipio)}/${esc(l.uf)}</p>
      <div class="tags"><span class="tag">${esc(modNome)}</span><span class="tag">${esc(base.categorias[l.cat])}</span>${l.srp ? '<span class="tag">Registro de preços</span>' : ""}</div>
    </div>
    <div class="valor">${l.valor != null ? `<div class="v">${brlCurto(l.valor)}</div><div class="vl">estimado</div>` : '<div class="nd">valor não divulgado</div>'}</div>
  </li>`;
}

function maisItens() {
  const fatia = filtradas.slice(mostrando, mostrando + POR_PAGINA);
  el.lista.insertAdjacentHTML("beforeend", fatia.map(linhaHTML).join(""));
  mostrando += fatia.length;
  el.mais.hidden = mostrando >= filtradas.length;
  el.mais.textContent = `Mostrar mais (${(filtradas.length - mostrando).toLocaleString("pt-BR")} restantes)`;
}

let espera;
el.q.addEventListener("input", () => { clearTimeout(espera); espera = setTimeout(aplicar, 180); });
["uf", "cat", "mod", "prazo", "valor", "esfera", "ordem"].forEach((c) => el[c].addEventListener("change", aplicar));
el.limpar.addEventListener("click", () => {
  el.q.value = ""; ["uf", "cat", "mod", "prazo", "valor", "esfera"].forEach((c) => (el[c].value = ""));
  aplicar();
});
el.mais.addEventListener("click", maisItens);
if ("IntersectionObserver" in window) {
  new IntersectionObserver((ents) => { if (ents[0].isIntersecting && !el.mais.hidden) maisItens(); }, { rootMargin: "600px" }).observe(el.mais);
}

// ---------- detalhes ----------
el.lista.addEventListener("click", (e) => { const li = e.target.closest(".item"); if (li) abrir(li.dataset.id); });
el.lista.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("item")) { e.preventDefault(); abrir(e.target.dataset.id); }
});
el.fechar.addEventListener("click", fechar);
el.fundo.addEventListener("click", fechar);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.painel.hidden) fechar(); });
window.addEventListener("hashchange", abrirDoEndereco);

function abrirDoEndereco() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && linhas.length && h !== el.painel.dataset.id) abrir(h, false);
  if (!h && !el.painel.hidden) fechar(false);
}

async function detalhesUF(uf) {
  if (!cacheUF[uf]) {
    cacheUF[uf] = fetch(`data/uf/${uf}.json`).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
    cacheUF[uf].catch(() => delete cacheUF[uf]);
  }
  return cacheUF[uf];
}

async function abrir(id, mudarEndereco = true) {
  const l = linhas.find((x) => x.id === id);
  if (!l) return;
  ultimoFoco = document.activeElement;
  el.painel.dataset.id = id;
  el.painel.hidden = false; el.fundo.hidden = false;
  document.body.style.overflow = "hidden";
  el.eyebrow.textContent = `${base.modalidades[l.mod]} · ${l.municipio}/${l.uf}`;
  el.corpo.innerHTML = `<h2 id="p-titulo">${esc(l.objeto)}</h2><p class="nota">Carregando detalhes…</p>`;
  el.fechar.focus();
  if (mudarEndereco) history.replaceState(null, "", "#" + encodeURIComponent(id));

  let d;
  try { d = (await detalhesUF(l.uf))[id]; } catch (e) { d = null; }
  if (el.painel.dataset.id !== id) return;
  if (!d) { el.corpo.innerHTML = `<h2 id="p-titulo">${esc(l.objeto)}</h2><p class="nota">Não foi possível carregar os detalhes agora. Tente de novo em instantes.</p>`; return; }
  el.corpo.innerHTML = painelHTML(l, d);
  carregarExtras(d, id);
}

function fechar(mudarEndereco = true) {
  el.painel.hidden = true; el.fundo.hidden = true;
  delete el.painel.dataset.id;
  document.body.style.overflow = "";
  if (mudarEndereco !== false) history.replaceState(null, "", location.pathname + location.search);
  if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
}

function linkPNCP(d) { return `https://pncp.gov.br/app/editais/${d.cnpj}/${d.ano}/${d.seq}`; }

function painelHTML(l, d) {
  const dias = diasRestantes(d.encerramento);
  const fatos = [
    ["Órgão", d.orgao + (d.unidade && d.unidade !== d.orgao ? ` (${d.unidade})` : "")],
    ["Local", `${d.municipio} / ${d.ufNome || d.uf}`],
    ["Esfera", ESFERAS[d.esfera] || "—"],
    ["Valor estimado", d.valor != null ? brl.format(d.valor) : "Não divulgado"],
    ["Modalidade", d.modalidade],
    ["Modo de disputa", d.disputa || "—"],
    ["Instrumento", d.instrumento || "—"],
    ["Registro de preços", d.srp ? "Sim" : "Não"],
    ["Recebimento de propostas", `${dataHora(d.abertura)} até ${dataHora(d.encerramento)}`],
    ["Publicado no PNCP", dataHora(d.publicacao)],
    ["Nº da compra / processo", `${d.numero || "—"} / ${d.processo || "—"}`],
    ["Plataforma da disputa", d.plataforma || "—"],
    ["CNPJ do órgão", formatarCNPJ(d.cnpj)],
    ["Código PNCP", l.id],
  ];
  if (d.amparo) fatos.push(["Base legal", d.amparo.nome]);

  const origem = d.linkEletronico || d.linkOrigem;
  return `
    <h2 id="p-titulo">${esc(d.objeto)}</h2>
    <div class="prazo-grande"><span class="falta ${classeFalta(dias)}">${textoFalta(dias)}</span><strong>Propostas até ${dataHora(d.encerramento)}</strong></div>
    <section class="resumo"><h3>Resumo</h3>${resumir(d).map((p) => `<p>${esc(p)}</p>`).join("")}</section>
    <div class="acoes">
      <a class="btn prim" href="${linkPNCP(d)}" target="_blank" rel="noopener">Ver edital e anexos no PNCP ↗</a>
      ${origem ? `<a class="btn" href="${esc(origem)}" target="_blank" rel="noopener">Abrir na plataforma da disputa ↗</a>` : ""}
    </div>
    <section id="p-arquivos" hidden><h3>Arquivos do edital</h3><ul class="arquivos"></ul></section>
    <section><h3>Dados da licitação</h3><dl class="fatos">${fatos.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>
    <section><h3>Objeto completo</h3><p class="texto">${esc(d.objeto)}</p></section>
    ${d.info && semAcento(d.info) !== semAcento(d.objeto) ? `<section><h3>Informações complementares</h3><p class="texto">${esc(d.info)}</p></section>` : ""}
    <section id="p-itens" hidden><h3>Itens</h3><ul class="arquivos"></ul></section>
    ${d.amparo ? `<section><h3>O que diz a base legal</h3><p class="texto">${esc(d.amparo.descricao)}</p></section>` : ""}
    <p class="nota">Situação no PNCP: ${esc(d.situacao || "—")} · última atualização do órgão em ${dataHora((d.atualizacao || "").slice(0, 16))}.</p>`;
}

function formatarCNPJ(c) {
  if (!c || c.length !== 14) return c || "—";
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

// arquivos e itens vêm direto da API do PNCP quando o navegador permite; se não, o botão do PNCP cobre
async function carregarExtras(d, id) {
  const raiz = `https://pncp.gov.br/pncp-api/v1/orgaos/${d.cnpj}/compras/${d.ano}/${d.seq}`;
  const pega = (u) => fetch(u, { signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [arqs, itens] = await Promise.all([pega(`${raiz}/arquivos`), pega(`${raiz}/itens?pagina=1&tamanhoPagina=30`)]);
  if (el.painel.dataset.id !== id) return;
  if (Array.isArray(arqs) && arqs.length) {
    const s = $("p-arquivos");
    s.querySelector("ul").innerHTML = arqs.map((a) =>
      `<li><a href="${esc(a.url || a.uri)}" target="_blank" rel="noopener">${esc(a.titulo || "Documento")} ↗</a> <small>${esc(a.tipoDocumentoNome || "")}</small></li>`).join("");
    s.hidden = false;
  }
  if (Array.isArray(itens) && itens.length) {
    const s = $("p-itens");
    s.querySelector("ul").innerHTML = itens.map((it) => {
      const q = it.quantidade != null ? `${Number(it.quantidade).toLocaleString("pt-BR")} ${it.unidadeMedida || ""}` : "";
      const v = it.valorTotal ? ` · ${brl.format(it.valorTotal)}` : "";
      return `<li><span>${esc(it.numeroItem)}. ${esc(it.descricao)}</span> <small>${esc(q)}${v}</small></li>`;
    }).join("") + (itens.length >= 30 ? '<li><small>Lista completa no PNCP.</small></li>' : "");
    s.hidden = false;
  }
}

// ---------- resumo automático ----------
const EXPLICA = {
  "Pregão - Eletrônico": "No pregão eletrônico, as empresas enviam propostas pela internet e depois disputam com lances; vence o menor preço (ou maior desconto) que atender ao edital.",
  "Pregão - Presencial": "No pregão presencial, a disputa de lances acontece em sessão pública no órgão; vence o menor preço que atender ao edital.",
  "Concorrência - Eletrônica": "A concorrência é usada para contratações maiores, como obras e serviços de engenharia; a disputa é feita pela internet.",
  "Concorrência - Presencial": "A concorrência é usada para contratações maiores, como obras e serviços de engenharia; a sessão é presencial.",
  "Dispensa": "Na dispensa, o órgão pode contratar diretamente, sem licitação completa. Costuma ter valor menor e prazo curto para enviar proposta.",
  "Dispensa de Licitação": "Na dispensa, o órgão pode contratar diretamente, sem licitação completa. Costuma ter valor menor e prazo curto para enviar proposta.",
  "Credenciamento": "No credenciamento não há disputa de preço: todos os interessados que cumprirem os requisitos podem ser cadastrados e contratados.",
  "Inexigibilidade": "Inexigibilidade é contratação direta quando não há competição possível (fornecedor exclusivo, por exemplo).",
  "Leilão - Eletrônico": "No leilão, o órgão está vendendo bens; vence quem oferecer o maior lance.",
  "Leilão - Presencial": "No leilão, o órgão está vendendo bens; vence quem oferecer o maior lance.",
  "Concurso": "No concurso, escolhe-se um trabalho técnico, científico ou artístico, com prêmio ou remuneração ao vencedor.",
  "Diálogo Competitivo": "No diálogo competitivo, o órgão conversa com empresas pré-selecionadas para chegar a uma solução antes da proposta final.",
  "Pré-qualificação": "A pré-qualificação seleciona antes quem poderá participar de licitações futuras.",
  "Manifestação de Interesse": "Na manifestação de interesse, o órgão recebe estudos ou projetos de interessados antes de abrir uma licitação.",
};

function resumir(d) {
  let obj = d.objeto.replace(/\s+/g, " ").trim();
  const n = semAcento(obj);
  let verbo = "abriu processo para";
  const regras = [
    [/^(registro de precos?|ata de registro de precos?|srp)\b/, "vai registrar preços para"],
    [/^(credenciamento|chamamento publico|chamamento)\b/, "está credenciando interessados para"],
    [/^(aquisicao|aquisicoes|compra|fornecimento)\b/, "quer comprar"],
    [/^(locacao|aluguel)\b/, "quer alugar"],
    [/^(alienacao|venda|leilao)\b/, "está vendendo"],
    [/^(contratacao|prestacao de servicos?|servicos?)\b/, "quer contratar"],
    [/^(execucao|construcao|reforma|pavimentacao|obra)\b/, "quer contratar a obra de"],
  ];
  const regra = regras.find(([re]) => re.test(n));
  if (regra) verbo = regra[1];

  // remove a expressão de abertura e enxuga o miolo
  let miolo = obj
    .replace(/^(registro de pre[çc]os?|ata de registro de pre[çc]os?|srp)\s*(para|visando|objetivando)?\s*(a|o|eventual|futura|futuras|eventuais)?\s*(e\s+)?(eventual|futura|futuras|eventuais)?\s*/i, "")
    .replace(/^(credenciamento|chamamento p[úu]blico|chamamento)\s*(de|para)?\s*/i, "")
    .replace(/^(aquisi[çc][ãa]o|aquisi[çc][õo]es|compra|fornecimento)\s*(de|do|da|dos|das)?\s*/i, "")
    .replace(/^(loca[çc][ãa]o|aluguel)\s*(de|do|da)?\s*/i, "")
    .replace(/^(contrata[çc][ãa]o|presta[çc][ãa]o de servi[çc]os?)\s*(de|do|da|dos|das)?\s*/i, "")
    .replace(/^(aquisi[çc][ãa]o|contrata[çc][ãa]o)\s*(de|do|da)?\s*/i, "")
    .replace(/^(pessoa[s]? (f[íi]sicas?|jur[íi]dicas?)( e\/?o?u? (f[íi]sicas?|jur[íi]dicas?))?|empresas?)( especializadas?)?( do ramo)?\s*(para|em|na|no|de)?\s*(a\s+)?(presta[çc][ãa]o de servi[çc]os?\s*(de|em)?\s*)?/i, "");
  const corte = miolo.search(/\s*(,?\s*(visando|objetivando|a fim de|para atender|para atendimento|conforme|de acordo com|nos termos|em atendimento|destinad[oa]s? a atender|atrav[ée]s d|por meio d)|;|\.\s)/i);
  if (corte > 25) miolo = miolo.slice(0, corte);
  if (miolo.length > 170) miolo = miolo.slice(0, 170).replace(/\s+\S*$/, "") + "…";
  miolo = miolo.replace(/[,;:.\s]+$/, "");
  if (miolo && miolo === miolo.toUpperCase()) miolo = miolo.toLowerCase();
  else if (miolo) miolo = miolo.charAt(0).toLowerCase() + miolo.slice(1);

  const quem = `${d.orgao} (${d.municipio}/${d.uf})`;
  const p = [];
  p.push(`${quem} ${verbo} ${miolo || "o objeto descrito no edital"}.`);

  const dias = diasRestantes(d.encerramento);
  const valor = d.valor != null ? `O valor estimado é de ${brl.format(d.valor)}` : "O órgão não divulgou o valor estimado";
  p.push(`${valor}, e as propostas podem ser enviadas até ${dataHora(d.encerramento)} (${textoFalta(dias)}).`);

  const chave = (s) => semAcento(s || "").replace(/[^a-z]/g, "");
  const ex = Object.entries(EXPLICA).find(([k]) => chave(k) === chave(d.modalidade))?.[1];
  if (ex) p.push(ex);
  if (d.srp) p.push("Por ser registro de preços, o órgão fixa preços por um período e compra conforme a necessidade, sem obrigação de adquirir toda a quantidade.");
  if (d.plataforma && semAcento(d.plataforma) !== semAcento(d.orgao)) p.push(`A disputa é conduzida pela plataforma ${d.plataforma}; é preciso estar cadastrado nela para participar.`);
  return p;
}

carregar();
