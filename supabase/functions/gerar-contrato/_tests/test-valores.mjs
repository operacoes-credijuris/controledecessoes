// Leitura do "Valor total da operação" (= CAPITAL_INVESTIDO da Cláusula 10.1 do
// contrato de originação/intermediação/gestão). Ver README.md desta pasta.
//
// As duas análises guardam esse número em geometrias diferentes, e o valor vai
// impresso num contrato assinado — pegar a célula errada é erro caro e silencioso.
// Os números dos casos são reais, da análise de precatório da Tatiana Hiiga
// (0001747-82.2015.5.02.0032), a mesma dos prints de 2026-08-06.
import { corta, cortaLinha, montar, dep, eq, ok, fim } from './_harness.mjs';

const JSZip = (await dep('jszip')).default;
const { detectValorTotalOperacaoFromXlsx, detectCenarioNegociadoFromXlsx, classeAtivo } = await montar('valores', [
  `import JSZip from 'jszip';`,
  `type Vars = Record<string, string | null>;`,
  corta('function normalizar('),
  corta('function colLetterFromRef('),
  corta('async function readSharedStrings('),
  corta('function decodeXmlEntities('),
  corta('const CENARIOS_NEGOCIACAO', '\n];\n'),
  cortaLinha(/^interface XlsxCell .*$/m),
  corta('function parseSheetCells('),
  corta('function linhaDaRef('),
  corta('function celulaNumerica('),
  corta('function ehPrecatorio('),
  corta('async function detectCenarioNegociadoFromXlsx('),
  corta('function classeAtivo('),
  corta('function formatBRL('),
  corta('function nextCol('),
  cortaLinha(/^const VTO_LINHAS_ABAIXO = .*$/m),
  corta('async function detectValorTotalOperacaoFromXlsx('),
  `export { detectValorTotalOperacaoFromXlsx, detectCenarioNegociadoFromXlsx, classeAtivo };`,
]);

// Monta um .xlsx mínimo com as células dadas: { A1: 'texto', B2: 1234.5 }.
// Usa t="inlineStr" e não gera sharedStrings.xml — igual aos modelos atuais.
async function planilha(celulas) {
  const porLinha = new Map();
  for (const [ref, valor] of Object.entries(celulas)) {
    const [, col, linha] = ref.match(/^([A-Z]+)(\d+)$/);
    if (!porLinha.has(linha)) porLinha.set(linha, []);
    porLinha.get(linha).push(
      typeof valor === 'number'
        ? `<c r="${ref}"><v>${valor}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${valor.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`,
    );
  }
  const rows = [...porLinha.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([n, cs]) => `<row r="${n}">${cs.join('')}</row>`).join('');
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file('xl/workbook.xml',
    `<?xml version="1.0"?><workbook><sheets><sheet name="P" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/worksheets/sheet1.xml',
    `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`);
  return await zip.generateAsync({ type: 'uint8array' });
}

const ROTULO = 'Valor total da operação\n**sem considerar atualização monetária estimada';

console.log('\n=== RPV: valor na célula à direita do rótulo ===');
eq('pega a célula à direita',
  await detectValorTotalOperacaoFromXlsx(await planilha({ X4: ROTULO, Y4: 61694.31 })),
  'R$ 61.694,31');

console.log('\n=== Precatório: rótulo é cabeçalho de coluna, valores nos cenários abaixo ===');
// Layout real: uma linha de rótulos, e abaixo um par (rótulo do cenário, valores) por
// cenário. Só o cenário negociado está preenchido — aqui o 1, "só o principal".
const precatorio = {
  B5: 'Valor líquido homologado (total do crédito disponível)',
  C5: ROTULO,
  D5: 'Custo da escritura pública',
  E5: 'Valor da aquisição (quanto o(s) credor(es) receberá(ão))',
  A6: '1) Negociando só o principal:',
  B7: 108672.77, C7: 61694.31, D7: 2923.31, E7: 49011.42,
  A8: '2) Negociando principal e honorários (S):',
  A10: '3) Negociando só honorários (S):',
};
eq('pega o valor do cenário preenchido, não o rótulo vizinho',
  await detectValorTotalOperacaoFromXlsx(await planilha(precatorio)),
  'R$ 61.694,31');

console.log('\n=== Precatório: cenário 3 preenchido (só honorários) ===');
eq('desce até o cenário que tem número',
  await detectValorTotalOperacaoFromXlsx(await planilha({
    B5: 'Valor líquido homologado (total do crédito disponível)',
    C5: ROTULO,
    D5: 'Custo da escritura pública',
    A6: '1) Negociando só o principal:',
    A8: '2) Negociando principal e honorários (S):',
    A10: '3) Negociando só honorários (S):',
    B11: 40000, C11: 22500.5,
  })),
  'R$ 22.500,50');

console.log('\n=== armadilha do "Ganho de capital projetado" ===');
// Na análise de RPV existe "Ganho de capital projetado … (Valor líquido com a
// atualização - valor total da operação)", que CONTÉM a frase e tem outro número ao
// lado. Por isso o casamento é startsWith, não includes.
eq('ignora rótulo que só contém a frase',
  await detectValorTotalOperacaoFromXlsx(await planilha({
    X41: 'Ganho de capital projetado, considerando a atualização prevista (Valor líquido com a atualização - valor total da operação)',
    Y41: 999999.99,
    X4: ROTULO,
    Y4: 61694.31,
  })),
  'R$ 61.694,31');

console.log('\n=== casos em que tem que devolver null (a IA assume) ===');
ok('rótulo ausente',
  (await detectValorTotalOperacaoFromXlsx(await planilha({ A1: 'Processo', B1: '0001747-82.2015.5.02.0032' }))) === null);
ok('rótulo presente mas nenhum cenário preenchido',
  (await detectValorTotalOperacaoFromXlsx(await planilha({ C5: ROTULO, D5: 'Custo da escritura pública', A6: '1) Negociando só o principal:' }))) === null);
ok('cenário zerado não conta como preenchido',
  (await detectValorTotalOperacaoFromXlsx(await planilha({ C5: ROTULO, C7: 0 }))) === null);

console.log('\n=== formato de saída ===');
eq('milhar com ponto e centavos com vírgula',
  await detectValorTotalOperacaoFromXlsx(await planilha({ X4: ROTULO, Y4: 1234567.5 })),
  'R$ 1.234.567,50');

// ---------------------------------------------------------------------------
// Cenário negociado → CLASSE_ATIVO
// ---------------------------------------------------------------------------

const CEN = {
  p:  '1) Negociando só o principal:',
  ph: '2) Negociando principal e honorários (S):',
  h:  '3) Negociando só honorários (S):',
};
// Três cenários declarados; `linhaComNumero` diz em qual faixa entram os números.
async function comCenario(linhaComNumero) {
  const c = { C5: ROTULO, A6: CEN.p, A8: CEN.ph, A10: CEN.h };
  if (linhaComNumero) { c[`B${linhaComNumero}`] = 108672.77; c[`C${linhaComNumero}`] = 61694.31; }
  return await planilha(c);
}

console.log('\n=== cenário negociado (análise de precatório) ===');
eq('cenário 1 preenchido → só o principal',
  (await detectCenarioNegociadoFromXlsx(await comCenario(7)))?.rotulo, 'só o principal');
eq('cenário 2 preenchido → principal e honorários',
  (await detectCenarioNegociadoFromXlsx(await comCenario(9)))?.rotulo, 'principal e honorários');
eq('cenário 3 preenchido → só honorários',
  (await detectCenarioNegociadoFromXlsx(await comCenario(11)))?.rotulo, 'só honorários');
ok('nenhum preenchido → null (a IA assume)',
  (await detectCenarioNegociadoFromXlsx(await comCenario(null))) === null);
ok('dois preenchidos → null, planilha ambígua não vira palpite',
  (await detectCenarioNegociadoFromXlsx(await planilha({
    C5: ROTULO, A6: CEN.p, B7: 1, A8: CEN.ph, B9: 2, A10: CEN.h,
  }))) === null);
ok('análise sem cenários → null',
  (await detectCenarioNegociadoFromXlsx(await planilha({ A1: 'Processo', A3: 'Vai ser negociado aqui quais créditos?' }))) === null);
ok('zero não conta como preenchido',
  (await detectCenarioNegociadoFromXlsx(await planilha({ C5: ROTULO, A6: CEN.p, B7: 0, A8: CEN.ph, A10: CEN.h }))) === null);

console.log('\n=== classeAtivo(categoria, principal, honorários) ===');
const RPV = 'Requisições de Pequeno Valor';
const PREC = 'Precatórios';
eq('precatório, só principal',           classeAtivo(PREC, true,  false), 'Precatório');
eq('precatório, só honorários',          classeAtivo(PREC, false, true),  'Honorário em precatório');
eq('precatório, principal e honorários', classeAtivo(PREC, true,  true),  'Honorário em precatório');
eq('RPV, só principal',                  classeAtivo(RPV,  true,  false), 'RPV');
eq('RPV, principal e honorários',        classeAtivo(RPV,  true,  true),  'Honorário em RPV combinado');
eq('RPV, só honorários',                 classeAtivo(RPV,  false, true),  'Honorário em RPV isolado');
eq('sem sinal nenhum → null',            classeAtivo(RPV,  false, false), null);
eq('categoria sem acento',               classeAtivo('precatorios', true, false), 'Precatório');

fim();
