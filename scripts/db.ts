import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

/**
 * Thin wrapper around the Supabase CLI that supplies `--db-url` from
 * `.env.local`.
 *
 * `supabase link` is avoided deliberately: it needs a dashboard access token,
 * whereas the database password we already hold is enough to run migrations.
 * The connection also has to go through the session-mode pooler — the direct
 * host `db.<ref>.supabase.co` publishes only an AAAA record and is unreachable
 * from IPv4-only networks.
 */

loadEnv({ path: '.env.local', quiet: true });

const dbUrl = process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  console.error(
    'SUPABASE_DB_URL is not set. Copy it from .env.example into .env.local ' +
      '(Supabase dashboard → Project Settings → Database → Connection string, ' +
      'session pooler on port 5432).',
  );
  process.exit(1);
}

const [subcommand, ...rest] = process.argv.slice(2);

const commands: Record<string, string[]> = {
  push: ['db', 'push', '--include-all'],
  diff: ['db', 'diff'],
  list: ['migration', 'list'],
};

const base = commands[subcommand];

if (!base) {
  console.error(
    `Unknown subcommand "${subcommand}". Expected one of: ${Object.keys(commands).join(', ')}`,
  );
  process.exit(1);
}

const result = spawnSync('supabase', [...base, '--db-url', dbUrl, ...rest], {
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status ?? 1);
