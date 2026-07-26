import { notFound } from 'next/navigation';
import { getTenantAccess } from '@/lib/tenant/context';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { AddStaffForm } from './add-staff-form';
import { StaffRow } from './staff-row';
import type { StaffMember } from './types';

export async function generateMetadata() {
  return { title: 'Staff' };
}

export default async function StaffPage(
  props: PageProps<'/t/[tenant]/settings/users'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();

  // Read through the session client so RLS scopes this to the caller's
  // pharmacy. The service role is used *only* to resolve emails, which live in
  // auth.users and are not reachable any other way.
  const { data: members } = await supabase
    .from('tenant_users')
    .select('user_id, role, is_active, created_at')
    .order('created_at', { ascending: true });

  const rows = members ?? [];
  const emails = new Map<string, string>();

  if (rows.length > 0) {
    const admin = createAdminClient();
    await Promise.all(
      rows.map(async (row) => {
        const { data } = await admin.auth.admin.getUserById(
          row.user_id as string,
        );
        if (data.user?.email)
          emails.set(row.user_id as string, data.user.email);
      }),
    );
  }

  const staff: StaffMember[] = rows.map((row) => ({
    userId: row.user_id as string,
    email: emails.get(row.user_id as string) ?? '(unknown)',
    role: row.role as string,
    isActive: row.is_active as boolean,
    createdAt: row.created_at as string,
  }));

  const isOwner = access.role === 'owner';

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Staff</h1>
        <p className="text-muted-foreground text-sm">
          Who can sign in to {access.tenant.name}, and what they may do.
        </p>
      </div>

      <section className="border-border overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Email</th>
              <th className="px-4 py-2 text-left font-medium">Role</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              {isOwner && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody>
            {staff.map((member) => (
              <StaffRow
                key={member.userId}
                member={member}
                slug={slug}
                canManage={isOwner}
                isSelf={member.userId === access.userId}
              />
            ))}
          </tbody>
        </table>
      </section>

      {isOwner ? (
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
          <div>
            <h2 className="font-semibold">Add a staff member</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              You set their first password and pass it on directly — no email is
              sent. Ask them to change it after signing in.
            </p>
          </div>
          <AddStaffForm slug={slug} />
        </section>
      ) : (
        <p className="text-muted-foreground text-sm">
          Only an owner can add or remove staff.
        </p>
      )}
    </main>
  );
}
