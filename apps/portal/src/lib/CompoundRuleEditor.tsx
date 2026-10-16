/**
 * Compound commission-rule editor, shared by the program terms
 * (AdminPrograms) and a partner's commission override
 * (AdminPartnerCommission) — both store the same CommissionSubRule[]
 * array, so both edit it with the same control.
 */

import { Trash2 } from 'lucide-react';
import { theme } from '../theme.js';
import { Input, Label, Select } from '../ui.js';

export interface CommissionSubRule {
  trigger: 'every' | 'first' | 'subsequent';
  eventType?: string;
  type: 'percent' | 'fixed';
  value: number;
  currency?: string;
  recurring?: boolean;
  recurringMonths?: number;
}

/**
 * True when a rule's event type can't be saved: an empty custom event
 * name, or a `first` / `subsequent` rule with no event type at all
 * ("first WHAT?"). The engine only filters on eventType when it's set,
 * so a first-sale bonus saved without one would pay on the first event
 * of every type. Mirrors the API's sub-rule validation; every form that
 * renders this editor gates Save on it.
 */
export function ruleEventTypeMissing(rule: CommissionSubRule): boolean {
  if (rule.eventType === '') return true;
  return (rule.trigger === 'first' || rule.trigger === 'subsequent') && !rule.eventType;
}

/**
 * Editor for a commissionRule[] array. Each row is one sub-rule.
 *
 * Sub-rules combine: a `subscription_created` event might match both a
 * first-sale bonus AND an every-event recurring rule, producing two
 * Commission rows against the same Attribution. Order in the array doesn't
 * affect engine semantics (each sub-rule evaluates independently).
 */
export function CompoundRuleEditor({
  rules,
  onChange,
}: {
  rules: CommissionSubRule[];
  onChange: (rules: CommissionSubRule[]) => void;
}) {
  const update = (i: number, patch: Partial<CommissionSubRule>) => {
    onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const remove = (i: number) => {
    onChange(rules.filter((_, j) => j !== i));
  };
  const add = () => {
    onChange([...rules, { trigger: 'first', eventType: 'subscription_created', type: 'fixed', value: 100 }]);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <Label>Commission rules</Label>
        <span style={{ fontSize: 12, color: theme.textDim }}>
          Multiple rules combine — e.g. one-time bonus + recurring revenue share.
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
        {rules.map((rule, i) => (
          <SubRuleRow
            key={i}
            rule={rule}
            onChange={(patch) => update(i, patch)}
            onRemove={rules.length > 1 ? () => remove(i) : undefined}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        style={{
          background: 'transparent',
          border: `1px dashed ${theme.accentA88}`,
          borderRadius: 6,
          padding: '6px 12px',
          color: theme.accentText,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        + Add bonus or rule
      </button>
    </div>
  );
}

/** Built-in event types brands typically reward on. The list mirrors
 *  EventType in @openpartner/db; custom event names are still accepted
 *  by the engine (string passthrough) but require the "Custom…" escape
 *  hatch in the UI so a typo doesn't silently misroute commissions to
 *  an event that never fires. */
const STANDARD_EVENT_TYPES = [
  { value: 'invoice_paid', label: 'Invoice paid' },
  { value: 'subscription_created', label: 'Subscription created' },
  { value: 'trial_started', label: 'Trial started' },
  { value: 'signup', label: 'Signup' },
] as const;
const STANDARD_EVENT_VALUES: ReadonlySet<string> = new Set(STANDARD_EVENT_TYPES.map((e) => e.value));

function SubRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: CommissionSubRule;
  onChange: (patch: Partial<CommissionSubRule>) => void;
  onRemove?: () => void;
}) {
  // 'custom' is a UI-only sentinel that flips the picker to a freeform
  // input. The eventType payload itself is still a plain string. A
  // first/subsequent rule with no event type (its custom name cleared, or
  // stored that way) stays on the custom input: the picker has no "all
  // events" option for those triggers, so it would otherwise show a
  // standard event the rule doesn't actually filter on.
  const eventTypeMissing = ruleEventTypeMissing(rule);
  const isCustomEvent =
    (rule.eventType != null && !STANDARD_EVENT_VALUES.has(rule.eventType)) || eventTypeMissing;
  // Default for the 'every'-trigger "all events" case (no eventType set)
  // is the empty-string sentinel — distinct from picking a known type so
  // the UI can render "All events with value" as the selected option.
  const eventSelectValue = isCustomEvent ? '__custom__' : rule.eventType ?? '';

  return (
    <div
      className="op-grid-collapse"
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 180px 110px 1fr 90px auto',
        gap: 8,
        alignItems: 'center',
        padding: 8,
        background: theme.surface2,
        borderRadius: 6,
      }}
    >
      <Select
        value={rule.trigger}
        onChange={(e) => {
          const trigger = e.target.value as 'every' | 'first' | 'subsequent';
          // Re-default eventType per trigger when the prior value would
          // be confusing in the new context. 'first' / 'subsequent'
          // require an event type — pick a sensible default. 'every'
          // tolerates absent (= all events with value).
          const patch: Partial<CommissionSubRule> = { trigger };
          if ((trigger === 'first' || trigger === 'subsequent') && !rule.eventType) {
            patch.eventType = trigger === 'first' ? 'subscription_created' : 'invoice_paid';
          }
          onChange(patch);
        }}
      >
        <option value="every">On every</option>
        <option value="first">On first</option>
        <option value="subsequent">On every subsequent</option>
      </Select>
      <Select
        value={eventSelectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') {
            // Seed with the current value if we already had one, else
            // empty so the user is forced to type. Empty string passes
            // through as undefined on save.
            onChange({ eventType: rule.eventType && !STANDARD_EVENT_VALUES.has(rule.eventType) ? rule.eventType : '' });
          } else if (v === '') {
            onChange({ eventType: undefined });
          } else {
            onChange({ eventType: v });
          }
        }}
      >
        {/* Empty-string option only meaningful for 'every' — 'first' and
            'subsequent' require a specific eventType, so we hide it. */}
        {rule.trigger === 'every' && <option value="">All events with value</option>}
        {STANDARD_EVENT_TYPES.map((e) => (
          <option key={e.value} value={e.value}>{e.label}</option>
        ))}
        <option value="__custom__">Custom event…</option>
      </Select>
      <Select value={rule.type} onChange={(e) => onChange({ type: e.target.value as 'percent' | 'fixed' })}>
        <option value="percent">Percent</option>
        <option value="fixed">Fixed $</option>
      </Select>
      <Input
        type="number"
        value={rule.value}
        onChange={(e) => onChange({ value: Number(e.target.value) })}
      />
      <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center', color: theme.textMuted }}>
        <input
          type="checkbox"
          checked={rule.recurring ?? false}
          onChange={(e) => onChange({ recurring: e.target.checked, recurringMonths: e.target.checked ? rule.recurringMonths : undefined })}
        />
        Recurring
      </label>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove rule"
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.danger,
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
          }}
        >
          <Trash2 size={14} />
        </button>
      ) : (
        <span />
      )}
      {isCustomEvent && (
        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: theme.textMuted }}>Custom event name</span>
          <Input
            placeholder="e.g. demo_booked"
            value={rule.eventType ?? ''}
            onChange={(e) => onChange({ eventType: e.target.value.trim() || undefined })}
          />
          {eventTypeMissing && (
            <span style={{ gridColumn: 2, fontSize: 12, color: theme.danger }}>
              Name the event this rule pays on.
            </span>
          )}
        </div>
      )}
      {rule.recurring && (
        <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'auto 120px 1fr', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: theme.textMuted }}>Cap recurring at</span>
          <Input
            type="number"
            placeholder="∞"
            value={rule.recurringMonths ?? ''}
            onChange={(e) => onChange({ recurringMonths: e.target.value ? Number(e.target.value) : undefined })}
          />
          <span style={{ fontSize: 12, color: theme.textDim }}>
            months from the partner's first attributed event of this type. Blank = no cap.
          </span>
        </div>
      )}
    </div>
  );
}
