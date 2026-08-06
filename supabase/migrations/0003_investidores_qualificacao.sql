-- Complemento da qualificação do investidor (cessionário).
--
-- Os modelos novos de contrato (layout Credijuris, 2026-08) pedem estado civil,
-- profissão e — quando o investidor é pessoa jurídica — o representante legal.
-- Em vez de uma coluna por dado, uma coluna de texto livre que a edge function
-- injeta na qualificação montada por montarQualificacaoInvestidor().
--
-- Como preencher:
--   • Pessoa física  → estado civil e profissão, sem prefixo nem vírgula nas pontas.
--       'casada, empresária'
--       → "Fulana, brasileira, casada, empresária, inscrita no CPF sob o nº …"
--   • Pessoa jurídica → a frase inteira, porque entra no FIM da qualificação.
--       'neste ato representada por João da Silva, sócio-administrador'
--       → "…, com sede em …, neste ato representada por João da Silva, sócio-administrador"
--
-- Órgão expedidor do RG NÃO precisa desta coluna: `rg` já é texto livre, basta
-- cadastrar 'MG-12.345.678 SSP/MG'.
--
-- Deixar NULL é seguro: a qualificação sai como sempre saiu, sem o trecho extra.

alter table public.investidores
  add column if not exists qualificacao_complemento text;

comment on column public.investidores.qualificacao_complemento is
  'Texto livre inserido na qualificação do contrato. PF: estado civil e profissão '
  '(ex.: "casada, empresária"). PJ: frase do representante legal (ex.: "neste ato '
  'representada por João da Silva, sócio-administrador").';
