/**
 * PostmarkMailer unit tests — mock fetch, assert payload shape + error
 * handling. DevMailer path is already exercised by the magic-link
 * integration suite; we don't duplicate it here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('PostmarkMailer', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MAIL_TRANSPORT;
    delete process.env.POSTMARK_SERVER_TOKEN;
    delete process.env.MAIL_FROM;
    delete process.env.POSTMARK_MESSAGE_STREAM;
  });

  it('POSTs a well-formed payload to the Postmark Email API', async () => {
    process.env.MAIL_TRANSPORT = 'postmark';
    process.env.POSTMARK_SERVER_TOKEN = 'test-token';
    process.env.MAIL_FROM = 'OpenPartner <no-reply@example.com>';
    process.env.POSTMARK_MESSAGE_STREAM = 'transactional-1';

    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ ErrorCode: 0, Message: 'OK' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { getMailer, __resetMailerForTests } = await import('../mailer.js');
    __resetMailerForTests();

    await getMailer().send({
      to: 'grace@example.com',
      subject: 'Hi',
      text: 'plain',
      html: '<b>rich</b>',
      tag: 'creator_signup',
      metadata: { handle: 'gracie' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://api.postmarkapp.com/email');

    const init = call[1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-postmark-server-token']).toBe('test-token');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(String(init.body));
    expect(body.From).toBe('OpenPartner <no-reply@example.com>');
    expect(body.To).toBe('grace@example.com');
    expect(body.Subject).toBe('Hi');
    expect(body.TextBody).toBe('plain');
    expect(body.HtmlBody).toBe('<b>rich</b>');
    expect(body.Tag).toBe('creator_signup');
    expect(body.MessageStream).toBe('transactional-1');
    expect(body.Metadata).toEqual({ handle: 'gracie' });
  });

  it('throws on non-2xx HTTP response', async () => {
    process.env.MAIL_TRANSPORT = 'postmark';
    process.env.POSTMARK_SERVER_TOKEN = 'bad-token';
    process.env.MAIL_FROM = 'no-reply@example.com';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unauthorized', { status: 401 })),
    );

    const { getMailer, __resetMailerForTests } = await import('../mailer.js');
    __resetMailerForTests();

    await expect(
      getMailer().send({ to: 'x@example.com', subject: 's', text: 't' }),
    ).rejects.toThrow(/postmark send failed: 401/);
  });

  it('throws on Postmark ErrorCode != 0', async () => {
    process.env.MAIL_TRANSPORT = 'postmark';
    process.env.POSTMARK_SERVER_TOKEN = 'ok';
    process.env.MAIL_FROM = 'no-reply@example.com';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ErrorCode: 406, Message: 'recipient suppressed' }), {
          status: 200,
        }),
      ),
    );

    const { getMailer, __resetMailerForTests } = await import('../mailer.js');
    __resetMailerForTests();

    await expect(
      getMailer().send({ to: 'sup@example.com', subject: 's', text: 't' }),
    ).rejects.toThrow(/postmark rejected message: 406/);
  });

  it('refuses to start without a token when MAIL_TRANSPORT=postmark', async () => {
    process.env.MAIL_TRANSPORT = 'postmark';
    // no POSTMARK_SERVER_TOKEN
    process.env.MAIL_FROM = 'no-reply@example.com';

    const { getMailer, __resetMailerForTests } = await import('../mailer.js');
    __resetMailerForTests();

    expect(() => getMailer()).toThrow(/POSTMARK_SERVER_TOKEN/);
  });

  it('refuses to start without MAIL_FROM', async () => {
    process.env.MAIL_TRANSPORT = 'postmark';
    process.env.POSTMARK_SERVER_TOKEN = 'ok';
    // no MAIL_FROM

    const { getMailer, __resetMailerForTests } = await import('../mailer.js');
    __resetMailerForTests();

    expect(() => getMailer()).toThrow(/MAIL_FROM/);
  });
});
