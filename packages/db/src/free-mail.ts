/**
 * Mail providers anyone can sign up to. A brand signs up with an address at
 * its own domain: an address at one of these says nothing about the business
 * behind it. Shared by the API, which refuses a new brand on one while ops
 * require a work email (brand-review.ts), and the portal, which says so on
 * the signup forms.
 *
 * Everything in the Network's SHARED_MAIL_DOMAINS (openpartner-network
 * src/creator-index/blocked-domains.ts), plus regional variants of the same
 * providers and the larger consumer ISPs. Exact domains only: a subdomain
 * (mail.example.com) is somebody's own.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  // The Network's list.
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'rocketmail.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io', 'fastmail.com', 'hey.com', 'zoho.com', 'zohomail.com',
  'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com', '126.com',
  'naver.com', 'daum.net', 'rediffmail.com', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'btinternet.com',
  // Regional variants of the same providers.
  'outlook.fr', 'outlook.de', 'outlook.es', 'outlook.it', 'hotmail.fr', 'hotmail.de', 'hotmail.es', 'hotmail.it',
  'live.fr', 'live.ca', 'live.com.au', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.ca', 'yahoo.com.au',
  'yahoo.co.jp', 'yahoo.com.br', 'aim.com', 'protonmail.ch', 'tutamail.com', 'gmx.at', 'gmx.ch', 'yandex.ua', 'bk.ru',
  'inbox.ru', 'list.ru', 'foxmail.com', 'yeah.net', 'sina.com', 'hanmail.net',
  // Consumer ISPs and other free mailboxes.
  'duck.com', 'posteo.de', 'mailbox.org', 't-online.de', 'orange.fr', 'free.fr', 'laposte.net', 'sfr.fr', 'wanadoo.fr',
  'libero.it', 'virgilio.it', 'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl', 'uol.com.br', 'bol.com.br',
  'sky.com', 'virginmedia.com', 'cox.net', 'charter.net', 'earthlink.net', 'shaw.ca', 'rogers.com', 'bigpond.com',
  'optusnet.com.au', 'xtra.co.nz',
]);

/** The address is at a free mail provider. */
export function isFreeMailAddress(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return FREE_MAIL_DOMAINS.has(email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, ''));
}
