# Handoff — Gerador de Contratos no site Credijuris

## Objetivo do projeto

Adicionar uma aba **"Gerar Contratos"** no site de Controle de Cessões da Credijuris (https://github.com/operacoes-credijuris/controledecessoes), permitindo que o operador:

1. Suba documentos (PDF/imagem/DOCX/XLSX) de cedente, escritório e apresentação do crédito
2. Escolha um investidor de uma lista
3. Digite o nome do intermediador (pasta no Google Drive)
4. Clique "Gerar Contratos"

E o sistema:
1. Lê os documentos via Claude API (claude-opus-4-5) extraindo as variáveis (CPF, RG, endereço, valores, número de processo, etc.)
2. **Detecta automaticamente** quais contratos gerar lendo 3 checkboxes do quadro "Vai ser negociado aqui quais créditos?" na análise de RPV (.xlsx): Crédito Principal, Honorários Contratuais, Honorários Sucumbenciais
3. Preenche até 5 templates `.docx` pré-prontos (cessão de crédito, cessão de honorários contratuais, cessão de honorários sucumbenciais, intermediação, procuração) substituindo as variáveis `{{NOME_VARIAVEL}}`
4. Faz upload no Drive em **duas pastas distintas**:
   - **Contratos gerados** → `Credijuris - Atualizado / B. Processos / Requisições de Pequeno Valor / <Intermediador> / <Cedente> - <Processo> / 2. Contratos assinados`
   - **Arquivos brutos da apresentação** (a própria análise + qualquer anexo) → mesma estrutura, em `1. Análise(s) de crédito`
5. Nomeia cada `.docx` no formato pedido: `Contrato de Cessão de X - Cedente v. Cessionário - Processo.docx`

Tudo isso **portado do projeto Python original** (`credijuris-contratos/`) que já fazia parte disso via CLI local. A meta é integrar no site para qualquer operador usar pelo navegador, sem instalar Python/LibreOffice.

**Restrições importantes:**
- O site é estático no GitHub Pages — backend só pode ser Supabase Edge Functions (Deno/TypeScript)
- Não vai gerar PDF, só `.docx` (decisão do usuário pra simplificar)
- A IA preenche APENAS as variáveis `{{...}}` — texto jurídico dos templates é INTOCÁVEL
- Os 3 booleans das checkboxes (`NEGOCIAR_CREDITO_PRINCIPAL`, `NEGOCIAR_HONORARIOS_CONTRATUAIS`, `NEGOCIAR_HONORARIOS_SUCUMBENCIAIS`) substituem a antiga variável `TIPO_CREDITO_NEGOCIADO` (dropdown único)

---

## Estado atual

### ✅ Pronto e em produção
- Site original refatorado: CSS/JS extraídos do HTML (era 6329 linhas inline) — commits `78ebc72`, `9d38b63`
- Pane "Gerar Contratos" no site: HTML + CSS + JS, item de sidebar sob "Operacional" — commit `cf74cc6`
- Schema Supabase: tabelas `investidores` (17 registros migrados do JSON), `contratos_jobs` (auditoria), `configuracoes` (secrets)
- 2 Storage buckets privados criados: `contratos-templates` e `contratos-input` (uploads temp)
- **RLS de Storage permissivo aplicado** — 5 policies criadas (SELECT em templates, todas as 4 ops em input) com `bucket_id` apenas, sem checagem por `auth.uid()` no path. O erro `new row violates row-level security policy` está resolvido.
- **4 secrets em `configuracoes`**: `anthropic_api_key`, `google_oauth_client_id`, `google_oauth_client_secret`, `google_oauth_refresh_token` (todos com tamanho de valor coerente: 108, 73, 35, 103 caracteres)
- **Edge Function `gerar-contrato` deployada** com o slug correto (após resolver problema do slug `smart-responder`)
- **Verify JWT desligado** no gateway (a função valida o JWT internamente)
- Fix do 406 `parametros_atualizacao` (trocado `.single()` por `.maybeSingle()` em `app.js`)
- **Análise de RPV no modelo novo** gerada para o Gilson Balduino para servir de teste (cabeçalho preenchido com checkbox de Crédito Principal marcada) — arquivo em `Downloads/Análise de RPV - GILSON BALDUINO DA SILVA - 5222044-59.2024.8.09.0168 (modelo novo).xlsx`

### 🟡 Pronto localmente, ainda não deployado/aplicado
Mudanças grandes no `index.ts` e `index.html` para a nova arquitetura de **checkboxes + 5 templates + nome novo de arquivo + upload em duas pastas**. As alterações de código estão prontas mas **falta**:
1. **Subir os 5 templates `.docx` para o bucket `contratos-templates`** (atuais arquivos no bucket são de versão anterior + falta as 2 variantes de honorários):
   - `cessao_credito.docx` (atualizado)
   - `cessao_honorarios_contratuais.docx` (novo)
   - `cessao_honorarios_sucumbenciais.docx` (novo)
   - `intermediacao.docx` (atualizado)
   - `procuracao.docx` (atualizado)

   Caminho local: `C:\Users\Windows 10\Desktop\novo projeto\credijuris-contratos\templates\`
   
   **Cuidado:** subir somente os `.docx`, ignorar os `.bak`. Recomendado também deletar o `cessao_honorarios.docx` antigo do bucket.

2. **Redeployar a Edge Function** com o `index.ts` atualizado. Como o usuário não tem Node.js instalado, o caminho é via Studio web:
   ```cmd
   type "C:\Users\Windows 10\Desktop\novo projeto\controledecessoes-main\supabase\functions\gerar-contrato\index.ts" | clip
   ```
   Depois: Studio → Edge Functions → `gerar-contrato` → Code → cola → Deploy.

3. **Atualizar `app.js` no servidor** (GitHub Pages — autodeploy via push) com o fix do `.maybeSingle()` (já está no arquivo local mas precisa commitar).

### ⏳ Mudanças contidas neste handoff (resumo do diff)

**`supabase/functions/gerar-contrato/index.ts`** — mudanças desde a versão anterior:
- `TEMPLATES`: agora tem 5 chaves (sem `cessao_honorarios`, com 2 variantes); `REQUIRED_PAPEIS` idem
- `TIPOS_POR_NEGOCIO` removido (não é mais necessário — checkboxes determinam direto)
- `DRIVE_PASTA_ANALISE = '1. Análise(s) de crédito'` constante adicionada
- `SCHEMA_APRESENTACAO_FIXOS`: trocou `TIPO_CREDITO_NEGOCIADO` por 3 booleans (`NEGOCIAR_CREDITO_PRINCIPAL`, `NEGOCIAR_HONORARIOS_CONTRATUAIS`, `NEGOCIAR_HONORARIOS_SUCUMBENCIAIS`) com descrição explicando à IA como mapear `1/TRUE` vs `0/FALSE` do XLSX
- `parseBool(v)` helper adicionado — aceita "true"/"1"/"sim"/"yes"/"marcado"
- `determinarTipos(tipoExplicito, aprVars)` reescrita: lê os 3 booleans, monta lista de cessões + intermediação + procuração; lança erro claro se nenhuma checkbox for marcada
- `sanitizeFilenamePart`, `nomeContratoArquivo(tipo, dados)` adicionados — gera nome no padrão "Contrato de Cessão de X - Cedente v. Cessionário - Processo.docx" (para honorários, Cedente = `ESCRITORIO_NOME`; nos demais = `CEDENTE_NOME`)
- `mimeForExtension(ext)` adicionado para upload genérico
- `driveGarantirEstruturaCedente` retorna agora `{ contratosId, analiseId }`
- `driveUploadBytes(token, name, parentId, bytes, mime, sobrescrever)` adicionado (refatoração do `driveUploadDocx` que virou wrapper compat)
- Após upload dos contratos para `2. Contratos assinados`, novo loop **best-effort** baixa cada arquivo de apresentação do bucket e sobe para `1. Análise(s) de crédito` com o nome original e mime detectado
- Payload de retorno inclui `analise_folder_url` e `analise_uploads`
- `insert` em `contratos_jobs` virou `upsert` (`onConflict: 'id'`, com reset de `erro_msg`) — corrige erro de duplicate key em retries

**`index.html`** — dropdown `gc-tipo`:
- Removida opção `cessao_honorarios` (genérica)
- Adicionadas opções `cessao_honorarios_contratuais` e `cessao_honorarios_sucumbenciais`
- Hint atualizado para explicar o modo auto via checkboxes

**`assets/js/app.js`** — micro-fix:
- `.single()` → `.maybeSingle()` na chamada de `parametros_atualizacao` (resolve 406)

---

## Arquivos em trabalho

### Frontend (site, deploy automático via GitHub Pages)
```
controledecessoes-main/
├── index.html                    ← dropdown gc-tipo atualizado (linhas ~771-779)
├── assets/
│   ├── css/app.css               ← estilos GC (linhas 2020+)
│   └── js/app.js                 ← módulo GC (linhas ~660–880); fix maybeSingle (linha 2562)
```

### Backend (Supabase)
```
controledecessoes-main/supabase/
├── functions/gerar-contrato/
│   └── index.ts                  ← ~950 linhas após as mudanças — pipeline com 5 templates, checkboxes, dois destinos no Drive
├── migrations/
│   └── 0001_contratos_setup.sql  ← schema base (já rodado — porém a tabela `configuracoes` já existia e não recebeu `descricao` nem `updated_at` automaticamente; foram adicionados via `alter table add column if not exists`)
├── seeds/
│   ├── investidores.sql          ← PII, gitignored, já rodado
│   ├── configuracoes_template.sql← template no repo
│   └── configuracoes.sql         ← secrets reais, gitignored, já rodado
└── STORAGE_SETUP.md              ← instruções dos buckets
```

### Projeto Python de referência (NÃO modificar)
```
credijuris-contratos/              ← origem da lógica, ainda funciona via CLI
├── main.py
├── src/                           ← extractor.py, filler.py, drive_uploader.py
├── templates/                     ← cessao_credito.docx, cessao_honorarios_contratuais.docx (novo),
│                                    cessao_honorarios_sucumbenciais.docx (novo), intermediacao.docx, procuracao.docx
│                                    + arquivos .bak (versões anteriores — NÃO subir pro bucket)
├── .env                           ← ANTHROPIC_API_KEY
├── client_secrets.json            ← Google OAuth client
└── token.json                     ← Google OAuth refresh_token
```

---

## Erros / coisas que tentamos e não deram certo

### 1. Conversão para PHP com partials
**O que foi tentado:** refatorar `index.html` (6329 linhas) em `index.php` + 6 partials + `config.php`.
**Por que deu errado:** servidor é GitHub Pages, estático puro, não roda PHP.
**Resolução:** revertido para `index.html` enxuto (899 linhas) com CSS/JS externos.

### 2. Nome de arquivo com acento no Storage upload
**O que foi tentado:** subir `Análise de RPV - GILSON ... .xlsx` direto pro bucket `contratos-input`.
**Erro:** `Invalid key: ...Análise_de_RPV_...`
**Por que:** Supabase Storage não aceita caracteres acentuados em nomes de objetos.
**Resolução:** commit `28cc9ab` — normalização via `String.prototype.normalize('NFD')` + remoção de marcas combinantes + regex pra trocar não-word por `_`.

### 3. Botão "Gerar Contratos" sem estilo `:disabled`
**Resolução:** commit `9d38b63` — adicionou `background:#1e2433; color:#4b5563; cursor:not-allowed`.

### 4. RLS de Storage com `(storage.foldername(name))[1] = auth.uid()::text`
**O que foi tentado:** policy restritiva por user_id no path.
**Erro:** `new row violates row-level security policy` (mesmo com path correto).
**Por que:** o parsing/contexto da policy em Storage não bateu — diagnóstico minucioso seria lento.
**Resolução:** policies permissivas (qualquer authenticated, sem restrição de pasta). Aceitável para MVP com operadores internos. Endurecer depois é item de refinamento.

### 5. Erro 406 em `/rest/v1/configuracoes?chave=eq.parametros_atualizacao`
**O que era:** PostgREST retornando 406 porque a chamada usava `.single()` mas a row não existia.
**Por que:** `.single()` exige exatamente 1 linha; com 0 retorna 406.
**Resolução:** trocado para `.maybeSingle()` em `app.js:2562` (retorna `null` em vez de erro).

### 6. Edge Function deployada com slug errado (`smart-responder`)
**Sintoma:** preflight OPTIONS retornava 404, browser bloqueava com "CORS error" e o JS surface mensagem `Failed to send a request to the Edge Function`.
**Por que:** quando a função foi criada no Studio originalmente, foi com o nome padrão de template `smart-responder`. Depois, alguém renomeou apenas o **display name** para `gerar-contrato`, mas o **slug** (parte da URL) é imutável após a criação — o aviso da própria UI dizia "Your slug and endpoint URL will remain the same".
**Resolução:** deletou-se a função `smart-responder` e criou-se uma nova com slug correto `gerar-contrato` desde a criação.

### 7. `Secret 'anthropic_api_key' não configurado em configuracoes`
**O que era:** Edge Function rodando, mas a tabela `configuracoes` no projeto Supabase atual estava sem as chaves necessárias (tinha só `advbox_token` e `gemini_key`).
**Por que:** o seed `configuracoes.sql` provavelmente foi rodado num projeto Supabase diferente em sessão anterior, ou nunca foi rodado neste.
**Resolução:**
1. ALTER TABLE add column if not exists `descricao` e `updated_at` (a tabela pré-existia com schema simples e a migration `0001` foi no-op para `configuracoes` por causa do `create table if not exists`)
2. INSERT do seed com `on conflict (chave) do update`
3. 4 chaves agora presentes com tamanhos coerentes (108/73/35/103)

### 8. `Erro criando job: duplicate key value violates unique constraint "contratos_jobs_pkey"`
**O que era:** após uma tentativa que falhou (intermediador errado), uma segunda tentativa com o mesmo `job_id` violava a PK.
**Por que:** o `job_id` no client (`app.js:689,856`) só é regenerado em sucesso ou ao entrar na aba. Erros mantêm o id. A Edge Function fazia `.insert(...)` em vez de upsert.
**Resolução:** dois layers
- **Unblock imediato:** `delete from public.contratos_jobs where status = 'erro';` (apaga a row órfã, permitindo retry com o mesmo job_id)
- **Fix permanente:** `index.ts` agora faz `.upsert(..., { onConflict: 'id' })` com reset de `erro_msg`. Depende do redeploy.

### 9. ⚠️ Vazamento de secrets na conversa
**Contexto:** durante o debug do erro 7, o operador colou o conteúdo do arquivo `configuracoes.sql` (com os 4 secrets reais) no chat.
**Mitigação imediata:** anotado em `~/.claude/projects/.../memory/project_secret_rotation_pendente.md`.
**Pendente pós-MVP:** rotacionar todas as 4 credenciais:
1. Anthropic key em https://console.anthropic.com/settings/keys
2. Google OAuth `client_secret` em console.cloud.google.com
3. Refresh token regerado via `python credijuris-contratos/main.py`
4. Atualizar `configuracoes.sql` local e re-executar o seed

---

## Próximo passo

### 1. Subir os 5 templates atualizados para o bucket

Supabase Studio → **Storage** → bucket `contratos-templates` → **Upload file** com os 5 `.docx` de:
```
C:\Users\Windows 10\Desktop\novo projeto\credijuris-contratos\templates\
```

Não subir nenhum `.bak`. Opcionalmente, apagar o `cessao_honorarios.docx` antigo do bucket.

### 2. Redeployar a Edge Function

No CMD/PowerShell normal (sem admin):
```cmd
type "C:\Users\Windows 10\Desktop\novo projeto\controledecessoes-main\supabase\functions\gerar-contrato\index.ts" | clip
```

Depois Studio → Edge Functions → `gerar-contrato` → **Code** → seleciona tudo, deleta, cola (Ctrl+V) → **Deploy**.

Confirma na aba **Versions/Deployments** que a versão nova subiu com timestamp recente. Olha **Logs** para garantir que não há erro de boot/import.

### 3. Testar end-to-end com o Gilson "modelo novo"

1. Hard reload no site: **Ctrl + Shift + R**
2. Aba "Gerar Contratos"
3. Preencher:
   - Investidor: qualquer da lista
   - Intermediador: nome de pasta que existe no Drive
4. Subir:
   - Apresentação: `Downloads/Análise de RPV - GILSON BALDUINO DA SILVA - 5222044-59.2024.8.09.0168 (modelo novo).xlsx`
   - Cedente: qualquer RG/CPF/comprovante do Gilson (PDF ou imagem)
5. Clicar **Gerar Contratos** e aguardar 30–90s

### 4. Resultado esperado

- **Drive → `2. Contratos assinados`:** 3 arquivos `.docx`
  - `Contrato de Cessão de Crédito Principal - GILSON BALDUINO DA SILVA - 5222044-59.2024.8.09.0168.docx`
  - `Contrato de Intermediação - GILSON BALDUINO DA SILVA - 5222044-59.2024.8.09.0168.docx`
  - `Procuração - GILSON BALDUINO DA SILVA - 5222044-59.2024.8.09.0168.docx`
- **Drive → `1. Análise(s) de crédito`:** o `.xlsx` da análise e quaisquer outros anexos que tenham sido subidos como apresentação
- **Site:** painel verde com link "Abrir pasta no Drive ↗"

### 5. Erros prováveis pós-testes e como tratar

| Mensagem | Causa | Fix |
|---|---|---|
| `Claude API 401` | API key errada | Atualizar `anthropic_api_key` em `configuracoes` |
| `Google OAuth refresh falhou` | refresh_token revogado | Regenerar via `python main.py` local |
| `'Credijuris - Atualizado' não encontrado` | Conta do token sem acesso ao Drive certo | Compartilhar a pasta com a conta Google do token |
| `Intermediador '...' não encontrado` | Nome digitado não bate com pasta no Drive | A resposta lista as opções disponíveis — copia uma |
| `Nenhuma checkbox marcada...` | A IA leu como "0/false" todas as 3 checkboxes | Conferir a planilha — abrir no Sheets/Excel, marcar pelo menos uma checkbox de fato (não só digitar texto na célula D) |
| `Template '...' não encontrado no bucket` | Algum dos 5 `.docx` não foi subido para `contratos-templates` | Subir o que falta |

### 6. Refinamentos pós-MVP (não bloqueante)

- Rotacionar os 4 secrets (vazaram no chat — ver erro #9 acima)
- Voltar policy de Storage para versão restrita por user_id (depois de entender por que falhava)
- Tela CRUD pra editar investidores (hoje só via SQL)
- Autocomplete do intermediador puxando lista do Drive (Edge Function nova `list-intermediadores`)
- Upgrade para `claude-opus-4-7` (atualmente `claude-opus-4-5` por compat com Python original)
- Migração da Q&A completa do modelo antigo → novo (até agora só o cabeçalho do modelo novo foi preenchido para teste; se quiser uma análise totalmente migrada, é trabalho adicional de mapear ~30 perguntas com offset de 2 linhas)
- Considerar mostrar 2 links no painel de sucesso: um pros contratos, outro pra análise (o payload já retorna `analise_folder_url`)

---

## Decisões arquiteturais relevantes

- **Modelo Claude:** `claude-opus-4-5` (matching projeto Python). Constante `CLAUDE_MODEL` no topo do `index.ts`.
- **PDF input:** envia direto pra Claude API como `type:document` — eliminou necessidade de `pdfplumber`/`pymupdf` (não rodam em Deno).
- **DOCX/XLSX input:** extrai texto via JSZip + regex em XML — funciona em Deno sem dependências pesadas.
- **DOCX template filling:** JSZip + xmldom — preserva 100% do layout (mesma abordagem do `filler.py`).
- **Detecção de checkboxes do XLSX:** Google Sheets exporta cada checkbox como uma célula booleana (`t="b"`) com valor `1` (TRUE) ou `0` (FALSE). O extrator atual já lê isso e passa pra Claude como texto tipo `"Crédito principal: | 1"`. O prompt do schema fala explicitamente em "1/TRUE" vs "0/FALSE" pra IA mapear corretamente.
- **Google Drive auth:** OAuth user-delegated. Refresh_token em `configuracoes`, function troca por access_token a cada chamada.
- **Storage temp:** browser sobe pra `contratos-input/{uid}/{job_id}/`, função lê, processa, apaga ao fim.
- **Upsert em `contratos_jobs`:** permite retry com mesmo `job_id` sem violar PK; reseta `erro_msg` automaticamente.

---

## Contatos / links úteis

- Repo do site: https://github.com/operacoes-credijuris/controledecessoes
- Supabase project ref: `uekoindsadcthbdkkbjt`
- GitHub Pages URL: `https://operacoes-credijuris.github.io/controledecessoes/`
- Projeto Python de referência: pasta `credijuris-contratos/` (não está no GitHub)

---

_Última atualização: 2026-05-13 — após resolução do RLS de Storage, fix do slug `smart-responder` → `gerar-contrato`, preenchimento dos 4 secrets em `configuracoes`, upsert em `contratos_jobs`, e implementação das 5 mudanças arquiteturais (5 templates, checkboxes, nome novo, upload duplo) ainda pendentes de redeploy._
