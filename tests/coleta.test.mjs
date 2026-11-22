// Roda o coletor de ponta a ponta com dados fictícios (FIXTURE), sem acessar o PNCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const coletor = path.join(raiz, "scripts/coletar.mjs");
const fixture = (nome) => path.join(raiz, "tests/fixtures", nome);

function coletar(env) {
  const dir = mkdtempSync(path.join(tmpdir(), "licitacoes-"));
  execFileSync(process.execPath, [coletor], {
    cwd: dir, stdio: "pipe",
    env: { ...process.env, UFS: "SP,RJ,MG,ES", SITE_URL: "", ANTERIOR_DIR: "", ...env },
  });
  const dados = path.join(dir, "site/data");
  const ler = (f) => JSON.parse(readFileSync(path.join(dados, f), "utf8"));
  return { dir, dados, ler };
}

test("primeira coleta: filtra, ordena e gera os arquivos do site", (t) => {
  const c = coletar({ FIXTURE: fixture("pncp-amostra.json") });
  t.after(() => rmSync(c.dir, { recursive: true, force: true }));

  const index = c.ler("index.json");
  // 8 registros: 1 fora do Sudeste, 1 com prazo encerrado e 1 duplicado ficam de fora
  assert.equal(index.total, 5);
  const ids = index.linhas.map((l) => l[0]);
  assert.equal(new Set(ids).size, ids.length, "sem duplicados");
  assert.ok(index.linhas.every((l) => ["SP", "RJ", "MG", "ES"].includes(l[1])));
  // ordenadas pelo prazo de encerramento
  const prazos = index.linhas.map((l) => l[index.colunas.indexOf("encerramento")]);
  assert.deepEqual(prazos, [...prazos].sort());

  assert.deepEqual(readdirSync(path.join(c.dados, "uf")).sort(), ["ES.json", "MG.json", "RJ.json", "SP.json"]);
  const sp = c.ler("uf/SP.json");
  const det = sp["00000000000001-1-000001/2099"];
  assert.equal(det.orgao, "Prefeitura Municipal de Cidade Exemplo");
  assert.ok(["Acessível", "Moderada", "Exige estrutura"].includes(det.facil.nivel));

  const meta = c.ler("meta.json");
  assert.equal(meta.total, 5);
  assert.equal(meta.brutos, 8);
  assert.equal(meta.parcial, false);

  const cache = JSON.parse(gunzipSync(readFileSync(path.join(c.dados, "cache.json.gz"))).toString("utf8"));
  assert.equal(cache.length, 5);
});

test("segunda coleta: marca licitações novas e alteradas comparando com a anterior", (t) => {
  const dia1 = coletar({ FIXTURE: fixture("pncp-amostra.json") });
  const dia2 = coletar({ FIXTURE: fixture("pncp-amostra-dia2.json"), ANTERIOR_DIR: dia1.dados });
  t.after(() => [dia1, dia2].forEach((c) => rmSync(c.dir, { recursive: true, force: true })));

  const meta = dia2.ler("meta.json");
  assert.equal(meta.novas, 1);
  assert.equal(meta.alteradas, 2);

  const hist = dia2.ler("historico.json");
  assert.equal(hist["00000000000008-1-000008/2099"][0].k, "nova");
  assert.match(hist["00000000000001-1-000001/2099"][0].t, /Prazo das propostas mudou de 10\/02\/2099 às 17:00 para 20\/02\/2099 às 17:00/);
  assert.match(hist["00000000000002-1-000002/2099"][0].t, /Valor estimado mudou/);
});
