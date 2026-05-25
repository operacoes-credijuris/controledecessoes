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
};

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

function nomeArquivo(tipo: string, dados: Vars): string {
  const cessionario = sanitizeFilenamePart(dados.NOME_CESSIONARIO) || 'Cessionario';
  const processo    = sanitizeFilenamePart(dados.NUMERO_PROCESSO) || 'sem-processo';
  const labels: Record<string, string> = {
    levantamento:     'Petição de Levantamento',
    sequestro:        'Petição de Sequestro',
    ilegitimidade:    'Petição de Ilegitimidade Passiva',
    rpv_complementar: 'Petição de RPV Complementar',
    registro_publico: 'Petição de Juntada de Registro Público',
  };
  const labelTipo = labels[tipo] || `Petição - ${tipo}`;
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

    // 5. Preenche
    const { bytes, pendentes } = await fillTemplate(templateBytes, dados);

    // 6. Retorna base64 pro browser
    return jsonResponse({
      success: true,
      filename: nomeArquivo(tipo, dados),
      docx_base64: b64encode(bytes),
      pendentes,
    });

  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[gerar-peticao] erro:', msg);
    return errorResponse(msg, 500);
  }
});
