// Regras de tratamento das licitações: limpeza de texto, categorias, nota de
// facilidade e detecção de alterações. Funções puras (sem rede nem arquivos),
// separadas do coletor para poderem ser testadas (tests/regras.test.mjs).

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
// "AAAA-MM-DD|tipo" da alteração mais recente (tipo: prazo, valor, texto, situacao, link, edital)
const ultimaAlteracao = (h) => {
  const e = (h || []).filter((x) => x.k !== "nova").sort((a, b) => a.d.localeCompare(b.d)).pop();
  return e ? `${e.d}|${e.k}` : "";
};
const nivelFacil = (n) => (n >= 65 ? "Acessível" : n >= 40 ? "Moderada" : "Exige estrutura");

// ---------- novas e alteradas ----------
const brlNode = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fmtData = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}${s.length > 10 ? " às " + s.slice(11, 16) : ""}` : "—");
const fmtValor = (v) => (typeof v === "number" && v > 1 ? brlNode.format(v) : "não divulgado");
const normal = (t) => semAcento(String(t || "")).replace(/\s+/g, " ").trim();
function mudancas(p, r) {
  const m = [];
  if ((p.dataEncerramentoProposta || "").slice(0, 16) !== (r.dataEncerramentoProposta || "").slice(0, 16))
    m.push(["prazo", `Prazo das propostas mudou de ${fmtData(p.dataEncerramentoProposta)} para ${fmtData(r.dataEncerramentoProposta)}`]);
  if ((p.dataAberturaProposta || "").slice(0, 16) !== (r.dataAberturaProposta || "").slice(0, 16))
    m.push(["prazo", `Início do envio de propostas mudou de ${fmtData(p.dataAberturaProposta)} para ${fmtData(r.dataAberturaProposta)}`]);
  if (Math.round((p.valorTotalEstimado || 0) * 100) !== Math.round((r.valorTotalEstimado || 0) * 100))
    m.push(["valor", `Valor estimado mudou de ${fmtValor(p.valorTotalEstimado)} para ${fmtValor(r.valorTotalEstimado)}`]);
  if (normal(p.objetoCompra) !== normal(r.objetoCompra)) m.push(["texto", "O texto do objeto foi alterado"]);
  if (p.modalidadeNome !== r.modalidadeNome) m.push(["texto", `Modalidade mudou de ${p.modalidadeNome} para ${r.modalidadeNome}`]);
  if (p.situacaoCompraNome !== r.situacaoCompraNome) m.push(["situacao", `Situação mudou para "${r.situacaoCompraNome}"`]);
  if ((p.linkSistemaOrigem || "") !== (r.linkSistemaOrigem || "") && r.linkSistemaOrigem) m.push(["link", "O link da plataforma de disputa foi alterado"]);
  if (!m.length && (p.dataAtualizacaoGlobal || "") !== (r.dataAtualizacaoGlobal || "") && r.dataAtualizacaoGlobal)
    m.push(["edital", "O órgão atualizou a publicação (novo arquivo, edital retificado, esclarecimento ou itens)"]);
  return m;
}

export {
  limpar, titulo, semAcento, CATEGORIAS, nomesCategorias, categoria, curto,
  EXIGE, ACESSIVEL, facilidade, ultimaAlteracao, nivelFacil, fmtData, fmtValor, normal, mudancas,
};
