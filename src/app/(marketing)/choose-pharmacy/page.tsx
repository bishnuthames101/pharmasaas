import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { listMyMemberships } from '@/lib/auth/actions';
import { OpenPharmacyForm } from './open-pharmacy-form';

export const metadata: Metadata = {
  title: 'Choose a pharmacy',
};

/**
 * Shown after sign-in when someone belongs to more than one pharmacy, and when
 * a valid session addresses a pharmacy its JWT claim does not point at.
 *
 * Selecting one restamps the claim and refreshes the session, which is what
 * makes every subsequent RLS check resolve to that pharmacy.
 */
export default async function ChoosePharmacyPage() {
  const memberships = await listMyMemberships();

  if (memberships.length === 0) redirect('/login');

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-6 py-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Choose a pharmacy</h1>
        <p className="text-muted-foreground text-sm">
          You have access to more than one workspace.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {memberships.map((membership) => (
          <li key={membership.tenantId}>
            <OpenPharmacyForm membership={membership} />
          </li>
        ))}
      </ul>
    </main>
  );
}
