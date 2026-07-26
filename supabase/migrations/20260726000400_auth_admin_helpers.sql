-- Two admin helpers the JavaScript client cannot express.
--
-- Both are SECURITY DEFINER and granted to `service_role` only. They read and
-- write the `auth` schema, which is Supabase-managed — note that this touches
-- only *rows*, never schema objects, so it does not carry the upgrade risk that
-- defining functions inside `auth` would.

-- ---------------------------------------------------------------------------
-- Look up an account by email
-- ---------------------------------------------------------------------------
--
-- Needed when an owner adds a staff member who already has an account, e.g. a
-- pharmacist working across two branches. The alternative offered by the
-- client library is paging through every user on the platform, which is both
-- slow and a far broader exposure than a single targeted lookup.
--
-- Returns only the id, never the row, and is unreachable by tenant users.
create or replace function public.user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
  limit 1
$$;

comment on function public.user_id_by_email(text) is
  'Service-role only. Resolves an email to a user id so an existing account can '
  'be added to a second pharmacy instead of being duplicated.';

revoke execute on function public.user_id_by_email(text)
  from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;

-- ---------------------------------------------------------------------------
-- Revoke a user's sessions
-- ---------------------------------------------------------------------------
--
-- `supabase.auth.admin.signOut()` takes a JWT, so it can only sign out the
-- holder of a token you already have — it cannot revoke a *different* user's
-- sessions, which is exactly what deactivating a staff member requires.
-- Deleting the session rows is the supported way to do that.
--
-- Honest scope of this operation: it invalidates refresh tokens immediately, so
-- the user cannot extend their session and is locked out at their next refresh.
-- Any access token already issued stays cryptographically valid until it
-- expires (one hour by default) — revocation cannot recall a bearer token that
-- has already been handed out.
--
-- This is why authorization does not rest on it. `tenant_role()` re-reads
-- `tenant_users` on every role-gated write, so a deactivated user loses write
-- access at once regardless of what their token still claims.
create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from auth.refresh_tokens rt
  where rt.session_id in (
    select s.id from auth.sessions s where s.user_id = p_user_id
  );

  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_deleted = row_count;

  return v_deleted;
end;
$$;

comment on function public.revoke_user_sessions(uuid) is
  'Service-role only. Deletes a user''s sessions and refresh tokens. Already '
  'issued access tokens remain valid until expiry; write access is cut off '
  'immediately by tenant_role() instead.';

revoke execute on function public.revoke_user_sessions(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
