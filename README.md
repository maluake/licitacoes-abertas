# Licitações Abertas

Site com todas as licitações do Brasil que estão com recebimento de propostas em aberto, a partir da API oficial do
[PNCP — Portal Nacional de Contratações Públicas](https://pncp.gov.br/api/consulta/swagger-ui/index.html).

- Lista todas as licitações abertas, do país inteiro, com busca e filtros (estado, área, modalidade, prazo, valor, esfera).
- Ao clicar, mostra os detalhes, um resumo em linguagem simples e o link para o edital e anexos no PNCP.
- Atualiza sozinho todos os dias às 06:17 (horário de Brasília) pelo GitHub Actions e publica no GitHub Pages.

## Como funciona

| Parte | Arquivo |
|---|---|
| Coleta diária no PNCP (`/v1/contratacoes/proposta`) | `scripts/coletar.mjs` |
| Agendamento e publicação | `.github/workflows/atualizar.yml` |
| Site (HTML/CSS/JS, sem dependências) | `site/` |

## Colocar no ar (uma vez)

1. Crie um repositório no GitHub e envie estes arquivos.
2. Em **Settings → Pages**, em *Source*, escolha **GitHub Actions**.
3. Em **Actions → Atualizar licitações**, clique em **Run workflow** para a primeira carga (leva alguns minutos).
4. O endereço do site aparece em **Settings → Pages** (algo como `https://SEU-USUARIO.github.io/licitacoes-abertas/`).

Depois disso, ele se atualiza sozinho todo dia. Para forçar uma atualização, use **Run workflow** de novo.

## Rodar localmente

```bash
node scripts/coletar.mjs          # baixa os dados (Node 20+)
cd site && python3 -m http.server # abre em http://localhost:8000
```
