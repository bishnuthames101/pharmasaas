import { notFound } from 'next/navigation';
import { getTenantAccess } from '@/lib/tenant/context';
import { MedicineForm } from '../medicine-form';

export const metadata = { title: 'Add medicine' };

export default async function NewMedicinePage(
  props: PageProps<'/t/[tenant]/inventory/new'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  // The RLS policy would refuse the insert anyway; this just avoids showing a
  // form that could only ever fail.
  if (access.role === 'cashier') {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold">Add medicine</h1>
        <p className="text-muted-foreground mt-2">
          Only an owner or pharmacist can change the catalogue.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Add medicine</h1>
        <p className="text-muted-foreground text-sm">
          Stock is added separately, once the item exists.
        </p>
      </div>
      <MedicineForm slug={slug} />
    </main>
  );
}
