import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, Trash2 } from 'lucide-react';
import { api, ApiError, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { useBrand } from '../lib/useBrand.js';
import { countryOptions } from '../lib/CountryField.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Page, Select, Textarea, formatDate } from '../ui.js';

type Method = 'paypal' | 'bank' | 'upi' | 'other';

interface Address {
  line1: string;
  city: string;
  postCode?: string;
  state?: string;
  country: string;
}

/** GET /partners/:id/payout-profile `details`, by method. */
type Details =
  | { method: 'paypal'; email: string; country?: string }
  | {
      method: 'bank';
      accountHolderName: string;
      accountHolderType: 'person' | 'business';
      country: string;
      currency: string;
      iban?: string;
      bic?: string;
      accountNumber?: string;
      sortCode?: string;
      routingNumber?: string;
      accountType?: 'checking' | 'savings';
      ifsc?: string;
      email?: string;
      address?: Address;
    }
  | { method: 'upi'; vpa: string; name?: string }
  | { method: 'other'; instructions: string; country?: string };

interface ProfileResponse {
  profile: {
    method: Method;
    country: string | null;
    details: Details | null;
    summary: string | null;
    updatedAt: string;
    updatedBy: 'partner' | 'admin' | 'api';
  } | null;
  paidVia: 'manual' | 'stripe_connect';
}

const METHOD_LABEL: Record<Method, string> = {
  paypal: 'PayPal',
  bank: 'Bank account',
  upi: 'UPI (India)',
  other: 'Something else',
};

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'CHF', 'JPY', 'SGD', 'AED', 'BRL', 'MXN', 'PHP', 'NGN', 'PLN', 'SEK', 'NOK', 'DKK', 'NZD', 'ZAR'];

/** The form's state: every field as text, so switching method keeps what was typed. */
interface Form {
  method: Method;
  email: string;
  country: string;
  accountHolderName: string;
  accountHolderType: 'person' | 'business';
  currency: string;
  /** Bank: reached by IBAN, or by a local account number. */
  byIban: boolean;
  iban: string;
  bic: string;
  accountNumber: string;
  sortCode: string;
  routingNumber: string;
  accountType: '' | 'checking' | 'savings';
  ifsc: string;
  bankEmail: string;
  line1: string;
  city: string;
  postCode: string;
  state: string;
  addressCountry: string;
  vpa: string;
  upiName: string;
  instructions: string;
}

const EMPTY: Form = {
  method: 'paypal',
  email: '',
  country: '',
  accountHolderName: '',
  accountHolderType: 'person',
  currency: 'USD',
  byIban: true,
  iban: '',
  bic: '',
  accountNumber: '',
  sortCode: '',
  routingNumber: '',
  accountType: '',
  ifsc: '',
  bankEmail: '',
  line1: '',
  city: '',
  postCode: '',
  state: '',
  addressCountry: '',
  vpa: '',
  upiName: '',
  instructions: '',
};

function formFrom(d: Details | null): Form {
  if (!d) return EMPTY;
  switch (d.method) {
    case 'paypal':
      return { ...EMPTY, method: 'paypal', email: d.email, country: d.country ?? '' };
    case 'bank':
      return {
        ...EMPTY,
        method: 'bank',
        accountHolderName: d.accountHolderName,
        accountHolderType: d.accountHolderType,
        country: d.country,
        currency: d.currency,
        byIban: !!d.iban,
        iban: d.iban ?? '',
        bic: d.bic ?? '',
        accountNumber: d.accountNumber ?? '',
        sortCode: d.sortCode ?? '',
        routingNumber: d.routingNumber ?? '',
        accountType: d.accountType ?? '',
        ifsc: d.ifsc ?? '',
        bankEmail: d.email ?? '',
        line1: d.address?.line1 ?? '',
        city: d.address?.city ?? '',
        postCode: d.address?.postCode ?? '',
        state: d.address?.state ?? '',
        addressCountry: d.address?.country ?? '',
      };
    case 'upi':
      return { ...EMPTY, method: 'upi', vpa: d.vpa, upiName: d.name ?? '' };
    case 'other':
      return { ...EMPTY, method: 'other', instructions: d.instructions, country: d.country ?? '' };
  }
}

/** Which local fields a bank account needs, as the API checks them. */
function bankRoute(f: Form): 'iban' | 'gbp' | 'usd' | 'inr' | 'swift' {
  if (f.byIban) return 'iban';
  if (f.currency === 'GBP') return 'gbp';
  if (f.currency === 'USD') return 'usd';
  if (f.currency === 'INR') return 'inr';
  return 'swift';
}

/** Wise needs the holder's address for these account currencies, and for
 *  any SWIFT transfer (the API checks the same). */
const ADDRESS_CURRENCIES = ['USD', 'PHP', 'THB', 'TRY'];
/** ...and the state or province in an address in these countries. */
const STATE_COUNTRIES = ['US', 'CA', 'BR'];

function addressRequired(f: Form): boolean {
  return bankRoute(f) === 'swift' || ADDRESS_CURRENCIES.includes(f.currency);
}

function stateRequired(f: Form): boolean {
  return (addressRequired(f) || !!f.line1.trim()) && STATE_COUNTRIES.includes(f.addressCountry || f.country);
}

function bodyFrom(f: Form): Record<string, unknown> {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  switch (f.method) {
    case 'paypal':
      return { method: 'paypal', email: f.email, country: opt(f.country) };
    case 'upi':
      return { method: 'upi', vpa: f.vpa, name: opt(f.upiName) };
    case 'other':
      return { method: 'other', instructions: f.instructions, country: opt(f.country) };
    case 'bank': {
      const route = bankRoute(f);
      return {
        method: 'bank',
        accountHolderName: f.accountHolderName,
        accountHolderType: f.accountHolderType,
        country: f.country,
        currency: f.currency,
        iban: route === 'iban' ? opt(f.iban) : undefined,
        bic: opt(f.bic),
        accountNumber: route === 'iban' ? undefined : opt(f.accountNumber),
        sortCode: route === 'gbp' ? opt(f.sortCode) : undefined,
        routingNumber: route === 'usd' ? opt(f.routingNumber) : undefined,
        accountType: route === 'usd' && f.accountType ? f.accountType : undefined,
        ifsc: route === 'inr' ? opt(f.ifsc) : undefined,
        email: opt(f.bankEmail),
        address:
          addressRequired(f) || f.line1.trim()
            ? { line1: f.line1, city: f.city, postCode: opt(f.postCode), state: opt(f.state), country: f.addressCountry || f.country }
            : undefined,
      };
    }
  }
}

/** zod field errors from a 400 invalid_body, keyed by field. */
function fieldErrors(err: unknown): Record<string, string[]> {
  if (!(err instanceof ApiError) || err.status !== 400) return {};
  const detail = (err.detail as { detail?: { fieldErrors?: Record<string, string[]> } } | undefined)?.detail;
  return detail?.fieldErrors ?? {};
}

export function PayoutDetailsPage({ principal }: { principal: Principal }) {
  const qc = useQueryClient();
  const { programName } = useBrand();
  const queryPartnerId = new URLSearchParams(window.location.search).get('partnerId');
  const partnerId = principal.role === 'partner' ? principal.partnerId : queryPartnerId;
  const [form, setForm] = useState<Form>(EMPTY);
  const [saved, setSaved] = useState(false);
  const countries = useMemo(() => countryOptions(), []);

  const query = useQuery({
    queryKey: ['payout-profile', partnerId],
    queryFn: () => api<ProfileResponse>(`/partners/${partnerId}/payout-profile`),
    enabled: !!partnerId,
  });

  // Fill the form from the saved details once. A refetch (window focus)
  // must not wipe what the user is typing.
  const filled = useRef(false);
  useEffect(() => {
    if (query.data && !filled.current) {
      filled.current = true;
      setForm(formFrom(query.data.profile?.details ?? null));
    }
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => api<ProfileResponse>(`/partners/${partnerId}/payout-profile`, { method: 'PUT', body: bodyFrom(form) }),
    onSuccess: (data) => {
      qc.setQueryData(['payout-profile', partnerId], data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const remove = useMutation({
    mutationFn: () => api<void>(`/partners/${partnerId}/payout-profile`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payout-profile', partnerId] });
      setForm(EMPTY);
    },
  });

  if (!partnerId) {
    return (
      <Page title="Payout details">
        <EmptyState
          title="Pick a partner"
          hint="Open a partner from Admin → Partners to see where their payouts go."
          icon={<Landmark size={28} strokeWidth={1.25} />}
        />
      </Page>
    );
  }

  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errors = fieldErrors(save.error);
  const profile = query.data?.profile ?? null;
  const route = bankRoute(form);
  const isAdmin = principal.role === 'admin';

  return (
    <Page
      title="Payout details"
      subtitle={isAdmin ? 'Where this partner wants their payouts sent.' : `Where ${programName} sends your payouts.`}
    >
      <ErrorBanner error={query.error ?? (Object.keys(errors).length ? null : save.error) ?? remove.error} />

      {query.data?.paidVia === 'stripe_connect' && (
        <Card style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.5 }}>
            {isAdmin ? 'This partner is' : 'You are'} paid through Stripe Connect, so these details aren’t used right now. They
            are kept in case {programName} pays {isAdmin ? 'them' : 'you'} directly later.
          </div>
        </Card>
      )}

      {profile && (
        <Card style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Landmark size={18} style={{ color: theme.accentText }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>
                {profile.summary ?? 'Saved details can’t be read here. Please enter them again.'}
              </div>
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>
                Updated {formatDate(profile.updatedAt, { relative: true })}
                {profile.updatedBy !== 'partner' && ` by ${programName}`}
              </div>
            </div>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={13} />}
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Remove
            </Button>
          </div>
        </Card>
      )}

      {query.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Card>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620 }}
          >
            <Field label={isAdmin ? 'Payout method' : 'How should we pay you?'}>
              <Select value={form.method} onChange={(e) => set('method')(e.target.value as Method)}>
                {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>

            {form.method === 'paypal' && (
              <>
                <Field label="PayPal email" error={errors.email}>
                  <Input type="email" autoComplete="email" value={form.email} onChange={(e) => set('email')(e.target.value)} required />
                </Field>
                <Field label="Country of your PayPal account (optional)" error={errors.country}>
                  <CountrySelect value={form.country} onChange={set('country')} options={countries} optional />
                </Field>
              </>
            )}

            {form.method === 'bank' && (
              <>
                <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                  <Field label="Name on the account" error={errors.accountHolderName}>
                    <Input value={form.accountHolderName} onChange={(e) => set('accountHolderName')(e.target.value)} required />
                  </Field>
                  <Field label="Account holder">
                    <Select value={form.accountHolderType} onChange={(e) => set('accountHolderType')(e.target.value as Form['accountHolderType'])}>
                      <option value="person">A person</option>
                      <option value="business">A business</option>
                    </Select>
                  </Field>
                </div>
                <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                  <Field label="Bank’s country" error={errors.country}>
                    <CountrySelect value={form.country} onChange={set('country')} options={countries} />
                  </Field>
                  <Field label="Account currency" error={errors.currency}>
                    <Select value={form.currency} onChange={(e) => set('currency')(e.target.value)}>
                      {Array.from(new Set([form.currency, ...CURRENCIES])).map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Account identified by">
                  <Select value={form.byIban ? 'iban' : 'local'} onChange={(e) => set('byIban')(e.target.value === 'iban')}>
                    <option value="iban">IBAN</option>
                    <option value="local">Account number</option>
                  </Select>
                </Field>
                {form.byIban ? (
                  <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
                    <Field label="IBAN" error={errors.iban}>
                      <Input value={form.iban} onChange={(e) => set('iban')(e.target.value)} required spellCheck={false} />
                    </Field>
                    <Field label="BIC / SWIFT (optional)" error={errors.bic}>
                      <Input value={form.bic} onChange={(e) => set('bic')(e.target.value)} spellCheck={false} />
                    </Field>
                  </div>
                ) : (
                  <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <Field label="Account number" error={errors.accountNumber}>
                      <Input value={form.accountNumber} onChange={(e) => set('accountNumber')(e.target.value)} required spellCheck={false} />
                    </Field>
                    {route === 'gbp' && (
                      <Field label="Sort code" error={errors.sortCode}>
                        <Input value={form.sortCode} onChange={(e) => set('sortCode')(e.target.value)} required placeholder="12-34-56" />
                      </Field>
                    )}
                    {route === 'usd' && (
                      <>
                        <Field label="ABA routing number" error={errors.routingNumber}>
                          <Input value={form.routingNumber} onChange={(e) => set('routingNumber')(e.target.value)} required />
                        </Field>
                        <Field label="Account type" error={errors.accountType}>
                          <Select value={form.accountType} onChange={(e) => set('accountType')(e.target.value as Form['accountType'])} required>
                            <option value="" disabled>
                              Select
                            </option>
                            <option value="checking">Checking</option>
                            <option value="savings">Savings</option>
                          </Select>
                        </Field>
                      </>
                    )}
                    {route === 'inr' && (
                      <Field label="IFSC" error={errors.ifsc}>
                        <Input value={form.ifsc} onChange={(e) => set('ifsc')(e.target.value)} required placeholder="HDFC0001234" />
                      </Field>
                    )}
                    {route === 'swift' && (
                      <Field label="BIC / SWIFT" error={errors.bic}>
                        <Input value={form.bic} onChange={(e) => set('bic')(e.target.value)} required spellCheck={false} />
                      </Field>
                    )}
                  </div>
                )}
                <div style={{ fontSize: 12, color: theme.textDim }}>
                  Account holder’s address
                  {addressRequired(form)
                    ? ' (needed for this account)'
                    : ' (optional, but payouts sent in US or Australian dollars need it)'}
                </div>
                <Field label="Street address" error={errors.address}>
                  <Input value={form.line1} onChange={(e) => set('line1')(e.target.value)} required={addressRequired(form)} />
                </Field>
                <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <Field label="City">
                    <Input value={form.city} onChange={(e) => set('city')(e.target.value)} required={addressRequired(form) || !!form.line1.trim()} />
                  </Field>
                  <Field label="Postcode">
                    <Input value={form.postCode} onChange={(e) => set('postCode')(e.target.value)} />
                  </Field>
                  <Field label={stateRequired(form) ? 'State or province' : 'State or region'}>
                    <Input value={form.state} onChange={(e) => set('state')(e.target.value)} required={stateRequired(form)} />
                  </Field>
                </div>
                <Field label="Address country">
                  <CountrySelect value={form.addressCountry || form.country} onChange={set('addressCountry')} options={countries} />
                </Field>
                <Field label="Email for transfer notices (optional)" error={errors.email}>
                  <Input type="email" value={form.bankEmail} onChange={(e) => set('bankEmail')(e.target.value)} />
                </Field>
              </>
            )}

            {form.method === 'upi' && (
              <>
                <Field label="UPI ID" error={errors.vpa}>
                  <Input value={form.vpa} onChange={(e) => set('vpa')(e.target.value)} required placeholder="name@okaxis" spellCheck={false} />
                </Field>
                <Field label="Name on the UPI ID (optional)" error={errors.name}>
                  <Input value={form.upiName} onChange={(e) => set('upiName')(e.target.value)} />
                </Field>
              </>
            )}

            {form.method === 'other' && (
              <Field label="How would you like to be paid?" error={errors.instructions}>
                <Textarea value={form.instructions} onChange={(e) => set('instructions')(e.target.value)} rows={4} maxLength={1000} required />
              </Field>
            )}

            <div style={{ fontSize: 12, color: theme.textDim, lineHeight: 1.5 }}>
              Stored encrypted. {programName} sends payouts from its own PayPal or bank account
              {form.method === 'upi' || form.method === 'other' ? ', one at a time for this method' : ''}.{' '}
              {isAdmin ? 'The partner is emailed whenever these change.' : 'We email you whenever these change.'}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : profile ? 'Replace details' : 'Save details'}
              </Button>
              {saved && <span style={{ fontSize: 13, color: theme.success }}>Saved</span>}
            </div>
          </form>
        </Card>
      )}
    </Page>
  );
}

/** A labelled control: the label wraps it, so screen readers (and tests)
 *  find the control by its label. */
function Field({ label, error, children }: { label: string; error?: string[]; children: ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 12, color: theme.textMuted, marginBottom: 6, fontWeight: 500 }}>{label}</span>
      {children}
      {error && error.length > 0 && <span style={{ display: 'block', fontSize: 12, color: theme.danger, marginTop: 4 }}>{error.join(' ')}</span>}
    </label>
  );
}

function CountrySelect({
  value,
  onChange,
  options,
  optional,
}: {
  value: string;
  onChange: (code: string) => void;
  options: Array<{ code: string; name: string }>;
  optional?: boolean;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} required={!optional}>
      <option value="" disabled={!optional}>
        {optional ? 'Not given' : 'Select a country'}
      </option>
      {options.map((o) => (
        <option key={o.code} value={o.code}>
          {o.name}
        </option>
      ))}
    </Select>
  );
}
