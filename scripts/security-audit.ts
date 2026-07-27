import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Client } from 'pg';
import { config as loadEnv } from 'dotenv';

/**
 * Static and database security checks, run in CI before a merge.
 *
 * These are the invariants that cannot be expressed as a unit test because they
 * are properties of the whole codebase rather than of any one function.
 */

loadEnv({ path: '.env.local', quiet: true });

interface Finding {
  check: string;
  detail: string;
}

const findings: Finding[] = [];
const passed: string[] = [];

function record(check: string, problems: string[]) {
  if (problems.length === 0) {
    passed.push(check);
  } else {
    for (const detail of problems) findings.push({ check, detail });
  }
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function staticChecks() {
  const root = process.cwd();
  const files = await walk(join(root, 'src'));

  // --- The service key must never be reachable from a client bundle ---------
  const serviceKeyLeaks: string[] = [];
  const adminImports: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(root, file);
    const isClientComponent = /^['"]use client['"]/m.test(source);

    if (/SUPABASE_SERVICE_ROLE_KEY/.test(source)) {
      // Only env.ts (which defines it) and admin.ts (which consumes it) may
      // mention the service key at all.
      if (!/src[\\/](env\.ts|lib[\\/]supabase[\\/]admin\.ts)$/.test(rel)) {
        serviceKeyLeaks.push(`${rel} references SUPABASE_SERVICE_ROLE_KEY`);
      }
    }

    if (isClientComponent && /supabase\/admin/.test(source)) {
      serviceKeyLeaks.push(
        `${rel} is a Client Component importing the admin client`,
      );
    }

    // Track every module that can bypass RLS, so the count is reviewed rather
    // than growing unnoticed.
    if (
      /from ['"]@\/lib\/supabase\/admin['"]/.test(source) &&
      !/src[\\/]lib[\\/]supabase[\\/]admin\.ts$/.test(rel)
    ) {
      adminImports.push(rel);
    }
  }

  record('Service key confined to env.ts and admin.ts', serviceKeyLeaks);

  // Not a failure — a report. Every entry here bypasses RLS by design and
  // should be justifiable on sight.
  console.log(
    `\nModules using the service-role client (${adminImports.length}) — each bypasses RLS:`,
  );
  for (const file of adminImports.sort()) console.log(`  · ${file}`);

  // --- admin.ts must stay server-only --------------------------------------
  const adminSource = readFileSync(
    join(root, 'src/lib/supabase/admin.ts'),
    'utf8',
  );
  record(
    'admin.ts imports server-only',
    /^import ['"]server-only['"]/m.test(adminSource)
      ? []
      : ['admin.ts is missing the server-only import'],
  );

  // --- No tenant id may come from the client -------------------------------
  const tenantParams: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(root, file);
    // RPCs derive the tenant from the JWT; passing one in would defeat that.
    if (/p_tenant_id\s*:/.test(source) && !/platform/.test(rel)) {
      tenantParams.push(`${rel} passes p_tenant_id to an RPC`);
    }
  }
  record('No RPC is passed a tenant id (outside platform admin)', tenantParams);
}

async function databaseChecks(client: Client) {
  // --- RLS coverage --------------------------------------------------------
  const { rows: gaps } = await client.query<{
    table_name: string;
    gap: string;
    detail: string;
  }>('select table_name, gap, detail from public.rls_coverage_gaps()');

  record(
    'Every table and view in public is RLS-protected',
    gaps.map((g) => `${g.table_name}: ${g.gap} — ${g.detail}`),
  );

  // --- SECURITY DEFINER functions must pin search_path ---------------------
  //
  // Without `set search_path`, a definer function resolves unqualified names
  // through the caller's search_path, which is a classic privilege-escalation
  // route: a caller creates their own `medicines` table and the function reads
  // that instead.
  const { rows: definers } = await client.query<{
    name: string;
    config: string[] | null;
  }>(`
    select p.proname as name, p.proconfig as config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  `);

  record(
    'Every SECURITY DEFINER function pins search_path',
    definers
      .filter(
        (fn) => !(fn.config ?? []).some((c) => c.startsWith('search_path=')),
      )
      .map((fn) => `${fn.name}() does not set search_path`),
  );

  // --- Anon must not reach domain tables -----------------------------------
  const { rows: anonGrants } = await client.query<{
    table_name: string;
    privilege_type: string;
  }>(`
    select table_name, privilege_type
    from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'
  `);

  record(
    'The anon role has no grants on public tables',
    anonGrants.map((g) => `anon has ${g.privilege_type} on ${g.table_name}`),
  );

  // --- Tenant-scoped tables need a leading tenant_id index -----------------
  //
  // RLS adds a tenant_id predicate to every query. Without an index leading
  // with tenant_id, one pharmacy's query scans every pharmacy's rows.
  const { rows: unindexed } = await client.query<{ table_name: string }>(`
    with tenant_tables as (
      select c.oid, c.relname::text as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
        and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
    )
    select t.table_name
    from tenant_tables t
    where not exists (
      select 1 from pg_index i
      join pg_attribute a
        on a.attrelid = t.oid and a.attnum = i.indkey[0]
      where i.indrelid = t.oid and a.attname = 'tenant_id'
    )
  `);

  record(
    'Tenant tables have an index leading with tenant_id',
    unindexed.map((t) => `${t.table_name} has no index leading with tenant_id`),
  );
}

async function main() {
  console.log('PharmaSaaS security audit\n');

  await staticChecks();

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    findings.push({
      check: 'Database checks',
      detail: 'SUPABASE_DB_URL is not set, so database checks were skipped',
    });
  } else {
    const client = new Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      await databaseChecks(client);
    } finally {
      await client.end();
    }
  }

  console.log('\nPassed:');
  for (const check of passed) console.log(`  ✓ ${check}`);

  if (findings.length > 0) {
    console.error('\nFailed:');
    for (const f of findings) console.error(`  ✗ ${f.check}: ${f.detail}`);
    console.error(`\n${findings.length} finding(s).`);
    process.exit(1);
  }

  console.log('\nAll security checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
