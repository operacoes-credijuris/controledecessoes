// ============================================================================
// Edge Function: gerar-peticao
//
// Diferente do gerar-contrato:
//   - sem PDFs / sem Claude — dados ja vem prontos do frontend (CACHE).
//   - sem Google Drive — retorna o .docx em base64 pro browser baixar direto.
//
// Fluxo:
//   1. Browser chama com { tipo, dados }
//   2. Funcao valida JWT, baixa template de `peticoes-templates/{tipo}.docx`
//   3. Preenche placeholders (mesmo motor JSZip + xmldom do gerar-contrato)
//   4. Retorna { docx_base64, filename, pendentes }
//
// REGRA CRITICA: o motor de preenchimento eh COPIA do filler.py do
// gerar-contrato (so troca {{VARIAVEIS}}, nao toca em texto juridico).
// ============================================================================

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import JSZip from 'https://esm.sh/jszip@3.10.1';
import { DOMParser, XMLSerializer } from 'https://esm.sh/@xmldom/xmldom@0.8.10';
import { encode as b64encode } from 'https://deno.land/std@0.168.0/encoding/base64.ts';

const BUCKET_TEMPLATES = 'peticoes-templates';

const TEMPLATES: Record<string, string> = {
  levantamento:     'levantamento.docx',
  sequestro:        'sequestro.docx',
  ilegitimidade:    'ilegitimidade.docx',
  rpv_complementar: 'rpv_complementar.docx',
  registro_publico: 'registro_publico.docx',
  homologacao:      'homologacao.docx',
  // Templates para o fluxo IA — o corpo central é gerado pelo Claude
  ai_com_qualif:    'ai_com_qualif.docx',
  ai_sem_qualif:    'ai_sem_qualif.docx',
};

const CLAUDE_MODEL = 'claude-opus-4-5';
const BUCKET_INPUT_IA = 'peticoes-input-ia'; // anexos temporários do fluxo IA

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Vars = Record<string, string | null>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400, extra?: Record<string, unknown>) {
  return jsonResponse({ error: message, ...extra }, status);
}

function sanitizeFilenamePart(s: string | null | undefined): string {
  if (!s) return '';
  return String(s).replace(/[\/\\:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim();
}

function nomeArquivo(tipo: string, dados: Vars, tituloOverride?: string | null): string {
  const cessionario = sanitizeFilenamePart(dados.NOME_CESSIONARIO) || 'Cessionario';
  const processo    = sanitizeFilenamePart(dados.NUMERO_PROCESSO) || 'sem-processo';
  const labels: Record<string, string> = {
    levantamento:     'Petição de Levantamento',
    sequestro:        'Petição de Sequestro',
    ilegitimidade:    'Petição de Ilegitimidade Passiva',
    rpv_complementar: 'Petição de RPV Complementar',
    registro_publico: 'Petição de Juntada de Registro Público',
    homologacao:      'Petição de Homologação de Cessão',
    ai_com_qualif:    'Petição Personalizada (IA)',
    ai_sem_qualif:    'Petição Personalizada (IA)',
  };
  // Se houver titulo override (vindo do Claude pros tipos IA), usa ele
  const labelTipo = tituloOverride
    ? sanitizeFilenamePart(tituloOverride)
    : (labels[tipo] || `Petição - ${tipo}`);
  return `${labelTipo} - ${cessionario} - ${processo}.docx`;
}

// ============================================================================
// DOCX Template Filling — copia do gerar-contrato/index.ts:580-662
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

  // Lista plana de TODOS os <w:t> do paragrafo, em ordem
  const tList: Element[] = [];
  for (const r of runs) {
    for (const t of Array.from(r.getElementsByTagName('w:t'))) tList.push(t as Element);
  }
  if (tList.length === 0) return 0;

  // Tenta substituicao PER-<w:t> primeiro — preserva a formatacao
  // individual de cada run (NOME em run bold continua bold apos substituir).
  let count = 0;
  let anyPlaceholderRemainingInFull = false;

  const placeholderKeys = Object.keys(variables);
  for (const t of tList) {
    let text = t.textContent || '';
    if (!text.includes('{{')) continue;
    let touched = false;
    for (const key of placeholderKeys) {
      const ph = '{{' + key + '}}';
      if (text.includes(ph)) {
        const value = variables[key];
        const replacement = value === null || value === undefined ? '' : String(value);
        text = text.split(ph).join(replacement);
        touched = true;
      }
    }
    if (touched) {
      t.textContent = text;
      t.setAttribute('xml:space', 'preserve');
      count++;
    }
  }

  // Apos o per-<w:t>, ve se sobrou algum {{}} (significa fragmentacao
  // entre runs — placeholder partido por spellcheck/rsid do Word).
  const fullAfter = tList.map(t => t.textContent || '').join('');
  for (const key of placeholderKeys) {
    if (fullAfter.includes('{{' + key + '}}')) {
      anyPlaceholderRemainingInFull = true;
      break;
    }
  }
  if (!anyPlaceholderRemainingInFull) return count;

  // FALLBACK: existe pelo menos um placeholder fragmentado. Mescla o
  // texto completo, substitui, e escreve no <w:t> com mais texto ja
  // preenchido (geralmente o run "normal" da continuacao).
  let merged = fullAfter;
  for (const key of placeholderKeys) {
    const ph = '{{' + key + '}}';
    if (merged.includes(ph)) {
      const value = variables[key];
      const replacement = value === null || value === undefined ? '' : String(value);
      merged = merged.split(ph).join(replacement);
      count++;
    }
  }

  // Escolhe o <w:t> alvo: o com mais texto atual
  let targetIdx = 0;
  let targetLen = -1;
  for (let i = 0; i < tList.length; i++) {
    const L = (tList[i].textContent || '').length;
    if (L >= targetLen) {
      targetIdx = i;
      targetLen = L;
    }
  }
  tList[targetIdx].textContent = merged;
  tList[targetIdx].setAttribute('xml:space', 'preserve');
  for (let i = 0; i < tList.length; i++) {
    if (i === targetIdx) continue;
    tList[i].textContent = '';
  }
  return count;
}

async function fillTemplate(
  templateBytes: Uint8Array,
  variables: Vars,
): Promise<{ bytes: Uint8Array; pendentes: string[] }> {
  const zip = await JSZip.loadAsync(templateBytes);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Template inválido: word/document.xml não encontrado');
  const xml = await docFile.async('string');

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
  if (!newXml.startsWith('<?xml')) {
    newXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + newXml;
  }
  zip.file('word/document.xml', newXml);
  const out = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

  const pendentes = getTemplateVariablesFromXml(newXml);
  return { bytes: out, pendentes };
}

async function storageGetBytes(
  sb: ReturnType<typeof createClient>,
  bucket: string,
  path: string,
): Promise<Uint8Array> {
  const { data, error } = await sb.storage.from(bucket).download(path);
  if (error) throw new Error(`Storage download falhou (${bucket}/${path}): ${error.message}`);
  const buf = await data.arrayBuffer();
  return new Uint8Array(buf);
}

// ============================================================================
// Google Drive — portado do gerar-contrato/index.ts
// ============================================================================

const DRIVE_ROOT_NAME = 'Credijuris - Atualizado';
const DRIVE_PROCESSOS_NAME = 'B. Processos';
const DRIVE_CATEGORIA_PADRAO = 'Requisições de Pequeno Valor';
const DRIVE_PASTA_PETICOES = '5. Petições';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function normalizar(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.\-/() ]/g, '');
}
function soDigitos(s: string): string {
  return String(s || '').replace(/\D/g, '');
}
function escapeDriveQuery(s: string): string {
  return s.replace(/'/g, "\\'");
}

async function refreshGoogleAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth refresh falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('Google OAuth: sem access_token na resposta');
  return data.access_token as string;
}

interface DriveFile { id: string; name: string; mimeType?: string; parents?: string[] }

async function driveListFiles(token: string, query: string, driveId?: string): Promise<DriveFile[]> {
  const params = new URLSearchParams({
    q: query, fields: 'files(id,name,mimeType,parents)',
    includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', pageSize: '1000',
  });
  if (driveId) { params.set('corpora', 'drive'); params.set('driveId', driveId); }
  else { params.set('corpora', 'allDrives'); }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error(`Drive list (${res.status}): ${(await res.text()).slice(0, 300)} | query=${query}`);
  return (await res.json()).files || [];
}

async function driveFindSharedDrive(token: string, name: string): Promise<{ id: string; name: string } | null> {
  let pageToken: string | undefined;
  while (true) {
    const params = new URLSearchParams({ fields: 'nextPageToken,drives(id,name)' });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/drives?${params}`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return null;
    const data = await res.json();
    for (const d of (data.drives || [])) if (d.name === name) return d;
    pageToken = data.nextPageToken;
    if (!pageToken) return null;
  }
}

async function driveFindChild(token: string, name: string, parentId: string, mime?: string): Promise<DriveFile | null> {
  let q = `name = '${escapeDriveQuery(name)}' and '${parentId}' in parents and trashed = false`;
  if (mime) q += ` and mimeType = '${mime}'`;
  return (await driveListFiles(token, q))[0] || null;
}

async function driveCreateFolder(token: string, name: string, parentId: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!res.ok) throw new Error(`Drive criar pasta '${name}' (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).id;
}

async function driveFindOrCreateFolder(token: string, name: string, parentId: string): Promise<string> {
  const existing = await driveFindChild(token, name, parentId, FOLDER_MIME);
  return existing ? existing.id : driveCreateFolder(token, name, parentId);
}

async function driveUploadDocx(token: string, name: string, parentId: string, bytes: Uint8Array): Promise<{ id: string; webViewLink?: string }> {
  // Sobrescreve se ja existir um com o mesmo nome
  const existing = await driveFindChild(token, name, parentId);
  if (existing) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}?supportsAllDrives=true`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    });
  }
  const boundary = '-------pet' + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${DOCX_MIME}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const bodyBytes = new Uint8Array(head.length + bytes.length + tail.length);
  bodyBytes.set(head, 0); bodyBytes.set(bytes, head.length); bodyBytes.set(tail, head.length + bytes.length);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: bodyBytes,
  });
  if (!res.ok) throw new Error(`Drive upload '${name}' (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

// Sobe na cadeia de pastas a partir de folderId. Retorna true se em algum
// momento encontra ancestorId. Limita a profundidade pra evitar loops.
async function driveEhDescendente(token: string, folderId: string, ancestorId: string): Promise<boolean> {
  let current = folderId;
  for (let i = 0; i < 12; i++) {
    if (current === ancestorId) return true;
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${current}?fields=parents&supportsAllDrives=true`,
      { headers: { Authorization: 'Bearer ' + token } },
    );
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.parents || data.parents.length === 0) return false;
    current = data.parents[0];
  }
  return false;
}

// Acha a "B. Processos" folder dentro do shared drive ou do raiz "Credijuris".
async function driveAcharProcessosFolder(token: string, driveId: string | undefined): Promise<string | null> {
  // Caminho 1: shared drive direto -> achar "B. Processos" como filho do drive
  if (driveId) {
    const q = `name = '${escapeDriveQuery(DRIVE_PROCESSOS_NAME)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const files = await driveListFiles(token, q, driveId);
    if (files[0]) return files[0].id;
  }
  // Caminho 2 (fallback): pasta normal -> Credijuris - Atualizado / B. Processos
  const roots = await driveListFiles(
    token,
    `name = '${escapeDriveQuery(DRIVE_ROOT_NAME)}' and trashed = false and mimeType = '${FOLDER_MIME}'`,
  );
  if (!roots[0]) return null;
  const procFolder = await driveFindChild(token, DRIVE_PROCESSOS_NAME, roots[0].id, FOLDER_MIME);
  return procFolder ? procFolder.id : null;
}

// Acha a pasta do processo no Drive — APENAS dentro de "B. Processos".
// Estrategia:
//  1. Procura pastas cujo nome contenha o nome do CEDENTE (busca global).
//  2. Filtra somente as que estao dentro da arvore "B. Processos".
//  3. Se houver mais de uma, desempata pelo numero do processo (CNJ).
//  4. Retorna { folderId, candidatas } — folderId null se nao achar/ambiguo.
async function driveAcharPastaProcesso(
  token: string, driveId: string | undefined, cedente: string, processo: string,
): Promise<{ folderId: string | null; motivo: string; candidatas: string[] }> {
  const cedenteLimpo = (cedente || '').trim();
  if (!cedenteLimpo) return { folderId: null, motivo: 'cedente vazio', candidatas: [] };

  // 1. Acha B. Processos (escopo da busca)
  const processosId = await driveAcharProcessosFolder(token, driveId);
  if (!processosId) return { folderId: null, motivo: '"B. Processos" não encontrada no Drive', candidatas: [] };

  // 2. Busca global por nome do cedente
  const q = `name contains '${escapeDriveQuery(cedenteLimpo)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  let folders: DriveFile[];
  try { folders = await driveListFiles(token, q, driveId); }
  catch (e) { return { folderId: null, motivo: 'erro na busca: ' + (e instanceof Error ? e.message : String(e)), candidatas: [] }; }

  const cedNorm = normalizar(cedenteLimpo);
  const matchCedente = folders.filter(f => normalizar(f.name).includes(cedNorm));

  // 3. Filtra somente os que estao SOB "B. Processos" (descarta resultados
  // de "A. Dados dos investidores", "C. ..." etc.)
  const candidatas: DriveFile[] = [];
  for (const f of matchCedente) {
    if (await driveEhDescendente(token, f.id, processosId)) candidatas.push(f);
  }
  const nomes = candidatas.map(f => f.name);

  if (candidatas.length === 0) {
    const fora = matchCedente.length;
    return { folderId: null, motivo: fora ? `nenhuma pasta do cedente DENTRO de "B. Processos" (${fora} encontrada(s) em outros lugares)` : 'nenhuma pasta com o nome do cedente', candidatas: [] };
  }
  if (candidatas.length === 1) return { folderId: candidatas[0].id, motivo: 'match unico por cedente (em B. Processos)', candidatas: nomes };

  // 4. Mais de uma: desempata pelo CNJ
  const procDig = soDigitos(processo);
  const porCnj = candidatas.filter(f => procDig && soDigitos(f.name).includes(procDig));
  if (porCnj.length === 1) return { folderId: porCnj[0].id, motivo: 'desempate por CNJ', candidatas: nomes };
  return { folderId: null, motivo: `ambiguo: ${candidatas.length} pastas do cedente em B. Processos e CNJ nao desempatou`, candidatas: nomes };
}

// Le os secrets do Google, faz refresh do token e acha o shared drive.
// Lanca em caso de erro (quem chama trata).
async function getDriveContext(sbAdmin: ReturnType<typeof createClient>): Promise<{ token: string; driveId?: string }> {
  const { data: cfgRows } = await sbAdmin.from('configuracoes')
    .select('chave,valor')
    .in('chave', ['google_oauth_client_id', 'google_oauth_client_secret', 'google_oauth_refresh_token']);
  const cfg: Record<string, string> = {};
  for (const r of (cfgRows || [])) cfg[r.chave] = r.valor;
  for (const k of ['google_oauth_client_id', 'google_oauth_client_secret', 'google_oauth_refresh_token']) {
    if (!cfg[k]) throw new Error(`Secret '${k}' não configurado`);
  }
  const token = await refreshGoogleAccessToken(cfg.google_oauth_client_id, cfg.google_oauth_client_secret, cfg.google_oauth_refresh_token);
  const drive = await driveFindSharedDrive(token, DRIVE_ROOT_NAME);
  return { token, driveId: drive?.id };
}

// Verifica se uma peticao com determinado nome ja existe na pasta do processo.
// NUNCA lanca. Retorna { exists, folder_url? }.
async function checkPeticaoExiste(
  sbAdmin: ReturnType<typeof createClient>,
  cedente: string, processo: string, nomeArq: string,
): Promise<{ exists: boolean; folder_url?: string; mensagem?: string }> {
  try {
    const { token, driveId } = await getDriveContext(sbAdmin);
    const { folderId } = await driveAcharPastaProcesso(token, driveId, cedente, processo);
    if (!folderId) return { exists: false, mensagem: 'pasta do processo não encontrada' };
    const peticoesFolder = await driveFindChild(token, DRIVE_PASTA_PETICOES, folderId, FOLDER_MIME);
    if (!peticoesFolder) return { exists: false };
    const folderUrl = `https://drive.google.com/drive/folders/${peticoesFolder.id}`;
    const file = await driveFindChild(token, nomeArq, peticoesFolder.id);
    return { exists: !!file, folder_url: folderUrl };
  } catch (e) {
    return { exists: false, mensagem: 'erro: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

// Orquestra o upload da peticao no Drive. Retorna status pro frontend.
// NUNCA lanca — qualquer falha vira { ok:false, ... } pra nao quebrar o fluxo.
async function subirPeticaoNoDrive(
  sbAdmin: ReturnType<typeof createClient>,
  cedente: string, processo: string, nomeArq: string, bytes: Uint8Array,
): Promise<{ ok: boolean; mensagem: string; folder_url?: string }> {
  try {
    const { token, driveId } = await getDriveContext(sbAdmin);
    const { folderId, motivo, candidatas } = await driveAcharPastaProcesso(token, driveId, cedente, processo);
    if (!folderId) {
      return { ok: false, mensagem: `Pasta do processo não localizada no Drive (${motivo}).${candidatas.length ? ' Candidatas: ' + candidatas.join(', ') : ''}` };
    }
    // Acha/cria a subpasta "5. Petições" dentro da pasta do processo
    const peticoesId = await driveFindOrCreateFolder(token, DRIVE_PASTA_PETICOES, folderId);
    await driveUploadDocx(token, nomeArq, peticoesId, bytes);
    const folderUrl = `https://drive.google.com/drive/folders/${peticoesId}`;
    return { ok: true, mensagem: 'Enviado ao Drive', folder_url: folderUrl };
  } catch (e) {
    return { ok: false, mensagem: 'Falha no Drive: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

// ============================================================================
// IA — Claude API + Markdown → docx
// ============================================================================

type ClaudeBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

const CLAUDE_SYSTEM_PROMPT =
  'Você é um assistente jurídico especializado em redigir petições brasileiras. ' +
  'O usuário vai te passar uma orientação e dados de um processo. Você deve gerar ' +
  'APENAS o CORPO da petição em Markdown (sem cabeçalho, sem rodapé, sem assinatura). ' +
  'O cabeçalho (AO JUÍZO, processo, qualificação) e o rodapé (Nestes termos, pede ' +
  'deferimento; assinatura) já estão no template — NÃO os reescreva. ' +
  'Use formal Português jurídico brasileiro. Estruture com seções (I, II, III...) ' +
  'quando fizer sentido. Use **negrito** em destaques importantes (citações, ' +
  'números de lei, conclusões). Cada parágrafo em sua própria linha, com linha em ' +
  'branco entre eles.\n\n' +
  'FORMATO OBRIGATÓRIO DA RESPOSTA: na PRIMEIRA linha, escreva apenas o título curto da peça ' +
  'no formato "TÍTULO: <até 3 palavras>". Exemplos válidos: "TÍTULO: Recurso Especial", ' +
  '"TÍTULO: Embargos Declaratórios", "TÍTULO: Manifestação", "TÍTULO: Petição de Cumprimento", ' +
  '"TÍTULO: Contrarrazões". Use o nome técnico da peça processual. Depois, pule uma linha ' +
  'e comece o corpo da petição em Markdown normalmente.';

function escapeXmlText(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inicializa um <w:rPr> com negrito, baseado num rPr existente (preserva fonte/tamanho).
function rPrComNegrito(rPrBase: string): string {
  if (!rPrBase) return '<w:rPr><w:b w:val="1"/><w:bCs w:val="1"/></w:rPr>';
  if (rPrBase.includes('<w:b ') || rPrBase.includes('<w:b/>')) return rPrBase;
  return rPrBase.replace('<w:rPr>', '<w:rPr><w:b w:val="1"/><w:bCs w:val="1"/>');
}

// Inicializa um <w:rPr> com italico, baseado num rPr existente.
function rPrComItalico(rPrBase: string): string {
  if (!rPrBase) return '<w:rPr><w:i w:val="1"/><w:iCs w:val="1"/></w:rPr>';
  if (rPrBase.includes('<w:i ') || rPrBase.includes('<w:i/>')) return rPrBase;
  return rPrBase.replace('<w:rPr>', '<w:rPr><w:i w:val="1"/><w:iCs w:val="1"/>');
}

// Constroi um <w:r> com texto. Aplica bold/italic ao rPr conforme flags.
function montarRun(texto: string, rPrBase: string, bold: boolean, italic = false): string {
  let rPr = rPrBase;
  if (bold) rPr = rPrComNegrito(rPr);
  if (italic) rPr = rPrComItalico(rPr);
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXmlText(texto)}</w:t></w:r>`;
}

// Processa **negrito** e *italico* dentro de uma linha, gerando sequência de runs.
// Ordem importa: **bold** vem antes do *italic* na regex pra não confundir.
function processarInline(linha: string, rPrBase: string): string {
  const out: string[] = [];
  // Captura **bold** OU *italic* (regex única, distingue pelo grupo casado)
  const re = /(\*\*([^*]+?)\*\*)|(\*([^*]+?)\*)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(linha)) !== null) {
    if (m.index > lastIdx) out.push(montarRun(linha.substring(lastIdx, m.index), rPrBase, false));
    if (m[1]) {
      // Group 1 casou: bold
      out.push(montarRun(m[2], rPrBase, true));
    } else {
      // Group 3 casou: italic
      out.push(montarRun(m[4], rPrBase, false, true));
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < linha.length) out.push(montarRun(linha.substring(lastIdx), rPrBase, false));
  return out.join('');
}

// Adiciona/substitui indentação à esquerda no pPr (pra blockquote).
function pPrComIndent(pPrBase: string, leftTwips = 720): string {
  if (!pPrBase) return `<w:pPr><w:ind w:left="${leftTwips}"/></w:pPr>`;
  const semInd = pPrBase.replace(/<w:ind\b[^/]*\/>/g, '');
  return semInd.replace('<w:pPr>', `<w:pPr><w:ind w:left="${leftTwips}"/>`);
}

// Converte markdown em sequência de <w:p>...</w:p>. Suporta:
//   - linha em branco → parágrafo vazio
//   - "# Heading" → parágrafo em negrito
//   - "> texto" → blockquote (paragrafo indentado à esquerda)
//   - "- item" / "* item" → parágrafo simples (sem bullet visual)
//   - **bold** e *italic* inline
function markdownParaParagrafos(markdown: string, pPr: string, rPrBase: string): string {
  const linhas = markdown.split('\n');
  const out: string[] = [];
  for (const raw of linhas) {
    const linha = raw.replace(/\s+$/, '');
    if (!linha.trim()) {
      out.push(`<w:p>${pPr}</w:p>`);
      continue;
    }
    // Horizontal rule (--- ou *** ou ___) — markdown separator, ignora
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(linha.trim())) continue;
    // Blockquote: linha começa com > (markdown citação)
    const bq = linha.match(/^>\s*(.*)$/);
    if (bq) {
      const conteudo = bq[1].trim();
      const pPrInd = pPrComIndent(pPr, 720);
      if (!conteudo) { out.push(`<w:p>${pPrInd}</w:p>`); continue; }
      out.push(`<w:p>${pPrInd}${processarInline(conteudo, rPrBase)}</w:p>`);
      continue;
    }
    // Headings (# ou ## ou ###) → parágrafo em negrito
    const head = linha.match(/^(#{1,3})\s+(.+)$/);
    if (head) {
      out.push(`<w:p>${pPr}${montarRun(head[2], rPrBase, true)}</w:p>`);
      continue;
    }
    // Listas (- ou *) — tratamos como parágrafo simples sem bullet
    const bullet = linha.match(/^[-*]\s+(.+)$/);
    const conteudo = bullet ? bullet[1] : linha;
    out.push(`<w:p>${pPr}${processarInline(conteudo, rPrBase)}</w:p>`);
  }
  return out.join('');
}

// Encontra o <w:p> que contém {{CORPO}} no XML e substitui pelos paragrafos
// do markdown. Preserva fonte/tamanho/spacing do paragrafo original, mas
// LIMPA: alinhamento centralizado e negrito (pra evitar herdar destaques
// visuais do placeholder).
function inserirCorpoNoXml(xml: string, markdown: string): string {
  // Match não-greedy do <w:p> que contém {{CORPO}}
  const re = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?\{\{CORPO\}\}(?:(?!<w:p\b)[\s\S])*?<\/w:p>/;
  const m = xml.match(re);
  if (!m) {
    // Sem placeholder de corpo — só substitui texto
    return xml.replace(/\{\{CORPO\}\}/g, escapeXmlText(markdown));
  }
  const original = m[0];
  // Extrai pPr, limpa bold e força alinhamento JUSTIFICADO (padrão jurídico).
  // Substitui o espaçamento por um compacto (after=0/before=0/line=276).
  // Adiciona recuo de primeira linha de 1.25cm (708 twips) — padrão jurídico.
  let pPr = '';
  const pPrMatch = original.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  if (pPrMatch) {
    pPr = pPrMatch[0]
      .replace(/<w:jc\b[^/]*\/>/g, '')      // remove alinhamento existente
      .replace(/<w:b\b[^/]*\/>/g, '')       // remove bold do rPr-default do paragrafo
      .replace(/<w:bCs\b[^/]*\/>/g, '')
      .replace(/<w:spacing\b[^/]*\/>/g, '')  // remove spacing antigo (muito grande)
      .replace(/<w:ind\b[^/]*\/>/g, '');     // remove indentação existente
    // Insere justified, spacing compacto e recuo de primeira linha
    pPr = pPr.replace('<w:pPr>', '<w:pPr><w:spacing w:after="0" w:before="0" w:line="276" w:lineRule="auto"/><w:ind w:firstLine="708"/><w:jc w:val="both"/>');
  } else {
    pPr = '<w:pPr><w:spacing w:after="0" w:before="0" w:line="276" w:lineRule="auto"/><w:ind w:firstLine="708"/><w:jc w:val="both"/></w:pPr>';
  }
  // Extrai rPr de um run e limpa bold
  let rPrBase = '';
  const rPrMatch = original.match(/<w:rPr>(?:(?!<w:rPr)[\s\S])*?<\/w:rPr>/);
  if (rPrMatch) {
    rPrBase = rPrMatch[0]
      .replace(/<w:b\b[^/]*\/>/g, '')
      .replace(/<w:bCs\b[^/]*\/>/g, '');
  }
  const novosParagrafos = markdownParaParagrafos(markdown, pPr, rPrBase);
  return xml.replace(original, novosParagrafos);
}

// Chama Claude API com prompt + contexto. Retorna o titulo (curto, até 3 palavras)
// e o corpo em markdown. Se o Claude não seguir o formato "TÍTULO: ...", titulo
// vem null e o body é o texto inteiro.
async function gerarCorpoComClaude(
  apiKey: string,
  orientacao: string,
  contexto: Record<string, string>,
  anexos: ClaudeBlock[],
): Promise<{ title: string | null; body: string }> {
  const contextoTexto = Object.entries(contexto)
    .filter(([_, v]) => v && v !== '(não informado)')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  const userContent: ClaudeBlock[] = [
    ...anexos,
    {
      type: 'text',
      text:
        `DADOS DO PROCESSO:\n${contextoTexto}\n\n` +
        `ORIENTAÇÃO DO USUÁRIO:\n${orientacao}\n\n` +
        `Gere o corpo da petição em Markdown agora. Lembre: SEM cabeçalho, SEM rodapé, ` +
        `SEM "Nestes termos, pede deferimento" — só o corpo central.`,
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
      max_tokens: 4000,
      system: CLAUDE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude API (${res.status}): ${txt.slice(0, 400)}`);
  }
  const data = await res.json();
  const block = data.content?.find((c: { type: string }) => c.type === 'text');
  if (!block) throw new Error('Claude retornou sem bloco de texto');
  const raw = String(block.text || '').trim();
  // Tenta extrair "TÍTULO: ..." da primeira linha. Tolerante a variações:
  // TITULO/TÍTULO, com ou sem acento, com ou sem dois-pontos, em qualquer caixa.
  const m = raw.match(/^\s*T[ÍI]TULO\s*[:\-]\s*([^\n]+)\s*\n([\s\S]*)$/i);
  if (m) {
    // Limpa o titulo: tira aspas, asteriscos, pontuação final, e capa em 60 chars
    let title = m[1].trim().replace(/^["'*]+|["'*.,;:]+$/g, '').slice(0, 60);
    return { title: title || null, body: m[2].trim() };
  }
  return { title: null, body: raw };
}

// Le os anexos (PDFs/imagens/docx) do bucket temp e converte em ClaudeBlocks.
async function lerAnexosParaClaude(
  sbAdmin: ReturnType<typeof createClient>,
  prefix: string,
): Promise<{ blocks: ClaudeBlock[]; paths: string[] }> {
  const { data: files, error } = await sbAdmin.storage.from(BUCKET_INPUT_IA).list(prefix, { limit: 20 });
  if (error || !files || files.length === 0) return { blocks: [], paths: [] };
  const blocks: ClaudeBlock[] = [];
  const paths: string[] = [];
  for (const f of files) {
    if (!f.name || f.name === '.emptyFolderPlaceholder') continue;
    const path = `${prefix}/${f.name}`;
    paths.push(path);
    try {
      const bytes = await storageGetBytes(sbAdmin, BUCKET_INPUT_IA, path);
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      blocks.push({ type: 'text', text: `[Anexo: ${f.name}]` });
      if (ext === 'pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64encode(bytes) } });
      } else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        const mt = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
        blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: b64encode(bytes) } });
      } else {
        // Outros tipos: tenta como texto
        try { blocks.push({ type: 'text', text: new TextDecoder().decode(bytes).slice(0, 50000) }); }
        catch (_) { blocks.push({ type: 'text', text: '(arquivo não-textual ignorado)' }); }
      }
    } catch (e) {
      console.error('[gerar-peticao] erro lendo anexo', path, e);
    }
  }
  return { blocks, paths };
}

async function limparAnexos(sbAdmin: ReturnType<typeof createClient>, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try { await sbAdmin.storage.from(BUCKET_INPUT_IA).remove(paths); } catch (_) { /* best-effort */ }
}

// ============================================================================
// HTTP Handler
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  try {
    // 1. Auth — valida JWT do usuario
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

    // 2. Body
    const body = await req.json();
    const tipo: string = body.tipo;
    const dados: Vars = body.dados || {};
    const driveParams = body.drive || null; // { cedente, processo } — opcional
    if (!tipo || !TEMPLATES[tipo]) {
      return errorResponse(
        `Tipo inválido. Disponíveis: ${Object.keys(TEMPLATES).join(', ')}`,
        400,
      );
    }

    // 3. Service-role pra acessar o bucket de templates sem expor policy publica
    const sbAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // 3b. MODO VERIFICAR — checa se a peticao ja existe no Drive, sem gerar.
    // Usado quando o usuario clica no botao, antes de mostrar o formulario.
    if (body.check_only) {
      const cedente = String(driveParams?.cedente || '');
      const processo = String(driveParams?.processo || dados.NUMERO_PROCESSO || '');
      const filename = nomeArquivo(tipo, dados);
      const r = await checkPeticaoExiste(sbAdmin, cedente, processo, filename);
      return jsonResponse({ success: true, check: true, exists: r.exists, folder_url: r.folder_url, filename, mensagem: r.mensagem });
    }

    // 4. Baixa template
    const fname = TEMPLATES[tipo];
    let templateBytes: Uint8Array;
    try {
      templateBytes = await storageGetBytes(sbAdmin, BUCKET_TEMPLATES, fname);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResponse(
        `Template '${fname}' não encontrado no bucket '${BUCKET_TEMPLATES}'. ` +
        `Faça upload do arquivo pelo painel do Supabase. Detalhe: ${msg}`,
        404,
      );
    }

    // 5a. (Apenas para tipos AI) chama Claude pra gerar o corpo da petição
    // e injeta como parágrafos {{CORPO}} antes do fillTemplate.
    let bytes: Uint8Array;
    let pendentes: string[];
    let anexosUsadosPaths: string[] = [];
    let corpoMarkdownGerado: string | null = null;
    let orientacaoOriginal: string = '';
    let tituloPersonalizado: string | null = null;
    if (tipo === 'ai_com_qualif' || tipo === 'ai_sem_qualif') {
      const orientacao = String(body.orientacao || '').trim();
      if (!orientacao) return errorResponse('Orientação vazia. Descreva o que a petição deve fazer.', 400);

      // Le secret do Anthropic
      const { data: cfgRows } = await sbAdmin.from('configuracoes')
        .select('chave,valor').in('chave', ['anthropic_api_key']);
      const anthKey = (cfgRows || [])[0]?.valor;
      if (!anthKey) return errorResponse("Secret 'anthropic_api_key' não configurado em configuracoes", 500);

      // Le anexos (se houver) do bucket temp — frontend os subiu antes de chamar
      const anexosPrefix = String(body.anexos_prefix || '');
      let anexoBlocks: ClaudeBlock[] = [];
      if (anexosPrefix) {
        const { blocks, paths } = await lerAnexosParaClaude(sbAdmin, anexosPrefix);
        anexoBlocks = blocks;
        anexosUsadosPaths = paths;
      }

      // Monta o contexto que vai pro Claude
      const contexto: Record<string, string> = {
        'Número do processo':    String(dados.NUMERO_PROCESSO || ''),
        'Juízo':                  String(dados.ENDERECAMENTO_JUIZO || ''),
        'Cessionário':            String(dados.NOME_CESSIONARIO || ''),
        'Qualificação do cessionário': String(dados.QUALIFICACAO_CESSIONARIO || ''),
        'Dados bancários do cessionário': String(dados.DADOS_BANCARIOS || ''),
        'Créditos cedidos':       String(dados.CREDITOS_CEDIDOS || ''),
        'Observações da tarefa (Advbox)': String(body.notes_tarefa || ''),
      };
      const { title: tituloIA, body: corpoMarkdown } = await gerarCorpoComClaude(anthKey, orientacao, contexto, anexoBlocks);
      corpoMarkdownGerado = corpoMarkdown;
      orientacaoOriginal = orientacao;
      // Se o Claude sugeriu um titulo curto, sobrescreve o label do nome do arquivo
      if (tituloIA) tituloPersonalizado = tituloIA;

      // 5b. Preenche os placeholders do header (sem o CORPO) e depois injeta o corpo
      const { bytes: bytesParcial, pendentes: pend1 } = await fillTemplate(templateBytes, dados);
      // Pega o XML do template parcialmente preenchido e injeta o corpo no lugar de {{CORPO}}
      const zipParcial = await JSZip.loadAsync(bytesParcial);
      const docFileParcial = zipParcial.file('word/document.xml');
      if (!docFileParcial) throw new Error('Template AI inválido: word/document.xml não encontrado');
      let xmlParcial = await docFileParcial.async('string');
      xmlParcial = inserirCorpoNoXml(xmlParcial, corpoMarkdown);
      zipParcial.file('word/document.xml', xmlParcial);
      bytes = await zipParcial.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      pendentes = pend1.filter(p => p !== 'CORPO');
    } else {
      // Caminho normal — preenche tudo via fillTemplate
      const r = await fillTemplate(templateBytes, dados);
      bytes = r.bytes;
      pendentes = r.pendentes;
    }
    // Pra tipos IA, usa o titulo sugerido pelo Claude (ex: "Recurso Especial");
    // pros outros, usa o label padrão da tabela.
    const filename = nomeArquivo(tipo, dados, tituloPersonalizado);

    // 6. (Opcional) sobe a peticao pro Google Drive. Best-effort: se falhar,
    // o download local continua normalmente — apenas reporta o status.
    let drive: { ok: boolean; mensagem: string; folder_url?: string } | null = null;
    if (driveParams && (driveParams.cedente || driveParams.processo)) {
      drive = await subirPeticaoNoDrive(
        sbAdmin,
        String(driveParams.cedente || ''),
        String(driveParams.processo || dados.NUMERO_PROCESSO || ''),
        filename,
        bytes,
      );
    }

    // 6b. Limpa anexos temporários do storage (best-effort)
    if (anexosUsadosPaths.length) await limparAnexos(sbAdmin, anexosUsadosPaths);

    // 7. Retorna base64 pro browser + status do Drive
    // Pra tipos AI, devolve também o markdown gerado e a orientação,
    // pro frontend montar o botão "Refinar com Claude" abrindo o chat
    // com contexto carregado.
    return jsonResponse({
      success: true,
      filename,
      docx_base64: b64encode(bytes),
      pendentes,
      drive,
      corpo_markdown: corpoMarkdownGerado,
      orientacao: orientacaoOriginal || undefined,
    });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[gerar-peticao] erro:', msg);
    return errorResponse(msg, 500);
  }
});
