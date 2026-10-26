/**
 * Images and links in conversations (the Network's docs/creator-storefront.md
 * §8.1), for both sides' threads (conversation-shared.tsx).
 *
 * Images are private. Each side fetches a file through its own API, with its
 * own credentials (the `load` it passes in), and shows it from a blob URL; an
 * image the sender just uploaded is seeded here so it shows without a second
 * download. Before upload, photos are redrawn (prepareImage), which drops
 * their metadata (where a phone photo was taken, for one) and keeps them
 * under the size limit.
 *
 * Links in messages are made clickable (Linkified). Only http(s) links; the
 * rest of the text stays text.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Download, X } from 'lucide-react';
import { alpha, theme } from '../../theme.js';

export interface MessageAttachment {
  id: string;
  contentType: string;
  width: number;
  height: number;
  size: number;
  /** OpenPartner took it down. */
  removed: boolean;
}

/** Fetch an image's file with this side's credentials. */
export type LoadAttachment = (id: string) => Promise<Blob>;

/** What the Network accepts (its conversation-attachments.ts). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Photos are scaled down to this on their longest side before upload. */
const MAX_SIDE = 2560;

// ----- preparing an image to send -----

/** Why an image can't be sent, for the composer to say. */
export class ImageProblem extends Error {}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The picture in `file`, drawable on a canvas: an ImageBitmap where the
 *  browser has them, else a decoded <img>. */
async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close?.() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * The file to upload for `file`: redrawn at most MAX_SIDE on its longest
 * side in its own format, or as a JPEG if that's still over the limit.
 * Redrawing is what drops a photo's metadata, so a photo the browser can't
 * redraw isn't sent. GIFs go as they are, since they may move.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (!IMAGE_TYPES.includes(file.type)) throw new ImageProblem('Only PNG, JPEG, WebP and GIF images can be sent.');
  const name = file.name || 'That image';
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_BYTES) throw new ImageProblem(`${name} is over 5 MB.`);
    return file;
  }
  let picture: Awaited<ReturnType<typeof decode>>;
  try {
    picture = await decode(file);
  } catch {
    throw new ImageProblem(`${name} can’t be read. Try a PNG or JPEG.`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(picture.width, picture.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(picture.width * scale));
  canvas.height = Math.max(1, Math.round(picture.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    picture.done();
    throw new ImageProblem('This browser can’t prepare images for sending. Try another browser.');
  }
  ctx.drawImage(picture.source, 0, 0, canvas.width, canvas.height);
  picture.done();
  let blob = await toBlob(canvas, file.type, 0.9);
  if (!blob || blob.size > MAX_IMAGE_BYTES) {
    // A JPEG has no transparency: put it on white rather than black.
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const fctx = flat.getContext('2d');
    if (fctx) {
      fctx.fillStyle = '#ffffff';
      fctx.fillRect(0, 0, flat.width, flat.height);
      fctx.drawImage(canvas, 0, 0);
      blob = await toBlob(flat, 'image/jpeg', 0.85);
    }
  }
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new ImageProblem(`${file.name || 'That image'} is too large to send.`);
  return blob;
}

/** The composer's words for an upload the API refused. */
export function uploadErrorText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/payload_too_large/.test(m)) return 'That image is over 5 MB.';
  if (/invalid_image|unsupported_content_type/.test(m)) return 'That file isn’t an image we can send. Use a PNG, JPEG, WebP or GIF.';
  if (/rate_limited/.test(m)) return 'You’ve sent a lot of images in the last hour. Try again a little later.';
  if (/conversation_blocked/.test(m)) return 'This creator has blocked you.';
  if (/creator_unavailable|brand_unavailable/.test(m)) return 'They can’t receive messages right now.';
  return 'The image didn’t upload. Try again.';
}

// ----- showing images -----

/**
 * Loaded images, by attachment id. An entry on screen (`users` > 0) or still
 * loading is never let go; past CACHE_MAX entries or CACHE_BYTES, the least
 * recently used of the rest are, and their blob URLs revoked. The files are
 * never cached by the browser (the API sends no-store), so this is what
 * saves refetching an image the thread already showed.
 */
const CACHE_MAX = 120;
const CACHE_BYTES = 120 * 1024 * 1024;

interface CacheEntry {
  url: Promise<string>;
  users: number;
  /** Known once loaded. */
  bytes: number | null;
}
const cache = new Map<string, CacheEntry>();

function prune(): void {
  let bytes = 0;
  for (const e of cache.values()) bytes += e.bytes ?? 0;
  // Oldest first: a Map keeps insertion order, and use re-inserts.
  for (const [id, e] of cache) {
    if (cache.size <= CACHE_MAX && bytes <= CACHE_BYTES) return;
    if (e.users > 0 || e.bytes == null) continue;
    cache.delete(id);
    bytes -= e.bytes;
    void e.url.then((u) => URL.revokeObjectURL(u));
  }
}

function touch(id: string, e: CacheEntry): void {
  cache.delete(id);
  cache.set(id, e);
}

/** Show `blob` for attachment `id` without fetching it (the sender's own
 *  upload). */
export function seedAttachment(id: string, blob: Blob): void {
  if (cache.has(id) || typeof URL.createObjectURL !== 'function') return;
  cache.set(id, { url: Promise.resolve(URL.createObjectURL(blob)), users: 0, bytes: blob.size });
  prune();
}

/** Take a hold on attachment `id`'s URL, loading it if need be. Give it
 *  back with release(). */
function acquire(id: string, load: LoadAttachment): CacheEntry {
  const known = cache.get(id);
  if (known) {
    known.users += 1;
    touch(id, known);
    return known;
  }
  const entry: CacheEntry = { url: Promise.resolve(''), users: 1, bytes: null };
  entry.url = load(id).then((blob) => {
    entry.bytes = blob.size;
    return URL.createObjectURL(blob);
  });
  entry.url.then(prune, () => {
    // A failed load is tried again next time it's shown.
    if (cache.get(id) === entry) cache.delete(id);
  });
  cache.set(id, entry);
  return entry;
}

function release(entry: CacheEntry): void {
  entry.users = Math.max(0, entry.users - 1);
  prune();
}

export function useAttachmentUrl(id: string, load: LoadAttachment): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    let current = true;
    const entry = acquire(id, load);
    entry.url.then(
      (url) => current && setState((s) => (s.url === url ? s : { url, failed: false })),
      () => current && setState((s) => (s.failed ? s : { url: null, failed: true })),
    );
    return () => {
      current = false;
      release(entry);
    };
  }, [id, load]);
  return state;
}

/** Let go of every loaded image, revoking its URL (once loaded, for those
 *  still loading). On signing out: whoever uses this tab next can't be
 *  shown one from memory. */
export function clearAttachmentCache(): void {
  for (const e of cache.values()) void e.url.then((u) => URL.revokeObjectURL(u), () => undefined);
  cache.clear();
}

/** A message's images: one shown large, several as a grid. Click to open. */
export function AttachmentGrid({ attachments, load, align }: { attachments: MessageAttachment[]; load: LoadAttachment; align: 'left' | 'right' }) {
  const [open, setOpen] = useState<MessageAttachment | null>(null);
  if (attachments.length === 0) return null;
  const single = attachments.length === 1;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: single ? 'auto' : 'repeat(2, minmax(0, 150px))',
        gap: 6,
        justifyContent: align === 'right' ? 'end' : 'start',
      }}
    >
      {attachments.map((a) => (
        <Tile key={a.id} a={a} load={load} single={single} onOpen={() => setOpen(a)} />
      ))}
      {open && <Lightbox a={open} load={load} onClose={() => setOpen(null)} />}
    </div>
  );
}

function boxFor(a: MessageAttachment, single: boolean): { width: number; height: number } {
  if (!single) return { width: 150, height: 150 };
  const scale = Math.min(1, 320 / a.width, 320 / a.height);
  return { width: Math.max(60, Math.round(a.width * scale)), height: Math.max(40, Math.round(a.height * scale)) };
}

function Tile({ a, load, single, onOpen }: { a: MessageAttachment; load: LoadAttachment; single: boolean; onOpen: () => void }) {
  const box = boxFor(a, single);
  if (a.removed) {
    return (
      <div style={{ ...box, height: 'auto', minHeight: 40, maxWidth: '100%', fontSize: 12, color: theme.textDim, background: theme.surface2, border: `1px dashed ${theme.borderSubtle}`, borderRadius: 8, padding: 10, boxSizing: 'border-box' }}>
        Image removed by OpenPartner
      </div>
    );
  }
  return <LoadedTile a={a} load={load} box={box} onOpen={onOpen} />;
}

function LoadedTile({ a, load, box, onOpen }: { a: MessageAttachment; load: LoadAttachment; box: { width: number; height: number }; onOpen: () => void }) {
  const { url, failed } = useAttachmentUrl(a.id, load);
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!url}
      aria-label="Open image"
      style={{
        ...box,
        maxWidth: '100%',
        padding: 0,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: theme.surface2,
        cursor: url ? 'zoom-in' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {url ? (
        <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <span style={{ fontSize: 12, color: theme.textDim }}>{failed ? 'Couldn’t load the image' : 'Loading…'}</span>
      )}
    </button>
  );
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function Lightbox({ a, load, onClose }: { a: MessageAttachment; load: LoadAttachment; onClose: () => void }) {
  const { url } = useAttachmentUrl(a.id, load);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: alpha('#000000', 0.85), display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 8 }}>
        {url && (
          <a
            href={url}
            download={`${a.id}.${EXT[a.contentType] ?? 'img'}`}
            onClick={(e) => e.stopPropagation()}
            aria-label="Download image"
            style={{ color: '#fff', display: 'inline-flex', padding: 8, borderRadius: 8, background: alpha('#ffffff', 0.12) }}
          >
            <Download size={18} />
          </a>
        )}
        <button type="button" onClick={onClose} aria-label="Close" style={{ color: '#fff', display: 'inline-flex', padding: 8, borderRadius: 8, border: 'none', background: alpha('#ffffff', 0.12), cursor: 'pointer' }}>
          <X size={18} />
        </button>
      </div>
      {url && <img src={url} alt="" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '92vw', maxHeight: '88vh', objectFit: 'contain', borderRadius: 6 }} />}
    </div>
  );
}

// ----- links -----

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING = /[.,!?;:)\]]$/;

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** Split `text` into text and links: http(s):// and www. addresses, minus
 *  the punctuation that ends the sentence around them. */
export function linkParts(text: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(URL_PATTERN)) {
    const start = m.index ?? 0;
    let url = m[0];
    while (TRAILING.test(url)) {
      const ch = url.at(-1)!;
      // A bracket the link opened is part of it: …/Foo_(bar)
      if (ch === ')' && count(url, '(') >= count(url, ')')) break;
      if (ch === ']' && count(url, '[') >= count(url, ']')) break;
      url = url.slice(0, -1);
    }
    if (!/[a-z0-9]/i.test(url.replace(/^(https?:\/\/|www\.)/i, ''))) continue;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: /^www\./i.test(url) ? `https://${url}` : url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** `text` with its links clickable, opening in a new tab. */
export function Linkified({ text }: { text: string }) {
  const nodes: ReactNode[] = linkParts(text).map((p, i) =>
    p.href ? (
      <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow ugc" style={{ color: 'inherit', textDecoration: 'underline', overflowWrap: 'anywhere' }}>
        {p.text}
      </a>
    ) : (
      <Fragment key={i}>{p.text}</Fragment>
    ),
  );
  return <>{nodes}</>;
}
