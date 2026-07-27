-- A sanctioned way for application code to append to the audit log.
--
-- `audit_log` has no insert policy: it is readable by owners and otherwise
-- immutable from the API, which is what makes it worth reading. The business
-- RPCs write to it as SECURITY DEFINER, but ordinary CRUD (editing a medicine,
-- say) happens through PostgREST against the table directly and has no such
-- path.
--
-- This function is that path. It cannot be used to forge history: the tenant
-- and the actor are both derived server-side, never accepted as parameters, so
-- a caller can only ever write entries attributed to themselves in their own
-- pharmacy.
create or replace function public.log_audit(
  p_action text,
  p_entity text,
  p_entity_id text,
  p_before jsonb default null,
  p_after jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.tenant_id();
begin
  -- Re-read membership rather than trusting the claim, so a deactivated user
  -- cannot keep writing entries with a stale token.
  if v_tenant is null or public.tenant_role() is null then
    raise exception 'You are not an active member of this pharmacy'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.audit_log (
    tenant_id, actor, action, entity, entity_id, before, after
  )
  values (
    v_tenant, auth.uid(), p_action, p_entity, p_entity_id, p_before, p_after
  );
end;
$$;

comment on function public.log_audit(text, text, text, jsonb, jsonb) is
  'Appends an audit entry attributed to the caller in their own pharmacy. '
  'Tenant and actor are derived server-side and cannot be spoofed.';

revoke execute on function public.log_audit(text, text, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.log_audit(text, text, text, jsonb, jsonb)
  to authenticated;
