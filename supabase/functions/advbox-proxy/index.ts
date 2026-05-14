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
    // Validar JWT do usuário antes de qualquer acesso
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Não autenticado' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const userJwt = authHeader.slice(7);
    const sbUser = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: 'Bearer ' + userJwt } } }
    );
    const { data: { user }, error: authErr } = await sbUser.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Sessão inválida ou expirada' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

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
    let method: 'GET' | 'POST' = 'GET';
    let forwardBody: string | undefined;
    if (action === 'lawsuits') {
      advboxUrl = `${ADVBOX_BASE}/lawsuits?process_number=${encodeURIComponent(processNumber)}`;
    } else if (action === 'movements') {
      advboxUrl = `${ADVBOX_BASE}/movements/${lawsuitId}?origin=TRIBUNAL`;
    } else if (action === 'posts') {
      advboxUrl = `${ADVBOX_BASE}/posts?lawsuit_id=${encodeURIComponent(lawsuitId)}&page=${page}&limit=${limit}`;
    } else if (action === 'history') {
      advboxUrl = `${ADVBOX_BASE}/history/${encodeURIComponent(lawsuitId)}`;
    } else if (action === 'activities') {
      advboxUrl = `${ADVBOX_BASE}/activities?lawsuit_id=${encodeURIComponent(lawsuitId)}&page=${page}&limit=${limit}`;
    } else if (action === 'settings') {
      // GET /settings — retorna users[] e tasks[] disponiveis no escritorio Advbox.
      advboxUrl = `${ADVBOX_BASE}/settings`;
    } else if (action === 'create-post') {
      // POST /posts — cria nova tarefa. Body do request e repassado integralmente
      // para o Advbox, preservando todos os campos enviados pelo cliente.
      if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Metodo POST obrigatorio para create-post' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      advboxUrl = `${ADVBOX_BASE}/posts`;
      method = 'POST';
      forwardBody = await req.text();
    } else if (action === 'raw') {
      // Passagem direta — para exploração de endpoints: ?action=raw&path=/posts%3Flawsuit_id%3D123%26concluded%3D1
      const rawPath = url.searchParams.get('path') ?? '';
      if (!rawPath) return new Response(JSON.stringify({ error: 'Parâmetro path obrigatório' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
      advboxUrl = `${ADVBOX_BASE}${rawPath}`;
    } else {
      return new Response(JSON.stringify({ error: 'action inválida' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const fetchOpts: RequestInit = {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
    };
    if (forwardBody !== undefined) fetchOpts.body = forwardBody;
    const res = await fetch(advboxUrl, fetchOpts);

    if (res.status === 204) return new Response(null, { status: 204, headers: CORS });

    const body = await res.text();

    // Rejeita respostas HTML mesmo com status 200 (ex: Advbox redireciona para login)
    if (body.trimStart().startsWith('<')) {
      return new Response(JSON.stringify({ error: 'Endpoint não encontrado ou token inválido (resposta HTML)', status: res.status }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

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
