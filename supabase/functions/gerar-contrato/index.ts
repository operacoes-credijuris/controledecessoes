// ============================================================================
// Edge Function: gerar-contrato
//
// Pipeline portado do credijuris-contratos (Python) para Deno/TypeScript.
//
// Fluxo:
//   1. Browser faz upload dos arquivos pro bucket 'contratos-input' em
//      `{user_id}/{job_id}/{papel}/<arquivo>`  (papel: apresentacao|cedente|escritorio)
//   2. Browser chama esta função com { job_id, investidor_id, intermediador, tipo? }
//   3. Função:
//        a. Valida JWT
//        b. Lê secrets de `configuracoes`
//        c. Lê investidor de `investidores`
//        d. Lê inputs do Storage
//        e. Extrai variáveis via Claude (PDFs vão direto, sem pdfplumber)
//        f. Decide quais contratos gerar (auto pelo TIPO_CREDITO_NEGOCIADO)
//        g. Preenche os templates .docx (JSZip + xmldom — preserva layout)
//        h. Refresh do access_token Google → upload pro Drive
//        i. Insere registro em `contratos_jobs`
//        j. Limpa o bucket temp
//   4. Retorna { drive_folder_url, tipos_gerados, pendentes, variaveis_extraidas }
//
// REGRA CRÍTICA (do CLAUDE.md): preenche APENAS {{VARIAVEIS}}. Texto jurídico
// dos contratos é INTOCÁVEL.
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import JSZip from 'https://esm.sh/jszip@3.10.1';
import { DOMParser, XMLSerializer } from 'https://esm.sh/@xmldom/xmldom@0.8.10';
import { encode as b64encode } from 'https://deno.land/std@0.168.0/encoding/base64.ts';

// ============================================================================
// Constants
// ============================================================================

const CLAUDE_MODEL = 'claude-opus-4-5';
const CLAUDE_MAX_TOKENS = 1500;

const BUCKET_TEMPLATES = 'contratos-templates';
const BUCKET_INPUT = 'contratos-input';

const TEMPLATES: Record<string, string> = {
  cessao_credito:    'cessao_credito.docx',
  cessao_honorarios: 'cessao_honorarios.docx',
  intermediacao:     'intermediacao.docx',
  procuracao:        'procuracao.docx',
};

const REQUIRED_PAPEIS: Record<string, string[]> = {
  cessao_credito:    ['cedente', 'apresentacao'],
  cessao_honorarios: ['escritorio', 'apresentacao'],
  intermediacao:     ['cedente', 'apresentacao'],
  procuracao:        ['apresentacao'],
};

const TIPOS_POR_NEGOCIO: Record<string, string[]> = {
  principal:  ['cessao_credito', 'intermediacao', 'procuracao'],
  honorarios: ['cessao_honorarios', 'intermediacao', 'procuracao'],
  ambos:      ['cessao_credito', 'cessao_honorarios', 'intermediacao', 'procuracao'],
};

// Drive layout (do drive_uploader.py)
const DRIVE_ROOT_NAME = 'Credijuris - Atualizado';
const DRIVE_PROCESSOS_NAME = 'B. Processos';
const DRIVE_CATEGORIA_PADRAO = 'Requisições de Pequeno Valor';
const DRIVE_SUBPASTAS = [
  '1. Análise(s) de crédito',
  '2. Contratos assinados',
  '3. Comprovantes de pagamento',
  '4. Documentos do cedente e advogado',
  '5. Petições',
  '6. Desempenho final',
  '7. RPV complementar',
];
const DRIVE_PASTA_CONTRATOS = '2. Contratos assinados';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Word XML namespace
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ============================================================================
// Types & Schemas
// ============================================================================

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

type Vars = Record<string, string | null>;

const SCHEMA_CEDENTE: Vars = {
  CEDENTE_NOME: 'nome completo',
  CEDENTE_CPF: 'CPF no formato XXX.XXX.XXX-XX ou null',
  CEDENTE_RG: 'número do RG com órgão emissor ou null',
  CEDENTE_ENDERECO: 'endereço completo com CEP',
  CEDENTE_BANCO: 'nome do banco ou null',
  CEDENTE_AGENCIA: 'número da agência ou null',
  CEDENTE_CONTA: 'número da conta com dígito ou null',
  CEDENTE_PIX: 'chave PIX ou null',
};

const SCHEMA_ESCRITORIO: Vars = {
  ESCRITORIO_NOME: 'razão social',
  ESCRITORIO_CNPJ: 'CNPJ no formato XX.XXX.XXX/XXXX-XX',
  ESCRITORIO_ENDERECO: 'endereço completo com CEP',
  ESCRITORIO_SOCIO_NOME: 'nome do sócio responsável',
  ESCRITORIO_SOCIO_CPF: 'CPF do sócio no formato XXX.XXX.XXX-XX',
  ESCRITORIO_SOCIO_ENDERECO: 'endereço do sócio ou null',
  ESCRITORIO_BANCO: 'nome do banco ou null',
  ESCRITORIO_AGENCIA: 'número da agência ou null',
  ESCRITORIO_CONTA: 'número da conta com dígito ou null',
  ESCRITORIO_PIX: 'chave PIX do escritório ou null',
};

const SCHEMA_APRESENTACAO_FIXOS: Vars = {
  NUMERO_PROCESSO: 'número completo do processo judicial',
  VALOR_CREDITO_TOTAL: 'valor total do crédito em R$ X.XXX,XX',
  PERCENTUAL_HONORARIOS: 'percentual de honorários ex: 30% ou null',
  VALOR_HONORARIOS: 'valor dos honorários em R$ X.XXX,XX ou null',
  VALOR_CESSAO: 'valor a ser pago ao cedente em R$ X.XXX,XX',
  TIPO_CREDITO_NEGOCIADO: 'principal | honorarios | ambos — qual parte do crédito está sendo cedida',
  DATA_EXTENSO: 'data de hoje por extenso ex: 07 de maio de 2025',
};

const CLAUDE_SYSTEM_PROMPT =
  'Você é um assistente especializado em leitura de documentos jurídicos e ' +
  'cadastrais brasileiros. Retorne APENAS JSON válido, sem explicações, sem ' +
  'blocos de código markdown. Se uma informação não estiver presente, use null. ' +
  'Formate CPF como XXX.XXX.XXX-XX e CNPJ como XX.XXX.XXX/XXXX-XX. ' +
  'Formate valores monetários como R$ X.XXX,XX.';

// ============================================================================
// Utils
// ============================================================================

function normalizar(s: string): string {
  // Lowercase, sem acento, sem pontuação — pra busca
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.\-/() ]/g, '');
}

function escapeDriveQuery(s: string): string {
  return s.replace(/'/g, "\\'");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400, extra?: Record<string, unknown>) {
  return jsonResponse({ error: message, ...extra }, status);
}

function dataExtenso(): string {
  const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const d = new Date();
  const day = String(d.getDate()).padStart(2,'0');
  return `${day} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================================================
// Document Reading — converte Storage path -> blocos de conteúdo do Claude
// ============================================================================

async function storageGetBytes(sb: ReturnType<typeof createClient>, bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error) throw new Error(`Storage download falhou (${bucket}/${path}): ${error.message}`);
  const buf = await data.arrayBuffer();
  return new Uint8Array(buf);
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

const PDF_EXTS  = new Set(['.pdf']);
const IMG_EXTS  = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const DOCX_EXTS = new Set(['.docx', '.doc']);
const XLSX_EXTS = new Set(['.xlsx', '.xls']);

function mediaTypeForImage(ext: string): string {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png')  return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return '';
  // Extrai texto entre <w:t ...>...</w:t> — suficiente pra Claude entender o conteúdo
  const tags = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  return tags.map(t => t.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, '')).join(' ');
}

async function extractXlsxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  // Lê shared strings
  const ssXml = await zip.file('xl/sharedStrings.xml')?.async('string') || '';
  const ss: string[] = [];
  const ssRe = /<t[^>]*>([^<]*)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = ssRe.exec(ssXml)) !== null) ss.push(m[1]);
  // Lê cada sheet
  const lines: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (!name.match(/^xl\/worksheets\/sheet\d+\.xml$/)) continue;
    const sx = await zip.file(name)?.async('string') || '';
    const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(sx)) !== null) {
      const cells: string[] = [];
      const cRe = /<c[^>]*?(?:t="([^"]*)")?[^>]*>([\s\S]*?)<\/c>/g;
      let cm: RegExpExecArray | null;
      while ((cm = cRe.exec(rm[1])) !== null) {
        const type = cm[1] || '';
        const inner = cm[2];
        const vMatch = inner.match(/<v>([^<]*)<\/v>/);
        const isMatch = inner.match(/<is>[\s\S]*?<t[^>]*>([^<]*)<\/t>/);
        if (isMatch) cells.push(isMatch[1]);
        else if (type === 's' && vMatch) cells.push(ss[parseInt(vMatch[1], 10)] || '');
        else if (vMatch) cells.push(vMatch[1]);
      }
      if (cells.length) lines.push(cells.join(' | '));
    }
  }
  return lines.join('\n');
}

async function readFileAsContent(
  sb: ReturnType<typeof createClient>,
  bucket: string,
  path: string,
): Promise<ClaudeContentBlock[]> {
  const filename = path.split('/').pop() || path;
  const ext = extOf(path);
  const bytes = await storageGetBytes(sb, bucket, path);
  const header: ClaudeContentBlock = { type: 'text', text: `[Documento: ${filename}]` };

  if (PDF_EXTS.has(ext)) {
    return [header, {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: b64encode(bytes) },
    }];
  }
  if (IMG_EXTS.has(ext)) {
    return [header, {
      type: 'image',
      source: { type: 'base64', media_type: mediaTypeForImage(ext), data: b64encode(bytes) },
    }];
  }
  if (DOCX_EXTS.has(ext)) {
    const text = await extractDocxText(bytes);
    return [header, { type: 'text', text }];
  }
  if (XLSX_EXTS.has(ext)) {
    const text = await extractXlsxText(bytes);
    return [header, { type: 'text', text }];
  }
  // .txt/.md ou desconhecido — tenta decodificar como UTF-8
  const text = new TextDecoder().decode(bytes);
  return [header, { type: 'text', text }];
}

// ============================================================================
// Claude Extraction
// ============================================================================

async function callClaude(apiKey: string, content: ClaudeContentBlock[], schema: Vars): Promise<Vars> {
  const userContent: ClaudeContentBlock[] = [
    ...content,
    {
      type: 'text',
      text:
        'Extraia as informações e retorne APENAS este JSON preenchido ' +
        '(sem markdown, sem explicações):\n' + JSON.stringify(schema, null, 2),
    },
  ];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: CLAUDE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude API ${res.status}: ${txt.slice(0, 500)}`);
  }
  const data = await res.json();
  const block = data.content?.find((c: { type: string }) => c.type === 'text');
  if (!block) throw new Error('Claude retornou sem bloco de texto');
  let raw: string = block.text.trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(raw);
  } catch (_) {
    // Tenta extrair o primeiro objeto JSON do texto
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude retornou JSON inválido: ' + raw.slice(0, 200));
  }
}

async function buildContentFromPaths(
  sb: ReturnType<typeof createClient>,
  paths: string[],
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [];
  for (const p of paths) {
    const chunks = await readFileAsContent(sb, BUCKET_INPUT, p);
    blocks.push(...chunks);
  }
  return blocks;
}

async function extractParte(
  sb: ReturnType<typeof createClient>,
  apiKey: string,
  paths: string[],
  schema: Vars,
): Promise<Vars> {
  const content = await buildContentFromPaths(sb, paths);
  return callClaude(apiKey, content, schema);
}

async function extractApresentacao(
  sb: ReturnType<typeof createClient>,
  apiKey: string,
  paths: string[],
  templateVars: string[],
): Promise<Vars> {
  const content = await buildContentFromPaths(sb, paths);
  // Passo 1 — campos fixos
  const fixos = await callClaude(apiKey, content, SCHEMA_APRESENTACAO_FIXOS);
  // Passo 2 — campos extras que ainda estão no template
  const conhecidos = new Set([
    ...Object.keys(SCHEMA_CEDENTE),
    ...Object.keys(SCHEMA_ESCRITORIO),
    ...Object.keys(SCHEMA_APRESENTACAO_FIXOS),
    'INVESTIDOR_NOME','INVESTIDOR_CPF','INVESTIDOR_RG','INVESTIDOR_ENDERECO',
    'INVESTIDOR_BANCO','INVESTIDOR_AGENCIA','INVESTIDOR_CONTA','INVESTIDOR_PIX',
  ]);
  const extras = templateVars.filter(v => !conhecidos.has(v));
  if (extras.length === 0) return fixos;
  const schemaExtras: Vars = {};
  for (const v of extras) schemaExtras[v] = `valor de ${v} encontrado no documento ou null`;
  const extrasOut = await callClaude(apiKey, content, schemaExtras);
  for (const [k, v] of Object.entries(extrasOut)) {
    if (v !== null && v !== undefined) fixos[k] = v;
  }
  return fixos;
}

// ============================================================================
// DOCX Template Filling (port de filler.py)
// ============================================================================

function getTemplateVariablesFromXml(xml: string): string[] {
  const set = new Set<string>();
  const re = /\{\{([A-Z_]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) set.add(m[1]);
  return Array.from(set);
}

function fillParagraph(para: Element, variables: Vars): number {
  const runs = Array.from(para.getElementsByTagName('w:r'));
  if (runs.length === 0) return 0;

  const runTexts: Array<{ run: Element; text: string; tElems: Element[] }> = runs.map(r => {
    const ts = Array.from(r.getElementsByTagName('w:t'));
    return {
      run: r,
      text: ts.map(t => t.textContent || '').join(''),
      tElems: ts,
    };
  });
  const fullText = runTexts.map(rt => rt.text).join('');
  if (!fullText.includes('{{')) return 0;

  let newText = fullText;
  let count = 0;
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = '{{' + key + '}}';
    if (newText.includes(placeholder)) {
      const replacement = value === null || value === undefined ? '' : String(value);
      newText = newText.split(placeholder).join(replacement);
      count++;
    }
  }
  if (count === 0) return 0;

  // Escreve todo o novo texto no primeiro run, zera os outros
  const first = runTexts[0];
  if (first.tElems.length > 0) {
    first.tElems[0].textContent = newText;
    first.tElems[0].setAttribute('xml:space', 'preserve');
    for (let i = 1; i < first.tElems.length; i++) first.tElems[i].textContent = '';
  } else {
    const doc = para.ownerDocument!;
    const t = doc.createElementNS(W_NS, 'w:t');
    t.setAttribute('xml:space', 'preserve');
    t.textContent = newText;
    first.run.appendChild(t);
  }
  for (let i = 1; i < runTexts.length; i++) {
    for (const t of runTexts[i].tElems) t.textContent = '';
  }
  return count;
}

async function fillTemplate(templateBytes: Uint8Array, variables: Vars): Promise<{ bytes: Uint8Array; pendentes: string[] }> {
  const zip = await JSZip.loadAsync(templateBytes);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Template inválido: word/document.xml não encontrado');
  const xml = await docFile.async('string');

  // Normaliza variáveis (upper case, sem null)
  const normalized: Vars = {};
  for (const [k, v] of Object.entries(variables)) {
    if (v !== null && v !== undefined) normalized[k.toUpperCase()] = String(v);
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  const paragraphs = Array.from(doc.getElementsByTagName('w:p'));
  for (const p of paragraphs) fillParagraph(p as unknown as Element, normalized);

  const serializer = new XMLSerializer();
  let newXml = serializer.serializeToString(doc as unknown as Node);
  // Garante declaração XML correta (xmldom às vezes omite)
  if (!newXml.startsWith('<?xml')) {
    newXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + newXml;
  }
  zip.file('word/document.xml', newXml);
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

  const pendentes = getTemplateVariablesFromXml(newXml);
  return { bytes: out, pendentes };
}

// ============================================================================
// Google Drive
// ============================================================================

async function refreshGoogleAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google OAuth refresh falhou (${res.status}): ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Google OAuth: sem access_token na resposta');
  return data.access_token as string;
}

interface DriveFile { id: string; name: string; mimeType?: string; parents?: string[] }

async function driveListFiles(
  token: string,
  query: string,
  driveId?: string,
): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query,
    fields: 'files(id,name,mimeType,parents)',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    pageSize: '1000',
  });
  if (driveId) {
    params.set('corpora', 'drive');
    params.set('driveId', driveId);
  } else {
    params.set('corpora', 'allDrives');
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive list (${res.status}): ${txt.slice(0, 300)} | query=${query}`);
  }
  const data = await res.json();
  return data.files || [];
}

async function driveFindSharedDrive(token: string, name: string): Promise<{ id: string; name: string } | null> {
  let pageToken: string | undefined;
  while (true) {
    const params = new URLSearchParams({ fields: 'nextPageToken,drives(id,name)' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/drives?${params}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) {
      // pode não ter permissão de listar drives — não é fatal, segue pra busca normal
      return null;
    }
    const data = await res.json();
    for (const d of (data.drives || [])) if (d.name === name) return d;
    pageToken = data.nextPageToken;
    if (!pageToken) return null;
  }
}

async function driveFindChild(token: string, name: string, parentId: string, mime?: string): Promise<DriveFile | null> {
  let q = `name = '${escapeDriveQuery(name)}' and '${parentId}' in parents and trashed = false`;
  if (mime) q += ` and mimeType = '${mime}'`;
  const files = await driveListFiles(token, q);
  return files[0] || null;
}

async function driveCreateFolder(token: string, name: string, parentId: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive criar pasta '${name}' (${res.status}): ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.id;
}

async function driveFindOrCreateFolder(token: string, name: string, parentId: string): Promise<string> {
  const existing = await driveFindChild(token, name, parentId, FOLDER_MIME);
  if (existing) return existing.id;
  return driveCreateFolder(token, name, parentId);
}

async function driveEncontrarProcessosFolder(token: string): Promise<string> {
  const drive = await driveFindSharedDrive(token, DRIVE_ROOT_NAME);
  if (drive) {
    const q = `name = '${escapeDriveQuery(DRIVE_PROCESSOS_NAME)}' and '${drive.id}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`;
    const files = await driveListFiles(token, q, drive.id);
    if (files[0]) return files[0].id;
    throw new Error(`Shared Drive '${DRIVE_ROOT_NAME}' achado, mas pasta '${DRIVE_PROCESSOS_NAME}' não existe nele.`);
  }
  // Fallback: pasta normal
  const roots = await driveListFiles(token, `name = '${escapeDriveQuery(DRIVE_ROOT_NAME)}' and trashed = false and mimeType = '${FOLDER_MIME}'`);
  if (!roots[0]) throw new Error(`'${DRIVE_ROOT_NAME}' não encontrado no Drive. Confirma que a conta do refresh_token tem acesso.`);
  const processos = await driveFindChild(token, DRIVE_PROCESSOS_NAME, roots[0].id, FOLDER_MIME);
  if (!processos) throw new Error(`Pasta '${DRIVE_PROCESSOS_NAME}' não existe dentro de '${DRIVE_ROOT_NAME}'.`);
  return processos.id;
}

async function driveListIntermediadores(token: string, processosId: string): Promise<Array<{ id: string; name: string; categoria: string }>> {
  const cats = await driveListFiles(
    token,
    `'${processosId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
  );
  const out: Array<{ id: string; name: string; categoria: string }> = [];
  for (const cat of cats) {
    if (cat.name !== DRIVE_CATEGORIA_PADRAO) continue; // só RPV por enquanto (matching Python default)
    const subs = await driveListFiles(
      token,
      `'${cat.id}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
    for (const s of subs) out.push({ id: s.id, name: s.name, categoria: cat.name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return out;
}

async function driveGarantirEstruturaCedente(token: string, intermediadorId: string, nomePasta: string): Promise<string> {
  const cedenteId = await driveFindOrCreateFolder(token, nomePasta, intermediadorId);
  let contratosId = '';
  for (const sub of DRIVE_SUBPASTAS) {
    const id = await driveFindOrCreateFolder(token, sub, cedenteId);
    if (sub === DRIVE_PASTA_CONTRATOS) contratosId = id;
  }
  if (!contratosId) throw new Error(`Subpasta '${DRIVE_PASTA_CONTRATOS}' não pôde ser criada.`);
  return contratosId;
}

async function driveUploadDocx(token: string, name: string, parentId: string, bytes: Uint8Array, sobrescrever = true): Promise<{ id: string; webViewLink?: string }> {
  if (sobrescrever) {
    const existing = await driveFindChild(token, name, parentId);
    if (existing) {
      await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?supportsAllDrives=true`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
    }
  }
  // Multipart upload (mais simples que resumable pra arquivos pequenos)
  const boundary = '-------cred' + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${DOCX_MIME}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive upload '${name}' (${res.status}): ${txt.slice(0, 300)}`);
  }
  return await res.json();
}

// ============================================================================
// Pipeline helpers
// ============================================================================

function determinarTipos(tipoExplicito: string | null | undefined, tipoNegociado: string | null | undefined): string[] {
  if (tipoExplicito && TEMPLATES[tipoExplicito]) return [tipoExplicito];
  const chave = normalizar(tipoNegociado || 'principal');
  if (chave.includes('ambos') || (chave.includes('principal') && chave.includes('honorar'))) {
    return TIPOS_POR_NEGOCIO.ambos;
  }
  if (chave.includes('honorar')) return TIPOS_POR_NEGOCIO.honorarios;
  return TIPOS_POR_NEGOCIO.principal;
}

interface InputPaths { apresentacao: string[]; cedente: string[]; escritorio: string[] }

async function listInputPaths(sb: ReturnType<typeof createClient>, jobPrefix: string): Promise<InputPaths> {
  const out: InputPaths = { apresentacao: [], cedente: [], escritorio: [] };
  for (const papel of ['apresentacao','cedente','escritorio'] as const) {
    const { data, error } = await sb.storage.from(BUCKET_INPUT).list(`${jobPrefix}/${papel}`, { limit: 100 });
    if (error) continue; // pasta pode não existir
    for (const f of (data || [])) {
      if (f.name && f.name !== '.emptyFolderPlaceholder') {
        out[papel].push(`${jobPrefix}/${papel}/${f.name}`);
      }
    }
  }
  return out;
}

async function cleanupInputs(sb: ReturnType<typeof createClient>, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try { await sb.storage.from(BUCKET_INPUT).remove(paths); } catch (_) { /* best-effort */ }
}

// ============================================================================
// HTTP Handler
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  let jobRow: { id: string } | null = null;
  let sbAdmin: ReturnType<typeof createClient> | null = null;
  let inputPathsAll: string[] = [];

  try {
    // 1. Auth — valida JWT do usuário
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse('Não autenticado', 401);
    }
    const userJwt = authHeader.slice(7);
    const sbUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: 'Bearer ' + userJwt } } },
    );
    const { data: userData, error: authErr } = await sbUser.auth.getUser();
    if (authErr || !userData?.user) return errorResponse('Sessão inválida ou expirada', 401);
    const userId = userData.user.id;

    // 2. Parse body
    const body = await req.json();
    const jobId: string = body.job_id;
    const investidorId: string = body.investidor_id;
    const intermediadorNome: string = body.intermediador;
    const tipoExplicito: string | null = body.tipo || null;
    if (!jobId || !investidorId || !intermediadorNome) {
      return errorResponse('Campos obrigatórios: job_id, investidor_id, intermediador');
    }

    // 3. Service-role client (lê secrets, faz cleanup, escreve auditoria)
    sbAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 4. Carrega secrets
    const { data: cfgRows, error: cfgErr } = await sbAdmin
      .from('configuracoes')
      .select('chave,valor')
      .in('chave', ['anthropic_api_key','google_oauth_client_id','google_oauth_client_secret','google_oauth_refresh_token']);
    if (cfgErr) throw new Error('Erro lendo configuracoes: ' + cfgErr.message);
    const cfg: Record<string, string> = {};
    for (const r of (cfgRows || [])) cfg[r.chave] = r.valor;
    for (const k of ['anthropic_api_key','google_oauth_client_id','google_oauth_client_secret','google_oauth_refresh_token']) {
      if (!cfg[k]) return errorResponse(`Secret '${k}' não configurado em configuracoes`, 500);
    }

    // 5. Carrega investidor
    const { data: inv, error: invErr } = await sbAdmin
      .from('investidores')
      .select('*')
      .eq('id', investidorId)
      .single();
    if (invErr || !inv) return errorResponse('Investidor não encontrado', 404);

    // 6. Cria registro do job (status=processing)
    const { data: createdJob, error: jobErr } = await sbAdmin
      .from('contratos_jobs')
      .insert({
        id: jobId,
        user_id: userId,
        investidor_id: investidorId,
        tipos: [],
        intermediador: intermediadorNome,
        status: 'processing',
      })
      .select('id')
      .single();
    if (jobErr) throw new Error('Erro criando job: ' + jobErr.message);
    jobRow = createdJob;

    // 7. Lista arquivos de input no Storage
    const jobPrefix = `${userId}/${jobId}`;
    const inputPaths = await listInputPaths(sbAdmin, jobPrefix);
    inputPathsAll = [...inputPaths.apresentacao, ...inputPaths.cedente, ...inputPaths.escritorio];
    if (inputPaths.apresentacao.length === 0) {
      return errorResponse(`Pasta '${jobPrefix}/apresentacao' está vazia no bucket ${BUCKET_INPUT}`, 400);
    }

    // 8. Lê templates do bucket → coleta união de variáveis
    const templateBytes: Record<string, Uint8Array> = {};
    const templateVarsByTipo: Record<string, string[]> = {};
    const allTemplateVars = new Set<string>();
    for (const [tipo, fname] of Object.entries(TEMPLATES)) {
      const bytes = await storageGetBytes(sbAdmin, BUCKET_TEMPLATES, fname);
      templateBytes[tipo] = bytes;
      const zip = await JSZip.loadAsync(bytes);
      const xml = await zip.file('word/document.xml')?.async('string') || '';
      const vars = getTemplateVariablesFromXml(xml);
      templateVarsByTipo[tipo] = vars;
      for (const v of vars) allTemplateVars.add(v);
    }

    // 9. Extrações em paralelo
    const apresentacaoP = extractApresentacao(sbAdmin, cfg.anthropic_api_key, inputPaths.apresentacao, Array.from(allTemplateVars));
    const cedenteP = inputPaths.cedente.length > 0
      ? extractParte(sbAdmin, cfg.anthropic_api_key, inputPaths.cedente, SCHEMA_CEDENTE)
      : Promise.resolve<Vars>({});
    const escritorioP = inputPaths.escritorio.length > 0
      ? extractParte(sbAdmin, cfg.anthropic_api_key, inputPaths.escritorio, SCHEMA_ESCRITORIO)
      : Promise.resolve<Vars>({});
    const [apresentacao, cedente, escritorio] = await Promise.all([apresentacaoP, cedenteP, escritorioP]);

    // 10. Junta variáveis (precedência: apresentação > cedente/escritório > investidor)
    const dados: Vars = {
      INVESTIDOR_NOME: inv.nome,
      INVESTIDOR_CPF: inv.cpf,
      INVESTIDOR_RG: inv.rg,
      INVESTIDOR_ENDERECO: inv.endereco,
      INVESTIDOR_BANCO: inv.banco,
      INVESTIDOR_AGENCIA: inv.agencia,
      INVESTIDOR_CONTA: inv.conta,
      INVESTIDOR_PIX: inv.pix,
      DATA_EXTENSO: dataExtenso(),
      ...cedente,
      ...escritorio,
      ...apresentacao,
    };

    // 11. Decide tipos a gerar e valida papéis necessários
    const tipos = determinarTipos(tipoExplicito, apresentacao.TIPO_CREDITO_NEGOCIADO || null);
    const papeisNecessarios = new Set<string>();
    for (const t of tipos) for (const p of REQUIRED_PAPEIS[t]) papeisNecessarios.add(p);
    papeisNecessarios.delete('apresentacao');
    const faltando: string[] = [];
    for (const p of papeisNecessarios) {
      if (p === 'cedente' && inputPaths.cedente.length === 0) faltando.push('cedente');
      if (p === 'escritorio' && inputPaths.escritorio.length === 0) faltando.push('escritorio');
    }
    if (faltando.length > 0) {
      return errorResponse(`Faltam documentos: ${faltando.join(', ')}`, 400, { tipos, faltando });
    }

    // 12. Preenche cada template e coleta pendentes
    const arquivosGerados: Array<{ tipo: string; nome: string; bytes: Uint8Array; pendentes: string[] }> = [];
    for (const tipo of tipos) {
      const { bytes, pendentes } = await fillTemplate(templateBytes[tipo], dados);
      arquivosGerados.push({
        tipo,
        nome: `contrato_${tipo}_${dateStamp()}.docx`,
        bytes,
        pendentes,
      });
    }

    // 13. Drive: refresh token + walk + create + upload
    const accessToken = await refreshGoogleAccessToken(
      cfg.google_oauth_client_id,
      cfg.google_oauth_client_secret,
      cfg.google_oauth_refresh_token,
    );
    const processosId = await driveEncontrarProcessosFolder(accessToken);
    const intermediadores = await driveListIntermediadores(accessToken, processosId);
    const interTermo = normalizar(intermediadorNome);
    const interMatch = intermediadores.find(i => normalizar(i.name) === interTermo)
                    ?? intermediadores.find(i => normalizar(i.name).includes(interTermo));
    if (!interMatch) {
      return errorResponse(`Intermediador '${intermediadorNome}' não encontrado no Drive`, 404, {
        intermediadores_disponiveis: intermediadores.map(i => i.name),
      });
    }
    const nomeTitular = (escritorio.ESCRITORIO_NOME || cedente.CEDENTE_NOME || inv.nome) ?? 'sem-titular';
    const processo = apresentacao.NUMERO_PROCESSO || 'sem-processo';
    const nomePastaCedente = `${nomeTitular} - ${processo}`;
    const contratosFolderId = await driveGarantirEstruturaCedente(accessToken, interMatch.id, nomePastaCedente);
    const uploads: Array<{ tipo: string; nome: string; drive_id: string; webViewLink?: string; pendentes: string[] }> = [];
    for (const a of arquivosGerados) {
      const r = await driveUploadDocx(accessToken, a.nome, contratosFolderId, a.bytes);
      uploads.push({ tipo: a.tipo, nome: a.nome, drive_id: r.id, webViewLink: r.webViewLink, pendentes: a.pendentes });
    }

    // 14. Folder URL
    const folderUrl = `https://drive.google.com/drive/folders/${contratosFolderId}`;

    // 15. Atualiza job com sucesso
    const todasPendentes = Array.from(new Set(arquivosGerados.flatMap(a => a.pendentes)));
    await sbAdmin.from('contratos_jobs').update({
      status: 'ok',
      tipos,
      numero_processo: apresentacao.NUMERO_PROCESSO || null,
      cedente_nome: nomeTitular,
      drive_folder_id: contratosFolderId,
      drive_folder_url: folderUrl,
      variaveis_extraidas: dados,
      pendentes: todasPendentes,
      arquivos_input: inputPaths,
      arquivos_output: uploads.map(u => u.nome),
    }).eq('id', jobId);

    // 16. Limpa inputs do Storage
    await cleanupInputs(sbAdmin, inputPathsAll);

    return jsonResponse({
      success: true,
      job_id: jobId,
      tipos_gerados: tipos,
      drive_folder_url: folderUrl,
      uploads,
      variaveis_extraidas: dados,
      pendentes: todasPendentes,
    });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[gerar-contrato] erro:', msg);
    // Marca job como erro (best-effort)
    if (jobRow && sbAdmin) {
      try {
        await sbAdmin.from('contratos_jobs').update({ status: 'erro', erro_msg: msg }).eq('id', jobRow.id);
      } catch (_) { /* ignore */ }
    }
    return errorResponse(msg, 500);
  }
});
