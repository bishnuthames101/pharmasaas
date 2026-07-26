-- Private storage for prescription images.
--
-- One bucket for the whole platform, with isolation carried by the object path:
-- every key begins with the tenant's UUID, and the policies below compare that
-- first path segment against the caller's tenant claim.
--
-- Storage RLS is easy to get subtly wrong, because `storage.objects` is a
-- single table shared by every tenant. A policy that checked only
-- `auth.role() = 'authenticated'` would expose every pharmacy's prescription
-- scans — which are patient records.

insert into storage.buckets (id, name, public)
values ('tenant-files', 'tenant-files', false)
on conflict (id) do nothing;

-- Objects are served through short-lived signed URLs, never public links.

drop policy if exists tenant_files_select on storage.objects;
drop policy if exists tenant_files_insert on storage.objects;
drop policy if exists tenant_files_update on storage.objects;
drop policy if exists tenant_files_delete on storage.objects;

-- `storage.foldername(name)` splits the key on '/', so element 1 is the tenant
-- UUID prefix. Comparing it to the JWT claim is what keeps one pharmacy's
-- files out of another's reach.
create policy tenant_files_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-files'
    and (storage.foldername(name))[1] = (select public.tenant_id())::text
  );

create policy tenant_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-files'
    and (storage.foldername(name))[1] = (select public.tenant_id())::text
  );

create policy tenant_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'tenant-files'
    and (storage.foldername(name))[1] = (select public.tenant_id())::text
  )
  with check (
    bucket_id = 'tenant-files'
    and (storage.foldername(name))[1] = (select public.tenant_id())::text
  );

-- Deleting a patient record is an owner/pharmacist action.
create policy tenant_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tenant-files'
    and (storage.foldername(name))[1] = (select public.tenant_id())::text
    and (select public.tenant_role()) in ('owner', 'pharmacist')
  );
