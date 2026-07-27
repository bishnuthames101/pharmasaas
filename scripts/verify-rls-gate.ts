import { Client } from 'pg';
import { config as loadEnv } from 'dotenv';

/**
 * Proves that `rls_coverage_gaps()` actually fires.
 *
 * A release gate that can only ever return "clean" is worse than no gate,
 * because it manufactures confidence. This script deliberately creates the four
 * kinds of broken table the gate is supposed to catch, asserts each one is
 * reported, then drops them and confirms the report is empty again.
 *
 * Run it after changing the gate. It mutates the database transiently, so it is
 * not part of the normal test run.
 */

loadEnv({ path: '.env.local', quiet: true });

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  throw new Error('SUPABASE_DB_URL is not set in .env.local');
}

interface Gap {
  table_name: string;
  gap: string;
}

async function gaps(client: Client): Promise<Gap[]> {
  const { rows } = await client.query<Gap>(
    'select table_name, gap from public.rls_coverage_gaps()',
  );
  return rows;
}

interface ProbeCase {
  name: string;
  ddl: string;
  /** Expected gap kind, or null when the probe must NOT be reported. */
  expected: string | null;
  /** Teardown statement; defaults to dropping a table of the same name. */
  drop?: string;
}

const cases: ProbeCase[] = [
  {
    name: 'gate_probe_no_rls',
    ddl: `create table public.gate_probe_no_rls (
            id uuid primary key default gen_random_uuid(),
            tenant_id uuid not null
          )`,
    expected: 'rls_disabled',
  },
  {
    name: 'gate_probe_unforced',
    ddl: `create table public.gate_probe_unforced (
            id uuid primary key default gen_random_uuid(),
            tenant_id uuid not null
          );
          alter table public.gate_probe_unforced enable row level security;
          create policy p on public.gate_probe_unforced for select
            using (tenant_id = public.tenant_id())`,
    expected: 'rls_not_forced',
  },
  {
    name: 'gate_probe_no_policy',
    ddl: `create table public.gate_probe_no_policy (
            id uuid primary key default gen_random_uuid(),
            tenant_id uuid not null
          );
          alter table public.gate_probe_no_policy enable row level security;
          alter table public.gate_probe_no_policy force row level security`,
    expected: 'no_policies',
  },
  {
    // Views run with their OWNER's privileges unless security_invoker is set,
    // so this one would serve every pharmacy's medicines to every caller —
    // with no error and nothing in the query to suggest anything is wrong.
    name: 'gate_probe_leaky_view',
    ddl: `create view public.gate_probe_leaky_view as
            select id, tenant_id, name from public.medicines`,
    expected: 'view_not_security_invoker',
    drop: 'drop view public.gate_probe_leaky_view',
  },
  {
    // The same view done correctly must NOT be reported.
    name: 'gate_probe_safe_view',
    ddl: `create view public.gate_probe_safe_view
            with (security_invoker = true) as
            select id, tenant_id, name from public.medicines`,
    expected: null,
    drop: 'drop view public.gate_probe_safe_view',
  },
  {
    // The dangerous one: RLS on, forced, and a policy that looks reassuring but
    // only checks authentication. Every tenant would see every row.
    name: 'gate_probe_auth_only',
    ddl: `create table public.gate_probe_auth_only (
            id uuid primary key default gen_random_uuid(),
            tenant_id uuid not null
          );
          alter table public.gate_probe_auth_only enable row level security;
          alter table public.gate_probe_auth_only force row level security;
          create policy p on public.gate_probe_auth_only for select
            using (auth.uid() is not null)`,
    expected: 'no_tenant_scoped_policy',
  },
];

async function main() {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let failures = 0;

  try {
    const before = await gaps(client);
    if (before.length > 0) {
      console.error('✗ Baseline is not clean. Existing gaps:', before);
      failures++;
    } else {
      console.log('✓ Baseline clean: no gaps reported');
    }

    for (const testCase of cases) {
      await client.query(testCase.ddl);

      const reported = await gaps(client);
      const mine = reported.filter((g) => g.table_name === testCase.name);

      if (testCase.expected === null) {
        // Negative control: a correctly built object must produce no finding,
        // or the gate would be crying wolf rather than checking anything.
        if (mine.length === 0) {
          console.log(`✓ ignored ${testCase.name} (correctly built)`);
        } else {
          console.error(`✗ FALSE POSITIVE on ${testCase.name}:`, mine);
          failures++;
        }
      } else if (mine.some((g) => g.gap === testCase.expected)) {
        console.log(`✓ caught ${testCase.name} → ${testCase.expected}`);
      } else {
        console.error(
          `✗ MISSED ${testCase.name}: expected "${testCase.expected}", got`,
          mine,
        );
        failures++;
      }

      await client.query(testCase.drop ?? `drop table public.${testCase.name}`);
    }

    const after = await gaps(client);
    if (after.length === 0) {
      console.log('✓ Clean again after teardown');
    } else {
      console.error('✗ Probe tables leaked:', after);
      failures++;
    }
  } finally {
    // Best-effort cleanup in case an assertion threw mid-run.
    for (const testCase of cases) {
      await client
        .query(`drop view if exists public.${testCase.name}`)
        .catch(() => {});
      await client
        .query(`drop table if exists public.${testCase.name}`)
        .catch(() => {});
    }
    await client.end();
  }

  if (failures > 0) {
    console.error(
      `\n${failures} check(s) failed — the RLS gate is unreliable.`,
    );
    process.exit(1);
  }
  console.log('\nAll gate probes behaved correctly.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
