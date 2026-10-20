/**
 * /creator/storefront/setup — first-run setup for the storefront: how it
 * works, an optional import from Passionfroot, channels (add, verify,
 * pitch), packages from templates, past collaborations, then a preview and
 * turning bookings on. Each step saves as it goes, so leaving halfway keeps
 * what's done; the editor at /creator/storefront changes anything later.
 * The step lives in ?step=<key> so a reload stays put and links can point
 * at one (?step=import).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Inbox, ListChecks, Wallet } from 'lucide-react';
import { Button, Card, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';
import { useMediaQuery } from '../../lib/useMediaQuery.js';
import { PlatformsCard, type NetworkProfile } from '../../lib/NetworkProfileEditor.js';
import { creatorApi } from './creator-api.js';
import { creatorProfileAdapter } from './CreatorMyProfile.js';
import {
  ChannelPitchForm,
  PLATFORMS_KEY,
  PROFILE_KEY,
  STOREFRONT_KEY,
  type ChannelDraft,
  type Storefront,
} from './CreatorStorefront.js';
import { ChannelHeader } from './StorefrontSection.js';
import { PreviewColumn, StorefrontPreview } from './StorefrontPreview.js';
import { PassionfrootImport } from './StorefrontImport.js';
import {
  PACKAGE_CURRENCIES,
  parsePackagePrice,
  PLATFORM_LABELS,
  templatesFor,
  type PackageTemplate,
  type StorefrontChannel,
  type StorefrontPackage,
} from './storefront-shared.js';

const STEPS = [
  { key: 'intro', label: 'How it works' },
  { key: 'import', label: 'Import' },
  { key: 'channels', label: 'Channels' },
  { key: 'packages', label: 'Packages' },
  { key: 'past', label: 'Past work' },
  { key: 'preview', label: 'Preview' },
] as const;
type StepKey = (typeof STEPS)[number]['key'];

/** A template the creator ticked in the packages step, with their price. */
interface TemplatePick {
  platform: string | null;
  template: PackageTemplate;
  price: string;
}

const pickKey = (platform: string | null, title: string) => `${platform ?? 'any'}|${title.toLowerCase()}`;

export function CreatorStorefrontSetupPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const step: StepKey = STEPS.find((s) => s.key === params.get('step'))?.key ?? 'intro';
  const go = (key: StepKey) => {
    setParams({ step: key });
    window.scrollTo({ top: 0 });
  };

  const sf = useQuery({
    queryKey: STOREFRONT_KEY,
    queryFn: () => creatorApi<Storefront>('/creators/me/storefront'),
    retry: false,
  });
  const profile = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => creatorApi<NetworkProfile>('/creators/me'),
    retry: false,
  });
  // The same query the Platforms card fills, so channels added there show here.
  const platforms = useQuery({
    queryKey: PLATFORMS_KEY,
    queryFn: () => creatorProfileAdapter.listPlatforms(),
    retry: false,
  });
  const channels = (platforms.data?.platforms ?? []) as StorefrontChannel[];

  // Unsaved edits the side preview reflects.
  const [channelDrafts, setChannelDrafts] = useState<Record<string, ChannelDraft>>({});
  const [picks, setPicks] = useState<Record<string, TemplatePick>>({});
  const [currency, setCurrency] = useState<string | null>(null);
  const [brandsRaw, setBrandsRaw] = useState<string | null>(null);

  const data = sf.data;
  const packageCurrency = currency ?? data?.packages[0]?.currency ?? 'USD';
  const pastBrands = brandsRaw == null ? undefined : splitBrands(brandsRaw);

  const previewChannels = channels.map((c) => {
    const d = channelDrafts[c.platform];
    return d ? { ...c, description: d.description.trim() || null, cadence: d.cadence.trim() || null } : c;
  });
  const previewPackages: StorefrontPackage[] = [
    ...(data?.packages ?? []).filter((p) => p.published),
    ...Object.entries(picks).map(([key, p]) => ({
      id: `pick:${key}`,
      title: p.template.title,
      description: p.template.description,
      platform: p.platform,
      priceAmount: parsePackagePrice(p.price).amount,
      priceIsFrom: false,
      currency: packageCurrency,
    })),
  ];

  const wide = useMediaQuery('(min-width: 1100px)');
  // Beside the steps that edit what brands see. The import step lists what
  // it found instead; the preview step is the preview.
  const sidePreview = wide && (step === 'channels' || step === 'packages' || step === 'past') && data;

  let body: ReactNode = null;
  if (sf.isLoading) body = <Card>Loading…</Card>;
  else if (data) {
    if (step === 'intro') body = <HowItWorks onNext={() => go('import')} />;
    else if (step === 'import') body = <ImportStep onBack={() => go('intro')} onNext={() => go('channels')} />;
    else if (step === 'channels')
      body = (
        <ChannelsStep
          channels={channels}
          loading={platforms.isLoading}
          onDraft={(platform, d) => setChannelDrafts((prev) => ({ ...prev, [platform]: d }))}
          onBack={() => go('import')}
          onNext={() => go('packages')}
        />
      );
    else if (step === 'packages')
      body = (
        <PackagesStep
          storefront={data}
          channels={channels}
          picks={picks}
          setPicks={setPicks}
          currency={packageCurrency}
          setCurrency={setCurrency}
          onBack={() => go('channels')}
          onNext={() => go('past')}
        />
      );
    else if (step === 'past')
      body = (
        <PastWorkStep
          profile={profile.data}
          raw={brandsRaw ?? (profile.data?.pastBrands ?? []).join(', ')}
          setRaw={setBrandsRaw}
          onBack={() => go('packages')}
          onNext={() => go('preview')}
        />
      );
    else
      body = (
        <PreviewStep
          storefront={data}
          profile={profile.data}
          channels={channels}
          onBack={() => go('past')}
          onFinished={() => {
            navigate('/creator/storefront');
            window.scrollTo({ top: 0 });
          }}
        />
      );
  }

  return (
    <Page
      title="Set up your storefront"
      actions={
        <Link to="/creator/storefront" style={{ textDecoration: 'none' }}>
          <Button variant="ghost">Skip to the editor</Button>
        </Link>
      }
    >
      <ErrorBanner error={sf.error ?? profile.error} />
      <StepBar step={step} onGo={go} />
      <div
        style={
          sidePreview
            ? { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(340px, 420px)', gap: 24, alignItems: 'start' }
            : { maxWidth: 760 }
        }
      >
        <div style={{ minWidth: 0 }}>{body}</div>
        {sidePreview && (
          <PreviewColumn>
            <StorefrontPreview
              profile={profile.data}
              packages={previewPackages}
              channels={previewChannels}
              bookingsOpen={data.bookingsOpen}
              pastBrands={pastBrands}
            />
          </PreviewColumn>
        )}
      </div>
    </Page>
  );
}

function StepBar({ step, onGo }: { step: StepKey; onGo: (key: StepKey) => void }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol style={{ listStyle: 'none', padding: 0, margin: '0 0 20px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {STEPS.map(({ key, label }, i) => {
        const n = i + 1;
        const current = i === at;
        const done = i < at;
        return (
          <li key={key}>
            <button
              type="button"
              onClick={() => onGo(key)}
              aria-current={current ? 'step' : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                borderRadius: 999,
                fontSize: 13,
                cursor: 'pointer',
                border: `1px solid ${current ? theme.accent : theme.border}`,
                background: current ? theme.accentSoft : 'transparent',
                color: current ? theme.text : done ? theme.textMuted : theme.textDim,
              }}
            >
              {done ? (
                <CheckCircle2 size={14} style={{ color: theme.success }} />
              ) : (
                <span style={{ fontSize: 12, fontWeight: 600 }}>{n}</span>
              )}
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepNav({ onBack, next }: { onBack?: () => void; next: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
      {onBack && (
        <Button variant="secondary" onClick={onBack}>Back</Button>
      )}
      <div style={{ flex: 1 }} />
      {next}
    </div>
  );
}

// ---------- 1. How it works ----------

function HowItWorks({ onNext }: { onNext: () => void }) {
  const items = [
    {
      icon: <ListChecks size={20} />,
      title: 'List what you offer',
      text: 'Pick formats for each channel, like a dedicated video or a newsletter sponsor slot, and set your own prices.',
    },
    {
      icon: <Inbox size={20} />,
      title: 'Brands send requests',
      text: 'Your packages show on your public page. Brands confirm their email before a request reaches you, and brands on OpenPartner can book you directly.',
    },
    {
      icon: <Wallet size={20} />,
      title: 'Deliver and get paid',
      text: 'You accept the work you want. Bookings made on OpenPartner are tracked like any partnership, and the brand pays you once it approves your post.',
    },
  ];
  return (
    <Card>
      <div style={{ fontSize: 17, fontWeight: 600 }}>Sell sponsorships from your own storefront</div>
      <div style={{ fontSize: 13.5, color: theme.textMuted, marginTop: 4 }}>About five minutes. Everything saves as you go.</div>
      <div style={{ display: 'grid', gap: 16, marginTop: 20 }}>
        {items.map((it) => (
          <div key={it.title} style={{ display: 'flex', gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: theme.radiusSm,
                background: theme.surface2,
                color: theme.accentText,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {it.icon}
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{it.title}</div>
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2, lineHeight: 1.5 }}>{it.text}</div>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: 20,
          padding: '12px 14px',
          borderRadius: theme.radiusSm,
          background: theme.successSoft,
          color: theme.text,
          fontSize: 13.5,
          display: 'flex',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <CheckCircle2 size={18} style={{ color: theme.success, flexShrink: 0 }} />
        <span>
          <strong>You keep 100%.</strong> OpenPartner doesn&rsquo;t take a cut of what brands pay you.
        </span>
      </div>
      <StepNav next={<Button onClick={onNext}>Get started</Button>} />
    </Card>
  );
}

// ---------- 2. Import (optional) ----------

function ImportStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  // Once something's imported, the summary's Continue is the way on.
  const [imported, setImported] = useState(false);
  return (
    <>
      <PassionfrootImport onDone={onNext} onImported={() => setImported(true)} />
      {!imported && (
        <StepNav
          onBack={onBack}
          next={
            <Button variant="secondary" onClick={onNext}>
              Skip, I’m starting fresh
            </Button>
          }
        />
      )}
    </>
  );
}

// ---------- 3. Channels ----------

function ChannelsStep({
  channels,
  loading,
  onDraft,
  onBack,
  onNext,
}: {
  channels: StorefrontChannel[];
  loading: boolean;
  onDraft: (platform: string, d: ChannelDraft) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <PlatformsCard adapter={creatorProfileAdapter} />
      <div style={{ height: 14 }} />
      <Card>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Pitch each channel</div>
        <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4, marginBottom: 14 }}>
          A line on what each channel covers and how often you publish. Brands read this above your packages.
        </div>
        {loading ? (
          <div style={{ fontSize: 13, color: theme.textMuted }}>Loading…</div>
        ) : channels.length === 0 ? (
          <div style={{ fontSize: 13, color: theme.textMuted }}>Add a channel above first.</div>
        ) : (
          <div style={{ display: 'grid', gap: 18 }}>
            {channels.map((c) => (
              <div key={c.id} style={{ display: 'grid', gap: 10 }}>
                <ChannelHeader channel={{ ...c, description: null }} />
                <ChannelPitchForm channel={c} onDraft={(d) => onDraft(c.platform, d)} />
              </div>
            ))}
          </div>
        )}
      </Card>
      <StepNav onBack={onBack} next={<Button onClick={onNext}>Next: packages</Button>} />
    </>
  );
}

// ---------- 4. Packages ----------

function PackagesStep({
  storefront,
  channels,
  picks,
  setPicks,
  currency,
  setCurrency,
  onBack,
  onNext,
}: {
  storefront: Storefront;
  channels: StorefrontChannel[];
  picks: Record<string, TemplatePick>;
  setPicks: (fn: (prev: Record<string, TemplatePick>) => Record<string, TemplatePick>) => void;
  currency: string;
  setCurrency: (c: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const qc = useQueryClient();
  const existing = useMemo(
    () => new Set(storefront.packages.map((p) => pickKey(p.platform, p.title))),
    [storefront.packages],
  );
  const sections = useMemo(() => {
    const kinds: Array<string | null> = channels.map((c) => c.platform);
    // Platforms with packages but no channel row still get their section.
    for (const p of storefront.packages) if (p.platform && !kinds.includes(p.platform)) kinds.push(p.platform);
    return [...kinds, null];
  }, [channels, storefront.packages]);

  const picked = Object.entries(picks);
  const room = storefront.maxPackages - storefront.packages.length;
  const badPrice = picked.some(([, p]) => !parsePackagePrice(p.price).valid);

  const create = useMutation({
    mutationFn: async () => {
      // One at a time, so they land in the order they're listed.
      for (const [key, p] of picked) {
        await creatorApi('/creators/me/packages', {
          method: 'POST',
          body: {
            title: p.template.title,
            description: p.template.description,
            platform: p.platform,
            priceAmount: parsePackagePrice(p.price).amount,
            priceIsFrom: false,
            currency,
            published: true,
          },
        });
        setPicks((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: STOREFRONT_KEY }),
    onSuccess: onNext,
  });

  function toggle(platform: string | null, t: PackageTemplate) {
    const key = pickKey(platform, t.title);
    setPicks((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = { platform, template: t, price: '' };
      return next;
    });
  }
  function setPrice(key: string, price: string) {
    setPicks((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key]!, price } } : prev));
  }

  const currencies = PACKAGE_CURRENCIES.includes(currency as (typeof PACKAGE_CURRENCIES)[number])
    ? PACKAGE_CURRENCIES
    : [currency, ...PACKAGE_CURRENCIES];

  return (
    <>
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Pick your packages</div>
            <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>
              Tick the formats you sell and set your price. Leave a price blank to show &ldquo;Price on request&rdquo;. You can
              reword any of them in the editor later.
            </div>
          </div>
          <div style={{ width: 110 }}>
            <Label>Currency</Label>
            <Select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
        </div>
      </Card>
      {sections.map((platform) => {
        const channel = channels.find((c) => c.platform === platform) ?? null;
        return (
          <div key={platform ?? 'any'} style={{ marginTop: 14 }}>
            <Card>
              {channel ? (
                <ChannelHeader channel={{ ...channel, description: null }} />
              ) : (
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {platform ? (PLATFORM_LABELS[platform] ?? platform) : 'Across channels'}
                </div>
              )}
              <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                {templatesFor(platform).map((t) => {
                  const key = pickKey(platform, t.title);
                  const added = existing.has(key);
                  const pick = picks[key];
                  const full = !pick && picked.length >= room;
                  return (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'flex-start',
                        padding: '10px 12px',
                        borderRadius: theme.radiusSm,
                        border: `1px solid ${pick ? theme.accent : theme.borderSubtle}`,
                        background: pick ? theme.accentSoft : 'transparent',
                        opacity: added || full ? 0.6 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${t.title}${platform ? ` on ${PLATFORM_LABELS[platform] ?? platform}` : ''}`}
                        checked={added || !!pick}
                        disabled={added || full}
                        onChange={() => toggle(platform, t)}
                        style={{ marginTop: 3 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 500 }}>
                          {t.title}
                          {added && <span style={{ fontSize: 12, color: theme.success, marginLeft: 8, fontWeight: 400 }}>Added</span>}
                        </div>
                        <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 2 }}>{t.description}</div>
                      </div>
                      {pick && (
                        <div style={{ width: 110, flexShrink: 0 }}>
                          <Input
                            aria-label={`${t.title} price`}
                            value={pick.price}
                            inputMode="numeric"
                            placeholder="Price"
                            onChange={(e) => setPrice(key, e.target.value)}
                            style={{ fontSize: 13 }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        );
      })}
      {room <= 0 && (
        <p style={{ fontSize: 13, color: theme.textMuted }}>
          You&rsquo;re at the maximum of {storefront.maxPackages} packages.
        </p>
      )}
      {badPrice && <p style={{ fontSize: 13, color: theme.danger }}>Prices are whole numbers up to 10,000,000, like 500.</p>}
      <ErrorBanner error={create.error} />
      <StepNav
        onBack={onBack}
        next={
          picked.length > 0 ? (
            <Button onClick={() => create.mutate()} disabled={badPrice || create.isPending}>
              {create.isPending ? 'Adding…' : `Add ${picked.length} package${picked.length === 1 ? '' : 's'} and continue`}
            </Button>
          ) : (
            <Button onClick={onNext}>{storefront.packages.length > 0 ? 'Next: past work' : 'Skip for now'}</Button>
          )
        }
      />
    </>
  );
}

// ---------- 5. Past work ----------

function splitBrands(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function PastWorkStep({
  profile,
  raw,
  setRaw,
  onBack,
  onNext,
}: {
  profile: NetworkProfile | undefined;
  raw: string;
  setRaw: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const qc = useQueryClient();
  const brands = splitBrands(raw);
  const dirty = brands.join('\n') !== (profile?.pastBrands ?? []).join('\n');
  const save = useMutation({
    mutationFn: () => creatorApi('/creators/me', { method: 'PATCH', body: { pastBrands: brands } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: PROFILE_KEY });
      onNext();
    },
  });
  return (
    <>
      <Card>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Brands you&rsquo;ve worked with</div>
        <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4, marginBottom: 14 }}>
          Past sponsors show on your public page. Brands look for these when deciding who to book.
        </div>
        <ErrorBanner error={save.error} />
        <Label>Past collaborations</Label>
        <Input
          aria-label="Past collaborations"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Notion, Linear, MongoDB"
        />
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>Separate names with commas. Up to 20.</div>
        {brands.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
            {brands.map((b) => (
              <span key={b} style={{ background: theme.surface2, fontSize: 12.5, padding: '3px 10px', borderRadius: 12, border: `1px solid ${theme.borderSubtle}` }}>
                {b}
              </span>
            ))}
          </div>
        )}
      </Card>
      <StepNav
        onBack={onBack}
        next={
          dirty ? (
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save and continue'}
            </Button>
          ) : (
            <Button onClick={onNext}>Next: preview</Button>
          )
        }
      />
    </>
  );
}

// ---------- 6. Preview ----------

function PreviewStep({
  storefront,
  profile,
  channels,
  onBack,
  onFinished,
}: {
  storefront: Storefront;
  profile: NetworkProfile | undefined;
  channels: StorefrontChannel[];
  onBack: () => void;
  onFinished: () => void;
}) {
  const qc = useQueryClient();
  const open = useMutation({
    mutationFn: () => creatorApi('/creators/me/storefront', { method: 'PUT', body: { bookingsOpen: true } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: STOREFRONT_KEY });
      onFinished();
    },
  });
  return (
    <div style={{ maxWidth: 560 }}>
      <StorefrontPreview
        profile={profile}
        packages={storefront.packages.filter((p) => p.published)}
        channels={channels}
        bookingsOpen
      />
      {!storefront.profileComplete && (
        <div style={{ marginTop: 14, fontSize: 13, color: theme.warn, background: theme.warnSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
          Your profile isn&rsquo;t complete yet, so your public page stays hidden until it is. You can still turn bookings on now.{' '}
          <Link to="/creator/profile" style={{ color: theme.warn, fontWeight: 600 }}>Finish your profile</Link>
        </div>
      )}
      <ErrorBanner error={open.error} />
      <StepNav
        onBack={onBack}
        next={
          storefront.bookingsOpen ? (
            <Button onClick={onFinished}>Go to your storefront</Button>
          ) : (
            <Button onClick={() => open.mutate()} disabled={open.isPending}>
              {open.isPending ? 'Turning on…' : 'Turn on bookings'}
            </Button>
          )
        }
      />
      {!storefront.bookingsOpen && (
        <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 10, textAlign: 'right' }}>
          Not ready? <Link to="/creator/storefront" style={{ color: theme.accentText }}>Keep editing first</Link>
        </div>
      )}
    </div>
  );
}
