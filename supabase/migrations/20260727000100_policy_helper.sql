-- Generator for the standard tenant policy set.
--
-- Thirteen domain tables times four policies is fifty-odd near-identical
-- clauses, and hand-writing them is precisely where a `tenant_id` comparison
-- gets omitted. Generating them means every table gets the same, reviewed
-- expression, and the only thing that varies per table is the role matrix from
-- docs/ROLES.md.
--
-- Passing NULL for a role array means "no policy of that kind at all", which is
-- how tables whose writes must go exclusively through a business RPC are
-- locked down.

create or replace function public.apply_tenant_policies(
  p_table text,
  p_select_roles text[] default null,   -- NULL = any member of the tenant
  p_insert_roles text[] default array['owner', 'pharmacist'],
  p_update_roles text[] default array['owner', 'pharmacist'],
  p_delete_roles text[] default array['owner']
)
returns void
language plpgsql
as $$
declare
  v_tenant_match constant text :=
    'tenant_id = (select public.tenant_id())';
  v_select_clause text;
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('alter table public.%I force row level security', p_table);

  -- Nothing in the domain schema is reachable anonymously. RLS then narrows
  -- what an authenticated caller can actually touch.
  execute format('revoke all on public.%I from anon', p_table);

  v_select_clause := v_tenant_match;
  if p_select_roles is not null then
    v_select_clause := v_select_clause ||
      format(' and (select public.tenant_role()) = any(%L::text[])', p_select_roles);
  end if;

  execute format(
    'create policy %I on public.%I for select to authenticated using (%s)',
    p_table || '_tenant_select', p_table, v_select_clause);
  execute format('grant select on public.%I to authenticated', p_table);

  if p_insert_roles is not null then
    execute format(
      'create policy %I on public.%I for insert to authenticated
         with check (%s and (select public.tenant_role()) = any(%L::text[]))',
      p_table || '_tenant_insert', p_table, v_tenant_match, p_insert_roles);
    execute format('grant insert on public.%I to authenticated', p_table);
  end if;

  if p_update_roles is not null then
    -- USING gates which rows are visible to update; WITH CHECK gates what they
    -- may become. Both compare tenant_id, so a row can be neither reached from
    -- another tenant nor moved into one.
    execute format(
      'create policy %I on public.%I for update to authenticated
         using (%s and (select public.tenant_role()) = any(%L::text[]))
         with check (%s and (select public.tenant_role()) = any(%L::text[]))',
      p_table || '_tenant_update', p_table,
      v_tenant_match, p_update_roles, v_tenant_match, p_update_roles);
    execute format('grant update on public.%I to authenticated', p_table);
  end if;

  if p_delete_roles is not null then
    execute format(
      'create policy %I on public.%I for delete to authenticated
         using (%s and (select public.tenant_role()) = any(%L::text[]))',
      p_table || '_tenant_delete', p_table, v_tenant_match, p_delete_roles);
    execute format('grant delete on public.%I to authenticated', p_table);
  end if;
end;
$$;

comment on function public.apply_tenant_policies(text, text[], text[], text[], text[]) is
  'Applies the standard tenant policy set to a table. NULL role array = no '
  'policy of that kind, used for tables written only by SECURITY DEFINER RPCs.';

revoke execute on function
  public.apply_tenant_policies(text, text[], text[], text[], text[])
  from public, anon, authenticated;
