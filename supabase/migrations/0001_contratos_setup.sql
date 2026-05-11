-- ============================================================================
-- Migration 0001 — Setup do gerador de contratos
--
-- Cria:
--   • tabela `investidores`        (migrada do investidores.json)
--   • tabela `contratos_jobs`      (auditoria/histórico de gerações)
--   • garante existência de `configuracoes` (já usada pelo advbox)
--   • RLS pra todas — só usuários autenticados acessam
--
-- Como rodar:
--   1. Abra Supabase Studio → SQL Editor → New query
--   2. Cole este arquivo todo, clique em "Run"
-- ============================================================================

-- ── 1. Tabela `configuracoes` (idempotente — pode já existir) ────────────────
create table if not exists public.configuracoes (
  chave        text primary key,
  valor        text not null,
  descricao    text,
  updated_at   timestamptz not null default now()
);

alter table public.configuracoes enable row level security;

drop policy if exists "configuracoes: leitura autenticada"     on public.configuracoes;
drop policy if exists "configuracoes: escrita autenticada"     on public.configuracoes;

create policy "configuracoes: leitura autenticada"
  on public.configuracoes for select
  to authenticated using (true);

create policy "configuracoes: escrita autenticada"
  on public.configuracoes for all
  to authenticated using (true) with check (true);


-- ── 2. Tabela `investidores` ─────────────────────────────────────────────────
create table if not exists public.investidores (
  id           uuid primary key default gen_random_uuid(),
  nome         text not null,
  cpf          text,
  rg           text,
  endereco     text,
  banco        text,
  agencia      text,
  conta        text,
  pix          text,
  ativo        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists investidores_nome_idx on public.investidores (nome);
create index if not exists investidores_cpf_idx  on public.investidores (cpf);

alter table public.investidores enable row level security;

drop policy if exists "investidores: leitura autenticada" on public.investidores;
drop policy if exists "investidores: escrita autenticada" on public.investidores;

create policy "investidores: leitura autenticada"
  on public.investidores for select
  to authenticated using (true);

create policy "investidores: escrita autenticada"
  on public.investidores for all
  to authenticated using (true) with check (true);


-- ── 3. Tabela `contratos_jobs` — histórico de gerações ───────────────────────
-- Útil pra auditoria, debugging, retry. Não é o contrato em si — só metadados.
create table if not exists public.contratos_jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete set null,
  investidor_id   uuid references public.investidores(id) on delete set null,
  tipos           text[] not null,                          -- ['cessao_credito','procuracao',...]
  intermediador   text,                                     -- nome da pasta no Drive
  numero_processo text,
  cedente_nome    text,
  status          text not null default 'pending',          -- pending|processing|ok|erro
  erro_msg        text,
  drive_folder_id text,                                     -- id da pasta "Contratos assinados"
  drive_folder_url text,                                    -- link clicável
  variaveis_extraidas jsonb,                                -- auditoria do que a IA extraiu
  pendentes       text[],                                   -- variáveis não preenchidas
  arquivos_input  jsonb,                                    -- {cedente:[paths], apresentacao:[...]}
  arquivos_output jsonb,                                    -- ['contrato_cessao_credito_20260511.docx', ...]
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists contratos_jobs_user_idx       on public.contratos_jobs (user_id, created_at desc);
create index if not exists contratos_jobs_status_idx     on public.contratos_jobs (status);
create index if not exists contratos_jobs_investidor_idx on public.contratos_jobs (investidor_id);

alter table public.contratos_jobs enable row level security;

drop policy if exists "contratos_jobs: leitura autenticada" on public.contratos_jobs;
drop policy if exists "contratos_jobs: escrita autenticada" on public.contratos_jobs;

create policy "contratos_jobs: leitura autenticada"
  on public.contratos_jobs for select
  to authenticated using (true);

create policy "contratos_jobs: escrita autenticada"
  on public.contratos_jobs for all
  to authenticated using (true) with check (true);


-- ── 4. Trigger pra updated_at automático ─────────────────────────────────────
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tg_investidores_updated   on public.investidores;
create trigger tg_investidores_updated  before update on public.investidores
  for each row execute function public.tg_set_updated_at();

drop trigger if exists tg_contratos_jobs_updated on public.contratos_jobs;
create trigger tg_contratos_jobs_updated before update on public.contratos_jobs
  for each row execute function public.tg_set_updated_at();

drop trigger if exists tg_configuracoes_updated  on public.configuracoes;
create trigger tg_configuracoes_updated before update on public.configuracoes
  for each row execute function public.tg_set_updated_at();
