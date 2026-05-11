# Storage Setup — Buckets para o gerador de contratos

A Edge Function `gerar-contrato` precisa de **2 buckets privados** no Supabase Storage. Crie-os via Supabase Studio.

## 1. Bucket `contratos-templates` (privado, contém os 4 .docx originais)

**Dashboard:**
1. Supabase Studio → **Storage** → New bucket
2. Nome: `contratos-templates`
3. **Public bucket: OFF** (privado — só service-role lê)
4. File size limit: 5 MB (cada template tem < 700 KB)
5. Allowed MIME types: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
6. Clique em **Create bucket**

**Subir os templates:**
- Dentro do bucket, faça upload dos 4 arquivos de `credijuris-contratos-main/templates/`:
  - `cessao_credito.docx`
  - `cessao_honorarios.docx`
  - `intermediacao.docx`
  - `procuracao.docx`
- **Mantenha os nomes exatos** — a Edge Function lê pelo nome.

## 2. Bucket `contratos-input` (privado, uploads temporários do usuário)

**Dashboard:**
1. Supabase Studio → **Storage** → New bucket
2. Nome: `contratos-input`
3. **Public bucket: OFF**
4. File size limit: 32 MB (PDFs escaneados pesados)
5. Allowed MIME types: deixar vazio (aceita PDF, JPG, PNG, DOCX, XLSX)
6. Create bucket

**Política de TTL (recomendado):** vou adicionar um cron job na Edge Function pra apagar pastas com mais de 1 hora. Por enquanto, fica aberto.

## 3. RLS das policies de Storage

No SQL Editor, rode:

```sql
-- contratos-templates: só authenticated lê (a Edge Function usa service-role e ignora RLS)
create policy "contratos-templates: leitura authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'contratos-templates');

-- contratos-input: authenticated lê/escreve só dentro de pastas do próprio user
create policy "contratos-input: insert do próprio usuário"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'contratos-input'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "contratos-input: select do próprio usuário"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'contratos-input'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "contratos-input: delete do próprio usuário"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'contratos-input'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
```

**Estrutura de paths no `contratos-input`:**
```
{auth.uid()}/{job_id}/apresentacao/<arquivo>
{auth.uid()}/{job_id}/cedente/<arquivo>
{auth.uid()}/{job_id}/escritorio/<arquivo>
```

A Edge Function lê tudo dentro de `{uid}/{job_id}/` e apaga ao fim.

## Verificação final

No SQL Editor:

```sql
select id, name, public from storage.buckets where name like 'contratos-%';
-- Deve retornar 2 linhas, ambas public=false
```

Se aparecer os 2 buckets privados, está pronto pra Etapa 2 (Edge Function).
