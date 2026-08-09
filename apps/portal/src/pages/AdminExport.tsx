import { useState } from 'react';
import { FileJson, FileSpreadsheet, Archive, Upload, Database } from 'lucide-react';
import { getApiKey } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, Page, SectionHeading } from '../ui.js';

// Mirrors EXPORT_TABLES in apps/api/src/export.ts, in the same FK-safe
// order. Keep the two in sync — a table missing here is a table nobody
// can download one-off, even though the full bundle has it.
const TABLES = [
  'Partner',
  'Program',
  'PartnerProgram',
  'PartnerCommission',
  'Coupon',
  'Link',
  'Click',
  'Identity',
  'Event',
  'Attribution',
  'Commission',
  'Payout',
  'PortalCustomDomain',
  'CommissionAdjustment',
];

export function AdminExport() {
  const key = getApiKey() ?? '';

  function download(path: string) {
    fetch(`/api${path}`, { headers: { Authorization: `Bearer ${key}` } })
      .then((res) => res.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = path.split('/').pop() ?? 'export';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
  }

  return (
    <Page title="Export / import" subtitle="Your data stays yours. Download everything, any time.">
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Archive size={22} color={theme.accent} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Full bundle</div>
            <div style={{ color: theme.textMuted, fontSize: 13 }}>
              Every exportable table in one file. JSON round-trips into a self-hosted instance via{' '}
              <code>POST /import</code>; the SQL dump restores directly with{' '}
              <code>psql -v tenant_id=&lt;destination tenant id&gt; -f openpartner-export.sql</code>.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button icon={<FileJson size={14} />} onClick={() => download('/export.json')}>
              JSON
            </Button>
            <Button variant="secondary" icon={<Database size={14} />} onClick={() => download('/export.sql')}>
              SQL
            </Button>
          </div>
        </div>
      </Card>

      <SectionHeading>Per-table</SectionHeading>
      <Card padded={false}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              {['Table', 'JSON', 'CSV', 'SQL'].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    padding: '12px 18px',
                    fontWeight: 500,
                    color: theme.textMuted,
                    fontSize: 12,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    borderBottom: `1px solid ${theme.border}`,
                    background: theme.surface2,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TABLES.map((t, i) => (
              <tr
                key={t}
                style={{
                  borderBottom: i < TABLES.length - 1 ? `1px solid ${theme.borderSubtle}` : 'none',
                }}
              >
                <td style={{ padding: '12px 18px' }}>
                  <code style={{ color: theme.text }}>{t}</code>
                </td>
                <td style={{ padding: '8px 18px' }}>
                  <Button size="sm" variant="ghost" icon={<FileJson size={14} />} onClick={() => download(`/export/${t}.json`)}>
                    JSON
                  </Button>
                </td>
                <td style={{ padding: '8px 18px' }}>
                  <Button size="sm" variant="ghost" icon={<FileSpreadsheet size={14} />} onClick={() => download(`/export/${t}.csv`)}>
                    CSV
                  </Button>
                </td>
                <td style={{ padding: '8px 18px' }}>
                  <Button size="sm" variant="ghost" icon={<Database size={14} />} onClick={() => download(`/export/${t}.sql`)}>
                    SQL
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <SectionHeading>Import partners from CSV</SectionHeading>
      <PartnersCsvImporter />
    </Page>
  );
}

interface ImportReportRow {
  row: number;
  email: string;
  status: 'created' | 'skipped_email_taken' | 'invalid';
  reason?: string;
  partnerId?: string;
}
interface ImportResult {
  dryRun: boolean;
  summary: { total: number; created: number; skipped: number; invalid: number };
  report: ImportReportRow[];
}

function PartnersCsvImporter() {
  const key = getApiKey() ?? '';
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/import/partners-csv?dryRun=${dryRun}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'text/csv' },
        body: csv,
      });
      const json = await res.json();
      if (!res.ok) {
        setError(typeof json.detail === 'string' ? json.detail : json.error ?? 'failed');
        setResult(null);
      } else {
        setResult(json as ImportResult);
      }
    } finally {
      setBusy(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(f);
  }

  return (
    <Card>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 12px' }}>
        Migrate from Impact, Rewardful, Refersion, etc. — adapt your export to the canonical
        format below and upload. Re-runnable: existing emails are skipped, not duplicated.
      </p>
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 13, color: theme.accent, cursor: 'pointer' }}>
          Canonical CSV format
        </summary>
        <pre style={{ background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 10, marginTop: 8, fontSize: 12, overflowX: 'auto' }}>
{`email,name,activatedAt,metadata
ada@example.com,Ada Lovelace,2024-01-15T00:00:00Z,"{""source"":""impact""}"
grace@example.com,Grace Hopper,,
`}
        </pre>
        <p style={{ fontSize: 12, color: theme.textMuted, margin: '8px 0 0' }}>
          <code>email</code> + <code>name</code> required. <code>activatedAt</code> defaults to
          now (existing partners come in already-activated). <code>metadata</code> is optional
          JSON merged into Partner.metadata. New partners get access to all current campaigns.
        </p>
      </details>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={onFile}
        style={{ marginBottom: 8, fontSize: 13, color: theme.text }}
      />
      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={6}
        placeholder="…or paste CSV here"
        style={{
          width: '100%',
          padding: '10px 12px',
          background: theme.surface2,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusSm,
          color: theme.text,
          fontFamily: theme.fontMono,
          fontSize: 12,
          resize: 'vertical',
          marginBottom: 12,
        }}
      />
      {error && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button onClick={() => run(true)} disabled={!csv.trim() || busy} variant="secondary">
          {busy ? 'Working…' : 'Preview (dry-run)'}
        </Button>
        <Button onClick={() => run(false)} disabled={!csv.trim() || busy} icon={<Upload size={14} />}>
          {busy ? 'Importing…' : 'Import'}
        </Button>
      </div>
      {result && (
        <div style={{ background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 12, fontSize: 13 }}>
          <div style={{ marginBottom: 8 }}>
            <strong>{result.dryRun ? 'Preview' : 'Import done'}</strong> · {result.summary.total} rows ·
            <span style={{ color: theme.success, marginLeft: 8 }}>{result.summary.created} created</span>
            <span style={{ color: theme.textMuted, marginLeft: 8 }}>{result.summary.skipped} skipped</span>
            {result.summary.invalid > 0 && <span style={{ color: theme.danger, marginLeft: 8 }}>{result.summary.invalid} invalid</span>}
          </div>
          {result.report.filter((r) => r.status !== 'created').slice(0, 50).map((r) => (
            <div key={r.row} style={{ fontSize: 12, color: r.status === 'invalid' ? theme.danger : theme.textMuted }}>
              row {r.row} ({r.email}): {r.status}{r.reason ? ` — ${r.reason}` : ''}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
