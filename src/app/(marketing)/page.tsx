import Link from 'next/link';

const features = [
  {
    title: 'Batch-level inventory',
    body: 'Track every batch by number and expiry. Expiry board flags what is expired, due in 30 days, and due in 90.',
  },
  {
    title: 'FEFO dispensing',
    body: 'Sales allocate earliest-expiry-first inside the database, with row locks so two counters can never oversell one batch.',
  },
  {
    title: 'Keyboard-first POS',
    body: 'Search by brand, generic, or barcode. Split payments, credit accounts, and 80mm thermal or A4 invoices.',
  },
  {
    title: 'Prescriptions & controlled register',
    body: 'Attach prescription images, track refills, and keep an auditable dispensing log for controlled medicines.',
  },
];

export default function MarketingHomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 py-16">
      <section className="flex flex-col gap-6">
        <p className="text-primary text-sm font-semibold tracking-wide uppercase">
          PharmaSaaS
        </p>
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Pharmacy management that keeps every branch&apos;s data its own.
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg">
          Inventory, purchasing, point of sale, prescriptions, and reporting for
          independent pharmacies. Each pharmacy gets an isolated workspace,
          enforced in the database rather than in application code.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/signup"
            className="bg-primary text-primary-foreground rounded-md px-5 py-2.5 text-sm font-medium"
          >
            Create your pharmacy
          </Link>
          <Link
            href="/login"
            className="border-border rounded-md border px-5 py-2.5 text-sm font-medium"
          >
            Sign in
          </Link>
        </div>
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="border-border rounded-lg border p-5"
          >
            <h2 className="font-semibold">{feature.title}</h2>
            <p className="text-muted-foreground mt-2 text-sm">{feature.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
