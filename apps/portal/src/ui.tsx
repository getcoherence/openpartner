import type { CSSProperties, ReactNode } from 'react';

export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
        <div>{actions}</div>
      </header>
      {children}
    </div>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ background: 'white', border: '1px solid #e5e5e5', borderRadius: 8, padding: 16, ...style }}>{children}</div>;
}

export function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <div style={{ fontSize: 13, color: '#666' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, marginTop: 4 }}>{value}</div>
    </Card>
  );
}

export function Table({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ background: '#fafafa' }}>
            {columns.map((c) => (
              <th key={c} style={{ textAlign: 'left', padding: '10px 14px', fontWeight: 600, borderBottom: '1px solid #e5e5e5' }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} style={{ padding: 20, color: '#888', textAlign: 'center' }}>
                No rows.
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                {row.map((cell, j) => (
                  <td key={j} style={{ padding: '10px 14px' }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Card>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
  type,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
  style?: CSSProperties;
}) {
  const bg = variant === 'danger' ? '#c0392b' : variant === 'secondary' ? '#fff' : '#111';
  const color = variant === 'secondary' ? '#111' : '#fff';
  const border = variant === 'secondary' ? '1px solid #ccc' : 'none';
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled}
      style={{
        background: bg,
        color,
        border,
        borderRadius: 4,
        padding: '8px 12px',
        fontSize: 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        padding: '8px 10px',
        fontSize: 14,
        border: '1px solid #ddd',
        borderRadius: 4,
        width: '100%',
        ...props.style,
      }}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label style={{ display: 'block', fontSize: 12, color: '#666', marginBottom: 4 }}>{children}</label>;
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div style={{ background: '#fde8e8', color: '#9b1c1c', padding: '10px 14px', borderRadius: 4, marginBottom: 16, fontSize: 13 }}>
      {msg}
    </div>
  );
}

export function money(amount: number | string | null, currency: string = 'USD'): string {
  const n = typeof amount === 'number' ? amount : amount == null ? 0 : Number(amount);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

export function formatDate(d: string | Date | null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}
