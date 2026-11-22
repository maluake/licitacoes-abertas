// Testes das regras de tratamento (funções puras, sem rede).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  limpar, titulo, categoria, nomesCategorias, curto, facilidade, nivelFacil, mudancas, fmtData, fmtValor, ultimaAlteracao,
} from "../scripts/lib/regras.mjs";

const cat = (texto) => nomesCategorias[categoria(texto)];
const motivos = (r) => facilidade(r).motivos.map(([, t]) => t).join(" | ");

test("limpar: tira prefixos e converte texto todo em maiúsculas preservando siglas", () => {
  assert.equal(limpar("[Portal de Compras Públicas] - Objeto: compra de cadeiras"), "compra de cadeiras");
  assert.equal(
    limpar("AQUISIÇÃO DE MEDICAMENTOS PARA A UBS E RECAPEAMENTO DA RODOVIA SP-055"),
    "Aquisição de medicamentos para a UBS e recapeamento da rodovia SP-055",
  );
  assert.equal(limpar(null), "");
});

test("titulo: nomes em maiúsculas viram título, outros ficam como estão", () => {
  assert.equal(titulo("PREFEITURA MUNICIPAL DE CIDADE EXEMPLO"), "Prefeitura Municipal de Cidade Exemplo");
  assert.equal(titulo("Câmara Municipal"), "Câmara Municipal");
});

test("categoria: classifica pelo texto do objeto", () => {
  assert.equal(cat("Aquisição de notebooks e impressoras"), "Tecnologia");
  assert.equal(cat("Pavimentação asfáltica"), "Obras e engenharia");
  assert.equal(cat("Gêneros alimentícios para merenda"), "Alimentação");
  assert.equal(cat("Algo sem palavra-chave conhecida"), "Outros");
});

test("curto: corta no último espaço e acrescenta reticências", () => {
  assert.equal(curto("texto curto", 50), "texto curto");
  assert.equal(curto("aquisição de material de expediente diverso", 30), "aquisição de material de…");
});

test("facilidade: dispensa de serviço gráfico de baixo valor é acessível", () => {
  const r = { objetoCompra: "Confecção de banners e faixas", modalidadeNome: "Dispensa", valorTotalEstimado: 9000 };
  const { nota } = facilidade(r);
  assert.ok(nota >= 65, `nota ${nota}`);
  assert.equal(nivelFacil(nota), "Acessível");
  assert.match(motivos(r), /Serviço gráfico/);
});

test("facilidade: atividade que exige licença nunca passa de 'Exige estrutura'", () => {
  const r = { objetoCompra: "Recarga de extintores e combate a incêndio", modalidadeNome: "Dispensa", valorTotalEstimado: 5000 };
  const { nota } = facilidade(r);
  assert.ok(nota <= 35, `nota ${nota}`);
  assert.equal(nivelFacil(nota), "Exige estrutura");
  assert.match(motivos(r), /Corpo de Bombeiros/);
});

test("facilidade: credenciamento pesa contra e fica no máximo em 'Moderada'", () => {
  const r = { objetoCompra: "Credenciamento para fornecimento de material de expediente", modalidadeNome: "Credenciamento", valorTotalEstimado: 10000 };
  const { nota } = facilidade(r);
  assert.ok(nota <= 45, `nota ${nota}`);
  assert.match(motivos(r), /^Credenciamento/);
});

test("facilidade: valor muito alto e concorrência derrubam a nota; motivos contra vêm primeiro", () => {
  const r = { objetoCompra: "Aquisição de cadeiras", modalidadeNome: "Concorrência", valorTotalEstimado: 20_000_000 };
  const f = facilidade(r);
  assert.ok(f.nota < 40, `nota ${f.nota}`);
  const tipos = f.motivos.map(([t]) => t);
  assert.equal(tipos[0], "ruim");
  assert.ok(tipos.indexOf("bom") === -1 || tipos.lastIndexOf("ruim") < tipos.indexOf("bom"));
});

test("facilidade: nota sempre entre 0 e 100", () => {
  for (const valor of [null, 1, 50_000, 1e9]) {
    for (const modalidadeNome of ["Dispensa", "Inexigibilidade", "Pregão - Eletrônico", "Leilão"]) {
      const { nota } = facilidade({ objetoCompra: "Obra de engenharia", modalidadeNome, valorTotalEstimado: valor });
      assert.ok(nota >= 0 && nota <= 100);
    }
  }
});

test("mudancas: detecta prazo, valor, situação e link", () => {
  const antes = {
    dataEncerramentoProposta: "2099-02-10T17:00:00", valorTotalEstimado: 100, objetoCompra: "x",
    modalidadeNome: "Pregão", situacaoCompraNome: "Divulgada", linkSistemaOrigem: "https://a.invalid",
  };
  const depois = { ...antes, dataEncerramentoProposta: "2099-02-20T17:00:00", valorTotalEstimado: 150,
    situacaoCompraNome: "Suspensa", linkSistemaOrigem: "https://b.invalid" };
  const tipos = mudancas(antes, depois).map(([k]) => k);
  assert.deepEqual(tipos, ["prazo", "valor", "situacao", "link"]);
  assert.deepEqual(mudancas(antes, { ...antes }), []);
});

test("mudancas: texto do objeto só conta se mudar além de acento, caixa e espaços", () => {
  const a = { objetoCompra: "Aquisição  de CADEIRAS" };
  assert.deepEqual(mudancas(a, { objetoCompra: "aquisicao de cadeiras" }), []);
  assert.equal(mudancas(a, { objetoCompra: "Aquisição de mesas" })[0][0], "texto");
});

test("formatação de data, valor e última alteração", () => {
  assert.equal(fmtData("2099-02-10T17:00:00"), "10/02/2099 às 17:00");
  assert.equal(fmtData("2099-02-10"), "10/02/2099");
  assert.equal(fmtData(null), "—");
  assert.equal(fmtValor(null), "não divulgado");
  assert.match(fmtValor(1500.5), /1\.500,50/);
  assert.equal(ultimaAlteracao([{ d: "2099-01-01", k: "nova" }, { d: "2099-01-03", k: "valor" }, { d: "2099-01-02", k: "prazo" }]), "2099-01-03|valor");
  assert.equal(ultimaAlteracao([]), "");
});
