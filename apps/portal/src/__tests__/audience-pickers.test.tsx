// @vitest-environment jsdom
/**
 * The Network profile editor's audience fields: countries are tags picked
 * from a searchable menu of names (no typed ISO codes), and age ranges are
 * a multi-select. A Network that predates audienceAgeRanges gets the one
 * youngest range in audienceAgeRange.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MyProfilePage } from '../pages/partner/MyProfile.js';

const PROFILE = {
  id: 'crt_1',
  email: 'pat@example.com',
  name: 'Pat',
  handle: 'pat',
  avatarUrl: null,
  bio: 'I make weekly videos about design tools for indie founders.',
  profile: null,
  categories: ['design'],
  audienceLocations: [] as string[],
  audienceAgeRanges: [] as string[],
  audienceAgeRange: null as string | null,
  audienceSize: null,
  portfolioLinks: [],
  pastBrands: [],
  createdAt: '2026-10-01T00:00:00.000Z',
};

let patches: unknown[] = [];

beforeEach(() => {
  patches = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'PATCH') patches.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
    const body = url.endsWith('/platforms') ? { platforms: [] } : method === 'GET' ? PROFILE : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(cleanup);

function renderEditor(profile: Record<string, unknown> = PROFILE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['network-my-profile'], profile);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <MyProfilePage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

async function save(page: ReturnType<typeof renderEditor>) {
  fireEvent.click(page.getByRole('button', { name: 'Save profile' }));
  await waitFor(() => expect(patches).toHaveLength(1));
  return patches[0] as Record<string, unknown>;
}

describe('audience locations', () => {
  it('picks countries by name from a menu and saves their codes in the order picked', async () => {
    const page = renderEditor();
    const box = page.getByRole('combobox', { name: 'Audience locations' });
    expect(page.queryByRole('listbox')).toBeNull();

    fireEvent.change(box, { target: { value: 'united k' } });
    const list = page.getByRole('listbox', { name: 'Audience locations' });
    fireEvent.click(within(list).getByRole('option', { name: 'United Kingdom' }));
    expect(page.getByRole('button', { name: 'Remove United Kingdom' })).toBeTruthy();
    expect((box as HTMLInputElement).value).toBe('');

    // A code typed whole comes first; Enter picks it.
    fireEvent.change(box, { target: { value: 'us' } });
    expect(within(page.getByRole('listbox')).getAllByRole('option')[0]!.textContent).toBe('United States');
    fireEvent.keyDown(box, { key: 'Enter' });
    // A picked country leaves the menu.
    fireEvent.change(box, { target: { value: 'united' } });
    const names = within(page.getByRole('listbox')).getAllByRole('option').map((o) => o.textContent);
    expect(names).toContain('United Arab Emirates');
    expect(names).not.toContain('United Kingdom');
    expect(names).not.toContain('United States');

    expect((await save(page)).audienceLocations).toEqual(['GB', 'US']);
  });

  it('shows saved codes as names, removes with × or Backspace, and stops at five', async () => {
    const page = renderEditor({ ...PROFILE, audienceLocations: ['US', 'GB', 'CA', 'AU'] });
    for (const name of ['United States', 'United Kingdom', 'Canada', 'Australia']) {
      expect(page.getByRole('button', { name: `Remove ${name}` })).toBeTruthy();
    }
    const box = page.getByRole('combobox', { name: 'Audience locations' }) as HTMLInputElement;

    fireEvent.change(box, { target: { value: 'ireland' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // Five: the search box goes read-only and the menu stays shut.
    expect(box.readOnly).toBe(true);
    fireEvent.click(box);
    expect(page.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(box, { key: 'Backspace' });
    expect(page.queryByRole('button', { name: 'Remove Ireland' })).toBeNull();
    expect(box.readOnly).toBe(false);
    fireEvent.click(page.getByRole('button', { name: 'Remove United Kingdom' }));

    expect((await save(page)).audienceLocations).toEqual(['US', 'CA', 'AU']);
  });

  it('Escape closes the menu and arrows move through it', () => {
    const page = renderEditor();
    const box = page.getByRole('combobox', { name: 'Audience locations' });
    fireEvent.change(box, { target: { value: 'united' } });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    const second = within(page.getByRole('listbox')).getAllByRole('option')[1]!;
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-activedescendant')).toBe(second.id);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(page.queryByRole('listbox')).toBeNull();
  });
});

describe('audience age ranges', () => {
  it('picks several and saves them youngest first', async () => {
    const page = renderEditor();
    fireEvent.click(page.getByRole('button', { name: '25-34' }));
    fireEvent.click(page.getByRole('button', { name: '18-24' }));
    fireEvent.click(page.getByRole('button', { name: '45-54' }));
    fireEvent.click(page.getByRole('button', { name: '45-54' }));
    expect(page.getByRole('button', { name: '18-24' }).getAttribute('aria-pressed')).toBe('true');
    expect(page.getByRole('button', { name: '45-54' }).getAttribute('aria-pressed')).toBe('false');

    const body = await save(page);
    expect(body.audienceAgeRanges).toEqual(['18-24', '25-34']);
    expect(body).not.toHaveProperty('audienceAgeRange');
  });

  it('a Network without audienceAgeRanges shows its one range and gets the youngest back', async () => {
    const { audienceAgeRanges: _, ...older } = PROFILE;
    const page = renderEditor({ ...older, audienceAgeRange: '35-44' });
    expect(page.getByRole('button', { name: '35-44' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(page.getByRole('button', { name: '25-34' }));

    const body = await save(page);
    expect(body.audienceAgeRange).toBe('25-34');
    expect(body).not.toHaveProperty('audienceAgeRanges');
  });
});
