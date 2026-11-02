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
  'yahoo.co.jp', 'yahoo.com.br', 'aim.com', 'protonmail.ch', 'tutamail.com', 'tuta.com', 'tutanota.de', 'keemail.me',
  'gmx.at', 'gmx.ch', 'gmx.us', 'gmx.co.uk', 'gmx.fr', 'yandex.ua', 'bk.ru', 'inbox.ru', 'list.ru', 'foxmail.com',
  'yeah.net', 'sina.com', 'hanmail.net',
  // mail.com's other free mailbox domains.
  'email.com', 'usa.com', 'post.com', 'consultant.com', 'engineer.com', 'myself.com', 'europe.com', 'asia.com',
  'iname.com', 'techie.com', 'writeme.com', 'accountant.com', 'dr.com', 'cheerful.com', 'workmail.com', 'contractor.net',
  // Consumer ISPs and other free mailboxes.
  'duck.com', 'posteo.de', 'mailbox.org', 't-online.de', 'orange.fr', 'free.fr', 'laposte.net', 'sfr.fr', 'wanadoo.fr',
  'libero.it', 'virgilio.it', 'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl', 'uol.com.br', 'bol.com.br',
  'sky.com', 'virginmedia.com', 'cox.net', 'charter.net', 'earthlink.net', 'shaw.ca', 'rogers.com', 'bigpond.com',
  'optusnet.com.au', 'xtra.co.nz',
]);

/** No address is longer (RFC 5321 path limit); anything longer isn't one. */
const MAX_ADDRESS_LENGTH = 254;

/** The address is at a free mail provider. Linear in the input, with no
 *  regular expression: it runs on whatever a public signup form sends. */
export function isFreeMailAddress(email: string): boolean {
  if (email.length > MAX_ADDRESS_LENGTH) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  // A trailing dot (the DNS root) names the same domain.
  let end = domain.length;
  while (end > 0 && domain[end - 1] === '.') end -= 1;
  return FREE_MAIL_DOMAINS.has(domain.slice(0, end));
}
