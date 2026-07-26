'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTenantBySlug, invalidateTenant } from '@/lib/tenant/lookup';
import { tenantAbsoluteUrl, tenantHref } from '@/lib/tenant/urls';
import {
  addStaffSchema,
  signInSchema,
  signUpSchema,
  staffStatusSchema,
  switchTenantSchema,
  toFieldErrors,
  type ActionResult,
} from '@/lib/auth/validation';

/**
 * Point the caller's JWT at a given tenant.
 *
 * `app_metadata` is server-writable only, which is what makes it trustworthy in
 * RLS policies — but it is baked into the access token at issue time, so
 * changing it has no effect until the session refreshes. Both steps are
 * required, and skipping the refresh produces the confusing failure mode where
 * a user appears signed in but every query returns nothing.
 */
async function setActiveTenant(userId: string, tenantId: string) {
  const admin = createAdminClient();

  const { error } = await admin.auth.admin.updateUserById(userId, {
    app_metadata: { tenant_id: tenantId },
  });

  if (error) throw new Error(`Could not set active pharmacy: ${error.message}`);

  const supabase = await createClient();
  const { error: refreshError } = await supabase.auth.refreshSession();

  if (refreshError) {
    throw new Error(`Could not refresh session: ${refreshError.message}`);
  }
}

/**
 * Public pharmacy signup.
 *
 * Creates the auth user, then provisions the tenant. The two cannot share a
 * transaction — one is an Auth API call, the other is Postgres — so if
 * provisioning fails the just-created user is deleted rather than left behind
 * as an orphan who can sign in but belongs to nothing.
 */
export async function signUpPharmacy(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = signUpSchema.safeParse({
    pharmacyName: formData.get('pharmacyName'),
    slug: formData.get('slug'),
    email: formData.get('email'),
    password: formData.get('password'),
    phone: formData.get('phone') ?? '',
    address: formData.get('address') ?? '',
  });

  if (!parsed.success) {
    return { fieldErrors: toFieldErrors(parsed.error) };
  }

  const { pharmacyName, slug, email, password, phone, address } = parsed.data;
  const admin = createAdminClient();

  const { data: available } = await admin.rpc('slug_available', {
    p_slug: slug,
  });

  if (!available) {
    return { fieldErrors: { slug: 'That address is already taken' } };
  }

  // Confirmed on creation: email delivery is not reliable enough to stand
  // between a pharmacy and its own data on day one. Revisit if self-serve
  // signup ever needs to resist automated abuse.
  const { data: created, error: userError } = await admin.auth.admin.createUser(
    {
      email,
      password,
      email_confirm: true,
    },
  );

  if (userError || !created.user) {
    const message = userError?.message ?? 'Could not create the account';
    const isDuplicate = /already|registered|exists/i.test(message);
    return isDuplicate
      ? { fieldErrors: { email: 'An account with this email already exists' } }
      : { error: message };
  }

  const userId = created.user.id;

  const { data: tenant, error: provisionError } = await admin.rpc(
    'provision_tenant',
    {
      p_slug: slug,
      p_name: pharmacyName,
      p_owner_id: userId,
      p_phone: phone || null,
      p_address: address || null,
    },
  );

  if (provisionError || !tenant) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    return {
      error:
        provisionError?.message ?? 'Could not create the pharmacy workspace',
    };
  }

  const tenantId = (tenant as { id: string }).id;

  await admin.auth.admin.updateUserById(userId, {
    app_metadata: { tenant_id: tenantId },
  });

  // Sign in through the session client so the auth cookies are written with the
  // freshly stamped claim already present.
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    // The pharmacy exists and is usable; only the automatic sign-in failed.
    redirect(await tenantHref(slug, '/login'));
  }

  invalidateTenant(slug);
  redirect(await tenantHref(slug, '/dashboard'));
}

/**
 * Sign in to a specific pharmacy.
 *
 * Authentication is global — one account can belong to several pharmacies — so
 * a successful password check is not the same as being allowed in *here*.
 * Membership is read from `tenant_users` rather than the token, and a member
 * whose token points at a different pharmacy has their claim restamped instead
 * of being told their password is wrong.
 */
export async function signInToTenant(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');

  const parsed = signInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { fieldErrors: toFieldErrors(parsed.error) };
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return { error: 'This pharmacy no longer exists.' };

  if (tenant.status === 'suspended') {
    return { error: 'This pharmacy is suspended. Contact support.' };
  }

  const supabase = await createClient();
  const { data: signIn, error: signInError } =
    await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

  if (signInError || !signIn.user) {
    // Deliberately not distinguishing "no such account" from "wrong password",
    // so this cannot be used to discover which emails are registered.
    return { error: 'Incorrect email or password.' };
  }

  const admin = createAdminClient();
  const { data: membership } = await admin
    .from('tenant_users')
    .select('role, is_active')
    .eq('tenant_id', tenant.id)
    .eq('user_id', signIn.user.id)
    .maybeSingle();

  if (!membership || !membership.is_active) {
    // Signed in, but not a member here. Sign back out so they are not left in
    // the confusing state of holding a session for a pharmacy they cannot see.
    await supabase.auth.signOut();
    return {
      error: `This account does not have access to ${tenant.name}.`,
    };
  }

  const activeTenantId = signIn.user.app_metadata?.tenant_id as
    string | undefined;

  if (activeTenantId !== tenant.id) {
    await setActiveTenant(signIn.user.id, tenant.id);
  }

  redirect(await tenantHref(slug, '/dashboard'));
}

/** A pharmacy the signed-in user belongs to. */
export interface Membership {
  tenantId: string;
  slug: string;
  name: string;
  role: string;
  status: string;
}

/**
 * Read the caller's own pharmacies.
 *
 * Deliberately uses the session client rather than the admin client: the
 * `tenant_users` select policy already permits `user_id = auth.uid()`, and the
 * embedded `tenants` read is permitted by `is_tenant_member()`. So RLS does the
 * filtering, and a bug here cannot widen the result beyond this user.
 */
export async function listMyMemberships(): Promise<Membership[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return [];

  const { data } = await supabase
    .from('tenant_users')
    .select('tenant_id, role, is_active, tenants(slug, name, status)')
    .eq('user_id', user.id)
    .eq('is_active', true);

  return (data ?? [])
    .map((row) => {
      const tenant = row.tenants as unknown as {
        slug: string;
        name: string;
        status: string;
      } | null;
      if (!tenant) return null;
      return {
        tenantId: row.tenant_id as string,
        slug: tenant.slug,
        name: tenant.name,
        role: row.role as string,
        status: tenant.status,
      };
    })
    .filter((m): m is Membership => m !== null && m.status === 'active');
}

/**
 * Sign in from the marketing site, without naming a pharmacy up front.
 *
 * Sends people with one pharmacy straight there; anyone with several gets to
 * choose. A successful password check with no active membership anywhere is
 * signed back out, since there is nowhere to go.
 */
export async function signInGlobal(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = signInSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { fieldErrors: toFieldErrors(parsed.error) };
  }

  const supabase = await createClient();
  const { data: signIn, error: signInError } =
    await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

  if (signInError || !signIn.user) {
    return { error: 'Incorrect email or password.' };
  }

  const memberships = await listMyMemberships();

  if (memberships.length === 0) {
    await supabase.auth.signOut();
    return {
      error: 'This account is not an active member of any pharmacy.',
    };
  }

  if (memberships.length > 1) {
    redirect('/choose-pharmacy');
  }

  const only = memberships[0];
  const activeTenantId = signIn.user.app_metadata?.tenant_id as
    string | undefined;

  if (activeTenantId !== only.tenantId) {
    await setActiveTenant(signIn.user.id, only.tenantId);
  }

  redirect(await tenantAbsoluteUrl(only.slug, '/dashboard'));
}

export async function signOut(formData: FormData) {
  const slug = String(formData.get('slug') ?? '');
  const supabase = await createClient();
  await supabase.auth.signOut();

  redirect(slug ? await tenantHref(slug, '/login') : '/');
}

/**
 * Move a multi-pharmacy user to another of their pharmacies.
 *
 * Membership is re-checked server-side: the tenant id arrives from a form and
 * is therefore untrusted, and stamping it blindly would let anyone point their
 * own claim at any pharmacy. RLS would still refuse to return rows, but the
 * user would land in a broken, empty workspace.
 */
export async function switchTenant(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = switchTenantSchema.safeParse({
    tenantId: formData.get('tenantId'),
  });

  if (!parsed.success) return { error: 'Invalid pharmacy selection.' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: 'You are not signed in.' };

  const admin = createAdminClient();
  const { data: membership } = await admin
    .from('tenant_users')
    .select('tenant_id, is_active, tenants(slug)')
    .eq('tenant_id', parsed.data.tenantId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership || !membership.is_active) {
    return { error: 'You do not have access to that pharmacy.' };
  }

  await setActiveTenant(user.id, parsed.data.tenantId);

  const target = membership.tenants as unknown as { slug: string };
  redirect(await tenantAbsoluteUrl(target.slug, '/dashboard'));
}

/**
 * Add a staff member to the current pharmacy.
 *
 * The owner sets an initial password directly rather than sending an email
 * invitation. Supabase's built-in mailer is rate limited and undeliverable to
 * many addresses without custom SMTP, and counter staff frequently have no
 * work email at all — an onboarding flow that depends on inbox access would
 * simply not work in a pharmacy. Email invitations remain a later option.
 *
 * Authorization is enforced twice over: this action checks the caller is an
 * owner, and the RLS policy on `tenant_users` independently refuses the insert
 * for anyone who is not. The membership insert deliberately runs through the
 * caller's own session, not the admin client, so that policy is the one in
 * force.
 */
export async function addStaff(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');

  const parsed = addStaffSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    role: formData.get('role'),
  });

  if (!parsed.success) {
    return { fieldErrors: toFieldErrors(parsed.error) };
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return { error: 'This pharmacy no longer exists.' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: 'You are not signed in.' };

  const { data: callerRole } = await supabase.rpc('tenant_role');
  if (callerRole !== 'owner') {
    return { error: 'Only an owner can add staff.' };
  }

  const admin = createAdminClient();

  // The person may already have an account — a pharmacist working across two
  // pharmacies, or a previously removed colleague. Reuse the account rather
  // than failing, so one person keeps one login.
  const { data: existing } = await admin.rpc('user_id_by_email', {
    p_email: parsed.data.email,
  });

  let staffUserId = existing as string | null;

  if (!staffUserId) {
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: parsed.data.email,
        password: parsed.data.password,
        email_confirm: true,
      });

    if (createError || !created.user) {
      return { error: createError?.message ?? 'Could not create the account' };
    }
    staffUserId = created.user.id;
  }

  const { error: membershipError } = await supabase
    .from('tenant_users')
    .insert({
      tenant_id: tenant.id,
      user_id: staffUserId,
      role: parsed.data.role,
    });

  if (membershipError) {
    const isDuplicate = membershipError.code === '23505';
    return {
      error: isDuplicate
        ? 'That person is already a member of this pharmacy.'
        : membershipError.message,
    };
  }

  // Only stamp the claim for brand-new accounts. Overwriting it for an existing
  // user would silently yank them out of whichever pharmacy they are currently
  // working in.
  if (!existing) {
    await admin.auth.admin.updateUserById(staffUserId, {
      app_metadata: { tenant_id: tenant.id },
    });
  }

  return { success: `${parsed.data.email} can now sign in.` };
}

/**
 * Activate or deactivate a staff member.
 *
 * Deactivation takes effect immediately for writes, because `tenant_role()`
 * re-reads `tenant_users` rather than trusting the token. Their existing
 * session is also revoked so reads stop too, rather than lingering until the
 * access token expires.
 */
export async function setStaffActive(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const slug = String(formData.get('slug') ?? '');

  const parsed = staffStatusSchema.safeParse({
    userId: formData.get('userId'),
    isActive: formData.get('isActive'),
  });

  if (!parsed.success) return { error: 'Invalid request.' };

  const tenant = await getTenantBySlug(slug);
  if (!tenant) return { error: 'This pharmacy no longer exists.' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { error: 'You are not signed in.' };

  if (user.id === parsed.data.userId && !parsed.data.isActive) {
    return { error: 'You cannot deactivate your own account.' };
  }

  // Runs under the caller's session, so the owner-only RLS policy applies.
  const { error, count } = await supabase
    .from('tenant_users')
    .update({ is_active: parsed.data.isActive }, { count: 'exact' })
    .eq('tenant_id', tenant.id)
    .eq('user_id', parsed.data.userId);

  if (error) return { error: error.message };
  if (!count) return { error: 'Only an owner can change staff access.' };

  if (!parsed.data.isActive) {
    // Cuts off session refresh. Their current access token stays valid until it
    // expires, but every role-gated write is already blocked by tenant_role(),
    // which re-reads the membership row rather than trusting the token.
    const admin = createAdminClient();
    await admin.rpc('revoke_user_sessions', { p_user_id: parsed.data.userId });
  }

  return { success: 'Staff access updated.' };
}
