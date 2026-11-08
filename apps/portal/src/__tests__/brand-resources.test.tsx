// @vitest-environment jsdom
/**
 * Admin → Settings → Brand resources: deleting an asset asks on its row
 * (not with window.confirm), and a refusal shows there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, api } from '../api.js';
import { BrandResourcesSection } from '../pages/admin/Settings.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  api: vi.fn(),
}));

const LOGO = {
  id: 'ast_1',
  kind: 'image',
  label: 'Logo',
  description: null,
  url: 'https://cdn.example/logo.png',
  body: null,
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path, opts) => {
    if (path === '/brand-resources' && !(opts as { method?: string } | undefined)?.method) {
      return { brand: { displayName: 'Acme', logoUrl: null, brandColor: null, programTermsUrl: null, supportEmail: null }, assets: [LOGO] };
    }
    return {};
  });
});

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <BrandResourcesSection />
    </QueryClientProvider>,
  );
}

const deletes = () => vi.mocked(api).mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE');

describe('brand resources', () => {
  it('deletes an asset after asking on its row', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Logo' }));
    expect(screen.getByText('Delete for good?')).toBeTruthy();
    expect(deletes()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(deletes()).toEqual([['/brand-resources/ast_1', { method: 'DELETE' }]]));
  });

  it('shows a refusal on the row', async () => {
    vi.mocked(api).mockImplementation(async (path, opts) => {
      if ((opts as { method?: string } | undefined)?.method === 'DELETE') throw new ApiError(409, 'asset_in_use');
      return { brand: { displayName: 'Acme', logoUrl: null, brandColor: null, programTermsUrl: null, supportEmail: null }, assets: [LOGO] };
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Logo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect((await screen.findByRole('alert')).textContent).toBe('asset_in_use');
  });
});
