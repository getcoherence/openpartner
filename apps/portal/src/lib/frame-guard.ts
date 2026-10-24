/**
 * The portal never runs inside a frame, whoever's: a framed sign-in or
 * magic-link page can be overlaid and clicked through (clickjacking).
 * Nothing embeds the portal, so this matches nginx's frame-ancestors 'none'.
 *
 * Self-hosted nginx refuses framing with headers (nginx.conf.template). The
 * hosted portal is an App Platform static site, which can't send response
 * headers, and a <meta> CSP ignores frame-ancestors, so app.openpartner.dev
 * and every white-label domain rely on this check
 * (docs/deploy-production.md, "Portal frame protection"). main.tsx mounts
 * nothing when it's framed. A frame sandboxed without scripts gets a blank
 * page: the SPA renders nothing without JS.
 */

/** This document is inside a frame or iframe, of any origin. */
export function isFramed(win: Pick<Window, 'self' | 'top'> = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/**
 * Replaces `root`'s contents with a short notice and a link that opens the
 * page in its own tab. The link drops the query and fragment: magic-link
 * tokens travel there.
 */
export function showFramedNotice(root: HTMLElement, location: Pick<Location, 'origin' | 'pathname'> = window.location): void {
  const notice = document.createElement('p');
  notice.style.margin = '0';
  notice.style.padding = '24px';
  notice.append('This page can’t be shown inside another website. ');
  const link = document.createElement('a');
  link.href = location.origin + location.pathname;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.textDecoration = 'underline';
  link.textContent = 'Open it in a new tab';
  notice.append(link, '.');
  root.replaceChildren(notice);
}
