import { describe, expect, it } from 'vitest';
import { admin } from './helpers';

/**
 * The release gate.
 *
 * Every other test checks behaviour we thought to write down. This one checks
 * the thing we might forget: that no table was added without RLS. It is
 * generated from the catalog rather than a hand-maintained list, so a new table
 * is covered the moment it exists.
 */
describe('RLS coverage', () => {
  it('has no unprotected tables in the public schema', async () => {
    const { data, error } = await admin.rpc('rls_coverage_gaps');

    expect(error, error?.message).toBeNull();

    const gaps = (data ?? []) as {
      table_name: string;
      gap: string;
      detail: string;
    }[];

    // Printed rather than just counted so a failure names the table and the
    // reason, instead of only "expected 3 to be 0".
    const report = gaps
      .map((g) => `  - ${g.table_name}: ${g.gap} — ${g.detail}`)
      .join('\n');

    expect(gaps, `RLS gaps found:\n${report}`).toEqual([]);
  });
});
