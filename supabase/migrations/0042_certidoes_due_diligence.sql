-- Due diligence documental do cedente: catálogo de certidões, regras e checklist.
--
-- Hoje a due diligence vive na planilha "Modelo: Análise de Precatórios", aba
-- Análise Jurídica, e quem monta a lista de certidões é uma pessoa lendo a
-- planilha. O erro que isso produz não é digitar errado — é ESQUECER: o estado
-- onde o cedente morou antes, o cônjuge, a empresa em que ele é sócio. Cada
-- omissão é uma certidão que ninguém emite e ninguém percebe que faltou.
--
-- Esta migration move a planilha para dentro do banco em três partes:
--
--   certidao_catalogo  O QUE existe (uma linha por tipo de certidão)
--   certidao_regra     QUANDO cada uma é exigida
--   dd_sujeito         DE QUEM (cedente, cônjuge, PJ, advogado)
--   dd_certidao        o checklist daquele crédito, congelado
--
-- A regra central — "não consegui emitir" não é "não precisa emitir" — fica no
-- BANCO, não na aplicação: os checks e o trigger no fim deste arquivo tornam
-- impossível marcar a etapa documental como concluída com certidão faltando.
-- Se a regra vivesse no TypeScript, um segundo consumidor (um cron, um script,
-- alguém no SQL Editor do Supabase) a contornaria sem querer.
--
-- Cada linha do catálogo aponta a LINHA da planilha de onde veio
-- (origem_planilha), para que qualquer divergência futura seja resolvível
-- contra a fonte em vez de discutida de memória.

-- ============================================================
-- 1. Catálogo: o que existe no mundo
-- ============================================================

create table if not exists public.certidao_catalogo (
  codigo           text primary key,
  nome_oficial     text not null,
  nome_curto       text not null,
  orgao_emissor    text not null,
  esfera           text,
  abrangencia      text,          -- nacional | uf | municipio | tribunal | comarca
  ordem_canonica   int  not null,
  url_oficial      text,

  -- Como se obtém. 'api' e 'portal_auto' são os únicos sem intervenção humana;
  -- 'portal_assistido' é o robô preenchendo e a pessoa resolvendo o CAPTCHA.
  metodo           text not null default 'manual'
                   check (metodo in ('api','portal_auto','portal_assistido','manual')),

  exige_captcha    boolean not null default false,
  -- O TIPO importa, não só a existência: CAPTCHA de imagem pode ser
  -- retransmitido ao operador; reCAPTCHA está preso à sessão e ao IP do
  -- navegador de origem, e mandar um print dele não gera token válido. É esse
  -- campo que decide se a emissão assistida é viável ou se cai para manual.
  captcha          text not null default 'nenhum'
                   check (captcha in ('nenhum','imagem','recaptcha','hcaptcha','desconhecido')),

  login            text not null default 'nenhum'
                   check (login in ('nenhum','govbr','cadastro','certificado_digital')),

  gratuita         boolean,       -- null = não confirmado em fonte oficial
  validade_dias    int,           -- null = sem prazo declarado
  sla_horas        int,           -- TJMG via RUPE não é instantâneo: 48h

  -- Insumos exigidos pelo portal. dados_entrada_pf/_pj somam ao comum: a CND
  -- federal pede data de nascimento no fluxo anônimo de pessoa física, e exigir
  -- isso de um CNPJ geraria pendência falsa.
  dados_entrada    jsonb not null default '[]'::jsonb,
  dados_entrada_pf jsonb not null default '[]'::jsonb,
  dados_entrada_pj jsonb not null default '[]'::jsonb,

  regra_positiva   text,          -- o que fazer quando a certidão vem positiva
  origem_planilha  text not null, -- linha da planilha, ou 'proposta'
  observacoes      text,
  atualizado_em    timestamptz not null default now(),

  -- Declarar CAPTCHA sem dizer o tipo esconde exatamente a informação que
  -- decide o método de emissão.
  constraint certidao_catalogo_captcha_coerente
    check (exige_captcha = (captcha <> 'nenhum')),

  -- Um método declarado automático não pode depender de gente. Sem este check,
  -- bastaria alguém marcar 'api' num item com CAPTCHA para o motor tentar
  -- emitir sozinho e falhar em silêncio.
  constraint certidao_catalogo_metodo_sem_bloqueio
    check (metodo not in ('api','portal_auto')
           or (exige_captcha = false and login in ('nenhum','cadastro')))
);

-- A ordem numera os arquivos no Drive. Única e estável: a mesma certidão tem
-- sempre o mesmo número, em todos os dossiês.
create unique index if not exists certidao_catalogo_ordem_uk
  on public.certidao_catalogo (ordem_canonica);

-- ============================================================
-- 2. Regras: quando cada certidão é exigida
-- ============================================================

create table if not exists public.certidao_regra (
  id              bigserial primary key,
  tipo            text not null check (tipo in ('FIXA','VARIAVEL')),

  -- Condição declarativa avaliada contra o contexto do caso. Formas aceitas:
  --   {"sempre": true}
  --   {"uf": "MG"} | {"uf": {"in": ["MG","SP"]}}
  --   {"uf": {"any_not_in": ["SP"]}}   -- ver nota da CENPROT no seed
  --   {"tipo_pessoa": "PJ"}
  condicao        jsonb not null,

  certidao_codigo text not null references public.certidao_catalogo (codigo) on delete cascade,

  -- A quais sujeitos a regra vale. A planilha dá bloco próprio ao cônjuge
  -- (linhas 52-67) e à pessoa jurídica (68-81) — não é o mesmo checklist
  -- repetido, são conjuntos diferentes.
  aplica_a        text[] not null default '{CEDENTE}',

  -- Expande em vários itens: {"uf": "{{ufs}}"} gera uma certidão por UF de
  -- residência do sujeito, atual e anteriores.
  parametros      jsonb not null default '{}'::jsonb,

  obrigatoria     boolean not null default true,
  justificativa   text not null,   -- por que exigimos: é o que se audita depois
  origem          text not null default 'checklist_oficial'
                  check (origem in ('checklist_oficial','proposta')),
  vigencia_inicio date not null default current_date,
  vigencia_fim    date,
  versao          int  not null default 1,

  constraint certidao_regra_vigencia
    check (vigencia_fim is null or vigencia_fim > vigencia_inicio),

  -- FIXA não avalia contexto; VARIAVEL sem condição real seria FIXA disfarçada.
  constraint certidao_regra_condicao_por_tipo
    check ((tipo = 'FIXA'     and condicao = '{"sempre": true}'::jsonb)
        or (tipo = 'VARIAVEL' and condicao <> '{"sempre": true}'::jsonb))
);

create index if not exists certidao_regra_certidao_idx
  on public.certidao_regra (certidao_codigo);

-- ============================================================
-- 3. Sujeitos do caso
-- ============================================================

create table if not exists public.dd_sujeito (
  id             uuid primary key default gen_random_uuid(),

  -- Sem FK para kommo_leads, pelo mesmo motivo do analises_credito.kommo_lead_id
  -- na 0014: o espelho de cards é descartável e recriado pelo sync; a due
  -- diligence sobrevive ao card.
  kommo_lead_id  bigint not null,

  papel          text not null check (papel in ('CEDENTE','CONJUGE','PJ','ADVOGADO')),
  tipo_pessoa    text not null check (tipo_pessoa in ('PF','PJ')),
  nome           text not null,
  documento      text not null,   -- só dígitos
  nome_mae       text,
  data_nascimento date,
  rg             text,

  -- Residência ATUAL e ANTERIORES. É este histórico, e não os tribunais onde a
  -- busca por CPF achou processo, que determina quais certidões estaduais e
  -- municipais são exigidas (planilha, linhas 48, 64 e 78). Uma residência
  -- antiga pode não ter processo nenhum e ainda assim exigir certidão.
  uf_atual              char(2),
  municipio_atual       text,
  ufs_anteriores        text[] not null default '{}',
  municipios_anteriores text[] not null default '{}',

  -- Enquanto for false, o checklist cobre só os endereços conhecidos hoje. É uma
  -- lacuna real e precisa ficar visível: "não sei se morou em outro estado" e
  -- "não morou em outro estado" são respostas diferentes.
  residencia_levantada  boolean not null default false,
  fonte_residencia      text,

  criado_por     uuid references public.profiles (id) on delete set null,
  criado_em      timestamptz not null default now(),

  unique (kommo_lead_id, papel, documento),

  constraint dd_sujeito_documento_digitos
    check (documento ~ '^[0-9]{11}$' or documento ~ '^[0-9]{14}$'),
  constraint dd_sujeito_tipo_bate_documento
    check ((tipo_pessoa = 'PF' and length(documento) = 11)
        or (tipo_pessoa = 'PJ' and length(documento) = 14))
);

create index if not exists dd_sujeito_lead_idx on public.dd_sujeito (kommo_lead_id, papel);

-- Um cedente por crédito. Sem isto, dois sync ou dois cliques criariam dois
-- cedentes e o checklist sairia dobrado.
create unique index if not exists dd_sujeito_um_cedente_uk
  on public.dd_sujeito (kommo_lead_id) where papel = 'CEDENTE';

-- ============================================================
-- 4. O checklist congelado
-- ============================================================

create table if not exists public.dd_certidao (
  id              uuid primary key default gen_random_uuid(),
  kommo_lead_id   bigint not null,
  sujeito_id      uuid not null references public.dd_sujeito (id) on delete cascade,
  certidao_codigo text not null references public.certidao_catalogo (codigo),

  parametros      jsonb not null default '{}'::jsonb,   -- {"uf":"SP"} | {"municipio":"Campinas"}
  parametros_hash text not null,                        -- md5 do jsonb normalizado
  obrigatoria     boolean not null default true,
  regra_id        bigint references public.certidao_regra (id) on delete set null,

  status          text not null default 'PENDENTE'
                  check (status in ('PENDENTE','EM_EMISSAO','OBTIDA',
                                    'PENDENTE_MANUAL','FALHA','NAO_APLICAVEL')),

  metodo_obtido   text,
  drive_file_id   text,
  drive_link      text,
  arquivo_sha256  char(64),
  emitida_em      date,
  validade_ate    date,
  url_fonte       text,
  erro_classe     text,
  erro_detalhe    text,

  dispensa_motivo      text,
  dispensa_aprovada_por uuid references public.profiles (id) on delete set null,

  atualizado_em   timestamptz not null default now(),

  unique (kommo_lead_id, sujeito_id, certidao_codigo, parametros_hash),

  -- OBTIDA sem arquivo é o furo que torna todo o resto decorativo: alguém dá
  -- baixa, o placar fecha, e o PDF não existe.
  constraint dd_certidao_obtida_exige_arquivo
    check (status <> 'OBTIDA' or drive_file_id is not null),
  constraint dd_certidao_obtida_exige_data
    check (status <> 'OBTIDA' or emitida_em is not null),

  -- Dispensar nunca é automático: exige motivo escrito e responsável nominal.
  -- É o único caminho legítimo para tirar uma certidão obrigatória da conta.
  constraint dd_certidao_dispensa_justificada
    check (status <> 'NAO_APLICAVEL'
           or (dispensa_motivo is not null and dispensa_aprovada_por is not null))
);

create index if not exists dd_certidao_lead_idx on public.dd_certidao (kommo_lead_id, status);
create index if not exists dd_certidao_pendencia_idx on public.dd_certidao (status)
  where status in ('PENDENTE_MANUAL','FALHA');

-- Preenche validade_ate a partir do catálogo. Ninguém precisa lembrar de contar
-- 180 dias, e uma certidão que vence antes da aquisição fechar reabre sozinha
-- (ver reabrir_certidoes_vencidas abaixo).
create or replace function public.dd_certidao_calcular_validade()
returns trigger language plpgsql as $$
declare dias int;
begin
  if new.status = 'OBTIDA' and new.emitida_em is not null and new.validade_ate is null then
    select validade_dias into dias
      from public.certidao_catalogo where codigo = new.certidao_codigo;
    if dias is not null then
      new.validade_ate := new.emitida_em + dias;
    end if;
  end if;
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists dd_certidao_validade on public.dd_certidao;
create trigger dd_certidao_validade
  before insert or update on public.dd_certidao
  for each row execute function public.dd_certidao_calcular_validade();

-- ============================================================
-- 5. A trava de completude
-- ============================================================

-- Placar por crédito. LEFT JOIN de propósito: um crédito sem nenhuma certidão
-- tem que aparecer como incompleto, não desaparecer da view.
create or replace view public.v_dd_completude as
select
  s.kommo_lead_id,
  count(c.id) filter (where c.obrigatoria and c.status <> 'NAO_APLICAVEL')     as necessarias,
  count(c.id) filter (where c.obrigatoria and c.status = 'OBTIDA'
                        and c.drive_file_id is not null
                        and (c.validade_ate is null or c.validade_ate >= current_date))
                                                                               as obtidas_validas,
  count(c.id) filter (where c.obrigatoria
                        and c.status in ('PENDENTE','EM_EMISSAO','PENDENTE_MANUAL','FALHA'))
                                                                               as pendentes,
  count(c.id) filter (where c.obrigatoria and c.status = 'OBTIDA'
                        and c.validade_ate < current_date)                     as vencidas,
  count(c.id) filter (where c.status = 'NAO_APLICAVEL')                        as dispensadas
from (select distinct kommo_lead_id from public.dd_sujeito) s
left join public.dd_certidao c on c.kommo_lead_id = s.kommo_lead_id
group by s.kommo_lead_id;

-- Registro de que a etapa documental fechou, e por quem.
create table if not exists public.dd_etapa_documental (
  kommo_lead_id bigint primary key,
  concluida_em  timestamptz not null default now(),
  concluida_por uuid references public.profiles (id) on delete set null
);

-- Marca a etapa documental como concluída, ou RECUSA dizendo o que falta.
--
-- É função, e não coluna com trigger, porque não existe uma tabela "dossiê":
-- o crédito é o card do Kommo. A função é a única porta, e ela conta em vez de
-- confiar. Chamar de qualquer lugar dá o mesmo resultado.
create or replace function public.dd_concluir_documental(p_lead_id bigint)
returns void language plpgsql security invoker as $$
declare c record;
begin
  select * into c from public.v_dd_completude where kommo_lead_id = p_lead_id;

  if c is null or c.necessarias = 0 then
    raise exception
      'Crédito %: nenhuma certidão obrigatória no checklist. Um checklist vazio não é um checklist completo.',
      p_lead_id using errcode = 'check_violation';
  end if;

  if c.pendentes > 0 or c.vencidas > 0 or c.obtidas_validas <> c.necessarias then
    raise exception
      'Crédito % incompleto: % de % obtidas, % pendente(s), % vencida(s).',
      p_lead_id, c.obtidas_validas, c.necessarias, c.pendentes, c.vencidas
      using errcode = 'check_violation';
  end if;

  insert into public.dd_etapa_documental (kommo_lead_id, concluida_em, concluida_por)
  values (p_lead_id, now(), auth.uid())
  on conflict (kommo_lead_id) do nothing;
end $$;

-- Devolve à fila a certidão que venceu. Sem isto, uma certidão vencida trava o
-- crédito (a trava acima barra o fechamento) mas não reaparece para ninguém —
-- bloqueado e invisível, o pior dos dois mundos. Rodar diariamente por cron.
create or replace function public.reabrir_certidoes_vencidas()
returns table (kommo_lead_id bigint, certidao_codigo text, venceu_em date)
language plpgsql as $$
begin
  return query
  update public.dd_certidao c
     set status = 'PENDENTE',
         erro_classe = 'VENCIDA',
         erro_detalhe = format('Certidão venceu em %s; reemissão necessária.', c.validade_ate)
   where c.status = 'OBTIDA'
     and c.validade_ate is not null
     and c.validade_ate < current_date
  returning c.kommo_lead_id, c.certidao_codigo, c.validade_ate;
end $$;

-- ============================================================
-- 6. RLS
-- ============================================================

alter table public.certidao_catalogo    enable row level security;
alter table public.certidao_regra       enable row level security;
alter table public.dd_sujeito           enable row level security;
alter table public.dd_certidao          enable row level security;
alter table public.dd_etapa_documental  enable row level security;

-- Catálogo e regras: qualquer autenticado lê (a UI mostra o checklist); só a
-- service_role escreve, porque mudar uma regra muda o checklist de todos os
-- créditos futuros — é alteração de política, não de dado operacional.
drop policy if exists "certidao_catalogo_select" on public.certidao_catalogo;
create policy "certidao_catalogo_select" on public.certidao_catalogo
  for select to authenticated using (true);

drop policy if exists "certidao_regra_select" on public.certidao_regra;
create policy "certidao_regra_select" on public.certidao_regra
  for select to authenticated using (true);

-- Operacional: autenticado lê e escreve. O upload de PDF e a dispensa passam
-- pela UI em nome de uma pessoa, e os checks acima já impedem o que não pode.
drop policy if exists "dd_sujeito_all" on public.dd_sujeito;
create policy "dd_sujeito_all" on public.dd_sujeito
  for all to authenticated using (true) with check (true);

drop policy if exists "dd_certidao_all" on public.dd_certidao;
create policy "dd_certidao_all" on public.dd_certidao
  for all to authenticated using (true) with check (true);

drop policy if exists "dd_etapa_documental_select" on public.dd_etapa_documental;
create policy "dd_etapa_documental_select" on public.dd_etapa_documental
  for select to authenticated using (true);

-- ============================================================
-- 7. Seed: o checklist da planilha
-- ============================================================
--
-- Transcrito da aba Análise Jurídica, linhas 27 a 81. O campo origem_planilha
-- guarda a linha de origem de cada item — quando alguém discordar da lista, a
-- discussão é contra a planilha, não contra a memória de quem programou.
--
-- Itens com origem_planilha = 'proposta' NÃO constam do checklist oficial: são
-- sugestões, e por isso as regras deles nascem obrigatoria = false. Promover é
-- trocar um boolean; descartar é apagar duas linhas.
--
-- captcha = 'desconhecido' significa "ninguém abriu esse portal no navegador
-- ainda para ver". É honesto e já basta para o motor não tentar automatizar:
-- só 'imagem' habilita emissão assistida barata.

insert into public.certidao_catalogo
  (codigo, nome_oficial, nome_curto, orgao_emissor, esfera, abrangencia,
   ordem_canonica, url_oficial, metodo, exige_captcha, captcha, login,
   gratuita, validade_dias, sla_horas, dados_entrada, dados_entrada_pf,
   regra_positiva, origem_planilha, observacoes)
values
  ('FED.CND_RFB_PGFN',
   'Certidão Negativa de Débitos relativos a Créditos Tributários Federais e à Dívida Ativa da União',
   'CND Federal', 'RFB-PGFN', 'federal', 'nacional', 1,
   'https://servicos.receitafederal.gov.br/servico/certidoes/',
   'portal_assistido', true, 'desconhecido', 'nenhum', true, 180, null,
   '["documento"]', '["data_nascimento"]',
   'Se positiva, pesquisar execuções fiscais e registrar nº do processo e valor.',
   'linhas 28 e 54',
   'Validade de 180 dias pela Portaria Conjunta RFB/PGFN 1.751/2014, art. 10.'),

  ('TRAB.CNDT', 'Certidão Negativa de Débitos Trabalhistas', 'CNDT', 'TST',
   'trabalhista', 'nacional', 2, 'https://cndt-certidao.tst.jus.br/inicio.faces',
   'portal_assistido', true, 'imagem', 'nenhum', true, 180, null,
   '["documento"]', '[]',
   'Se positiva, registrar nº do processo, objeto, valor cobrado e estágio.',
   'linhas 29 e 55',
   'CAPTCHA de imagem verificado em tela — emissão assistida é viável aqui. '
   'Validade de 180 dias pela CLT art. 642-A, §4º. ATENÇÃO: a Certidão POSITIVA '
   'COM EFEITOS DE NEGATIVA (art. 642-A, §2º) é desfecho válido e deve contar '
   'como negativa, com ressalva — confundir as duas reprova crédito bom.'),

  ('FED.CJF_UNIFICADA', 'Certidão Unificada da Justiça Federal',
   'Certidao Unificada JF', 'CJF', 'federal', 'nacional', 3,
   'https://certidao-unificada.cjf.jus.br/#/solicitacao-certidao',
   'portal_assistido', true, 'desconhecido', 'nenhum', true, null, null,
   '["documento","nome"]', '[]', null, 'linhas 30 e 56',
   'Cobre TRF1 a TRF5 — o TRF6 está FORA. Por isso o checklist pede, além '
   'desta, a certidão individual de cada TRF.'),

  ('FED.TRF1','Certidão Unificada do TRF da 1ª Região','Certidao TRF1','TRF1',
   'federal','tribunal',4,'https://sistemas.trf1.jus.br/certidao/#/solicitacao',
   'portal_assistido',true,'desconhecido','nenhum',true,null,null,'["documento","nome"]','[]',null,'linha 31',null),
  ('FED.TRF2','Certidão Unificada do TRF da 2ª Região','Certidao TRF2','TRF2',
   'federal','tribunal',5,'https://certidoes.trf2.jus.br/certidoes/#/principal/solicitar',
   'portal_assistido',true,'desconhecido','nenhum',true,null,null,'["documento","nome"]','[]',null,'linha 32',null),
  ('FED.TRF3','Certidão Unificada do TRF da 3ª Região','Certidao TRF3','TRF3',
   'federal','tribunal',6,'https://web.trf3.jus.br/certidao-regional/CertidaoCivelEleitoralCriminal/SolicitarDadosCertidao',
   'portal_assistido',true,'desconhecido','nenhum',true,null,null,'["documento","nome"]','[]',null,'linha 33',null),
  ('FED.TRF4','Certidão Unificada do TRF da 4ª Região','Certidao TRF4','TRF4',
   'federal','tribunal',7,'https://www2.trf4.jus.br/trf4/processos/certidao/index.php',
   'portal_assistido',true,'desconhecido','nenhum',true,null,null,'["documento","nome"]','[]',null,'linha 34',null),
  ('FED.TRF5','Certidão Unificada do TRF da 5ª Região','Certidao TRF5','TRF5',
   'federal','tribunal',8,'https://certidoes.trf5.jus.br/certidoes2022/',
   'portal_assistido',true,'desconhecido','nenhum',true,null,null,'["documento","nome"]','[]',null,'linha 35',null),
  ('FED.TRF6','Certidão Unificada do TRF da 6ª Região','Certidao TRF6','TRF6',
   'federal','tribunal',9,'https://sistemas.trf6.jus.br/certidao/#/solicitacao',
   'portal_assistido',true,'desconhecido','nenhum',true,null,null,'["documento","nome"]','[]',null,'linha 36',
   'A planilha traz duas URLs (sistemas.trf6 para PJe/legados e '
   'certidao.trf6.jus.br/consulta para eproc). Podem ser DOIS documentos.'),

  ('EXTRA.PROTESTO_CENPROT','Pesquisa de Protestos — CENPROT Nacional',
   'Protesto CENPROT','IEPTB','extrajudicial','nacional',10,
   'https://www.cenprotnacional.org.br/','manual',false,'nenhum','cadastro',
   true,null,null,'["documento"]','[]',
   'Se positiva, descrever as dívidas, o credor e o valor de cada uma.',
   'linhas 37 e 57',
   'NÃO cobre São Paulo — SP tem central própria. A consulta é gratuita; a '
   'certidão com fé pública é PAGA, com emolumento por cartório.'),

  ('EXTRA.PROTESTO_CENPROT_SP','Pesquisa de Protestos — CENPROT São Paulo',
   'Protesto CENPROT-SP','IEPTB-SP','extrajudicial','uf',11,
   'https://protestosp.com.br/consulta-de-protesto','manual',false,'nenhum',
   'nenhum',true,null,null,'["documento"]','[]',null,
   'linha 37 (desdobramento: SP não é coberto pela nacional)',null),

  ('FGTS.CRF','Certificado de Regularidade do FGTS','CRF FGTS','CAIXA',
   'federal','nacional',12,
   'https://consulta-crf.caixa.gov.br/consultacrf/pages/consultaEmpregador.jsf',
   'portal_assistido',true,'desconhecido','nenhum',true,30,null,
   '["documento"]','[]',null,'linhas 58 e 70',
   'Só existe CRF para quem é EMPREGADOR inscrito no FGTS. Para sujeito que '
   'não é empregador, a não emissão NÃO é indício negativo — o item deve ser '
   'DISPENSADO com motivo, não deixado pendente para sempre.'),

  ('EST.CDT','Certidão de Débitos Tributários Estaduais','CDT Estadual',
   'Fazenda Estadual','estadual','uf',20,null,'portal_assistido',true,
   'desconhecido','nenhum',null,null,null,'["documento","uf"]','[]',
   'Se positiva, pesquisar execuções fiscais e registrar nº e valor.',
   'linhas 44, 49, 60, 65, 73 e 79',
   'Uma emissão por UF de residência, ATUAL E ANTERIORES. Portal e regras '
   'mudam por estado. Em MG (cdt.fazenda.mg.gov.br) o resultado negativo e o '
   'positivo com efeito de negativa saem sem login; só o positivo exige gov.br.'),

  ('EST.TJ_CIVEL_CRIMINAL',
   'Certidões Cíveis e Criminais do Tribunal de Justiça Estadual',
   'TJ Civel-Criminal','Tribunal de Justica','estadual','uf',21,null,
   'portal_assistido',true,'desconhecido','nenhum',null,null,48,
   '["documento","nome","uf"]','[]',
   'Se positiva, registrar nº do processo, objeto, valor e ESTÁGIO — é o '
   'estágio que decide entre recusar, avaliar e aceitar.',
   'linhas 47, 51, 63, 67, 76 e 81',
   'Uma emissão por UF de residência. Vários TJs emitem por NOME e por '
   'COMARCA, não por CPF (o TJMG é assim, via RUPE, com 48h de prazo): risco '
   'alto de homônimo, conferência humana obrigatória. O TJSP exige conta '
   'gov.br e emite DOIS documentos (SAJ e eproc).'),

  ('MUN.CND','Certidão de Débitos Tributários Municipais','CND Municipal',
   'Prefeitura','municipal','municipio',30,null,'portal_assistido',true,
   'desconhecido','nenhum',null,null,null,'["documento","municipio"]','[]',
   'Se positiva, pesquisar execuções fiscais e registrar nº e valor.',
   'linhas 46, 50, 62, 66, 75 e 80',
   'Uma emissão por município de residência, atual e anteriores. Cada '
   'prefeitura tem portal próprio: é o item de maior custo de adapter do '
   'catálogo. Belo Horizonte exige login gov.br.'),

  ('PJ.CNPJ_SITUACAO','Comprovante de Inscrição e Situação Cadastral no CNPJ',
   'Situacao CNPJ','Receita Federal','federal','nacional',40,
   'https://solucoes.receita.fazenda.gov.br/servicos/cnpjreva/cnpjreva_solicitacao.asp',
   'portal_assistido',true,'desconhecido','nenhum',true,null,null,
   '["documento"]','[]','Se não estiver ATIVA, registrar a razão.','linha 69',
   'Também é a fonte do Estado e do Município da sede atual (linhas 72 e 74), '
   'que alimentam o fan-out das certidões estaduais e municipais da PJ.'),

  ('PREC.CADERNO_PROCESSUAL','Caderno processual completo para análise jurídica',
   'Caderno Processual','Tribunal de origem',null,'tribunal',50,null,'manual',
   false,'nenhum','nenhum',null,null,null,'["cnj"]','[]',null,
   'linhas 103 a 139',
   'NÃO é obtenível por API. Exige ler sentença, trânsito em julgado, cálculos '
   'da CONTADORIA e sua homologação, destaque de honorários, expedição do '
   'precatório, autuação na Presidência, penhora do crédito e cessões '
   'anteriores. Obrigatório e sempre manual.'),

  ('PROP.SANCOES_CGU','Consulta de Sanções — CEIS, CNEP, CEPIM e CEAF',
   'Sancoes CGU','CGU','federal','nacional',90,
   'https://api.portaldatransparencia.gov.br/','api',false,'nenhum','cadastro',
   true,null,null,'["documento"]','[]',null,'proposta',
   'PROPOSTA, fora do checklist oficial. É a ÚNICA fonte do catálogo com API '
   'oficial, gratuita e sem CAPTCHA — custo marginal perto de zero, e o CEIS '
   'inclui pessoas físicas. O token sai uma vez, por login gov.br.'),

  ('PROP.INTERDICAO','Certidão de Interdição, Tutela e Curatela','Interdicao',
   'Tribunal de Justica',null,'comarca',92,null,'portal_assistido',true,
   'desconhecido','nenhum',null,null,null,'["nome","comarca"]','[]',null,
   'proposta',
   'PROPOSTA. A planilha PERGUNTA sobre curatela (linha 41) e trata a '
   'existência como RECUSA (linha 143), mas não pede documento que comprove — '
   'hoje a resposta depende de declaração.')
on conflict (codigo) do nothing;

-- ---------- Regras ----------

insert into public.certidao_regra
  (tipo, condicao, certidao_codigo, aplica_a, parametros, obrigatoria, justificativa, origem)
values
  -- Federais: valem para todos os sujeitos (planilha repete o bloco no cônjuge e na PJ)
  ('FIXA','{"sempre": true}','FED.CND_RFB_PGFN','{CEDENTE,CONJUGE,PJ,ADVOGADO}','{}',true,
   'Regularidade fiscal federal — planilha, linhas 28 e 54','checklist_oficial'),
  ('FIXA','{"sempre": true}','TRAB.CNDT','{CEDENTE,CONJUGE,PJ,ADVOGADO}','{}',true,
   'Débitos trabalhistas no BNDT — planilha, linhas 29 e 55','checklist_oficial'),
  ('FIXA','{"sempre": true}','FED.CJF_UNIFICADA','{CEDENTE,CONJUGE,PJ,ADVOGADO}','{}',true,
   'Certidão unificada da Justiça Federal — planilha, linhas 30 e 56','checklist_oficial'),

  -- Os seis TRFs são FIXOS, não condicionados ao tribunal onde a busca por CPF
  -- achou processo. É o que a planilha manda (linhas 31 a 36) e é mais seguro:
  -- condicionar economizaria emissões e perderia o processo que a busca não viu.
  ('FIXA','{"sempre": true}','FED.TRF1','{CEDENTE}','{}',true,'Planilha, linha 31','checklist_oficial'),
  ('FIXA','{"sempre": true}','FED.TRF2','{CEDENTE}','{}',true,'Planilha, linha 32','checklist_oficial'),
  ('FIXA','{"sempre": true}','FED.TRF3','{CEDENTE}','{}',true,'Planilha, linha 33','checklist_oficial'),
  ('FIXA','{"sempre": true}','FED.TRF4','{CEDENTE}','{}',true,'Planilha, linha 34','checklist_oficial'),
  ('FIXA','{"sempre": true}','FED.TRF5','{CEDENTE}','{}',true,'Planilha, linha 35','checklist_oficial'),
  ('FIXA','{"sempre": true}','FED.TRF6','{CEDENTE}','{}',true,'Planilha, linha 36','checklist_oficial'),

  -- Protesto: any_not_in, e NÃO not_in. Quem morou em MG e em SP precisa das
  -- DUAS consultas. Com not_in, a presença de SP cancelaria a nacional e o
  -- dossiê perderia a cobertura de MG — furo silencioso.
  ('VARIAVEL','{"uf": {"any_not_in": ["SP"]}}','EXTRA.PROTESTO_CENPROT',
   '{CEDENTE,CONJUGE,PJ,ADVOGADO}','{}',true,
   'Protesto de títulos — planilha, linhas 37 e 57','checklist_oficial'),
  ('VARIAVEL','{"uf": "SP"}','EXTRA.PROTESTO_CENPROT_SP',
   '{CEDENTE,CONJUGE,PJ,ADVOGADO}','{}',true,
   'São Paulo não é coberto pela CENPROT Nacional','checklist_oficial'),

  -- FGTS só no cônjuge e na PJ: é onde a planilha pede (linhas 58 e 70)
  ('FIXA','{"sempre": true}','FGTS.CRF','{CONJUGE,PJ}','{}',true,
   'Regularidade do FGTS — planilha, linhas 58 e 70','checklist_oficial'),

  -- Estaduais e municipais: uma por RESIDÊNCIA, atual e anteriores
  ('FIXA','{"sempre": true}','EST.CDT','{CEDENTE,CONJUGE,PJ,ADVOGADO}',
   '{"uf": "{{ufs}}"}',true,
   'Débitos estaduais na residência atual e nas anteriores — linhas 44, 49, 60, 65, 73 e 79',
   'checklist_oficial'),
  ('FIXA','{"sempre": true}','EST.TJ_CIVEL_CRIMINAL','{CEDENTE,CONJUGE,PJ,ADVOGADO}',
   '{"uf": "{{ufs}}"}',true,
   'Certidões cíveis e criminais do TJ de cada UF de residência — linhas 47, 51, 63, 67, 76 e 81',
   'checklist_oficial'),
  ('FIXA','{"sempre": true}','MUN.CND','{CEDENTE,CONJUGE,PJ,ADVOGADO}',
   '{"municipio": "{{municipios}}"}',true,
   'Débitos municipais na residência atual e nas anteriores — linhas 46, 50, 62, 66, 75 e 80',
   'checklist_oficial'),

  ('VARIAVEL','{"tipo_pessoa": "PJ"}','PJ.CNPJ_SITUACAO','{PJ}','{}',true,
   'Situação cadastral do CNPJ — planilha, linha 69','checklist_oficial'),

  ('FIXA','{"sempre": true}','PREC.CADERNO_PROCESSUAL','{CEDENTE}','{"cnj": "{{cnj}}"}',true,
   'Análise do caderno processual — planilha, linhas 103 a 139','checklist_oficial'),

  -- Propostas: nascem opcionais. Promover é trocar o boolean.
  ('FIXA','{"sempre": true}','PROP.SANCOES_CGU','{CEDENTE,CONJUGE,PJ}','{}',false,
   'PROPOSTA: única fonte do catálogo com API oficial gratuita e sem CAPTCHA','proposta'),
  ('FIXA','{"sempre": true}','PROP.INTERDICAO','{CEDENTE}','{"comarca": "{{comarcas}}"}',false,
   'PROPOSTA: a planilha trata curatela como RECUSA mas não pede certidão','proposta');
