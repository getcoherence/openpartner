/**
 * Filesystem storage backend. Regression: put() used to create only the
 * storage root, so a nested key (tenants/<id>/logos/...) ENOENT'd on a
 * fresh self-host install. Unit tier — no DB, real temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'op-storage-test-'));
process.env.OPENPARTNER_STORAGE_KIND = 'fs';
process.env.OPENPARTNER_STORAGE_FS_DIR = dir;

const { getStorage } = await import('../storage.js');

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FsStorage.put', () => {
  it('creates nested key directories before writing', async () => {
    const key = 'tenants/01ABCDEFGHIJKLMNOPQRSTUV/logos/logo.png';
    await getStorage().put(key, Buffer.from('logo-bytes'), { contentType: 'image/png' });
    const written = await readFile(join(dir, key));
    expect(written.toString()).toBe('logo-bytes');
  });

  it('overwrites an existing nested key', async () => {
    const key = 'tenants/t1/avatars/a.png';
    await getStorage().put(key, Buffer.from('v1'), { contentType: 'image/png' });
    await getStorage().put(key, Buffer.from('v2'), { contentType: 'image/png' });
    expect((await readFile(join(dir, key))).toString()).toBe('v2');
  });
});
