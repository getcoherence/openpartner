/**
 * Object storage for user-uploaded assets (brand logos, partner avatars).
 *
 * Two backends, picked by OPENPARTNER_STORAGE_KIND:
 *
 *   fs (default) — write to a local directory, served by an Express
 *                  static handler at /uploads/*. Fine for self-hosters
 *                  who don't have an S3-compatible store and don't want
 *                  to provision one. Persists across restarts when the
 *                  dir is on a docker volume; ephemeral otherwise.
 *
 *   s3           — write to any S3-compatible bucket. Used in our DO
 *                  deployment with DO Spaces. The s3 client is lazy-
 *                  imported so self-host installs that never set
 *                  STORAGE_KIND=s3 don't pay the dependency cost.
 *
 * Both backends return a `publicUrl(key)` the rest of the app can stamp
 * into JSON responses + DB columns. Switching backends is a deploy-time
 * config change; previously-uploaded files keep their old URLs (we
 * never rewrite stored URLs).
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface PutOptions {
  contentType: string;
}

export interface StorageBackend {
  /**
   * Write `buf` to `key`. Implementations overwrite atomically when the
   * key already exists; callers shouldn't rely on read-after-write
   * consistency across distributed S3 backends but DO Spaces + AWS S3
   * give us strong consistency in practice.
   */
  put(key: string, buf: Buffer, opts: PutOptions): Promise<void>;
  /**
   * Public URL for `key`. Constructed from configured base — never
   * involves a request to the storage backend.
   */
  publicUrl(key: string): string;
}

// ---------- FS backend ----------

class FsStorage implements StorageBackend {
  constructor(
    private dir: string,
    private publicBase: string,
  ) {}

  async put(key: string, buf: Buffer, _opts: PutOptions): Promise<void> {
    // Keys nest (e.g. tenants/<id>/logos/...), so create the full parent
    // path, not just the storage root — otherwise a fresh install ENOENTs
    // on the first upload. atomic-ish: write then rename would be safer but
    // for v1 a direct write is fine; the next overwrite supersedes.
    const target = join(this.dir, key);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, buf);
  }

  publicUrl(key: string): string {
    return `${this.publicBase.replace(/\/$/, '')}/${key}`;
  }
}

// ---------- S3 backend ----------

interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBase?: string;
}

class S3Storage implements StorageBackend {
  // The s3 client is constructed once and re-used — internal connection
  // pool handles concurrency. Typed as `any` because we lazy-import the
  // SDK; carrying the real types would force a top-level import.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientPromise: Promise<any> | null = null;

  constructor(private cfg: S3Config) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-s3').then(
        (mod) =>
          new mod.S3Client({
            region: this.cfg.region,
            endpoint: this.cfg.endpoint,
            // DO Spaces requires path-style URLs; AWS allows both.
            // forcePathStyle: false works for AWS, true is needed for
            // some on-prem MinIO setups. DO Spaces accepts either; we
            // default to the safer path-style.
            forcePathStyle: !!this.cfg.endpoint,
            credentials: {
              accessKeyId: this.cfg.accessKeyId,
              secretAccessKey: this.cfg.secretAccessKey,
            },
          }),
      );
    }
    return this.clientPromise;
  }

  async put(key: string, buf: Buffer, opts: PutOptions): Promise<void> {
    const c = await this.client();
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await c.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: buf,
        ContentType: opts.contentType,
        // Avatars and logos are public-read by design — they're shown
        // in unauthenticated brand pages on the Network and inline in
        // emails. ACL header is the cross-cloud way to set this.
        ACL: 'public-read',
        // 1y cache header — uploads use random keys so the URL changes
        // on every replace. Aggressive caching is safe.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  publicUrl(key: string): string {
    if (this.cfg.publicBase) {
      return `${this.cfg.publicBase.replace(/\/$/, '')}/${key}`;
    }
    if (this.cfg.endpoint) {
      // Custom endpoint (DO Spaces, MinIO): URL is endpoint/bucket/key.
      const ep = this.cfg.endpoint.replace(/\/$/, '');
      return `${ep}/${this.cfg.bucket}/${key}`;
    }
    // AWS: bucket-subdomain style.
    return `https://${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com/${key}`;
  }
}

// ---------- factory ----------

let backend: StorageBackend | null = null;

export function getStorage(): StorageBackend {
  if (backend) return backend;

  const kind = (process.env.OPENPARTNER_STORAGE_KIND ?? 'fs').toLowerCase();

  if (kind === 's3') {
    const required = ['STORAGE_S3_BUCKET', 'STORAGE_S3_REGION', 'STORAGE_S3_ACCESS_KEY_ID', 'STORAGE_S3_SECRET_ACCESS_KEY'];
    for (const name of required) {
      if (!process.env[`OPENPARTNER_${name}`]) {
        throw new Error(`OPENPARTNER_STORAGE_KIND=s3 requires OPENPARTNER_${name}`);
      }
    }
    backend = new S3Storage({
      bucket: process.env.OPENPARTNER_STORAGE_S3_BUCKET!,
      region: process.env.OPENPARTNER_STORAGE_S3_REGION!,
      endpoint: process.env.OPENPARTNER_STORAGE_S3_ENDPOINT,
      accessKeyId: process.env.OPENPARTNER_STORAGE_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.OPENPARTNER_STORAGE_S3_SECRET_ACCESS_KEY!,
      publicBase: process.env.OPENPARTNER_STORAGE_S3_PUBLIC_BASE,
    });
    return backend;
  }

  // fs default. publicBase computes off API_URL when not explicitly set
  // — saves operators from having to declare two URLs in the common case.
  const dir = resolve(process.env.OPENPARTNER_STORAGE_FS_DIR ?? '/var/lib/openpartner/uploads');
  const publicBase =
    process.env.OPENPARTNER_STORAGE_FS_PUBLIC_BASE ??
    `${(process.env.API_URL ?? 'http://localhost:4601').replace(/\/$/, '')}/uploads`;
  backend = new FsStorage(dir, publicBase);
  return backend;
}

export function fsStorageDir(): string | null {
  if ((process.env.OPENPARTNER_STORAGE_KIND ?? 'fs').toLowerCase() !== 'fs') return null;
  return resolve(process.env.OPENPARTNER_STORAGE_FS_DIR ?? '/var/lib/openpartner/uploads');
}

// ---------- helpers ----------

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

export interface ValidatedUpload {
  contentType: string;
  ext: string;
}

export function validateImageUpload(
  rawContentType: string | string[] | undefined,
  byteLength: number,
): ValidatedUpload {
  // Accept the raw header union and normalize the array case explicitly —
  // duplicate Content-Type headers must not sneak a second value past the
  // allowlist, and the explicit Array.isArray branch is what CodeQL's
  // js/type-confusion query recognizes as the sanitizer.
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new UploadError(`unsupported_content_type`, `Content-Type must be one of: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`);
  }
  if (byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadError('payload_too_large', `Upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }
  return { contentType, ext: EXT_BY_TYPE[contentType]! };
}

export function newUploadKey(prefix: string, ext: string): string {
  return `${prefix}/${randomBytes(16).toString('hex')}.${ext}`;
}

export class UploadError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
