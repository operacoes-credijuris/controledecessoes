// Recorta funções do index.ts, transpila com esbuild e devolve o módulo pronto pra usar.
//
// Recorte em vez de import direto porque o index.ts importa de URLs (Deno) que o Node não
// resolve; e em vez de copiar a lógica pra cá porque cópia envelhece calada. Se um marcador
// deixar de existir, o teste quebra com "nao achei: <marcador>" — que é o aviso certo.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const AQUI = import.meta.dirname;
export const REPO = join(AQUI, '..', '..', '..', '..');
export const FONTE = join(REPO, 'supabase', 'functions', 'gerar-contrato', 'index.ts');

const src = readFileSync(FONTE, 'utf8').replace(/\r\n/g, '\n');

// Recorta de `marcador` até `fecha` (primeira ocorrência). Todo top-level do arquivo tem
// indentação 0, então "\n}\n" fecha função e "\n};\n" / "\n];\n" fecham const de objeto/array.
export function corta(marcador, fecha = '\n}\n') {
  const i = src.indexOf(marcador);
  if (i < 0) throw new Error(`nao achei: ${marcador}`);
  const fim = src.indexOf(fecha, i);
  if (fim < 0) throw new Error(`sem fim: ${marcador}`);
  return src.slice(i, fim + fecha.length);
}

// Recorta uma linha inteira por regex (pra `const X = '...'` e `interface Y { ... }` de 1 linha).
export function cortaLinha(regex) {
  const m = src.match(regex);
  if (!m) throw new Error(`nao achei linha: ${regex}`);
  return m[0] + '\n';
}

// Monta um módulo com os pedaços, transpila e importa. `nome` só serve pro arquivo temp.
export async function montar(nome, pedacos) {
  const dir = join(tmpdir(), 'gerar-contrato-tests');
  mkdirSync(dir, { recursive: true });
  const ts = join(dir, `${nome}.ts`);
  writeFileSync(ts, pedacos.join('\n'), 'utf8');
  // nomes relativos + cwd: caminhos com espaço quebram em dois argumentos no shell do npx
  execFileSync('npx', ['--yes', 'esbuild@0.21.5', `--outfile=${nome}.mjs`, '--format=esm', '--platform=node', `${nome}.ts`],
    { cwd: dir, stdio: 'pipe', shell: true });
  return await import('file://' + join(dir, `${nome}.mjs`));
}

// Instala uma dependência npm num diretório temporário e devolve o módulo.
export async function dep(pacote) {
  const dir = join(tmpdir(), 'gerar-contrato-tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }', 'utf8');
  execFileSync('npm', ['install', pacote, '--silent', '--no-fund', '--no-audit'], { cwd: dir, stdio: 'pipe', shell: true });
  return await import('file://' + join(dir, 'node_modules', pacote, 'dist', 'jszip.min.js').replace(/\\/g, '/'));
}

// ---------- asserções ----------
export const estado = { falhas: 0 };

export function ok(nome, cond, extra = '') {
  console.log(`${cond ? '  PASS ' : '  FALHA'}  ${nome}${extra ? ' — ' + extra : ''}`);
  if (!cond) estado.falhas++;
}

export function eq(nome, obtido, esperado) {
  const a = JSON.stringify(obtido), b = JSON.stringify(esperado);
  console.log(`${a === b ? '  PASS ' : '  FALHA'}  ${nome}\n           ${a}${a === b ? '' : `\n  esperado ${b}`}`);
  if (a !== b) estado.falhas++;
}

export function lanca(nome, fn, regex) {
  try {
    fn();
    console.log(`  FALHA  ${nome} — não lançou erro`);
    estado.falhas++;
  } catch (e) {
    const bate = regex.test(e.message);
    console.log(`${bate ? '  PASS ' : '  FALHA'}  ${nome} — ${e.message.slice(0, 100)}`);
    if (!bate) estado.falhas++;
  }
}

export function fim() {
  console.log(estado.falhas === 0 ? '\nTUDO PASSOU\n' : `\n${estado.falhas} FALHA(S)\n`);
  process.exit(estado.falhas === 0 ? 0 : 1);
}
