import { afterEach, describe, expect, it } from 'vitest';
import { classify, contentAt, isAccountTrigger } from '../src/pack/classify';
import { accountMenu, claudeSettings, devinShell, modelPicker, sidebar, singleCard, transcript, userCards } from './fixtures/ui-structures';

const tier = (sel: string, src?: string, kind: 'text' | 'aria-label' = 'text') => {
  const el = document.querySelector(sel)!;
  const text = src ?? (kind === 'text' ? el.textContent!.trim() : el.getAttribute(kind)!);
  return classify(el, kind, text, 'zh-CN')?.tier ?? 'dropped';
};

afterEach(() => {
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

describe('classify', () => {
  it('settings labels, options and descriptions are interface', () => {
    document.body.innerHTML = claudeSettings('general');
    expect(tier('#_r_a4_')).toBe('high'); // group label
    expect(tier('#width-m')).toBe('high'); // option
    expect(tier('#_r_a5_')).toBe('high'); // description
    expect(tier('[data-testid="account-settings"] .truncate')).toBe('high'); // nav item
  });

  it('the account trigger is never collected; its menu keeps only menu items', () => {
    document.body.innerHTML = sidebar + accountMenu;
    const trigger = document.querySelector('[data-testid="user-menu-button"]')!;
    expect(isAccountTrigger(trigger)).toBe(true);
    for (const span of trigger.querySelectorAll('span')) expect(classify(span, 'text', span.textContent!, 'zh-CN')!.tier).toBe('content');
    trigger.setAttribute('aria-expanded', 'true');
    expect(tier('#who')).toBe('content');
    expect(tier('#mi-settings')).toBe('high');
    expect(tier('#mi-out')).toBe('high');
    // Chat titles in the sidebar link to one conversation each: dropped outright.
    expect(tier('[data-testid="sidebar-recents"] a span')).toBe('dropped');
    expect(tier('[data-testid="nav-pin-rows"] a[href="/projects"] span')).toBe('high');
  });

  it('user cards are content even when there are only one or two; repeated row labels are not', () => {
    document.body.innerHTML = userCards;
    expect(tier('#c2')).toBe('content');
    expect(tier('#d2')).toBe('content');
    expect(tier('main h2')).toBe('high');
    expect(tier('.card button', undefined, 'aria-label')).toBe('high');
    expect(tier('#e1')).toBe('uncertain');
    document.body.innerHTML = singleCard;
    expect(tier('#only')).toBe('content');
  });

  it('transcripts are content; controls under messages are uncertain', () => {
    document.body.innerHTML = transcript;
    expect(tier('#msg')).toBe('content');
    expect(tier('#copy')).toBe('uncertain');
  });

  it('option lists are never mistaken for user lists', () => {
    document.body.innerHTML = modelPicker;
    expect(tier('#m1')).toBe('high');
    expect(tier('#m3')).toBe('high');
  });

  it('organization names repeated from the address are content', () => {
    history.replaceState(null, '', '/org/acme/settings');
    document.body.innerHTML = devinShell;
    expect(tier('main h2')).toBe('content');
    expect(tier('main h3')).toBe('high');
    expect(tier('nav[aria-label="Pages"] a')).toBe('high');
  });

  it('protects content at apply time', () => {
    document.body.innerHTML = userCards + sidebar;
    expect(contentAt(document.querySelector('#c2')!, 'text', 'Weekly digest')).toBe(true);
    expect(contentAt(document.querySelector('#e1')!, 'text', 'Enabled')).toBe(false);
    const name = document.querySelector('[data-testid="user-menu-button"] span:nth-child(2)')!;
    expect(contentAt(name, 'text', 'Mira Chen')).toBe(true);
  });
});
