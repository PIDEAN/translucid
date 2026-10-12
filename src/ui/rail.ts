// The one navigation of every extension page: Workbench (site localization,
// the headline feature), Immersive translation and Config sit side by side.
// The sites page renders the workbench; the options page renders the other two.
import { browser } from 'wxt/browser';
import type { PackIndexItem } from '../pack/format';
import { langLabel } from '../pack/langs';
import { providerReady } from '../shared/pricing';
import type { Settings } from '../shared/types';
import { h } from './dom';
import { icon } from './icons';
import { appIcon } from './provider-logos';

export type RailGroup = 'workbench' | 'immersive' | 'config';

export const IMMERSIVE_ITEMS: [id: string, label: string][] = [
  ['display', '显示与样式'],
  ['experts', '场景专家'],
  ['glossary', '术语表'],
  ['sites', '站点规则'],
];
export const CONFIG_ITEMS: [id: string, label: string][] = [
  ['providers', '服务商与路由'],
  ['usage', '用量与缓存'],
  ['about', '关于与隐私'],
];

export interface RailOptions {
  group: RailGroup;
  /** Sub-item of the group (a section id, or a site id in the workbench). */
  item?: string;
  sites?: PackIndexItem[];
  /** A small status line at the bottom (active provider). */
  status?: RailStatus;
}

export interface RailStatus {
  label: string;
  tone: 'ok' | 'warn' | 'danger';
}

/** The provider that translates page text, and whether it can (a test result wins when there is one). */
export function providerStatus(s: Settings, test?: { ok: boolean }): RailStatus {
  const p = s.providers.find((x) => x.id === s.activeProviderId);
  if (!p) return { label: '正文服务商未配置', tone: 'warn' };
  if (!providerReady(p)) return { label: `${p.name} · 未配置`, tone: 'warn' };
  if (test) return test.ok ? { label: `${p.name} · 已连接`, tone: 'ok' } : { label: `${p.name} · 连接失败`, tone: 'danger' };
  return { label: `${p.name} · 可用`, tone: 'ok' };
}

/** Title, one line of context and the page's actions, above the cards. */
export function pageHead(title: string, hint: string | Node | null, ...actions: (Node | null)[]): HTMLElement {
  const acts = actions.filter((a): a is Node => !!a);
  return h(
    'div',
    { class: 'page-head' },
    h('div', { class: 'page-title' }, h('h1', {}, title), hint ? h('p', { class: 'hint' }, hint) : null),
    acts.length ? h('div', { class: 'page-actions' }, ...acts) : null,
  );
}

const onPage = (file: string) => location.pathname.endsWith(file);
/** A link to a route on the sites page or the options page; same-page links stay hash-only. */
export function routeHref(group: RailGroup, item?: string): string {
  if (group === 'workbench') {
    const hash = item ? `#/site/${encodeURIComponent(item)}/overview` : '#/';
    return onPage('sites.html') ? hash : browser.runtime.getURL(`/sites.html${hash}`);
  }
  const hash = `#/${group}${item ? `/${item}` : ''}`;
  return onPage('options.html') ? hash : browser.runtime.getURL(`/options.html${hash}`);
}

export function rail(o: RailOptions): HTMLElement {
  const top = (group: RailGroup, label: string, ic: string) =>
    h('a', { class: 'rail-link', href: routeHref(group), 'aria-current': o.group === group ? 'page' : null }, icon(ic, 18), label);
  const sub = (group: RailGroup, items: [string, string][]) =>
    o.group === group
      ? h(
          'div',
          { class: 'rail-sub' },
          ...items.map(([id, label]) => h('a', { class: 'rail-sublink', href: routeHref(group, id), 'data-nav': id, 'aria-current': o.item === id ? 'true' : null }, label)),
        )
      : null;
  const sites = o.sites ?? [];
  return h(
    'nav',
    { class: 'app-rail', 'aria-label': '主菜单' },
    h(
      'div',
      { class: 'rail-brand' },
      h('span', { class: 'rail-logo' }, appIcon(32)),
      h('div', {}, h('div', { class: 'rail-name' }, 'Translucid'), h('div', { class: 'hint' }, `透译 · v${browser.runtime.getManifest().version}`)),
    ),
    top('workbench', '工作台', 'pack'),
    o.group === 'workbench' || sites.length
      ? h(
          'div',
          { class: 'rail-sub' },
          ...sites.map((p) =>
            h(
              'a',
              { class: 'rail-sublink rail-site', href: routeHref('workbench', p.id), 'aria-current': o.group === 'workbench' && o.item === p.id ? 'true' : null },
              h('span', {}, p.hosts[0] ?? p.id),
              h('span', { class: 'hint' }, `${langLabel(p.targetLang)} · ${p.entries} 条${p.enabled ? '' : ' · 已停用'}`),
            ),
          ),
          sites.length ? null : h('span', { class: 'hint rail-empty' }, '还没有本地化的网站'),
        )
      : null,
    top('immersive', '沉浸翻译', 'lines'),
    sub('immersive', IMMERSIVE_ITEMS),
    top('config', '配置', 'settings'),
    sub('config', CONFIG_ITEMS),
    o.status
      ? h(
          'a',
          { class: 'rail-status', href: routeHref('config', 'providers'), title: '服务商与路由' },
          h('span', { class: 'rail-dot', style: `background: var(--${o.status.tone})` }),
          h('span', { class: 'rail-status-text' }, o.status.label),
        )
      : null,
  );
}
