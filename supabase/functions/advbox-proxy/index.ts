import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADVBOX_BASE = 'https://app.advbox.com.br/api/v1';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: cfg } = await sb.from('configuracoes').select('valor').eq('chave', 'advbox_token').single();
    const token = cfg?.valor;
    if (!token) return new Response(JSON.stringify({ error: 'Token Advbox não configurado' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });

    const url = new URL(req.url);
    const action = url.searchParams.get('action');
    const processNumber = url.searchParams.get('process_number') ?? '';
    const lawsuitId = url.searchParams.get('lawsuit_id') ?? '';
    const page = url.searchParams.get('page') ?? '1';
    const limit = url.searchParams.get('limit') ?? '100';

    let advboxUrl: string;
    if (action === 'lawsuits') {
      advboxUrl = `${ADVBOX_BASE}/lawsuits?process_number=${encodeURIComponent(processNumber)}`;
    } else if (action === 'movements') {
      advboxUrl = `${ADVBOX_BASE}/movements/${lawsuitId}?origin=TRIBUNAL`;
    } else if (action === 'posts') {
      advboxUrl = `${ADVBOX_BASE}/posts?lawsuit_id=${encodeURIComponent(lawsuitId)}&page=${page}&limit=${limit}`;
    } else {
      return new Response(JSON.stringify({ error: 'action inválida' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const res = await fetch(advboxUrl, { headers: { Authorization: 'Bearer ' + token } });

    if (res.status === 204) return new Response(null, { status: 204, headers: CORS });

    const body = await res.text();

    if (!res.ok) {
      const s = res.status;
      const isHtml = body.trimStart().startsWith('<');
      const errorMsg = s === 401 || s === 403 ? 'Token Advbox inválido ou expirado'
        : s === 429 ? 'Limite de requisições Advbox atingido'
        : s === 404 ? 'Recurso não encontrado na Advbox'
        : isHtml ? `Erro ${s} (resposta HTML inesperada da Advbox)`
        : body.slice(0, 300);
      return new Response(JSON.stringify({ error: errorMsg, status: s }), {
        status: s,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    return new Response(body, {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
