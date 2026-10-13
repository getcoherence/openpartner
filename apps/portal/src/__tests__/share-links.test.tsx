// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LinksPage } from '../pages/Links.js';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });
function show(routerUrl: string | null, slug: string | null = null) {
  if (slug) window.history.replaceState(null, '', `/t/${slug}/links`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['program-settings'], { routerUrl, whiteLabel: false });
  client.setQueryData(['public-branding', slug], { tenantSlug: slug ?? 'default', whiteLabel: false });
  client.setQueryData(['links', 'p1'], { links: [{ id: 'l1', linkKey: 'rene', programId: 'pr1', destinationUrl: null, createdAt: new Date().toISOString() }] });
  client.setQueryData(['me-campaigns'], { programs: [{ id: 'pr1', name: 'Brand', destinationUrl: 'https://brand.example', deepLinkAllowedDomains: null }] });
  return render(<MemoryRouter><QueryClientProvider client={client}><LinksPage principal={{ role: 'partner', partnerId: 'p1' }} /></QueryClientProvider></MemoryRouter>);
}
describe('complete share URLs', () => {
  it('shows, copies and previews the configured self-host router URL', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const page = show('https://links.example.com');
    fireEvent.click(page.getByTitle('Copy share link'));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('https://links.example.com/r/rene'));
    expect(page.getByText('https://links.example.com/r/rene')).toBeTruthy();
    fireEvent.click(page.getByText('New link'));
    expect(page.getByText('https://links.example.com/r/your-key')).toBeTruthy();
  });
  it('explains missing self-host router configuration instead of inventing an origin', () => {
    const page = show(null);
    expect(page.getByText(/Ask your brand admin to set the public router URL/)).toBeTruthy();
    expect(page.queryByTitle('Copy share link')).toBeNull();
  });
  it('preserves path-based tenant routing', () => {
    const page = show('https://unused.example.com', 'acme');
    expect(page.getByText(`${window.location.origin}/r/acme/rene`)).toBeTruthy();
  });
});
