# Testes do `gerar-contrato`

Dois testes, sem framework, sem `npm install` no repo. Precisam só de Node e conexão
(o `esbuild` vem via `npx --yes`, e o `jszip` é instalado num diretório temporário).

```cmd
node supabase/functions/gerar-contrato/_tests/test-tipos.mjs
node supabase/functions/gerar-contrato/_tests/test-valores.mjs
node supabase/functions/gerar-contrato/_tests/test-quadro.mjs
```

Os dois **recortam as funções do próprio `index.ts`** em tempo de execução, transpilam com
esbuild e rodam. Não existe cópia da lógica aqui: se você renomear
`determinarTipos`, `detectCreditosNegociadosFromXlsx` ou as funções que elas usam, o teste
falha na hora do recorte com `nao achei: <marcador>` em vez de testar código velho.

## `test-tipos.mjs` — quais contratos são gerados

Cobre `determinarTipos()`: escolha manual do operador (vale exatamente o que foi marcado,
sem acrescentar nada), precatório (só intermediação + procuração, nunca cessão), RPV
(sai do quadro da análise) e a compatibilidade com o dropdown de tipo único.

Não precisa de nada externo.

## `test-valores.mjs` — valores e classe do ativo lidos da análise

### "Valor total da operação" → `CAPITAL_INVESTIDO`

Esse número vai impresso na Cláusula 10.1 do contrato de originação/intermediação/gestão,
então pegar a célula errada é erro caro e silencioso. As duas análises guardam o valor em
geometrias diferentes: no RPV à direita do rótulo, no precatório em linhas de cenário abaixo
(*"1) Negociando só o principal"*, só o cenário negociado preenchido).

Monta planilhas mínimas nas duas geometrias e verifica também a armadilha do *"Ganho de
capital projetado (… - valor total da operação)"*, que contém a frase do rótulo mas tem
outro número ao lado — é por isso que o casamento é `startsWith` e não `includes`.

Os números são reais, da análise de precatório da Tatiana Hiiga. Não precisa de nada externo.

### Cenário negociado → `CLASSE_ATIVO`

`detectCenarioNegociadoFromXlsx()` acha qual faixa de cenário da análise de precatório tem
números (*"1) Negociando só o principal"* / *"2) principal e honorários"* / *"3) só
honorários"*) e `classeAtivo()` traduz categoria + o que está sendo cedido numa das cinco
classes que o contrato aceita. Cobre também os casos que devolvem `null` de propósito:
nenhum cenário preenchido, **dois** preenchidos (planilha ambígua não vira palpite) e valor
zero, que não conta como preenchido.

## `test-quadro.mjs` — leitura do quadro da análise

Cobre `detectCreditosNegociadosFromXlsx()` contra uma planilha real: as 3 respostas do
dropdown, resposta vazia, resposta fora das opções, acento chegando como entidade XML
(`cr&#233;dito`) e a garantia de que a leitura acontece na aba do cabeçalho, não nas de
precificação — a confusão entre as duas foi a causa do bug de 2026-08.

Precisa de um `.xlsx` do modelo da análise, que **não é versionado**. Por padrão procura em
`fix bugs/templates/Modelo_Analise_de_RPV.xlsx`; dá pra apontar outro:

```cmd
set ANALISE_XLSX=C:\caminho\Analise de RPV - fulano.xlsx
node supabase/functions/gerar-contrato/_tests/test-quadro.mjs
```

Sem o arquivo, o teste avisa e sai sem falhar.

## Type-check

O `index.ts` importa de URLs (Deno), então `tsc` não resolve os imports. Para checar tipos
ignorando isso:

```cmd
npx --yes -p typescript@5.6.3 tsc --noEmit --skipLibCheck --target es2022 --lib es2022,dom --strict supabase/functions/gerar-contrato/index.ts
```

Erros esperados e aceitáveis: `TS2792`/`TS2307` (módulos remotos), `Cannot find name 'Deno'`
e o `req` implicitamente `any` no `serve()`. Qualquer outro erro é problema real.
