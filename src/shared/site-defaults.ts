import { matchHost } from './match';

/**
 * Built-in exclusions for site chrome that is never worth translating (menus,
 * vote counts, edit links, reference lists). Merged with the user's own site
 * rule; can be switched off in Options. Selectors were checked against the live
 * sites in Oct 2026 and are deliberately conservative: when a site changes its
 * markup the worst case is translating a little extra noise.
 */
export interface SiteDefault {
  host: string;
  exclude: string[];
}

/** Everywhere: visually hidden helper text. */
export const GLOBAL_EXCLUDE = [
  '[class*="sr-only"]', '.visually-hidden', '.screen-reader-text', '[class*="skip-link"]', '.skip-to-content',
  // UI controls: a translation injected inside a button or tab breaks its layout.
  '[role="button"]', '[role="tab"]', '[role="tablist"]', '[role="menuitem"]', '[role="menu"]', '[role="toolbar"]', '[role="tooltip"]',
  // Pagers: page numbers and Previous/Next links run together into one bogus sentence ("Go to Page1234PreviousNext").
  '.pager', '.pagination', '[class*="pagination"]', '[aria-label*="pagination" i]',
];

export const SITE_DEFAULTS: SiteDefault[] = [
  {
    host: 'wikipedia.org',
    exclude: [
      '.vector-header-container', '.vector-column-start', '.vector-column-end', '.vector-page-toolbar',
      '.vector-sticky-header', '.mw-editsection', '.mw-jump-link', '#p-lang-btn', '.vector-menu',
      '.navbox', '.navbox-styles', '.sidebar', '.vertical-navbox', '.ambox', '.mbox-small', '.metadata',
      '.catlinks', '.mw-footer', '.reflist', '.refbegin', '.mw-references-wrap', '.mw-indicators',
    ],
  },
  {
    host: 'news.ycombinator.com',
    exclude: ['.pagetop', '.comhead', '.reply', '.subline', '.yclinks', '.morelink', '.navs', '.rank'],
  },
  {
    host: 'github.com',
    exclude: [
      'header.AppHeader', '.AppHeader', 'nav[aria-label="Repository"]', '.UnderlineNav',
      '[data-testid="breadcrumbs"]', '.file-navigation', 'react-app [aria-labelledby="folders-and-files"]',
      '.BorderGrid-cell .Counter', 'footer', '.js-header-wrapper',
    ],
  },
  {
    host: 'stackoverflow.com',
    exclude: [
      '.s-topbar', '#left-sidebar', '#sidebar', '.js-vote-count', '.s-user-card', '.post-taglist',
      '.js-post-menu', '.comment-user', '.comment-date', '.site-footer', '.js-voting-container',
      '.s-btn', '.s-sidebarwidget', '.everyonelovesstackoverflow',
    ],
  },
  {
    host: 'stackexchange.com',
    exclude: ['.s-topbar', '#left-sidebar', '#sidebar', '.js-vote-count', '.s-user-card', '.post-taglist', '.js-post-menu', '.site-footer'],
  },
  {
    host: 'developer.mozilla.org',
    exclude: [
      '.top-navigation', '.navigation', '.sidebar', '.left-sidebar', '.toc', '.document-toc-container', '.page-footer',
      '.breadcrumbs-container', '.article-actions', '.reference-toc', '.a11y-menu', '.breadcrumbs',
    ],
  },
  {
    host: 'x.com',
    exclude: ['header[role="banner"]', '[data-testid="sidebarColumn"]', '[role="group"]', '[data-testid="User-Name"]'],
  },
  {
    host: 'twitter.com',
    exclude: ['header[role="banner"]', '[data-testid="sidebarColumn"]', '[role="group"]', '[data-testid="User-Name"]'],
  },
  {
    host: 'reddit.com',
    exclude: ['reddit-header-large', 'shreddit-async-loader[bundlename="left_nav"]', '#left-sidebar-container', 'faceplate-number', 'shreddit-comment-action-row', '.side', '.tabmenu', '.flat-list.buttons'],
  },
  {
    host: 'youtube.com',
    exclude: ['ytd-masthead', '#guide', 'ytd-mini-guide-renderer', '#chips', 'ytd-menu-renderer', '#owner', '#info-container'],
  },
  {
    host: 'bbc.com',
    exclude: ['[class*="Navigation-styles"]', '.dotcom-ad-text', '[class*="CreditStyled"]', '[data-testid="ad-unit"]'],
  },
  {
    host: 'bbc.co.uk',
    exclude: ['[class*="Navigation-styles"]', '.dotcom-ad-text', '[class*="CreditStyled"]', '[data-testid="ad-unit"]'],
  },
  {
    host: 'arxiv.org',
    exclude: ['#header', 'header', '.extra-services', '.submission-history', 'footer'],
  },
  {
    host: 'readthedocs.io',
    exclude: ['.wy-nav-side', '.rst-footer-buttons', '.headerlink', '.wy-breadcrumbs'],
  },
  {
    host: 'docs.python.org',
    exclude: ['.sphinxsidebar', '.related', '.headerlink', '.footer'],
  },
];

export function builtinExcludeList(host: string, siteRules = true): string[] {
  const site = siteRules ? SITE_DEFAULTS.filter((d) => matchHost(d.host, host)).flatMap((d) => d.exclude) : [];
  return [...GLOBAL_EXCLUDE, ...site];
}

/**
 * Join selectors for Element.matches, dropping any that do not parse: one bad
 * selector in a comma list makes the whole list throw and disables every exclusion.
 */
export function joinSelectors(parts: (string | undefined)[], doc: Document = document): string | undefined {
  const frag = doc.createDocumentFragment();
  const ok = parts
    .flatMap((p) => (p ?? '').split(/,(?![^\[]*\])/))
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      try {
        frag.querySelector(s);
        return true;
      } catch {
        return false;
      }
    });
  return ok.length ? ok.join(', ') : undefined;
}
