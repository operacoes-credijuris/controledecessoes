// Leitura do quadro "Vai ser negociado aqui quais créditos?" contra uma planilha real.
// Ver README.md desta pasta (inclusive como apontar outro .xlsx via ANALISE_XLSX).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, corta, cortaLinha, montar, dep, ok, fim } from './_harness.mjs';

const XLSX = process.env.ANALISE_XLSX || join(REPO, 'fix bugs', 'templates', 'Modelo_Analise_de_RPV.xlsx');
if (!existsSync(XLSX)) {
  console.log(`\nPULADO: não achei a planilha da análise.\n  procurei em: ${XLSX}\n  aponte outra com: set ANALISE_XLSX=C:\\caminho\\arquivo.xlsx\n`);
  process.exit(0);
}

const JSZip = (await dep('jszip')).default;
const { detectCreditosNegociadosFromXlsx, decodeXmlEntities, colDepois } = await montar('quadro', [
  `import JSZip from 'jszip';`,
  `type Vars = Record<string, string | null>;`,
  corta('function normalizar('),
  corta('function colLetterFromRef('),
  corta('async function readSharedStrings('),
  corta('function decodeXmlEntities('),
  cortaLinha(/^const ROTULO_CREDITOS_NEGOCIADOS = .*$/m),
  corta('const OPCOES_CREDITOS_NEGOCIADOS', '\n];\n'),
  corta('const ROTULOS_CHECKBOX_LEGADO', '\n];\n'),
  cortaLinha(/^interface XlsxCell .*$/m),
  corta('function colDepois('),
  corta('function parseSheetCells('),
  corta('async function detectCreditosNegociadosFromXlsx('),
  `export { detectCreditosNegociadosFromXlsx, parseSheetCells, decodeXmlEntities, colDepois };`,
]);

const original = readFileSync(XLSX);

async function ler(bytes) {
  try { return { r: await detectCreditosNegociadosFromXlsx(bytes) }; }
  catch (e) { return { erro: e.message }; }
}

// Injeta uma resposta na célula do dropdown, simulando a análise preenchida pelo operador.
async function comResposta(texto, celula = 'C3') {
  const zip = await JSZip.loadAsync(original);
  const sx = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const re = new RegExp(`<c r="${celula}"[^>]*/>|<c r="${celula}"[^>]*>[\\s\\S]*?</c>`);
  const nova = sx.replace(re, `<c r="${celula}" t="inlineStr"><is><t>${texto}</t></is></c>`);
  if (nova === sx) throw new Error(`não consegui injetar ${celula} na planilha`);
  zip.file('xl/worksheets/sheet1.xml', nova);
  return await zip.generateAsync({ type: 'uint8array' });
}

console.log('\n=== decodeXmlEntities ===');
ok('decodifica &#233; e &amp;', decodeXmlEntities('cr&#233;dito &amp; algo') === 'crédito & algo');

console.log('\n=== colDepois ===');
ok('C depois de A', colDepois('C', 'A'));
ok('AA depois de Z', colDepois('AA', 'Z'));
ok('A não depois de C', !colDepois('A', 'C'));

console.log('\n=== quadro sem resposta → erro explícito, não palpite ===');
const vazio = await ler(original);
ok('lança erro em vez de assumir', !!vazio.erro);
ok('erro aponta a célula do rótulo', /A3/.test(vazio.erro || ''), vazio.erro);
ok('não devolveu honorários marcados', !vazio.r);

console.log('\n=== as 3 respostas do dropdown ===');
for (const [texto, esp] of [
  ['Apenas o crédito principal',     { p: 'true',  h: 'false' }],
  ['Crédito principal e honorários', { p: 'true',  h: 'true'  }],
  ['Apenas os honorários',           { p: 'false', h: 'true'  }],
]) {
  const { r, erro } = await ler(await comResposta(texto));
  if (erro) { ok(`"${texto}"`, false, erro); continue; }
  const v = r.vars;
  ok(`"${texto}"`,
    v.NEGOCIAR_CREDITO_PRINCIPAL === esp.p &&
    v.NEGOCIAR_HONORARIOS_CONTRATUAIS === esp.h &&
    v.NEGOCIAR_HONORARIOS_SUCUMBENCIAIS === esp.h,
    `principal=${v.NEGOCIAR_CREDITO_PRINCIPAL} honorários=${v.NEGOCIAR_HONORARIOS_CONTRATUAIS}/${v.NEGOCIAR_HONORARIOS_SUCUMBENCIAIS} (${r.debug.celula_resposta})`);
  // O bug de 2026-08: "Crédito Principal" e "Honorários Contratuais" também são rótulos
  // das tabelas de precificação (abas do modelo verde/azul), e a leitura caía lá.
  ok('  leu a aba do cabeçalho, não a de precificação', r.debug.aba === 'xl/worksheets/sheet1.xml', String(r.debug.aba));
}

console.log('\n=== resposta fora das opções → erro mostrando o que leu ===');
const lixo = await ler(await comResposta('sei lá, ver depois'));
ok('lança erro', !!lixo.erro);
ok('erro cita o texto lido', /sei lá/.test(lixo.erro || ''), lixo.erro);

console.log('\n=== acento chegando como entidade XML ===');
const ent = await ler(await comResposta('Apenas o cr&#233;dito principal'));
ok('entidade decodificada e opção reconhecida',
  !ent.erro && ent.r?.vars.NEGOCIAR_CREDITO_PRINCIPAL === 'true', ent.erro || '');

fim();
