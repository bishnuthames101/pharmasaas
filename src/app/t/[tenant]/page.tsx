/**
 * Placeholder tenant entry point. Phase 1 replaces this with the membership
 * guard and Phase 2 with the real dashboard; for now it exists to prove that
 * proxy rewriting resolves the tenant on both addressing modes.
 */
export default async function TenantHomePage(props: PageProps<'/t/[tenant]'>) {
  const { tenant } = await props.params;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold">Tenant workspace</h1>
      <p className="text-muted-foreground">
        Resolved tenant slug: <code className="font-mono">{tenant}</code>
      </p>
      <p className="text-muted-foreground text-sm">
        Membership verification, the dashboard, and the rest of the modules
        arrive in later phases.
      </p>
    </main>
  );
}
