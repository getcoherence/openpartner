import { Check } from 'lucide-react';
import { theme } from '../theme.js';

/**
 * Numbered steps in a row. `compact` drops the labels beside the numbers
 * (a phone can't fit five) and names the current step underneath instead.
 */
export function Stepper({ steps, current, compact = false }: { steps: string[]; current: number; compact?: boolean }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {steps.map((label, i) => {
          const done = i < current;
          const active = i === current;
          const c = done ? theme.accentText : active ? theme.text : theme.textDim;
          const bg = done ? theme.accent : active ? theme.surface2 : 'transparent';
          const border = done ? theme.accent : active ? theme.accent : theme.border;
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: i === steps.length - 1 ? 0 : 1 }}>
              <div
                aria-current={active ? 'step' : undefined}
                aria-label={compact ? label : undefined}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: bg,
                  border: `1px solid ${border}`,
                  color: done ? theme.accentInk : c,
                  fontSize: 11,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {done ? <Check size={12} /> : i + 1}
              </div>
              {!compact && (
                <div style={{ fontSize: 12, color: c, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap' }}>{label}</div>
              )}
              {i !== steps.length - 1 && <div style={{ height: 1, flex: 1, background: theme.border, marginLeft: compact ? 0 : 4 }} />}
            </div>
          );
        })}
      </div>
      {compact && steps[current] && (
        <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 10 }}>
          Step {current + 1} of {steps.length}: <span style={{ color: theme.text, fontWeight: 600 }}>{steps[current]}</span>
        </div>
      )}
    </div>
  );
}
