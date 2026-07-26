import Link from 'next/link';

export default function TenantNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-start justify-center gap-4 px-6 py-24">
      <h1 className="text-2xl font-semibold">Pharmacy not found</h1>
      <p className="text-muted-foreground">
        This workspace does not exist, or it has been suspended. Check the
        address, or sign in to see the pharmacies you belong to.
      </p>
      <Link href="/" className="text-primary text-sm font-medium underline">
        Back to PharmaSaaS
      </Link>
    </main>
  );
}
