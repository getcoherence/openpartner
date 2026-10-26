// @vitest-environment jsdom
/**
 * The conversation box and thread (conversation-shared.tsx,
 * conversation-media.tsx), as both sides use them:
 *
 *   - Enter sends, Shift+Enter is a new line, Enter mid-composition picks
 *     the word, and an empty box sends nothing.
 *   - A pasted, picked or dropped image uploads straight away and is sent
 *     with the message, alone or with text; up to four; a refused upload
 *     says why and isn't sent.
 *   - Links in a message are clickable and open in a new tab; nothing else
 *     the other side typed becomes markup.
 *   - Images in the thread are fetched with the side's own loader and open
 *     larger on a click; a removed one says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer, Thread, ThreadPane, type ConversationMessage, type MessageAttachment } from '../pages/creator/conversation-shared.js';
import { clearAttachmentCache, linkParts, prepareImage } from '../pages/creator/conversation-media.js';

let urls = 0;
const drawn: string[] = [];
beforeEach(() => {
  urls = 0;
  drawn.length = 0;
  clearAttachmentCache();
  URL.createObjectURL = vi.fn(() => `blob:test/${++urls}`);
  URL.revokeObjectURL = vi.fn();
  // jsdom draws nothing: stand in for the browser's decoder and canvas, and
  // note what each photo was redrawn as.
  globalThis.createImageBitmap = vi.fn(async () => ({ width: 4000, height: 3000, close: () => undefined })) as unknown as typeof createImageBitmap;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: () => undefined, fillRect: () => undefined, fillStyle: '' })) as never;
  HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, done: BlobCallback, type?: string) {
    drawn.push(`${type} ${this.width}x${this.height}`);
    done(new Blob([new Uint8Array(16)], { type }));
  };
});
afterEach(cleanup);

function box() {
  return screen.getByRole('textbox', { name: 'Message' });
}

function image(name = 'shot.png', type = 'image/png'): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, { type });
}

function paste(files: File[], text = '') {
  fireEvent.paste(box(), { clipboardData: { files, getData: (t: string) => (t === 'text/plain' ? text : '') } });
}

type Sent = { body: string; attachmentIds: string[] };

let uploadCount = 0;
function uploader(fail?: Error) {
  return vi.fn(async (_blob: Blob): Promise<MessageAttachment> => {
    if (fail) throw fail;
    uploadCount += 1;
    return { id: `cna_${uploadCount}`, contentType: 'image/png', width: 10, height: 10, size: 7, removed: false };
  });
}

describe('Composer', () => {
  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    const onSend = vi.fn(async (_m: Sent) => undefined);
    render(<Composer onSend={onSend} pending={false} />);
    fireEvent.change(box(), { target: { value: 'Hello there' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    // Choosing a word in an input method isn't sending.
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledWith({ body: 'Hello there', attachmentIds: [] });
    expect((box() as HTMLTextAreaElement).value).toBe('');
    // Nothing to send: Enter does nothing.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Enter to send, Shift\+Enter for a new line/)).toBeTruthy();
  });

  it('uploads a pasted image and sends it, alone or with text', async () => {
    const onSend = vi.fn(async (_m: Sent) => undefined);
    const onUpload = uploader();
    render(<Composer onSend={onSend} onUpload={onUpload} pending={false} />);
    paste([image()]);
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(1));
    const send = screen.getByRole('button', { name: 'Send' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      fireEvent.click(send);
    });
    expect(onSend).toHaveBeenLastCalledWith({ body: '', attachmentIds: [expect.stringMatching(/^cna_/)] });
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();

    // With text, and a removed image isn't sent.
    paste([image('a.png'), image('b.png')]);
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove image' })[0]!);
    fireEvent.change(box(), { target: { value: 'See this' } });
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    const last = onSend.mock.calls.at(-1)![0] as { body: string; attachmentIds: string[] };
    expect(last.body).toBe('See this');
    expect(last.attachmentIds).toHaveLength(1);
  });

  it('takes images from the picker and from a drop, up to four', async () => {
    const onUpload = uploader();
    render(<Composer onSend={vi.fn(async (_m: Sent) => undefined)} onUpload={onUpload} pending={false} />);
    fireEvent.change(screen.getByLabelText('Add images'), { target: { files: [image('1.png'), image('2.jpg', 'image/jpeg')] } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    fireEvent.drop(box().parentElement!, { dataTransfer: { files: [image('3.png'), image('4.webp', 'image/webp'), image('5.gif', 'image/gif')], types: ['Files'] } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(4));
    expect(screen.getByRole('alert').textContent).toMatch(/Up to 4 images per message/);
    expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(4);
  });

  it('says why an image was refused and does not send it', async () => {
    const onSend = vi.fn(async (_m: Sent) => undefined);
    render(<Composer onSend={onSend} onUpload={uploader(new Error('network_call_failed: {"error":"payload_too_large"}'))} pending={false} />);
    paste([image()]);
    expect(await screen.findByText('That image is over 5 MB.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box(), { target: { value: 'Text still goes' } });
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    expect(onSend).toHaveBeenCalledWith({ body: 'Text still goes', attachmentIds: [] });
  });

  it('refuses a file that is not a PNG, JPEG, WebP or GIF before uploading it', async () => {
    const onUpload = uploader();
    render(<Composer onSend={vi.fn(async (_m: Sent) => undefined)} onUpload={onUpload} pending={false} />);
    paste([image('vector.svg', 'image/svg+xml')]);
    expect(await screen.findByText('Only PNG, JPEG, WebP and GIF images can be sent.')).toBeTruthy();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('keeps what was added while a message was sending', async () => {
    let finish!: () => void;
    const onSend = vi.fn((_m: Sent) => new Promise<void>((resolve) => (finish = resolve)));
    const onUpload = uploader();
    render(<Composer onSend={onSend} onUpload={onUpload} pending={false} />);
    paste([image('first.png')]);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(box(), { target: { value: 'First' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    // While it's on its way: another image and more text.
    paste([image('second.png')]);
    fireEvent.change(box(), { target: { value: 'First, and then' } });
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    await act(async () => finish());
    expect(onSend.mock.calls[0]![0]).toMatchObject({ body: 'First' });
    expect((box() as HTMLTextAreaElement).value).toBe('First, and then');
    expect(screen.getAllByRole('button', { name: 'Remove image' })).toHaveLength(1);
  });

  it('redraws photos smaller, which drops their metadata, and refuses one it cannot redraw', async () => {
    const out = await prepareImage(image('photo.jpg', 'image/jpeg'));
    expect(out.type).toBe('image/jpeg');
    expect(drawn).toEqual(['image/jpeg 2560x1920']);
    const gif = image('moving.gif', 'image/gif');
    expect(await prepareImage(gif)).toBe(gif);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
    await expect(prepareImage(image('photo.jpg', 'image/jpeg'))).rejects.toThrow(/can’t prepare images/);
  });

  it('is text only without an uploader: a pasted image is left alone', () => {
    render(<Composer onSend={vi.fn(async (_m: Sent) => undefined)} pending={false} />);
    paste([image()]);
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
    expect(screen.queryByRole('button', { name: /image/i })).toBeNull();
  });
});

describe('links', () => {
  it('finds http(s) and www. links, minus the sentence around them', () => {
    expect(linkParts('See https://example.com/a?b=1, and www.acme.test.')).toEqual([
      { text: 'See ' },
      { text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { text: ', and ' },
      { text: 'www.acme.test', href: 'https://www.acme.test' },
      { text: '.' },
    ]);
    expect(linkParts('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { text: '(' },
      { text: 'https://en.wikipedia.org/wiki/Foo_(bar)', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { text: ')' },
    ]);
    expect(linkParts('javascript:alert(1) and ftp://x.test and plain text')).toEqual([{ text: 'javascript:alert(1) and ftp://x.test and plain text' }]);
    expect(linkParts('https://')).toEqual([{ text: 'https://' }]);
  });
});

const names = { creator: 'Ada', brand: 'Acme' };

function msg(over: Partial<ConversationMessage>): ConversationMessage {
  return { id: 'cnm_1', author: 'vendor', authorName: 'Grace', kind: 'text', body: null, event: null, bookingId: null, createdAt: new Date().toISOString(), ...over };
}

describe('ThreadPane', () => {
  /** jsdom lays nothing out: give the scroller a size to scroll in. */
  function sized(el: HTMLElement, layout: { scrollHeight: number; clientHeight: number }) {
    let top = 0;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => layout.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => layout.clientHeight });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => (top = v) });
    return { get top() { return top; }, set top(v: number) { top = v; } };
  }

  function pane(firstId: string, lastId: string, lastIsMine = false) {
    return (
      <ThreadPane firstId={firstId} lastId={lastId} lastIsMine={lastIsMine} footer={<Composer onSend={vi.fn(async (_m: Sent) => undefined)} onUpload={uploader()} pending={false} />}>
        <div>messages {firstId}…{lastId}</div>
      </ThreadPane>
    );
  }

  it('puts send and + inside the box, and keeps the box out of the scrolling messages', () => {
    render(pane('a', 'b'));
    const row = box().parentElement!;
    expect(row.querySelector('button[aria-label="Send"]')).not.toBeNull();
    expect(row.querySelector('button[aria-label="Add an image"]')).not.toBeNull();
    expect(screen.getByTestId('thread-scroll').contains(box())).toBe(false);
  });

  it('follows new messages at the bottom, leaves a reader who scrolled up, and keeps their place when earlier ones load', () => {
    const layout = { scrollHeight: 1000, clientHeight: 400 };
    const { rerender } = render(pane('m1', 'm5'));
    const scroller = screen.getByTestId('thread-scroll');
    const pos = sized(scroller, layout);

    // At the bottom: a new message from the other side is followed.
    pos.top = 600;
    fireEvent.scroll(scroller);
    layout.scrollHeight = 1100;
    rerender(pane('m1', 'm6'));
    expect(pos.top).toBe(1100);

    // Scrolled up to read: theirs doesn't move them, their own does.
    pos.top = 100;
    fireEvent.scroll(scroller);
    layout.scrollHeight = 1200;
    rerender(pane('m1', 'm7'));
    expect(pos.top).toBe(100);
    layout.scrollHeight = 1300;
    rerender(pane('m1', 'm8', true));
    expect(pos.top).toBe(1300);

    // Earlier messages load above: what they were reading stays put.
    pos.top = 50;
    fireEvent.scroll(scroller);
    layout.scrollHeight = 1800;
    rerender(pane('m0', 'm8', true));
    expect(pos.top).toBe(550);
  });
});

describe('Thread', () => {
  it('makes links clickable and keeps everything else text', () => {
    render(
      <Thread
        messages={[msg({ body: 'Brief: https://app.openpartner.dev/t/acme/admin/network/messages/cnv_01M5TB589A1SPBD9V23BQKZ0W9 <b>bold</b>' })]}
        side="creator"
        names={names}
        renderBooking={() => null}
        loadAttachment={vi.fn()}
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://app.openpartner.dev/t/acme/admin/network/messages/cnv_01M5TB589A1SPBD9V23BQKZ0W9');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
    expect(screen.getByText(/<b>bold<\/b>/)).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('never lets go of an image still on screen, however many there are', async () => {
    const load = vi.fn(async () => new Blob([new Uint8Array(1)], { type: 'image/png' }));
    const many = Array.from({ length: 140 }, (_, i) =>
      msg({ id: `cnm_${i}`, attachments: [{ id: `cna_${i}`, contentType: 'image/png', width: 10, height: 10, size: 1, removed: false }] }),
    );
    const { unmount } = render(<Thread messages={many} side="creator" names={names} renderBooking={() => null} loadAttachment={load} />);
    await waitFor(() => expect(document.querySelectorAll('img[src^="blob:"]')).toHaveLength(140));
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    // Off screen, the oldest past the cap are let go.
    unmount();
    await waitFor(() => expect((URL.revokeObjectURL as ReturnType<typeof vi.fn>).mock.calls.length).toBe(20));
  });

  it('loads images with the side’s own loader and opens one larger', async () => {
    const load = vi.fn(async () => new Blob([new Uint8Array([1])], { type: 'image/png' }));
    const attachments: MessageAttachment[] = [
      { id: 'cna_a', contentType: 'image/png', width: 800, height: 600, size: 1, removed: false },
      { id: 'cna_b', contentType: 'image/jpeg', width: 300, height: 300, size: 1, removed: true },
    ];
    render(<Thread messages={[msg({ attachments })]} side="creator" names={names} renderBooking={() => null} loadAttachment={load} />);
    await waitFor(() => expect(document.querySelector('img[src^="blob:"]')).not.toBeNull());
    expect(load).toHaveBeenCalledWith('cna_a');
    expect(load).not.toHaveBeenCalledWith('cna_b');
    expect(screen.getByText('Image removed by OpenPartner')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open image' }));
    expect(screen.getByRole('dialog', { name: 'Image' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Image' })).toBeNull();
  });
});
