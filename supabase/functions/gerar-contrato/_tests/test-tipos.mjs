// Quais contratos a geração produz. Ver README.md desta pasta.
import { corta, montar, eq, lanca, fim } from './_harness.mjs';

const { determinarTipos, TEMPLATES } = await montar('tipos', [
  `type Vars = Record<string, string | null>;`,
  corta('const TEMPLATES: Record<string, string> = {', '\n};\n'),
  corta('function normalizar('),
  corta('function parseBool('),
  corta('function ehPrecatorio('),
  corta('function tiposPadraoDaCategoria('),
  corta('function determinarTipos('),
  `export { determinarTipos, tiposPadraoDaCategoria, TEMPLATES };`,
]);

const RPV = 'Requisições de Pequeno Valor';
const PREC = 'Precatórios';
// Quadro da análise: tudo "false" por padrão, sobrescreve o que o caso precisa.
const quadro = (o) => ({
  NEGOCIAR_CREDITO_PRINCIPAL: 'false',
  NEGOCIAR_HONORARIOS_CONTRATUAIS: 'false',
  NEGOCIAR_HONORARIOS_SUCUMBENCIAIS: 'false',
  ...o,
});

console.log('\n=== escolha manual: vale exatamente o que foi marcado ===');
eq('só procuração', determinarTipos(null, ['procuracao'], {}, RPV), ['procuracao']);
eq('cessão sem intermediação nem procuração', determinarTipos(null, ['cessao_credito'], {}, RPV), ['cessao_credito']);
eq('manual ganha do quadro da análise',
  determinarTipos(null, ['procuracao'], quadro({ NEGOCIAR_CREDITO_PRINCIPAL: 'true' }), RPV), ['procuracao']);
eq('manual ganha da categoria precatório', determinarTipos(null, ['cessao_credito'], {}, PREC), ['cessao_credito']);
eq('ordem canônica, não a ordem em que os checkboxes vieram',
  determinarTipos(null, ['procuracao', 'cessao_honorarios_sucumbenciais', 'cessao_credito'], {}, RPV),
  ['cessao_credito', 'cessao_honorarios_sucumbenciais', 'procuracao']);
lanca('tipo inexistente', () => determinarTipos(null, ['cessao_inventada'], {}, RPV), /desconhecido/i);

console.log('\n=== precatório: 2 documentos, nunca cessão ===');
eq('automático', determinarTipos(null, null, {}, PREC), ['intermediacao', 'procuracao']);
eq('ignora quadro dizendo principal + honorários',
  determinarTipos(null, null, quadro({ NEGOCIAR_CREDITO_PRINCIPAL: 'true', NEGOCIAR_HONORARIOS_CONTRATUAIS: 'true' }), PREC),
  ['intermediacao', 'procuracao']);
eq('tolera grafia sem acento', determinarTipos(null, null, {}, 'precatorios'), ['intermediacao', 'procuracao']);

console.log('\n=== RPV automático: sai do quadro da análise ===');
eq('apenas o crédito principal',
  determinarTipos(null, null, quadro({ NEGOCIAR_CREDITO_PRINCIPAL: 'true' }), RPV),
  ['cessao_credito', 'intermediacao', 'procuracao']);
eq('crédito principal e honorários (as duas cessões de honorários)',
  determinarTipos(null, null, quadro({ NEGOCIAR_CREDITO_PRINCIPAL: 'true', NEGOCIAR_HONORARIOS_CONTRATUAIS: 'true', NEGOCIAR_HONORARIOS_SUCUMBENCIAIS: 'true' }), RPV),
  ['cessao_credito', 'cessao_honorarios_contratuais', 'cessao_honorarios_sucumbenciais', 'intermediacao', 'procuracao']);
eq('apenas os honorários — sem cessão de crédito',
  determinarTipos(null, null, quadro({ NEGOCIAR_HONORARIOS_CONTRATUAIS: 'true', NEGOCIAR_HONORARIOS_SUCUMBENCIAIS: 'true' }), RPV),
  ['cessao_honorarios_contratuais', 'cessao_honorarios_sucumbenciais', 'intermediacao', 'procuracao']);
lanca('quadro sem nada marcado', () => determinarTipos(null, null, quadro({}), RPV), /não indicou nenhum/i);
lanca('quadro ausente — a IA não é mais fallback', () => determinarTipos(null, null, {}, RPV), /não indicou nenhum/i);

console.log('\n=== compatibilidade com o dropdown de tipo único ===');
eq('cessão única ainda arrasta intermediação + procuração',
  determinarTipos('cessao_credito', null, {}, RPV), ['cessao_credito', 'intermediacao', 'procuracao']);
eq('procuração única fica só ela', determinarTipos('procuracao', null, {}, RPV), ['procuracao']);
eq('lista vazia não conta como escolha manual',
  determinarTipos(null, [], quadro({ NEGOCIAR_CREDITO_PRINCIPAL: 'true' }), RPV),
  ['cessao_credito', 'intermediacao', 'procuracao']);

console.log('\n=== todo tipo gerado tem template ===');
const gerados = new Set([
  ...determinarTipos(null, null, quadro({ NEGOCIAR_CREDITO_PRINCIPAL: 'true', NEGOCIAR_HONORARIOS_CONTRATUAIS: 'true', NEGOCIAR_HONORARIOS_SUCUMBENCIAIS: 'true' }), RPV),
  ...determinarTipos(null, null, {}, PREC),
]);
eq('nenhum tipo sem entrada em TEMPLATES', [...gerados].filter(t => !TEMPLATES[t]), []);

fim();
