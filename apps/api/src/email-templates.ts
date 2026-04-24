/**
 * HTML + plain-text templates for auth emails.
 *
 * Kept deliberately small: inline CSS only, safe fonts, single CTA
 * button. Plaintext fallback carries the same link for clients that
 * block HTML. Preheader text primes the inbox preview so the user sees
 * "Sign in to OpenPartner" before they open the message.
 */

export interface MagicEmail {
  subject: string;
  text: string;
  html: string;
  tag: string;
}

interface BuildParams {
  headline: string;
  preheader: string;
  intro: string;
  buttonLabel: string;
  url: string;
  note?: string;
  tag: string;
  subject: string;
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function build(params: BuildParams): MagicEmail {
  const { headline, preheader, intro, buttonLabel, url, note, tag, subject } = params;

  const text =
    `${headline}\n\n${intro}\n\n${buttonLabel}: ${url}\n\n` +
    `This link expires in 15 minutes. If you didn't request it, ignore this email.` +
    (note ? `\n\n${note}` : '');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#0b0d10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#e6e8eb;">
  <span style="display:none;font-size:0;line-height:0;max-height:0;max-width:0;opacity:0;overflow:hidden;">${esc(preheader)}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0b0d10;padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#14171c;border:1px solid #242932;border-radius:14px;padding:32px;">
          <tr>
            <td style="padding-bottom:24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:linear-gradient(135deg,#2dd4bf,#0891b2);width:28px;height:28px;border-radius:8px;text-align:center;color:#08141a;font-weight:700;font-size:15px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">O</td>
                  <td style="padding-left:10px;font-size:16px;font-weight:600;color:#e6e8eb;">OpenPartner</td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="font-size:22px;font-weight:600;color:#e6e8eb;padding-bottom:8px;letter-spacing:-0.01em;">${esc(headline)}</td>
          </tr>
          <tr>
            <td style="font-size:14px;line-height:1.6;color:#8b929c;padding-bottom:24px;">${esc(intro)}</td>
          </tr>
          <tr>
            <td style="padding-bottom:24px;">
              <a href="${esc(url)}" style="display:inline-block;background:#2dd4bf;color:#08141a;text-decoration:none;padding:11px 20px;border-radius:6px;font-size:14px;font-weight:600;">${esc(buttonLabel)}</a>
            </td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#5a6370;padding-bottom:16px;">
              This link expires in 15 minutes. If you didn't request it, ignore this email.
            </td>
          </tr>
          ${note ? `<tr><td style="font-size:12px;color:#8b929c;padding-top:16px;border-top:1px solid #242932;line-height:1.6;">${esc(note)}</td></tr>` : ''}
          <tr>
            <td style="font-size:11px;color:#5a6370;padding-top:16px;word-break:break-all;">
              Or paste this URL into your browser:<br>
              <span style="color:#8b929c;">${esc(url)}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html, tag };
}

export function creatorSignupEmail(name: string, url: string): MagicEmail {
  return build({
    subject: 'Finish your OpenPartner signup',
    preheader: `Hi ${name} — one click to finish creating your OpenPartner account.`,
    headline: `Hi ${name}, one click to finish.`,
    intro:
      'Click the button below to verify your email and finish setting up your OpenPartner creator account. Once verified, you can browse offerings and apply to promote any product.',
    buttonLabel: 'Finish signup',
    url,
    tag: 'creator_signup',
  });
}

export function creatorSigninEmail(url: string): MagicEmail {
  return build({
    subject: 'Your OpenPartner sign-in link',
    preheader: 'One click to sign in to OpenPartner.',
    headline: 'Sign in to OpenPartner',
    intro: 'Click the button below to sign in.',
    buttonLabel: 'Sign in',
    url,
    tag: 'creator_signin',
  });
}

export function vendorSignupEmail(name: string, url: string): MagicEmail {
  return build({
    subject: 'Finish your OpenPartner vendor signup',
    preheader: `Verify your email to submit ${name} for Network review.`,
    headline: `Welcome, ${name}.`,
    intro:
      'Click the button below to verify your email and submit your vendor application. An admin reviews your federation credentials and activates your account — usually within a day.',
    buttonLabel: 'Verify email',
    url,
    tag: 'vendor_signup',
    note:
      "After your account is active, creators on the Network will be able to discover and apply to promote your offerings. You'll receive their applications in your portal inbox.",
  });
}

export function vendorSigninEmail(url: string): MagicEmail {
  return build({
    subject: 'Your OpenPartner sign-in link',
    preheader: 'One click to sign in to OpenPartner.',
    headline: 'Sign in to OpenPartner',
    intro: 'Click the button below to sign in.',
    buttonLabel: 'Sign in',
    url,
    tag: 'vendor_signin',
  });
}
