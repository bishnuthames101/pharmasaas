import Link from 'next/link';
import { tenantHref } from '@/lib/tenant/urls';

/**
 * Settings shell. The sub-nav is shown to everyone; each page decides for
 * itself what a given role may see or change, since the pages have different
 * rules — general settings are owner-only to edit but readable by all staff,
 * whereas the staff list is owner-only throughout.
 */
export default async function SettingsLayout(
  props: LayoutProps<'/t/[tenant]/settings'>,
) {
  const { tenant: slug } = await props.params;

  const tabs = [
    { href: await tenantHref(slug, '/settings'), label: 'Pharmacy' },
    { href: await tenantHref(slug, '/settings/users'), label: 'Staff' },
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <nav className="border-border mt-3 flex gap-4 border-b text-sm">
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className="text-muted-foreground hover:text-foreground -mb-px border-b-2 border-transparent pb-2"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>

      {props.children}
    </div>
  );
}
