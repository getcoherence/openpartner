import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { alpha, theme } from '../theme.js';

/**
 * Asks before an action that's hard to undo, on the page where the button
 * was: the button swaps for a short question, "Yes, …" and Cancel.
 *
 * Not window.confirm: a browser that blocks or auto-dismisses dialogs (a
 * scripted or agent-driven one) gets false back, so the click did nothing
 * and no request went out.
 *
 * `children` renders the button and calls `ask` from its onClick. `error`
 * shows next to it, so a refusal appears where it was asked for rather than
 * in a page banner that may be off-screen.
 */
export function ConfirmAction({
  prompt,
  confirmLabel,
  cancelLabel,
  onConfirm,
  tone = 'danger',
  title,
  error,
  children,
}: {
  prompt: ReactNode;
  confirmLabel: string;
  /** For when "Cancel" would read as the action itself. */
  cancelLabel?: string;
  onConfirm: () => void;
  tone?: ConfirmTone;
  /** Detail that used to sit in the dialog; shown on hover. */
  title?: string;
  error?: unknown;
  children: (ask: () => void) => ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const cancelled = useRef(false);

  // Cancel hands focus back to the button that asked, which remounted.
  useEffect(() => {
    if (asking || !cancelled.current) return;
    cancelled.current = false;
    wrap.current?.querySelector<HTMLElement>('button, a[href], [tabindex]')?.focus();
  }, [asking]);

  return (
    <span ref={wrap} style={{ display: 'contents' }}>
      {asking ? (
        <ConfirmPrompt
          prompt={prompt}
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          tone={tone}
          title={title}
          onConfirm={() => {
            setAsking(false);
            onConfirm();
          }}
          onCancel={() => {
            cancelled.current = true;
            setAsking(false);
          }}
        />
      ) : (
        children(() => setAsking(true))
      )}
      {!asking && <ConfirmError error={error} />}
    </span>
  );
}

export type ConfirmTone = 'danger' | 'accent';

/**
 * The question and its two buttons, for a caller that keeps its own
 * asking state (one that fetches something to show before asking).
 */
export function ConfirmPrompt({
  prompt,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  tone = 'danger',
  title,
  disabled,
}: {
  prompt: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  tone?: ConfirmTone;
  title?: string;
  disabled?: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  // Cancel, not Yes, takes focus: a second Enter or a double-click mustn't
  // confirm.
  useEffect(() => cancel.current?.focus(), []);
  const color = tone === 'danger' ? theme.danger : theme.accentText;
  return (
    <span
      role="group"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
    >
      <span title={title} style={{ fontSize: 12.5, color: theme.textMuted }}>
        {prompt}
      </span>
      <button type="button" onClick={onConfirm} disabled={disabled} style={smallButton(color, disabled)}>
        {confirmLabel}
      </button>
      <button type="button" ref={cancel} onClick={onCancel} disabled={disabled} style={smallButton(theme.textMuted, disabled)}>
        {cancelLabel}
      </button>
    </span>
  );
}

/** A refusal, shown beside the action it refused. */
export function ConfirmError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <span role="alert" style={{ fontSize: 12, color: theme.danger }}>
      {error instanceof Error ? error.message : String(error)}
    </span>
  );
}

function smallButton(color: string, disabled?: boolean): CSSProperties {
  return {
    background: 'transparent',
    border: `1px solid ${alpha(color, 0.333)}`,
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    color,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
  };
}
