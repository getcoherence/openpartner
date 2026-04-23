import { Download, FileJson, FileSpreadsheet, Archive } from 'lucide-react';
import { getApiKey } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, Page, SectionHeading } from '../ui.js';

const TABLES = ['Partner', 'Campaign', 'Link', 'Click', 'Identity', 'Event', 'Attribution', 'Commission', 'Payout'];

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
              Every exportable table as one JSON file. Round-trippable into a self-hosted instance via <code>POST /import</code>.
            </div>
          </div>
          <Button icon={<Download size={14} />} onClick={() => download('/export.json')}>
            Download
          </Button>
        </div>
      </Card>

      <SectionHeading>Per-table</SectionHeading>
      <Card padded={false}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr>
              {['Table', 'JSON', 'CSV'].map((h) => (
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
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
