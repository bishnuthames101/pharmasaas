import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTenantAccess } from '@/lib/tenant/context';
import { PrescriptionForm } from './prescription-form';
import { PrescriptionRow } from './prescription-row';

export const metadata = { title: 'Prescriptions' };

export default async function PrescriptionsPage(
  props: PageProps<'/t/[tenant]/prescriptions'>,
) {
  const { tenant: slug } = await props.params;
  const access = await getTenantAccess(slug);
  if (!access.ok) notFound();

  const supabase = await createClient();

  const [{ data: prescriptions }, { data: customers }] = await Promise.all([
    supabase
      .from('prescriptions')
      .select(
        'id, prescriber_name, prescriber_reg_no, issued_date, refills_allowed, refills_used, image_path, created_at, customers(name)',
      )
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from('customers').select('id, name').order('name').limit(200),
  ]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Prescriptions</h1>
        <p className="text-muted-foreground text-sm">
          Record a prescription, then paste its ID at the counter to dispense
          prescription-only items against it.
        </p>
      </div>

      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full min-w-3xl text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">ID</th>
              <th className="px-4 py-2 text-left font-medium">Customer</th>
              <th className="px-4 py-2 text-left font-medium">Prescriber</th>
              <th className="px-4 py-2 text-left font-medium">Issued</th>
              <th className="px-4 py-2 text-right font-medium">Refills</th>
              <th className="px-4 py-2 text-left font-medium">Image</th>
            </tr>
          </thead>
          <tbody>
            {(prescriptions ?? []).length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="text-muted-foreground px-4 py-8 text-center"
                >
                  No prescriptions recorded.
                </td>
              </tr>
            )}
            {(prescriptions ?? []).map((p) => {
              const customer = p.customers as unknown as {
                name: string;
              } | null;
              return (
                <PrescriptionRow
                  key={p.id}
                  slug={slug}
                  prescription={{
                    id: p.id as string,
                    customerName: customer?.name ?? null,
                    prescriberName: (p.prescriber_name as string) ?? null,
                    prescriberRegNo: (p.prescriber_reg_no as string) ?? null,
                    issuedDate: (p.issued_date as string) ?? null,
                    refillsAllowed: Number(p.refills_allowed),
                    refillsUsed: Number(p.refills_used),
                    imagePath: (p.image_path as string) ?? null,
                  }}
                />
              );
            })}
          </tbody>
        </table>
      </div>

      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <h2 className="font-semibold">Record a prescription</h2>
        <PrescriptionForm
          slug={slug}
          customers={(customers ?? []).map((c) => ({
            id: c.id as string,
            name: c.name as string,
          }))}
        />
      </section>
    </main>
  );
}
