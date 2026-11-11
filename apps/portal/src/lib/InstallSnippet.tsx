import { useState } from 'react';
import { currentTenantSlug } from '../api.js';
import { theme } from '../theme.js';
import { Button } from '../ui.js';

/**
 * The tag a brand adds to its site. The API builds the same string for the
 * "send to a developer" email (routes/tracking-health.ts trackingScriptTag).
 */
export function useScriptTag(): string {
  const origin = typeof window === 'undefined' ? 'https://your-instance' : window.location.origin;
  const slug = currentTenantSlug();
  const apiBase = slug ? `${origin}/api/t/${slug}` : `${origin}/api`;
  return `<script src="${origin}/op.js" data-api-url="${apiBase}"></script>`;
}

/** A block of code with a Copy button. */
export function CodeSnippet({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <pre
        aria-label={label}
        style={{
          margin: 0,
          padding: '14px 14px 44px',
          background: theme.surface2,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          fontSize: 12,
          fontFamily: theme.fontMono,
          color: theme.text,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {code}
      </pre>
      <div style={{ position: 'absolute', right: 8, bottom: 8 }}>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
