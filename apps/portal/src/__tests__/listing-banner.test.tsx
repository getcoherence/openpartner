// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ListingBanner, ListingVideo } from '../pages/creator/ListingBanner.js';

/**
 * Creator-side rendering of a listing's cover + video (Discover cards and
 * the program page). The banner falls back to a wash of the brand logo; the
 * player only ever embeds a URL our own parser builds.
 */
describe('ListingBanner', () => {
  afterEach(cleanup);

  it('shows the cover when the brand set one', () => {
    const { container } = render(
      <ListingBanner coverUrl="https://cdn.example.test/cover.png" logoUrl="https://cdn.example.test/logo.png" />,
    );
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute('src')).toBe('https://cdn.example.test/cover.png');
  });

  it('falls back to a blurred wash of the logo', () => {
    const { container } = render(<ListingBanner coverUrl={null} logoUrl="https://cdn.example.test/logo.png" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://cdn.example.test/logo.png');
    expect(img.style.filter).toContain('blur');
  });

  it('is just the tinted base with neither', () => {
    const { container } = render(<ListingBanner coverUrl={null} logoUrl={null} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild).not.toBeNull();
  });

  it("puts YouTube's icon, linking to the channel, on a cover copied from YouTube", () => {
    const source = { platform: 'youtube' as const, url: 'https://www.youtube.com/channel/UC_ada' };
    const page = render(<ListingBanner coverUrl="https://cdn.example.test/creators/c/youtube/b.jpg" logoUrl={null} coverSource={source} />);
    const link = page.getByRole('link', { name: 'YouTube' });
    expect(link.getAttribute('href')).toBe(source.url);
    expect(link.getAttribute('target')).toBe('_blank');
    cleanup();
    // No cover shown (the wash), or an uploaded one: no icon.
    expect(render(<ListingBanner coverUrl={null} logoUrl="https://cdn.example.test/logo.png" coverSource={source} />).queryByRole('link')).toBeNull();
    cleanup();
    expect(render(<ListingBanner coverUrl="https://cdn.example.test/cover.png" logoUrl={null} />).queryByRole('link')).toBeNull();
  });
});

describe('ListingVideo', () => {
  afterEach(cleanup);
  const yt = {
    provider: 'youtube' as const,
    id: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
  };

  it('embeds a player URL our parser builds', () => {
    const { container } = render(<ListingVideo video={yt} title="Brand video" />);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(yt.embedUrl);
  });

  it('renders nothing for a missing video or any other embed URL', () => {
    expect(render(<ListingVideo video={null} title="x" />).container.innerHTML).toBe('');
    cleanup();
    const forged = { ...yt, embedUrl: 'https://evil.example/embed/dQw4w9WgXcQ' };
    expect(render(<ListingVideo video={forged} title="x" />).container.querySelector('iframe')).toBeNull();
  });
});
