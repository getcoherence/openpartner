import { useSearchParams } from 'react-router';
import { safeNextPath } from '@openpartner/db';

/**
 * ?next= through platform sign-in: a path inside the brand workspace
 * (/admin/…) that /workspaces opens under /t/<slug> once the user enters
 * one. /go/creators/:handle starts it; /signin, the emailed link's landing,
 * Google and /workspaces pass it along. safeNextPath (packages/db) is the
 * only gate, so an unsafe value reads as no next at all.
 */
export function useNextPath(): string | null {
  const [params] = useSearchParams();
  return safeNextPath(params.get('next'));
}

/** `path`, carrying `next` as ?next= when there is one. */
export function withNext(path: string, next: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}
