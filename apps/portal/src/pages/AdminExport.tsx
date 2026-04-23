import { getApiKey } from '../api.js';
import { Card, Page } from '../ui.js';

const TABLES = ['Partner', 'Campaign', 'Link', 'Click', 'Identity', 'Event', 'Attribution', 'Commission', 'Payout'];

export function AdminExport() {
  const key = getApiKey() ?? '';

  function download(path: string) {
    // Browsers don't support Authorization headers on direct navigation, so
    // we fetch, convert to a blob, and trigger the download from a temp URL.
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
    <Page title="Export / import">
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Full bundle</div>
        <div style={{ color: '#666', marginBottom: 12, fontSize: 13 }}>
          One JSON file with every exportable table. Round-trippable into a self-hosted instance via <code>POST /import</code>.
        </div>
        <button
          onClick={() => download('/export.json')}
          style={{ background: '#111', color: 'white', border: 'none', padding: '8px 12px', borderRadius: 4, cursor: 'pointer' }}
        >
          Download openpartner-export.json
        </button>
      </Card>
      <Card>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Per-table</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>Table</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>JSON</th>
              <th style={{ textAlign: 'left', padding: '8px 12px' }}>CSV</th>
            </tr>
          </thead>
          <tbody>
            {TABLES.map((t) => (
              <tr key={t} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '8px 12px' }}>
                  <code>{t}</code>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <button
                    onClick={() => download(`/export/${t}.json`)}
                    style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 13 }}
                  >
                    Download
                  </button>
                </td>
                <td style={{ padding: '8px 12px' }}>
                  <button
                    onClick={() => download(`/export/${t}.csv`)}
                    style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 13 }}
                  >
                    Download
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </Page>
  );
}
