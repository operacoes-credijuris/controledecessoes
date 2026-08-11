# Handoff — Controle de Cessões Credijuris

> **Revisado em 2026-08-11** por auditoria do código. A versão anterior deste arquivo era de
> 2026-05-21 e estava ~3 meses e ~200 commits atrás da realidade: descrevia como "pendente"
> coisas já entregues e não mencionava dois módulos inteiros que entraram depois.
>
> **Ainda não deployado nesta data:** a branch `fix/contratos-precatorio` (leitura do quadro
> da análise, precatório separado de RPV, escolha manual dos contratos, campos do investidor).
> Ver [O que falta deployar](#o-que-falta-deployar).

---

## O que o sistema é hoje

Site estático em GitHub Pages (`index.html` 1.4k linhas + `assets/css/app.css` 2.7k +
`assets/js/app.js` 7.2k) com backend em Supabase Edge Functions (Deno/TypeScript). Sem build
step — deploy do front é `git push`, deploy de função é colar no Studio.

**Módulos:**

| Módulo | Onde | Estado |
|---|---|---|
| Visão Geral (dashboard, prazos fatais, publicações DJEN, resumo IA de movimentações) | `pane-dashboard` | produção |
| Acompanhamento Processual (cessões, RPV, requerimentos, encerrados) | `pane-acompanhamento` | produção |
| Telefones e Contatos | `pane-contatos` | produção |
| Carteiras / Investidores (CRUD pela interface) | `pane-carteiras` | produção |
| **Análise de Crédito** (Portão 1, due diligence, precificação) | `pane-credito` | produção — **não estava no handoff antigo** |
| **Gerar Contratos** | `pane-contratos` | produção |
| **Gerar Petição** (8 modelos + fluxo IA) | modal em Urgências → Fatais | produção |

**Edge Functions chamadas pelo front — 7, das quais só 3 têm código no repo:**

| Função | Fonte no repo? | Chamada em |
|---|---|---|
| `gerar-contrato` | ✅ `supabase/functions/gerar-contrato/index.ts` (1904 linhas) | `app.js` |
| `gerar-peticao` | ✅ `supabase/functions/gerar-peticao/index.ts` (1027 linhas) | 2 pontos |
| `resumir-movimentacoes` | ✅ (271 linhas) | 2 pontos |
| `advbox-proxy` | ✅ (141 linhas, via URL `functions/v1/`) | 3 pontos |
| `gerar-analise-rpv` | ❌ **nenhuma versão, em nenhuma branch** | `app.js:6735,6940,7062` |
| `buscar-judit` | ❌ **idem** | `app.js` |
| `dd-credor` | ❌ **idem** | `app.js` |
| `resolver-pasta` | ❌ **idem** | `app.js` |

**Buckets exigidos pelo código:** `contratos-templates`, `contratos-input`,
`peticoes-templates`, `peticoes-input-ia` (+ o que `gerar-analise-rpv` usar, desconhecido).

**Tabelas referenciadas:** `configuracoes`, `investidores`, `contratos_jobs`,
`contatos_auxiliares`. **Migrations no repo cobrem só as 3 primeiras.**

---

## Pendências

Em ordem de risco, não de esforço.

### 1. 🔴 Quatro Edge Functions existem só deployadas — sem código-fonte em lugar nenhum

`gerar-analise-rpv`, `buscar-judit`, `dd-credor` e `resolver-pasta` são invocadas pelo
`app.js` e sustentam o módulo Análise de Crédito inteiro. Rodei `git log --all` e
`git rev-list --all --objects`: **nunca foram comitadas em nenhuma branch**. O único lugar
onde esse código existe é dentro do projeto Supabase.

Consequência: um deploy errado, um rollback do Studio ou a perda do projeto apaga o módulo
sem backup. Também não dá para revisar, versionar ou reproduzir localmente.

**Como resolver:** Studio → Edge Functions → cada uma → Code → copiar → salvar em
`supabase/functions/<nome>/index.ts` → commitar. É a pendência mais barata de resolver e a
mais cara de ignorar.

### 2. ✅ Branch `feat/templates-layout-novo` — mergeada em 2026-08-11 (`84ac498`)

Estava pronta desde 2026-08-06 e **já rodando em produção**, sem nunca ter sido mergeada: a
`main` é que estava atrás. Conferido comparando o código colado do Studio com o da branch —
**hash idêntico** (1730 linhas). Os 4 passos do deploy dela (migration `0003`, redeploy, build dos
templates, upload no bucket) já tinham rodado: os `.docx` baixados do bucket trazem
`JUIZO_TRIBUNAL`, `CLASSE_ATIVO`, `CAPITAL_INVESTIDO` e `I_LO`, que só existem nos templates
gerados por aquele `_build_template.py`.

### 3. 🟡 `contatos_auxiliares` sem migration

A tabela é lida e escrita em 3 pontos do `app.js`, mas não existe em
`supabase/migrations/`. Quem recriar o banco do zero pelas migrations quebra a aba
Telefones e Contatos. Extrair o DDL do Studio e adicionar como `0004_*.sql`.

### 4. 🟡 `STORAGE_SETUP.md` desatualizado — descreve um estado que não existe mais

Diz "2 buckets" e lista 4 templates, incluindo `cessao_honorarios.docx`, que foi
substituído pelas duas variantes (contratuais/sucumbenciais) em maio. Não menciona
`peticoes-templates` nem `peticoes-input-ia`. Quem seguir esse doc para montar um ambiente
novo monta errado.

### 5. 🟡 Secrets vazados em maio, rotação nunca confirmada

Em 2026-05, durante debug, o conteúdo de `configuracoes.sql` (4 secrets reais) foi colado
no chat. A rotação foi anotada como pendente e **não há evidência de que tenha acontecido**:

1. `anthropic_api_key` → https://console.anthropic.com/settings/keys
2. `google_oauth_client_secret` → console.cloud.google.com
3. `google_oauth_refresh_token` → regerar via `python credijuris-contratos/main.py`
4. Atualizar `configuracoes.sql` local e re-executar o seed

Se já foi rotacionado, **marque isso aqui** para não ficar aparecendo como pendência a cada
revisão. Se não foi: são 3 meses de exposição.

### 6. 🟢 Modelos novos dos 3 templates de cessão

`cessao_credito`, `cessao_honorarios_contratuais` e `cessao_honorarios_sucumbenciais`
seguem no layout antigo. Cada operação hoje gera 2 documentos no visual novo e 3 no antigo.
Bloqueado no jurídico.

### 7. 🟢 `qualificacao_complemento` dos investidores já cadastrados

Coluna criada pela migration `0003`. O campo passou a existir no modal de investidor em
2026-08-11, então dá para preencher pela interface — mas os investidores cadastrados antes
seguem com `null`, e a qualificação deles sai sem estado civil nem profissão.

### 8. 🟢 Limpeza de repo

- `origin/contratos-teste` — 1 commit à frente da `main`, mas o conteúdo (portão de crédito
  reprovado em `_acShowOk`) **já está na `main`**. Branch morta, pode deletar.
- `ai_livre.docx` e `_modelo_original_ai_livre.docx` seguem no repo, mas `ai_livre` foi
  removido de `TEMPLATES` em `b2680ea` ("simplifica — Sonnet + remove ai_livre"). Órfãos.
- 14 branches remotas, a maioria já mergeada. Podar as mergeadas reduz ruído.
- ~~`__pycache__` versionado~~ — resolvido em `30e8974`.

### 9. 🟢 Refinamentos que continuam abertos

- RLS de Storage segue permissivo (qualquer `authenticated`, sem checagem de path) — foi
  decisão consciente de MVP, ver [Armadilhas](#armadilhas-conhecidas) #4
- `gerar-contrato` usa `claude-opus-4-5`; `gerar-peticao` usa `claude-sonnet-4-5`. Avaliar
  atualizar os dois para a geração atual de modelos
- Painel de sucesso mostra 1 link (contratos); o payload já devolve `analise_folder_url`

---

## O que falta deployar

A branch **`fix/contratos-precatorio`** (commits `d9337bc` e `2118b6b`) está pronta e testada
localmente, **não deployada**. Ordem:

```
1. git push + merge na main   → GitHub Pages publica o front (hard reload: Ctrl+Shift+R)
2. Studio → Edge Functions → gerar-contrato → colar index.ts → Deploy → conferir Logs
```

Os dois lados são independentes: o front antigo continua funcionando com a função nova (não
manda `tipos`, então cai no automático), e o front novo com a função antiga mandaria `tipos`
para quem os ignora — ou seja, **deploy a função primeiro** se for fazer um de cada vez.

Nada de bucket, nada de migration: nenhum template mudou e nenhuma coluna foi criada.

### Testes locais (rodam sem Supabase)

```cmd
node supabase/functions/gerar-contrato/_tests/test-tipos.mjs
node supabase/functions/gerar-contrato/_tests/test-quadro.mjs
```

O segundo precisa de um `.xlsx` do modelo da análise; sem ele, avisa e sai. Ver
`supabase/functions/gerar-contrato/_tests/README.md`.

### E2E depois do deploy

| Caso | Esperado |
|---|---|
| RPV, análise com "Apenas o crédito principal", sem doc de escritório | cessão de crédito + intermediação + procuração. **Não pede escritório** |
| RPV, análise com "Crédito principal e honorários" | 5 documentos; pede doc do escritório |
| Precatório, automático | 2 documentos: intermediação + procuração. Nunca cessão |
| Manual, só procuração marcada | 1 documento, sem intermediação |
| Precatório com intermediador que só existe em `A. Análises` | pasta criada em `B. Processos`, aviso no painel de sucesso |
| Análise em pasta com nome do escritório (caso Klemm) | localiza pelo nº do processo na subpasta |
| Investidor novo com sexo + "solteiro, engenheiro civil" | qualificação sai completa no contrato |

---

## Checklist do Studio (só dá pra conferir logado)

Project ref: `uekoindsadcthbdkkbjt`

- [x] `contratos-templates` tem os 5 `.docx` de `TEMPLATES` — conferido em 2026-08-11 pelos
      arquivos baixados do bucket. **Se qualquer um faltar, toda requisição falha**: o passo 8
      carrega os 5 incondicionalmente, antes de saber quais serão usados
- [x] Migrations `0001`, `0002` e `0003` aplicadas (a função em produção lê
      `qualificacao_complemento` sem erro)
- [ ] `peticoes-templates` contém os 8 `.docx` de `gerar-peticao/index.ts:24`
- [ ] `peticoes-input-ia` existe
- [ ] `configuracoes` tem as 4 chaves: `anthropic_api_key`, `google_oauth_client_id`,
      `google_oauth_client_secret`, `google_oauth_refresh_token` (+ `advbox_token`)
- [ ] Secrets do item 5 rotacionados?

---

## Já resolvido — não refazer

O handoff antigo pedia estas coisas. Todas caíram; ficam registradas para ninguém
"consertar" o que já está certo.

| Pedido antigo | Situação |
|---|---|
| Subir os 5 templates de `credijuris-contratos\templates\` | **Não faça.** Aquela pasta ficou *atrás* do bucket (testemunhas antigas, `intermediacao.docx` sem marcadores de gênero). A fonte de verdade é o bucket; o gerador é `seeds/contratos-templates/_build_template.py` |
| Fix `.single()` → `.maybeSingle()` em `parametros_atualizacao` | Código não existe mais no `app.js` |
| Dropdown `gc-tipo` com as 2 variantes de honorários | Substituído em 2026-08-11 por lista de checkboxes: `Automático` + escolha manual dos 5 contratos |
| Upload da apresentação pelo browser | **Arquitetura mudou.** A análise agora é *puxada do Drive* (`A. Análises de crédito / {categoria} / {intermediador} / {cedente - processo}`). O browser só sobe documentos do cedente/escritório. Front manda `numero_processo` e `categoria` |
| Autocomplete de intermediador | Feito — dropdown populado via `acao: 'listar_intermediadores'` |
| Tela CRUD de investidores | Feita (`8288d32`), aba Carteiras |
| Detecção de checkbox pela IA | A IA **não é mais consultada** para isso. `detectCreditosNegociadosFromXlsx()` lê o quadro direto do XML e falha alto se não conseguir. Ver [Como o quadro da análise é lido](#como-o-quadro-da-análise-é-lido) |
| Upsert em `contratos_jobs` | Feito, `index.ts:1304` |
| Só 1 modelo de petição (`levantamento`) | Hoje são 8: levantamento, sequestro, ilegitimidade, rpv_complementar, registro_publico, homologacao + ai_com_qualif/ai_sem_qualif (fluxo IA) |

---

## Fluxo atual do `gerar-contrato`

1. Valida JWT → lê secrets de `configuracoes` → lê investidor
2. `upsert` do job (`status=processing`) — permite retry com mesmo `job_id`
3. Lista inputs do Storage: **só cedente e escritório**
4. Carrega os 5 templates do bucket e coleta a união das variáveis `{{...}}`
5. Extrai cedente + escritório via Claude — o nome do cedente define qual pasta buscar
6. Refresh do token Google
7. Localiza e baixa a análise no Drive (export se for Google Sheets nativo). A pasta é
   procurada por cedente → escritório → nº do processo no nome → nº do processo em subpasta →
   pasta única. `debug.leaf_casou_por` diz qual critério valeu
8. Extrai a apresentação via Claude; depois **sobrescreve** os créditos negociados e o
   `CAPITAL_INVESTIDO` com a leitura determinística do XLSX (dois `try` independentes)
9. Junta variáveis (apresentação > cedente/escritório > investidor), aplica title case e
   marcadores de gênero (`C_*`, `I_*`, `S_*`, `I_QL`)
10. `determinarTipos(tipo, tipos, aprVars, categoria)` decide o conjunto, nesta precedência:
    escolha manual do operador → dropdown de tipo único → categoria precatório → quadro da análise
11. Preenche templates (JSZip + xmldom) e sobe em 3 pastas do Drive:
    - `2. Contratos assinados` — contratos gerados (nunca sobrescreve: colisão gera versão datada)
    - `1. Análise(s) de crédito` — cópia da análise baixada (best-effort)
    - `4. Documentos do cedente e advogado` — docs do cedente (best-effort)
    - a pasta do intermediador em `B. Processos` é criada se não existir
12. Atualiza o job, limpa o bucket temp, retorna URLs

### Quais contratos saem

| | RPV | Precatórios |
|---|---|---|
| **Automático** | cessões conforme o quadro da análise + intermediação + procuração | intermediação + procuração, sempre. Nenhuma cessão |
| **Manual** | exatamente o que o operador marcar — nada é acrescentado | idem |

O contrato de intermediação é o *"Contrato de originação, intermediação e gestão de ativo"*,
que já contempla a cessão onerosa no próprio corpo — é por isso que precatório não tem cessão
avulsa.

### As duas análises não têm a mesma estrutura

Conferido em 2026-08-11 contra uma análise real de cada tipo:

| | Análise de **RPV** | Análise de **Precatório** |
|---|---|---|
| Quais créditos são negociados | quadro *"Vai ser negociado aqui quais créditos?"*, dropdown em `sheet1!C3` | **não existe.** A análise é por crédito: *"se mais de um crédito estiver sendo negociado (inclusive honorários), realizar uma análise jurídica para cada um deles, em abas separadas"* |
| Valores | rótulo à esquerda, valor à direita (`X4`→`Y4`, ou `X41`→`Y41` no modelo azul) | rótulo é cabeçalho de coluna, valores nas linhas de cenário abaixo (*"1) Negociando só o principal:"*, um por linha, só um preenchido) |
| Cabeçalho | `Processo`, `Intermediador`, `cedente e CPF`, `escritório e CPF/CNPJ`, `Tribunal` | idem, mais `Qual o tipo de crédito?` e `Natureza do crédito` |

Por isso o quadro **só é lido quando o conjunto de contratos depende dele** — nunca em
precatório (a categoria já define os 2 documentos) nem quando o operador escolheu na mão.
Ler ali daria erro em toda geração de precatório.

### Como o quadro da análise é lido

O modelo da análise de RPV mudou em 2026-08: as 3 checkboxes viraram **um dropdown** em
`sheet1!C3` com `Apenas o crédito principal` / `Crédito principal e honorários` /
`Apenas os honorários`. "Honorários" não separa contratuais de sucumbenciais, então as duas
cessões saem juntas.

`detectCreditosNegociadosFromXlsx()`:

- aceita rótulo em `t="s"` (sharedStrings), `t="inlineStr"` e `t="str"` — o modelo novo **não
  tem `sharedStrings.xml`**, usa `inlineStr`
- decodifica entidades XML antes de comparar: `cr&#233;dito` normalizaria para `cr233dito`
- lê **só a aba que contém o quadro**. As abas de precificação (modelo verde / modelo azul)
  repetem "Crédito Principal" e "Honorários Contratuais" como rótulo de tabela
- ainda entende o formato antigo de 3 checkboxes booleanas
- **lança erro** dizendo célula e texto lido quando não consegue. A IA não é fallback: chute
  errado aqui gera o conjunto errado de documento jurídico. Se a planilha estiver ilegível, o
  operador desmarca "Automático" e escolhe na tela

---

## Decisões arquiteturais

- **Preenche APENAS `{{VARIAVEIS}}`.** Texto jurídico dos templates é INTOCÁVEL.
- **PDF vai direto pra Claude** como `type:document` — elimina `pdfplumber`/`pymupdf`,
  que não rodam em Deno.
- **DOCX/XLSX de input:** texto extraído com JSZip + regex no XML.
- **Preenchimento de DOCX:** JSZip + xmldom, preserva 100% do layout (igual ao `filler.py`).
- **Créditos negociados e "Valor total da operação" lidos direto do XML**, sem IA — a IA erra
  com input grande, e nos créditos negociados o erro troca o conjunto de contratos. Nos
  créditos a leitura é obrigatória (falha alto); no valor é best-effort com a IA como fallback.
- **Templates `.docx` não são versionados.** O repo é público e servido por GitHub Pages;
  todo template traz CPF e endereço residencial de pessoa física — versionar deixaria os
  arquivos baixáveis pela URL do site. Versionado é só o que os reproduz (`_build_template.py`,
  `README.md`, `_dados_locais_template.py`). Mesma regra de `seeds/investidores.sql`.
- **Drive auth:** OAuth user-delegated, refresh_token em `configuracoes`, trocado por
  access_token a cada chamada.
- **Storage temp:** browser sobe em `contratos-input/{uid}/{job_id}/{papel}/`, a função lê,
  processa e apaga.
- **Sem geração de PDF** — só `.docx`, decisão do usuário.

---

## Armadilhas conhecidas

1. **Slug de Edge Function é imutável.** Renomear o display name não muda a URL. Já custou
   um "CORS error" fantasma (era 404 no preflight) quando a função nasceu como
   `smart-responder`. Para corrigir: deletar e recriar com o slug certo.
2. **Supabase Storage não aceita acento em nome de objeto.** Normalizar com
   `normalize('NFD')` + remoção de marcas combinantes + `_` no lugar de não-word
   (`28cc9ab`). Usar escapes Unicode no regex, não marcas literais (`5e05cfb`).
3. **`.single()` retorna 406 quando não há linha.** Use `.maybeSingle()`.
4. **RLS de Storage por `(storage.foldername(name))[1] = auth.uid()::text` não funcionou**
   — `new row violates row-level security policy` mesmo com path correto. Trocado por
   policies permissivas. Endurecer é item aberto.
5. **GitHub Pages e Jekyll:** `.nojekyll` + cache-busting no `?v=` do `app.js` são o que
   destrava o deploy (`7e02492`). Ao mexer no `app.js`, bumpar a versão no `index.html`.
6. **PowerShell 5.1 mente sobre arquivos.** `Get-Content` lê UTF-8 como ANSI (mojibake no
   terminal é o terminal, não o arquivo); `Set-Content -Encoding utf8` **escreve BOM** — não
   use pra reescrever `index.html`/`.ts`, e BOM no começo do `index.ts` quebra o boot da
   função; e `Get-Content | Measure-Object -Line` **não conta linhas em branco**, então
   reporta ~160 linhas menos que o editor no `gerar-contrato/index.ts`. Para contar de
   verdade: `([regex]::Matches([IO.File]::ReadAllText($p),"\n")).Count + 1`. Para comparar
   dois arquivos, use `Get-FileHash` ou `git diff --no-index`, nunca contagem de linhas.
7. **A análise vem de uma árvore do Drive, o upload vai pra outra.** O dropdown de
   intermediador lê `A. Análises de crédito/{categoria}`, mas os contratos sobem em
   `B. Processos/{categoria}`. As duas não andam juntas — por isso a pasta do intermediador é
   criada quando falta na segunda.
8. **O nome da pasta da análise não é sempre o do cedente.** Em operação de honorários ela vem
   com o nome do escritório. Não confie no nome; o nº do processo é a chave única.
9. **Mudança no modelo da análise quebra a leitura do quadro em silêncio** se a leitura não
   falhar alto. Foi o que aconteceu quando as checkboxes viraram dropdown: a IA assumiu e
   passou a pedir documento de escritório em operação sem honorários. Ao mexer no modelo,
   rode `_tests/test-quadro.mjs` apontando pra planilha nova.

---

## Links

- Repo: https://github.com/operacoes-credijuris/controledecessoes
- Site: https://operacoes-credijuris.github.io/controledecessoes/
- Supabase project ref: `uekoindsadcthbdkkbjt`
- Projeto Python de referência: `credijuris-contratos/` (fora do GitHub; templates
  desatualizados — a lógica ainda serve de referência)
- Mapa completo de variáveis dos templates: `supabase/seeds/contratos-templates/README.md`
- Testes locais: `supabase/functions/gerar-contrato/_tests/README.md`
