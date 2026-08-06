# contratos-templates — modelos do fluxo `gerar-contrato`

Templates `.docx` que a Edge Function [`gerar-contrato`](../../functions/gerar-contrato/index.ts)
baixa do bucket **`contratos-templates`** e preenche substituindo `{{VARIAVEIS}}`.
O nome do arquivo aqui tem que ser **idêntico** ao valor em `TEMPLATES` no `index.ts`.

Mesma convenção da pasta `peticoes-templates/`:

| Arquivo | O que é |
|---|---|
| `_modelo_original_<tipo>.docx` | modelo em branco recebido do jurídico (marcadores `XXXXXXXXXX` em amarelo) |
| `_template_antigo_<tipo>.docx` | versão que estava no bucket antes da troca — referência do mapa de variáveis |
| `_bucket_atual_<tipo>.docx` | template **em produção** que ainda não foi reescrito no layout novo. Só referência — não é gerado nem alterado pelo script |
| `<tipo>.docx` | **saída** — é este que vai pro bucket |
| `_build_template.py` | gera os `<tipo>.docx`: de `_modelo_original_*` (via `MODELOS`) ou de `_bucket_atual_*` com correção pontual de texto (via `CORRECOES`) |
| `_dados_locais.py` | nome e CPF das testemunhas |

> ### ⚠️ Nada de `.docx` no git
>
> Os `.docx` e o `_dados_locais.py` estão no `.gitignore`. Este repositório é **público**
> e servido por GitHub Pages — um `.docx` versionado aqui ficaria baixável pela URL do
> site, e todos eles trazem CPF e endereço residencial de pessoas físicas (sócio da
> Credijuris, testemunhas). Mesma regra que já vale para `supabase/seeds/investidores.sql`.
>
> **A fonte de verdade dos templates é o bucket `contratos-templates`.** Versionado aqui
> fica só o que os reproduz: o script, este README e o `_dados_locais_template.py`.
>
> Para trabalhar nos templates: baixe os `.docx` do bucket para esta pasta com os nomes
> da tabela acima, copie `_dados_locais_template.py` para `_dados_locais.py` e preencha.

```bash
python supabase/seeds/contratos-templates/_build_template.py
```

O script não toca no texto jurídico: só troca o texto dos `<w:t>` dos marcadores,
copia o `rPr` de destaque (`CJDestaque`) para o run do nome da parte e remove os
`<w:highlight w:val="yellow"/>` (a marcação amarela é sinalização de campo a
preencher no modelo em branco, não deve sair no documento gerado).

Como todos os marcadores têm o mesmo texto (`XXXXXXXXXX`), a substituição é
posicional: a lista `sequencia` de cada modelo casa com a ordem em que os
marcadores aparecem no documento. **Se o jurídico mexer no modelo, a build falha**
em vez de gerar contrato com campo trocado — é só reajustar a `sequencia`.

---

## procuracao.docx

Outorgante = **investidor/cessionário**; outorgada = Credijuris. Mesmos papéis do template antigo.

| Local no documento | Placeholder | Origem no `index.ts` |
|---|---|---|
| Qualificação do outorgante | `{{INVESTIDOR_NOME}}, {{I_QL}}.` | `investidores` + `montarQualificacaoInvestidor()` |
| `o(a) OUTORGANTE` / `O(A) OUTORGANTE` | `{{I_O}}` / `{{I_OM}}` | `marcadoresGenero('I', …)` |
| `representá-lo(a)` (Cláusula 2) | `representá-{{I_LO}}` | `marcadoresGenero('I', …)` |
| Tabela → Processo nº | `{{NUMERO_PROCESSO}}` | `SCHEMA_APRESENTACAO_FIXOS` |
| Tabela → Juízo / Tribunal | `{{JUIZO_TRIBUNAL}}` | **novo** — passo "campos extras" do `extractApresentacao()` |
| Assinatura → nome | `{{INVESTIDOR_NOME}}` | `investidores` |
| Assinatura → CPF / CNPJ | `{{INVESTIDOR_CPF}}` | `investidores` (coluna `cpf` guarda CNPJ quando PJ) |

## intermediacao.docx

Substitui o antigo *"Contrato de prestação de serviços de intermediação"*.
Contratante = **investidor/cessionário**; contratada = Credijuris.
O modelo novo é bem maior (originação + intermediação + gestão de ativo, remuneração
de performance por faixa de TIR), mas o conjunto de dados variáveis é quase o mesmo.

| Local no documento | Placeholder | Origem no `index.ts` |
|---|---|---|
| Qualificação do contratante | `{{INVESTIDOR_NOME}}, {{I_QL}}.` | `investidores` |
| Dados da operação → Processo nº | `{{NUMERO_PROCESSO}}` | `SCHEMA_APRESENTACAO_FIXOS` |
| Dados da operação → Juízo / Tribunal | `{{JUIZO_TRIBUNAL}}` | **novo** — campos extras |
| Dados da operação → Cedente | `{{CEDENTE_NOME}}` | `SCHEMA_CEDENTE` |
| Dados da operação → CPF / CNPJ do Cedente | `{{CEDENTE_CPF}}` | `SCHEMA_CEDENTE` |
| Dados da operação → Classe do ativo | `{{CLASSE_ATIVO}}` | **novo** — campos extras |
| Dados da operação → Valor de face atualizado | `{{VALOR_CREDITO_TOTAL}}` | `SCHEMA_APRESENTACAO_FIXOS` |
| Dados da operação → Preço pago ao Cedente | `{{VALOR_CESSAO}}` | `SCHEMA_APRESENTACAO_FIXOS` |
| Dados da operação → Capital Investido | `{{CAPITAL_INVESTIDO}}` | `detectValorTotalOperacaoFromXlsx()` lê da planilha; IA como fallback |
| Assinatura → nome / CPF do contratante | `{{INVESTIDOR_NOME}}` / `{{INVESTIDOR_CPF}}` | `investidores` |
| Assinatura → Testemunhas 1 e 2 (nome + CPF) | fixo no template | `_dados_locais.py` (não versionado) |

O corpo usa "o CONTRATANTE" (substantivo masculino do papel), sem flexão — não precisa
de marcador de gênero, ao contrário da procuração.

## Templates ainda no layout antigo

`cessao_credito`, `cessao_honorarios_contratuais` e `cessao_honorarios_sucumbenciais`
não foram reescritos pelo jurídico. Cópias do que está em produção ficam aqui como
`_bucket_atual_<tipo>.docx`, só para referência — o `_build_template.py` não mexe nelas.
Enquanto isso, cada operação gera 2 documentos no layout novo e 3 no antigo.

As testemunhas dos três estão gravadas no próprio `.docx` e são as atuais — confira
abrindo o arquivo do bucket antes de assumir que estão certas.

**`cessao_credito.docx` tem correção.** A versão em produção grafa a razão social como
`CREDJURIS` (sem o `I`) no bloco de assinatura da intermediadora. O bloco `CORRECOES` do
script gera um `cessao_credito.docx` corrigido a partir do `_bucket_atual_*`, trocando só
essa palavra — nada de placeholder, formatação ou texto jurídico é tocado. Os outros 36
placeholders e as testemunhas ficam idênticos. **Esse arquivo também precisa subir.**

---

## Notas de conversão

- **Qualificação colapsada** (nos dois templates). Os modelos novos têm 12 campos
  granulares (nacionalidade, estado civil, profissão, órgão expedidor,
  logradouro/nº/bairro/cidade/UF/CEP, representante legal). Nenhum existe na tabela
  `investidores` nem é extraído pela IA — deixá-los como placeholders individuais
  geraria vírgulas soltas em cima de valores nulos. Por isso o parágrafo inteiro vira
  `{{INVESTIDOR_NOME}}, {{I_QL}}.`, igual ao template antigo. `{{I_QL}}` monta a
  qualificação completa e alterna sozinho entre PF (`brasileira, inscrita no CPF…`)
  e PJ (`pessoa jurídica de direito privado, inscrita no CNPJ…, com sede em…`).

  **Parcialmente resolvido** pela migration `0003`: a coluna livre
  `investidores.qualificacao_complemento` entra na qualificação — em PF logo depois da
  nacionalidade (`"casada, empresária"`), em PJ no fim (`"neste ato representada por
  João da Silva, sócio-administrador"`). O órgão expedidor do RG não precisou de coluna:
  `rg` já é texto livre, basta cadastrar `MG-12.345.678 SSP/MG`. Depende de preencher os
  cadastros existentes — hoje só via SQL, não há tela de CRUD de investidores.
- **`R$` duplicado — corrigido.** O template antigo escrevia `R$ {{VALOR_CREDITO_TOTAL}}`,
  mas `SCHEMA_APRESENTACAO_FIXOS` já pede o valor no formato `R$ X.XXX,XX` — o contrato
  saía com `R$ R$ 84.320,17`. Aqui o run inteiro (`R$ XXXXXXXXXX`) é substituído pela
  variável, sem o prefixo literal.
- **Variáveis novas** (`{{JUIZO_TRIBUNAL}}`, `{{CLASSE_ATIVO}}`, `{{CAPITAL_INVESTIDO}}`).
  Entraram em `SCHEMA_APRESENTACAO_FIXOS` com descrição explícita — `CLASSE_ATIVO` lista
  as 5 opções válidas, para a IA não inventar variação. **Dependem do redeploy da Edge
  Function**; sem ele, caem no passo genérico de "campos extras" e podem voltar `null`,
  deixando o placeholder literal no `.docx` (e listado em `pendentes` no painel do site).
- **`{{CAPITAL_INVESTIDO}}` é lido deterministicamente**, não pela IA, por
  `detectValorTotalOperacaoFromXlsx()` — mesmo padrão do `detectCheckboxesFromXlsx()`.
  O rótulo *"Valor total da operação"* é igual nas duas análises, mas a geometria muda:
  no RPV o valor fica **à direita** (`X4` → `Y4`, ou `X41` → `Y41` no modelo azul); no
  precatório fica **abaixo** (`B5` → `B6`/`B8`/`B10`/`B12`, um por cenário, só um != 0).
  A regra cobre as duas: candidatos = célula à direita + 12 abaixo, vence o primeiro
  numérico diferente de zero. O casamento do rótulo usa `startsWith`, não `includes`,
  porque a análise de RPV tem um *"Ganho de capital projetado … (Valor líquido com a
  atualização - valor total da operação)"* que contém a frase e tem outro número ao lado.
- **Data.** Os modelos novos usam "Belo Horizonte/MG, data da assinatura eletrônica."
  em vez do `{{DATA_EXTENSO}}` dos antigos. Mantido como veio — é coerente com a nota
  de assinatura eletrônica (MP 2.200-2/2001) no rodapé.
- **`representá-lo(a)`** na Cláusula 2 da procuração agora flexiona, via o código
  `LO: ['lo','la']` adicionado a `GENERO_PALAVRAS`. **Atenção:** o `conduzi-lo` da mesma
  frase se refere ao *processo*, não ao outorgante, e continua masculino de propósito.

## Pendências

1. **Modelos novos dos 3 templates de cessão**, quando o jurídico entregar. Hoje cada
   operação gera 2 documentos no layout novo e 3 no antigo.
2. **Preencher `qualificacao_complemento`** dos investidores já cadastrados — só via SQL,
   não existe tela de CRUD. Sem isso a qualificação sai como sempre saiu.

> Testemunhas do `intermediacao.docx`: nome e CPF ficam em `_dados_locais.py`, fora do
> git. Quem assina pela CONTRATADA **não** pode acumular como testemunha — no modelo novo
> o procurador da Credijuris assina pela empresa, então saiu da lista de testemunhas.

> Nota: a pasta local `credijuris-contratos\templates\`, fora do repo, está
> **desatualizada** — testemunhas antigas e um `intermediacao.docx` sem marcadores de
> gênero. **A fonte de verdade é o bucket** `contratos-templates`.

## Deploy

Estes templates dependem de mudanças no `index.ts` — subir os `.docx` **sem** redeployar
faz `{{CLASSE_ATIVO}}`, `{{JUIZO_TRIBUNAL}}` e `{{CAPITAL_INVESTIDO}}` caírem no caminho
genérico da IA, com risco de placeholder literal no documento. Ordem correta:

1. **SQL Editor** → rodar `supabase/migrations/0003_investidores_qualificacao.sql`.
2. **Edge Functions** → `gerar-contrato` → Code → colar o `index.ts` → Deploy.
   Conferir em Logs que não houve erro de boot.
3. Rodar `python supabase/seeds/contratos-templates/_build_template.py`.
4. **Storage** → bucket `contratos-templates` → upload de `procuracao.docx`,
   `intermediacao.docx` e `cessao_credito.docx`, sobrescrevendo os antigos.
   Subir **só** os `<tipo>.docx` — nunca `_modelo_original_*`, `_template_antigo_*`
   ou `_bucket_atual_*`.
5. Testar ponta a ponta e conferir o campo `pendentes` no painel de sucesso.
6. (Quando houver dado) preencher `qualificacao_complemento` dos investidores via SQL.
