# Como funciona

Detalhes da coleta, do tratamento e da publicação dos dados.

## 1. Coleta (`scripts/coletar.mjs`)

A fonte é a API pública de consultas do PNCP, no endpoint [`/v1/contratacoes/proposta`](https://pncp.gov.br/api/consulta/swagger-ui/index.html), que lista contratações com recebimento de propostas em aberto. A API não exige chave.

A API oscila com consultas grandes, por isso a coleta é dividida em partes menores:

1. **Total esperado por estado:** uma consulta por UF só para saber quantos registros existem.
2. **Partições estado × modalidade:** a primeira página de cada combinação (4 estados × 13 modalidades). Dividir assim deixa cada lista curta. As páginas "fundas" são as que mais falham.
3. **Demais páginas em fila:** 4 requisições simultâneas, até 50 itens por página e tempo limite de 45 s por requisição.
4. **Novas tentativas:** cada requisição tenta de novo com espera crescente. As páginas que falharem voltam em até 5 rodadas extras, com pausas maiores.
5. **Limites de segurança:**
   - a coleta para de pedir páginas novas depois de `TEMPO_MAX_MIN` minutos (padrão 50);
   - se chegar menos da metade das páginas, o script **aborta** para não publicar dados muito incompletos;
   - se a coleta ficar parcial, reaproveita da coleta anterior (publicada no próprio site) as licitações que continuam abertas.

## 2. Tratamento (`scripts/lib/regras.mjs`)

| Etapa | O que faz |
|---|---|
| Filtro | Descarta duplicados, licitações fora dos estados escolhidos e com prazo já encerrado (considerando o dia em Brasília) |
| Limpeza de texto | Tira prefixos como "[Portal de Compras Públicas] -", converte textos TODO EM MAIÚSCULAS para frases normais preservando siglas (UBS, SUS, EPI…) e padroniza nomes de órgãos |
| Categoria | Classifica pelo texto do objeto em áreas como Tecnologia, Saúde, Obras, Alimentação, Eventos… |
| Nota de facilidade | Estimativa de 0 a 100 (ver abaixo) |
| Novas e alteradas | Compara com a coleta anterior e registra mudanças de prazo, valor, texto, modalidade, situação, link e edital; o histórico guarda 60 dias |

### Nota de facilidade

É uma **heurística por palavras-chave**, pensada para ajudar pequenas empresas a filtrar o que vale a pena ler. **Não é uma análise jurídica:** as exigências reais estão sempre no edital.

- Começa em 50.
- **Pesa contra:** atividades que costumam exigir licença, registro em conselho ou estrutura própria (prevenção de incêndio, gás, saúde, obras, mão de obra dedicada, vigilância…), além de credenciamento, concorrência, inexigibilidade e valores altos.
- **Pesa a favor:** compra de produtos comuns (material de expediente, serviço gráfico, instrumentos, ferramentas, móveis…), dispensa, valores até R$ 80 mil e registro de preços.
- **Tetos:** atividades que exigem licença nunca passam de 35 ("Exige estrutura"), e credenciamento nunca passa de 45 ("Moderada").
- Faixas: **Acessível** a partir de 65, **Moderada** de 40 a 64, **Exige estrutura** abaixo de 40.
- Cada nota mostra os motivos: primeiro os que pesam contra, depois os a favor.

## 3. Arquivos gerados (`site/data/`, não versionados)

| Arquivo | Conteúdo |
|---|---|
| `index.json` | Lista compacta (uma linha por licitação), carregada ao abrir o site |
| `uf/XX.json` | Detalhes completos por estado, carregados só ao abrir uma licitação |
| `meta.json` | Data da coleta, totais por estado, erros e duração |
| `historico.json` | Alterações dos últimos 60 dias |
| `cache.json.gz` | Coleta bruta, usada pela próxima execução para detectar mudanças e cobrir falhas |

## 4. Publicação (`.github/workflows/atualizar.yml`)

O GitHub Actions roda o coletor **todo dia às 06:17 (Brasília)**, a cada push na `main` e quando alguém clica em *Run workflow*. Em seguida, publica a pasta `site/` no GitHub Pages. Não há servidor nem banco: o site é estático e lê os JSON gerados.

## 5. Site (`site/`)

HTML, CSS e JavaScript sem dependências. Os favoritos ("Minhas disputas") ficam no `localStorage` do navegador. A planilha usa a biblioteca SheetJS, carregada só no clique; se ela não carregar, o site gera um CSV, que também abre no Excel.

## Variáveis de ambiente do coletor

Nenhuma é secreta.

| Variável | Padrão | Uso |
|---|---|---|
| `UFS` | `SP,RJ,MG,ES` | Estados coletados |
| `TEMPO_MAX_MIN` | `50` | Tempo máximo pedindo páginas novas |
| `SITE_URL` | (vazio) | Endereço do site publicado, de onde vem a coleta anterior |
| `FIXTURE` | (vazio) | Usa um arquivo JSON local no lugar da API (testes) |
| `ANTERIOR_DIR` | (vazio) | Pasta local com a coleta anterior (testes) |
