-- ============================================================================
-- Seed da tabela `configuracoes` — secrets do gerador de contratos
--
-- ⚠️  ESTE ARQUIVO TEM SECRETS. NÃO COMITAR NO GITHUB.
--     Já está no .gitignore (supabase/seeds/).
--
-- COMO USAR:
--   1. Copie este arquivo para `configuracoes.sql` (sem _template)
--   2. Substitua os 4 valores `__PREENCHA_AQUI__` pelos valores reais:
--
--      ANTHROPIC_API_KEY        → de credijuris-contratos/.env
--                                  (linha: ANTHROPIC_API_KEY=sk-ant-...)
--
--      GOOGLE_OAUTH_CLIENT_ID   → de credijuris-contratos/client_secrets.json
--                                  → chave "client_id" dentro de "installed"
--
--      GOOGLE_OAUTH_CLIENT_SECRET → de credijuris-contratos/client_secrets.json
--                                    → chave "client_secret" dentro de "installed"
--
--      GOOGLE_OAUTH_REFRESH_TOKEN → de credijuris-contratos/token.json
--                                    → chave "refresh_token"
--
--   3. Supabase Studio → SQL Editor → cole `configuracoes.sql` → Run
--   4. Confirma que rodou:   select chave, length(valor) from configuracoes;
--
-- O Edge Function lê esses valores usando service-role — nunca expõe no client.
-- ============================================================================

insert into public.configuracoes (chave, valor, descricao) values
  ('anthropic_api_key',
   '__PREENCHA_AQUI__',
   'API key da Anthropic — extração de variáveis dos documentos'),

  ('google_oauth_client_id',
   '__PREENCHA_AQUI__',
   'OAuth Client ID do projeto Google credijuris-contratos (Desktop app)'),

  ('google_oauth_client_secret',
   '__PREENCHA_AQUI__',
   'OAuth Client Secret correspondente'),

  ('google_oauth_refresh_token',
   '__PREENCHA_AQUI__',
   'Refresh token gerado pelo fluxo OAuth do main.py — usado pra obter access_token novo a cada chamada')
on conflict (chave) do update set
  valor = excluded.valor,
  descricao = excluded.descricao,
  updated_at = now();

-- Sanity check (mostra só o tamanho, nunca o valor)
select chave, length(valor) as valor_len, descricao from public.configuracoes
where chave in ('anthropic_api_key','google_oauth_client_id','google_oauth_client_secret','google_oauth_refresh_token','advbox_token')
order by chave;
