-- Gênero do investidor (cessionário) pra personalizar pronomes/flexões nos
-- contratos gerados. 'M' | 'F'. NULL é tratado como masculino (default
-- gramatical) pela edge function gerar-contrato.
--
-- Depois de rodar, preencher os cadastros existentes, ex.:
--   update public.investidores set genero = 'F' where nome ilike 'Maria%';
--   update public.investidores set genero = 'M' where genero is null;

alter table public.investidores add column if not exists genero text;
