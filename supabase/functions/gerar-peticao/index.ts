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
  levantamento: 'levantamento.docx',
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
  const labelTipo = tipo === 'levantamento' ? 'Petição de Levantamento' : `Petição - ${tipo}`;
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
