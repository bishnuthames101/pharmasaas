import { getTenantBySlug } from '@/lib/tenant/lookup';

/**
 * Placeholder tenant entry point. Phase 2 replaces this with the authenticated
 * dashboard; for now it confirms that slug resolution and the tenant registry
 * lookup are wired together correctly.
 */
export default async function TenantHomePage(props: PageProps<'/t/[tenant]'>) {
  const { tenant: slug } = await props.params;

  // The layout has already established that this resolves; the cache makes the
  // repeat lookup free.
  const tenant = await getTenantBySlug(slug);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold">{tenant?.name}</h1>
      <p className="text-muted-foreground">
        Workspace <code className="font-mono">{slug}</code> · plan status{' '}
        <code className="font-mono">{tenant?.status}</code>
      </p>
      <p className="text-muted-foreground text-sm">
        Sign-in, the dashboard, and the pharmacy modules arrive in later phases.
      </p>
    </main>
  );
}
