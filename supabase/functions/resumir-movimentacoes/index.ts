import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLAUDE_MODEL = 'claude-haiku-4-5';
const CLAUDE_MAX_TOKENS = 600;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PROMPT_PROVIDENCIAS = `Você é um assistente especializado em comunicação jurídica para investidores da Credijuris, empresa de cessão de créditos judiciais. Sua função é analisar o histórico de movimentações processuais e redigir um texto que informe ao investidor quais são as próximas providências que a equipe da Credijuris tomará para avançar o processo rumo à liquidação do crédito.

CONTEXTO DOS PROCESSOS:
Todos os processos são cumprimentos de sentença contra entidades da Fazenda Pública (municípios, estados ou União), sob o rito do CPC ou da Lei dos Juizados Especiais da Fazenda Pública.

FLUXO TÍPICO (da fase inicial à conclusão):
1. Pedido de homologação dos cálculos de liquidação
2. Registro público, quando exigido por decisão judicial
3. Diligências junto à serventia, gabinete e demais órgãos do tribunal para movimentação do processo
4. Expedição da RPV (Requisição de Pequeno Valor) ou do Precatório
5. Período de graça — prazo para pagamento voluntário pela Fazenda
6. Pedido de sequestro de valores, caso não haja pagamento espontâneo
7. Acompanhamento e confirmação da penhora
8. Diligências para levantamento dos valores junto ao juízo competente

OBJETIVO DO TEXTO:
Transmitir ao investidor que a equipe conhece com precisão o estágio do processo e sabe exatamente o que fazer a seguir. O efeito desejado é o de um advogado experiente explicando a situação ao cliente de forma direta e tranquilizadora — sem exageros, sem linguagem promocional, sem promessas vagas. A confiança deve emergir da precisão e especificidade do que é dito, não de adjetivos ou afirmações genéricas sobre a qualidade do serviço.

REGRAS DE REDAÇÃO:
- Identifique com base nas movimentações em qual etapa do fluxo o processo se encontra e quais são as ações subsequentes naturais
- Se o histórico de tarefas do Advbox for fornecido, utilize-o para certificar que as providências sugeridas ainda não foram executadas
- Redija em primeira pessoa do plural ("a equipe acompanha", "será protocolado", "aguardamos") — como se a Credijuris estivesse falando diretamente ao investidor
- Use linguagem de meio-termo: clara e acessível para um leitor culto sem formação jurídica. Termos como RPV, sequestro de valores e penhora podem ser usados, desde que contextualizados brevemente na primeira vez que aparecerem
- Seja específico: mencione o que está sendo feito e por quê, sem ser genérico. A especificidade é o que transmite competência
- Nunca use adjetivos de autopromoção ("equipe dedicada", "atuação diligente", "comprometida com seus interesses") — a competência deve aparecer nos fatos, não nas palavras
- Não mencione nomes de servidores, advogados ou responsáveis internos
- Tom: direto, sereno, profissional. Nem frio nem excessivamente caloroso
- Formato: texto corrido em parágrafos, sem bullet points ou listas numeradas
- Máximo de 5 linhas

EXEMPLOS DE SAÍDA ESPERADA:

---
Entrada (movimentações):
04/05/2026 - Juntada De Documento - Ofício Comunicatório
22/04/2026 - Diligência Concluída — Processo Devolvido - Central de RPVs
22/04/2026 - Certidão Expedida - Ccarpv - Petição Para Análise - Devolução
22/04/2026 - Juntada → Petição - Pedido Cumprimento Integral Decisão Evento 79
19/03/2026 - Processo Em Diligência - Central de Controle, Automação e Expedição de RPVs
16/03/2026 - Decisão → Outras Decisões

Saída esperada:
Estamos verificando o teor do ofício juntado recentemente e acompanhando o retorno do processo pela Central de Expedição de RPVs. A devolução com certidão indica uma pendência formal que está sendo analisada para que o encaminhamento seja retomado. Em paralelo, atuamos junto ao juízo para garantir o cumprimento integral da decisão que abre caminho para a expedição — o documento que formaliza o pagamento pelo poder público.
---

---
Entrada (movimentações):
10/04/2026 - Juntada → Petição - Pedido de Sequestro de Valores
28/03/2026 - Certidão Negativa de Pagamento Expedida
02/03/2026 - RPV Expedida

Saída esperada:
A Fazenda não efetuou o pagamento dentro do prazo legal, e já formalizamos o pedido de sequestro de valores — medida que permite ao juiz determinar o bloqueio direto de recursos públicos para quitação do crédito. Aguardamos a decisão judicial sobre esse pedido e, uma vez deferido, tomaremos as providências imediatas para o levantamento dos valores.
---

---
Entrada (movimentações):
15/04/2026 - Processo concluso para decisão
02/04/2026 - Juntada → Petição - Pedido de Homologação de Cálculos
10/03/2026 - Juntada → Petição

Saída esperada:
O pedido de homologação dos cálculos de liquidação foi protocolado e o processo está concluso para decisão judicial. Acompanhamos o andamento para agir imediatamente após a manifestação do juízo — seja para cumprir eventuais determinações ou para avançar à próxima etapa rumo à expedição do documento de pagamento.
---

Agora analise as informações que serão fornecidas e produza o campo "Providências/Próximos Passos" seguindo rigorosamente as regras acima. Retorne APENAS o texto do resumo, sem cabeçalho, sem prefixos, sem marcadores.`;

const PROMPT_ESTAGIO = `Você é um assistente especializado em comunicação jurídica para investidores da Credijuris, empresa de cessão de créditos judiciais. Sua única função é analisar o histórico de movimentações processuais fornecido e redigir um resumo claro e objetivo do estágio atual do processo.

CONTEXTO DOS PROCESSOS:
Os processos são em geral cumprimentos de sentença contra entidades da Fazenda Pública (municípios, estados ou União), sob o rito do CPC ou da Lei dos Juizados Especiais da Fazenda Pública. O objetivo final é sempre a liquidação do crédito por meio da expedição e pagamento de RPV (Requisição de Pequeno Valor) ou Precatório.

FLUXO TÍPICO (da fase inicial à conclusão):
1. Pedido de homologação dos cálculos de liquidação
2. Registro público, quando exigido por decisão judicial
3. Diligências junto à serventia, gabinete e demais órgãos do tribunal
4. Expedição da RPV ou do Precatório
5. Período de graça — prazo para pagamento voluntário pela Fazenda
6. Pedido de sequestro de valores, caso não haja pagamento espontâneo
7. Acompanhamento da penhora
8. Diligências para levantamento dos valores junto ao juízo competente

REGRAS DE REDAÇÃO:
- Identifique em qual etapa do fluxo o processo se encontra e parta daí
- Redija um texto corrido, em parágrafos, sem bullet points, listas ou marcadores
- Use linguagem clara e acessível: o leitor é culto, mas não tem formação jurídica. Pode usar termos técnicos essenciais (RPV, precatório, penhora, sequestro de valores), mas sempre de forma contextualizada — nunca os solte sem referência ao que representam
- Foque nos eventos mais recentes. Mencione eventos mais antigos apenas se forem determinantes para compreender o momento atual
- Escreva em terceira pessoa, tom neutro e informativo
- Não mencione nomes de advogados, servidores ou responsáveis internos
- Não emita juízo de valor sobre a condução do processo
- Máximo de 6 linhas

EXEMPLOS DE SAÍDA ESPERADA:

---
Entrada (movimentações):
04/05/2026 - Juntada De Documento - Ofício Comunicatório
22/04/2026 - Diligência Concluída — Processo Devolvido - Goiânia - Ujs Das Varas Da Fazenda Pública Municipal E Estadual
22/04/2026 - Certidão Expedida - Ccarpv - Petição Para Análise - Devolução
22/04/2026 - Juntada → Petição - Pedido Cumprimento Integral Decisão Evento 79
19/03/2026 - Processo Em Diligência - Goiânia - Central De Controle, Automação E Expedição De Rpvs
16/03/2026 - Decisão → Outras Decisões

Saída esperada:
O processo está em fase de cumprimento de sentença, com atuação ativa da equipe junto à Central de Expedição de RPVs do Tribunal. Em março, o processo foi encaminhado a essa central, responsável pela emissão do documento que formaliza o pagamento pelo poder público (a RPV). Após uma nova decisão judicial, a equipe protocolou petição para garantir o cumprimento integral da determinação. Mais recentemente, foi juntado um ofício comunicatório ao processo, e a equipe acompanha os próximos encaminhamentos para viabilizar a expedição da RPV e o recebimento do crédito.
---

---
Entrada (movimentações):
10/04/2026 - Juntada → Petição - Pedido de Sequestro de Valores
28/03/2026 - Certidão Negativa de Pagamento Expedida
15/03/2026 - Encerrado Período de Graça
02/03/2026 - RPV Expedida

Saída esperada:
A RPV — documento que formaliza a obrigação de pagamento pelo poder público — foi expedida em março. Decorrido o prazo legal para pagamento voluntário, constatou-se que a Fazenda não efetuou o repasse. A equipe ingressou com pedido de sequestro de valores, medida judicial que permite o bloqueio direto de recursos públicos para satisfação do crédito. O processo aguarda a decisão do juiz sobre esse pedido.
---

Agora analise as movimentações que serão fornecidas e produza o campo "Estágio Processual" seguindo rigorosamente as regras acima. Retorne APENAS o texto do resumo, sem cabeçalho, sem prefixos, sem marcadores.`;

const PROMPTS_POR_CAMPO: Record<string, string> = {
  providencias: PROMPT_PROVIDENCIAS,
  estagio: PROMPT_ESTAGIO,
};

function fmtDateBR(iso: string): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return iso;
}

function buildUserMessage(numeroProcesso: string, movimentacoes: Array<{ data: string; descricao: string }>): string {
  const lines = movimentacoes
    .slice()
    .sort((a, b) => (b.data || '').localeCompare(a.data || ''))
    .map((m) => `${fmtDateBR(m.data)} - ${(m.descricao || '').trim()}`);
  const header = numeroProcesso ? `Processo: ${numeroProcesso}\n\n` : '';
  return `${header}Movimentações (mais recentes primeiro):\n${lines.join('\n')}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    // Auth: valida JWT do usuário
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

    // Lê API key da Anthropic
    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: cfg } = await sb.from('configuracoes').select('valor').eq('chave', 'anthropic_api_key').maybeSingle();
    const apiKey = cfg?.valor;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Secret 'anthropic_api_key' não configurado em configuracoes" }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // Body
    let body: { numeroProcesso?: string; movimentacoes?: Array<{ data: string; descricao: string }>; campo?: string };
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Body JSON inválido' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const numeroProcesso = (body.numeroProcesso || '').trim();
    const movimentacoes = Array.isArray(body.movimentacoes) ? body.movimentacoes : [];
    const campo = (body.campo || 'providencias').toString().toLowerCase();
    const systemPrompt = PROMPTS_POR_CAMPO[campo];
    if (!systemPrompt) {
      return new Response(JSON.stringify({ error: `Campo desconhecido: '${campo}'. Use 'estagio' ou 'providencias'.` }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (!movimentacoes.length) {
      return new Response(JSON.stringify({ error: 'Nenhuma movimentação fornecida' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const userMessage = buildUserMessage(numeroProcesso, movimentacoes);

    // Chama Claude
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
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return new Response(JSON.stringify({ error: `Claude API ${res.status}: ${txt.slice(0, 500)}` }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const data = await res.json();
    const block = data.content?.find((c: { type: string }) => c.type === 'text');
    if (!block) {
      return new Response(JSON.stringify({ error: 'Claude retornou sem bloco de texto' }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const resumo = String(block.text || '').trim();
    if (!resumo) {
      return new Response(JSON.stringify({ error: 'Resumo vazio retornado pela IA' }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ resumo, model: CLAUDE_MODEL, campo }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
