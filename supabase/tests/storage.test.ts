import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPharmacy, seedPharmacy, type SeededPharmacy } from './helpers';

/**
 * Storage isolation.
 *
 * Prescription images are patient records sitting in one bucket shared by every
 * pharmacy on the platform. Isolation comes entirely from the object key: the
 * first path segment is the tenant's UUID, and the policies compare it against
 * the caller's claim. If that comparison is wrong, one pharmacy can read
 * another's patient scans.
 */
describe('tenant-files storage', () => {
  let alpha: SeededPharmacy;
  let beta: SeededPharmacy;
  let alphaPath: string;

  const file = () =>
    new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], {
      type: 'application/pdf',
    });

  beforeAll(async () => {
    alpha = await seedPharmacy('storage-a');
    beta = await seedPharmacy('storage-b');
    alphaPath = `${alpha.tenant.id}/rx/scan.pdf`;
  }, 120_000);

  afterAll(async () => {
    await cleanupPharmacy(alpha);
    await cleanupPharmacy(beta);
  });

  it('lets a pharmacy upload under its own tenant prefix', async () => {
    const { error } = await alpha.pharmacist.client.storage
      .from('tenant-files')
      .upload(alphaPath, file(), { upsert: true });

    expect(error, error?.message).toBeNull();
  });

  it('refuses an upload written under another tenant prefix', async () => {
    const { error } = await beta.pharmacist.client.storage
      .from('tenant-files')
      .upload(`${alpha.tenant.id}/rx/planted.pdf`, file());

    // The path is attacker-controlled, so this is the check that matters.
    expect(error).not.toBeNull();
  });

  it("refuses to download another pharmacy's file", async () => {
    const { data, error } = await beta.owner.client.storage
      .from('tenant-files')
      .download(alphaPath);

    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it("does not list another pharmacy's files", async () => {
    const { data } = await beta.owner.client.storage
      .from('tenant-files')
      .list(`${alpha.tenant.id}/rx`);

    expect(data ?? []).toEqual([]);
  });

  it("refuses to sign a URL for another pharmacy's file", async () => {
    const { data, error } = await beta.owner.client.storage
      .from('tenant-files')
      .createSignedUrl(alphaPath, 60);

    // A signed URL bypasses RLS once issued, so refusing to mint it is the
    // only defence.
    expect(data).toBeNull();
    expect(error).not.toBeNull();
  });

  it('lets the owning pharmacy sign and fetch its own file', async () => {
    const { data, error } = await alpha.owner.client.storage
      .from('tenant-files')
      .createSignedUrl(alphaPath, 60);

    expect(error, error?.message).toBeNull();
    expect(data?.signedUrl).toBeTruthy();

    const response = await fetch(data!.signedUrl);
    expect(response.status).toBe(200);
  });

  it("refuses to delete another pharmacy's file", async () => {
    await beta.owner.client.storage.from('tenant-files').remove([alphaPath]);

    // remove() reports success for keys it cannot see, so the real assertion is
    // that the file is still there afterwards.
    const { error } = await alpha.owner.client.storage
      .from('tenant-files')
      .download(alphaPath);
    expect(error).toBeNull();
  });

  it('refuses deletion by a cashier', async () => {
    await alpha.cashier.client.storage.from('tenant-files').remove([alphaPath]);

    const { error } = await alpha.owner.client.storage
      .from('tenant-files')
      .download(alphaPath);
    expect(error).toBeNull();
  });
});
