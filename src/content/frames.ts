// Which documents page translation runs in. The top document always; a subframe only when it is the page
// itself, like a docs site that renders its whole body in an iframe filling the window, and only once the
// user asked for it (see entrypoints/content.ts). Ads, captchas, video players, social widgets, editors
// and frames holding sign-in or card fields are never read.

/** Smallest subframe treated as page content: common ad sizes (300×250, 728×90, 300×600) stay out. */
export const PAGE_FRAME_MIN = { width: 500, height: 400 };

/** Frames from these sites are widgets, not page content (the host or any subdomain). */
const WIDGET_HOSTS = [
  // captchas and bot checks
  'recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com', 'arkoselabs.com', 'funcaptcha.com',
  // ads
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adnxs.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com',
  // payments
  'stripe.com', 'stripe.network', 'paypal.com', 'braintreegateway.com', 'adyen.com', 'checkout.com', 'klarna.com', 'alipay.com',
  // video and audio players
  'youtube.com', 'youtube-nocookie.com', 'vimeo.com', 'twitch.tv', 'dailymotion.com', 'spotify.com', 'soundcloud.com',
  // social widgets and comments
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'disqus.com',
  // sign-in
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com',
];

const hostIn = (host: string, list: readonly string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** A widget frame by its address (Google serves reCAPTCHA and map embeds from its main domain). */
export function isWidgetFrame(url: URL): boolean {
  if (hostIn(url.hostname, WIDGET_HOSTS)) return true;
  return /^\/(recaptcha|maps\/embed)(\/|$)/.test(url.pathname);
}

export interface FrameInfo {
  top: boolean;
  url: string;
  width: number;
  height: number;
  /** The whole document is an editor (designMode, or an editable body as rich-text editors use). */
  editable: boolean;
}

export function frameInfo(win: Window): FrameInfo {
  const doc = win.document;
  return {
    top: win === win.top,
    url: win.location.href,
    width: win.innerWidth,
    height: win.innerHeight,
    editable: doc.designMode === 'on' || !!doc.body?.isContentEditable,
  };
}

/**
 * 'yes': translate in this document. 'no': never (a widget, an editor, not a web page).
 * 'size': a subframe that may still become page-sized (iframes are often sized after they load).
 */
export function pageFrameVerdict(f: FrameInfo): 'yes' | 'no' | 'size' {
  if (f.top) return 'yes';
  if (f.editable) return 'no';
  let url: URL;
  try {
    url = new URL(f.url);
  } catch {
    return 'no';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'no';
  if (isWidgetFrame(url)) return 'no';
  return f.width >= PAGE_FRAME_MIN.width && f.height >= PAGE_FRAME_MIN.height ? 'yes' : 'size';
}

/** Fields a frame is never translated around: sign-in, one-time codes and payment cards. */
const SENSITIVE_FIELDS = 'input[type="password"], [autocomplete~="current-password"], [autocomplete~="new-password"], [autocomplete~="one-time-code"], [autocomplete*="cc-"]';
/** The same fields recognized by name, id, label or placeholder (many forms set no autocomplete). */
const SENSITIVE_HINT = /pass(word|code)|\botp\b|one.?time|verif\w*.?code|security.?code|card.?(number|num|no)\b|\bcc.?(num|number|no)\b|\b(cvv|cvc|csc)\b|expir|密码|验证码|卡号|安全码|有效期/i;
const TEXT_INPUTS = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"])';

/** A subframe holding sign-in or payment fields that can be recognized: not translated, whatever its domain. */
export function sensitiveFrame(doc: Document): boolean {
  if (doc.querySelector(SENSITIVE_FIELDS)) return true;
  for (const el of doc.querySelectorAll<HTMLInputElement>(TEXT_INPUTS)) {
    const hint = [el.name, el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].filter(Boolean).join(' ');
    if (hint && SENSITIVE_HINT.test(hint)) return true;
  }
  return false;
}

/** Resolves true once this document should run page translation; frames not page-sized yet keep watching. */
export function pageFrameReady(win: Window = window): Promise<boolean> {
  const verdict = () => pageFrameVerdict(frameInfo(win));
  const first = verdict();
  if (first !== 'size') return Promise.resolve(first === 'yes');
  // A frame's document can be ready before its page lays the frame out (it reads 0×0 then), and that
  // first layout fires no resize event: the root element is watched as well as resizes and load.
  return new Promise((resolve) => {
    let observer: ResizeObserver | undefined;
    const check = () => {
      const v = verdict();
      if (v === 'size') return;
      win.removeEventListener('resize', check);
      win.removeEventListener('load', check);
      observer?.disconnect();
      resolve(v === 'yes');
    };
    win.addEventListener('resize', check);
    win.addEventListener('load', check);
    const Observer = (win as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) {
      observer = new Observer(check);
      observer.observe(win.document.documentElement);
    }
  });
}

/** The site the user is on: the top document's host, also inside its frames (Chrome's ancestorOrigins). */
export function siteHost(loc: Location): string {
  const ancestors = (loc as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ancestors?.length) {
    try {
      return new URL(ancestors[ancestors.length - 1]!).hostname;
    } catch {
      // fall back to this document's host
    }
  }
  return loc.hostname;
}
