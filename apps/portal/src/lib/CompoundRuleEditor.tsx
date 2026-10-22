/**
 * Compound commission-rule editor, shared by the program terms
 * (AdminPrograms) and a partner's commission override
 * (AdminPartnerCommission) — both store the same CommissionSubRule[]
 * array, so both edit it with the same control.
 */

import { Trash2 } from 'lucide-react';
import type { CommissionBands, CommissionTiers } from '@openpartner/db';
import { theme } from '../theme.js';
import { Input, Label, Select } from '../ui.js';
import { useDefaultCurrency } from './useBrand.js';

export interface CommissionSubRule {
  trigger: 'every' | 'first' | 'subsequent';
  eventType?: string;
  type: 'percent' | 'fixed';
  /** With bands or tiers: the base rate, below the first threshold. */
  value: number;
  /** Currency of fixed amounts and slab thresholds. Unset = the event's. */
  currency?: string;
  recurring?: boolean;
  recurringMonths?: number;
  /** Rate by the event's own value. See docs/commission-slabs.md. */
  bands?: CommissionBands;
  /** Rate by the partner's attributed performance over a window. */
  tiers?: CommissionTiers;
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

/** Steps per slab table — the API's MAX_SLAB_LEVELS. */
export const MAX_SLAB_LEVELS = 10;

/**
 * Why a rule's slab table can't be saved, or null when it can (or the rule
 * has none). Mirrors the API's refineCommissionSubRule + level schemas so
 * the form says what's wrong instead of surfacing a 400; every form that
 * renders this editor gates Save on it.
 */
export function ruleSlabProblem(rule: CommissionSubRule): string | null {
  // Checked for every rule, flat ones included: the API refuses a bad code
  // wherever it sits, so a flat rule mustn't look savable with one.
  if (rule.currency != null && !/^[A-Za-z]{3}$/.test(rule.currency)) return 'Currency is a 3-letter code, e.g. INR.';
  if (rule.bands && rule.tiers) return 'Use slabs or tiers on a rule, not both.';
  const table = rule.bands ?? rule.tiers;
  if (!table) return null;
  const thresholds = rule.bands
    ? rule.bands.levels.map((l) => l.above)
    : rule.tiers!.levels.map((l) => l.atLeast);
  if (thresholds.length === 0) return 'Add at least one step, or switch the rate back to flat.';
  if (thresholds.length > MAX_SLAB_LEVELS) return `At most ${MAX_SLAB_LEVELS} steps.`;
  for (let i = 0; i < thresholds.length; i += 1) {
    const threshold = thresholds[i]!;
    const value = table.levels[i]!.value;
    if (!Number.isFinite(threshold) || threshold <= 0) return 'Each threshold must be more than 0.';
    if (i > 0 && threshold <= thresholds[i - 1]!) return 'Thresholds must increase from one step to the next.';
    if (!Number.isFinite(value) || value < 0) return 'Each step needs a rate of 0 or more.';
    if (rule.type === 'percent' && value > 100) return 'A percent rate can’t exceed 100.';
  }
  if (rule.bands?.mode === 'marginal' && rule.type !== 'percent') return 'Marginal slabs need a percent rate.';
  if (rule.tiers) {
    const days = rule.tiers.windowDays;
    if (rule.tiers.window === 'rolling_days' && !(days != null && Number.isInteger(days) && days >= 1 && days <= 3650)) {
      return 'Set the rolling window to 1–3650 days.';
    }
    if (!rule.tiers.eventType && !rule.eventType) return 'Pick the event the tier counts.';
  }
  return null;
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
  const defaultCurrency = useDefaultCurrency();
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
            defaultCurrency={defaultCurrency}
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

/**
 * The currency a fixed amount is shown in: the rule's own, else the brand's
 * default. A fixed rule with no currency pays in each event's currency
 * (commissionCurrency in apps/api/src/attribution.ts), and a conversion
 * sent without one is stored in the brand's default, so that's the
 * currency nearly all of them pay in — not "$".
 */
function fixedCurrency(rule: CommissionSubRule, defaultCurrency: string): string {
  return rule.currency || defaultCurrency;
}

function SubRuleRow({
  rule,
  defaultCurrency,
  onChange,
  onRemove,
}: {
  rule: CommissionSubRule;
  defaultCurrency: string;
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
        gridTemplateColumns: '110px 180px 100px minmax(70px, 1fr) 170px 90px auto',
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
      <Select
        value={rule.type}
        onChange={(e) => {
          const type = e.target.value as 'percent' | 'fixed';
          // A fixed amount has no slices to split, so marginal slabs fall
          // back to whole-event slabs rather than leaving an unsavable rule.
          const patch: Partial<CommissionSubRule> = { type };
          if (type === 'fixed' && rule.bands?.mode === 'marginal') patch.bands = { ...rule.bands, mode: 'whole' };
          onChange(patch);
        }}
      >
        <option value="percent">Percent</option>
        <option value="fixed">Fixed {fixedCurrency(rule, defaultCurrency)}</option>
      </Select>
      <Input
        type="number"
        aria-label={rule.bands || rule.tiers ? 'Base rate' : 'Rate'}
        value={rule.value}
        onChange={(e) => onChange({ value: Number(e.target.value) })}
      />
      <Select
        aria-label="Rate varies"
        value={rateKindOf(rule)}
        onChange={(e) => onChange(switchRateKind(rule, e.target.value as RateKind))}
      >
        <option value="flat">Flat rate</option>
        <option value="bands">Slabs by value</option>
        <option value="tiers">Performance tiers</option>
      </Select>
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
      {(rule.bands || rule.tiers) && <SlabPanel rule={rule} defaultCurrency={defaultCurrency} onChange={onChange} />}
      {/* A flat rule's only possible slab problem is a currency the API
          refuses (stored via the API before the 3-letter check). The slab
          panel isn't there to show it, so say it here with a way out. */}
      {!rule.bands && !rule.tiers && ruleSlabProblem(rule) && (
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: theme.danger }}>
          {ruleSlabProblem(rule)}
          <button
            type="button"
            onClick={() => onChange({ currency: undefined })}
            style={{ background: 'transparent', border: 'none', color: theme.accentText, fontSize: 12, cursor: 'pointer', padding: 0 }}
          >
            Clear currency
          </button>
        </div>
      )}
    </div>
  );
}

type RateKind = 'flat' | 'bands' | 'tiers';

function rateKindOf(rule: CommissionSubRule): RateKind {
  return rule.bands ? 'bands' : rule.tiers ? 'tiers' : 'flat';
}

/** Switch how a rule's rate varies. A new table opens with one step above
 *  the current rate, so there's something to edit rather than an empty,
 *  unsavable table; switching back to flat drops the table, and with it
 *  the "Thresholds in" currency when nothing else uses it (a percent rule)
 *  or it isn't a valid code — a flat rule has no field left to fix it in. */
function switchRateKind(rule: CommissionSubRule, kind: RateKind): Partial<CommissionSubRule> {
  const step = nextStepValue(rule, rule.value);
  if (kind === 'bands') {
    return { tiers: undefined, bands: rule.bands ?? { mode: 'whole', levels: [{ above: 50000, value: step }] } };
  }
  if (kind === 'tiers') {
    return {
      bands: undefined,
      tiers: rule.tiers ?? {
        metric: 'revenue',
        window: 'calendar_month',
        // A tier has to count a specific event; an every-event rule
        // doesn't name one, so default to the paid stage.
        ...(rule.eventType ? {} : { eventType: 'invoice_paid' }),
        levels: [{ atLeast: 10000, value: step }],
      },
    };
  }
  const keepCurrency = rule.type === 'fixed' && rule.currency != null && /^[A-Za-z]{3}$/.test(rule.currency);
  return { bands: undefined, tiers: undefined, ...(keepCurrency ? {} : { currency: undefined }) };
}

function nextStepValue(rule: CommissionSubRule, from: number): number {
  return rule.type === 'percent' ? Math.min(100, from + 5) : from * 2;
}

const hintStyle = { fontSize: 12, color: theme.textMuted } as const;

/**
 * The step table under a banded or tiered rule. The rule's own rate input
 * is the base step; each row here is one step above it. Semantics match
 * the engine (apps/api/src/commission-slabs.ts): a band threshold is the
 * top of the band below it, and a tier applies once the partner's metric
 * reaches it, measured from history before each event.
 */
function SlabPanel({
  rule,
  defaultCurrency,
  onChange,
}: {
  rule: CommissionSubRule;
  defaultCurrency: string;
  onChange: (patch: Partial<CommissionSubRule>) => void;
}) {
  const { bands, tiers } = rule;
  const steps = bands
    ? bands.levels.map((l) => ({ threshold: l.above, value: l.value }))
    : (tiers?.levels ?? []).map((l) => ({ threshold: l.atLeast, value: l.value }));
  const setSteps = (next: Array<{ threshold: number; value: number }>) => {
    if (bands) onChange({ bands: { ...bands, levels: next.map((l) => ({ above: l.threshold, value: l.value })) } });
    else if (tiers) onChange({ tiers: { ...tiers, levels: next.map((l) => ({ atLeast: l.threshold, value: l.value })) } });
  };
  const updateStep = (i: number, patch: Partial<{ threshold: number; value: number }>) =>
    setSteps(steps.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addStep = () => {
    const last = steps[steps.length - 1];
    setSteps([
      ...steps,
      { threshold: last ? last.threshold * 2 : 1000, value: nextStepValue(rule, last ? last.value : rule.value) },
    ]);
  };

  const unit = rule.type === 'percent' ? '%' : fixedCurrency(rule, defaultCurrency);
  const baseRate = rule.type === 'percent' ? `${rule.value}%` : `${rule.value} ${unit}`;
  const moneyThresholds = Boolean(bands) || tiers?.metric === 'revenue';
  const thresholdLabel = bands ? 'Value above' : tiers?.metric === 'conversions' ? 'Conversions ≥' : 'Revenue ≥';
  const problem = ruleSlabProblem(rule);
  const atMax = steps.length >= MAX_SLAB_LEVELS;

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 10,
        border: `1px solid ${theme.border}`,
        borderRadius: 6,
        background: theme.surface,
      }}
    >
      {bands && (
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center' }}>
          <span style={hintStyle}>Pay</span>
          <Select
            aria-label="Slab mode"
            value={bands.mode}
            onChange={(e) => onChange({ bands: { ...bands, mode: e.target.value as 'whole' | 'marginal' } })}
          >
            <option value="whole">the whole event at its slab’s rate</option>
            <option value="marginal" disabled={rule.type !== 'percent'}>
              each slice of the value at its own rate (marginal)
            </option>
          </Select>
        </div>
      )}
      {tiers && (
        <div
          className="op-grid-collapse"
          style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: 8, alignItems: 'center' }}
        >
          <span style={hintStyle}>Measure</span>
          <Select
            aria-label="Tier metric"
            value={tiers.metric}
            onChange={(e) => onChange({ tiers: { ...tiers, metric: e.target.value as 'revenue' | 'conversions' } })}
          >
            <option value="revenue">attributed revenue</option>
            <option value="conversions">attributed conversions</option>
          </Select>
          <span style={hintStyle}>over</span>
          <Select
            aria-label="Tier window"
            value={tiers.window}
            onChange={(e) => {
              const window = e.target.value as 'lifetime' | 'calendar_month' | 'rolling_days';
              onChange({
                tiers: { ...tiers, window, windowDays: window === 'rolling_days' ? tiers.windowDays ?? 30 : undefined },
              });
            }}
          >
            <option value="lifetime">the partner’s lifetime</option>
            <option value="calendar_month">the calendar month (UTC)</option>
            <option value="rolling_days">a rolling window</option>
          </Select>
          <span style={hintStyle}>counting</span>
          <Select
            aria-label="Counted event"
            value={tiers.eventType ?? ''}
            onChange={(e) => onChange({ tiers: { ...tiers, eventType: e.target.value || undefined } })}
          >
            {rule.eventType ? (
              <option value="">this rule’s event</option>
            ) : (
              !tiers.eventType && <option value="">Pick an event…</option>
            )}
            {STANDARD_EVENT_TYPES.map((ev) => (
              <option key={ev.value} value={ev.value}>{ev.label}</option>
            ))}
            {tiers.eventType && !STANDARD_EVENT_VALUES.has(tiers.eventType) && (
              <option value={tiers.eventType}>{tiers.eventType}</option>
            )}
          </Select>
          {tiers.window === 'rolling_days' && (
            <>
              <span style={hintStyle}>days</span>
              <Input
                aria-label="Window days"
                type="number"
                value={tiers.windowDays ?? ''}
                onChange={(e) =>
                  onChange({ tiers: { ...tiers, windowDays: e.target.value ? Number(e.target.value) : undefined } })
                }
              />
            </>
          )}
        </div>
      )}
      {/* Also shown when a currency is set but no threshold is money (a
          conversions tier): otherwise a bad leftover code would block Save
          with no field to fix it in. */}
      {(moneyThresholds || rule.currency != null) && (
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'auto 160px 1fr', gap: 8, alignItems: 'center' }}>
          <span style={hintStyle}>{moneyThresholds ? 'Thresholds in' : 'Currency'}</span>
          <Input
            aria-label="Threshold currency"
            placeholder="event’s currency"
            maxLength={3}
            value={rule.currency ?? ''}
            onChange={(e) => onChange({ currency: e.target.value.trim().toUpperCase() || undefined })}
          />
          <span style={{ fontSize: 12, color: theme.textDim }}>
            {moneyThresholds ? 'Blank = compare in each event’s own currency.' : 'Blank = the event’s own currency.'}
          </span>
        </div>
      )}
      <div style={{ fontSize: 12, color: theme.textDim }}>
        Base: {baseRate} {bands ? 'up to and including the first threshold' : 'until the first tier is reached'} — set in the
        rate field above.
      </div>
      {steps.map((step, i) => (
        <div
          key={i}
          className="op-grid-collapse"
          style={{
            display: 'grid',
            gridTemplateColumns: '110px minmax(80px, 1fr) 16px minmax(80px, 1fr) 40px auto',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span style={hintStyle}>{thresholdLabel}</span>
          <Input
            aria-label={`Step ${i + 1} threshold`}
            type="number"
            value={step.threshold}
            onChange={(e) => updateStep(i, { threshold: Number(e.target.value) })}
          />
          <span style={{ ...hintStyle, textAlign: 'center' }}>→</span>
          <Input
            aria-label={`Step ${i + 1} rate`}
            type="number"
            value={step.value}
            onChange={(e) => updateStep(i, { value: Number(e.target.value) })}
          />
          <span style={hintStyle}>{unit}</span>
          <button
            type="button"
            onClick={() => setSteps(steps.filter((_, j) => j !== i))}
            aria-label="Remove step"
            style={{ background: 'transparent', border: 'none', color: theme.danger, cursor: 'pointer', padding: 4, display: 'flex' }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={addStep}
          disabled={atMax}
          style={{
            background: 'transparent',
            border: `1px dashed ${theme.accentA88}`,
            borderRadius: 6,
            padding: '4px 10px',
            color: theme.accentText,
            fontSize: 12,
            cursor: atMax ? 'not-allowed' : 'pointer',
            opacity: atMax ? 0.5 : 1,
          }}
        >
          + Add step
        </button>
        {problem && <span style={{ fontSize: 12, color: theme.danger }}>{problem}</span>}
      </div>
      <span style={{ fontSize: 12, color: theme.textDim, lineHeight: 1.5 }}>
        {bands
          ? bands.mode === 'marginal'
            ? 'Like tax brackets: each event’s first slice pays the base rate, the next slice the next rate, and so on.'
            : 'A value exactly at a threshold stays in the slab below it: “above 50,000” starts at 50,000.01.'
          : 'Measured from the partner’s attributed history in this program before each event. Reaching a tier raises the rate for later events, not ones already accrued.'}
      </span>
    </div>
  );
}
