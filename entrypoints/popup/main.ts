import { browser } from 'wxt/browser';
import { estimateCost, formatCostLines, monthKey } from '../../src/shared/cost';
import { isDeepSeekPeak, providerReady, resolvedPrice } from '../../src/shared/pricing';
import { explainExpert, findSiteRule } from '../../src/shared/match';
import type { RuntimeRequest, TabCommand, TabState } from '../../src/shared/messages';
import { sendToTab, tabState } from '../../src/shared/tab-state';
import { loadSettings, onSettingsChanged, saveSettings } from '../../src/shared/settings';
import type { DisplayMode, Settings, SiteMode, TransStyle, UsageStats } from '../../src/shared/types';
import { h, select, toast } from '../../src/ui/dom';
import { icon } from '../../src/ui/icons';
import { appIcon, providerLogo } from '../../src/ui/provider-logos';
import { langLabel, PACK_LANGS } from '../../src/pack/langs';
import { loadShortcuts, shortcut } from '../../src/ui/shortcuts';
import { packId as packIdOf } from '../../src/pack/format';
import { reviewRowKey } from '../../src/pack/units';
import type { PackRequest, PackResponse, PackTabState } from '../../src/pack/messages';
import '../../src/ui/ui.css';
import './popup.css';

const POLL_MS = 800;
const STYLES: [TransStyle, string][] = [
  ['faded', '淡化'],
  ['border', '边框'],
  ['dashed', '虚线'],
  ['tint', '底色'],
];

let settings: Settings;
let tabId: number | undefined;
let tabUrl = '';
let host = '';
let update: (st: TabState) => void = () => {};

/** Run a command in every translating document of the tab, then read the tab as one page. */
async function send(cmd: TabCommand): Promise<TabState | null> {
  if (tabId === undefined) return null;
  try {
    if (cmd.type !== 'get-state') await sendToTab(tabId, cmd);
    return await tabState(tabId);
  } catch {
    return null; // chrome:// pages, the Web Store, PDFs, or a tab opened before install
  }
}

const langName = (code: string) => {
  try {
    return new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(code.split('-')[0]!) ?? code;
  } catch {
    return code;
  }
};

const ms = (v: number | null) => (v === null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

async function monthCost(): Promise<string> {
  const usage = (await browser.runtime.sendMessage({ type: 'usage' } satisfies RuntimeRequest).catch(() => ({}))) as UsageStats;
  const month = usage?.[monthKey()] ?? {};
  const lines = Object.entries(month).map(([id, b]) => estimateCost(b, settings.providers.find((p) => p.id === id)));
  const active = settings.providers.find((p) => p.id === settings.activeProviderId);
  return formatCostLines(lines, active ? resolvedPrice(active).currency : '¥');
}

// ---------- shared pieces ----------

function header(st: TabState | null) {
  const lang = st?.lang ?? '';
  // Each tab names its own target: the site's language pack, or Chinese for page translation.
  const target = tab === 'site' ? langLabel(settings.packTargetLang || 'zh-CN') : '简体中文';
  const sub = !st
    ? tab === 'site' && isWebPage()
      ? `界面 → ${target}`
      : '此页面无法翻译'
    : tab === 'page' && lang.startsWith('zh')
      ? '页面已是中文'
      : `${langName(lang)} → ${target}`;
  return h(
    'header',
    { class: 'pp-head' },
    h('span', { class: 'pp-logo' }, appIcon(30)),
    h('div', { class: 'pp-site' }, h('span', { class: 'pp-host' }, host || '—'), h('span', { class: 'hint', id: 'pp-lang' }, sub)),
    h('a', { class: 'icon-btn', href: sitesUrl('#/'), target: '_blank', 'aria-label': '打开工作台', title: '工作台' }, icon('pack')),
    h('a', { class: 'icon-btn', href: browser.runtime.getURL('/options.html#/config'), target: '_blank', 'aria-label': '打开配置', title: '配置' }, icon('settings')),
  );
}

type Tab = 'site' | 'page';
const TAB_KEY = 'translucid.popup.tab';
let tab: Tab = 'site';
try {
  tab = (localStorage.getItem(TAB_KEY) as Tab | null) === 'page' ? 'page' : 'site';
} catch {
  /* storage unavailable: default tab */
}

function pickTab(t: Tab) {
  if (tab === t) return;
  tab = t;
  try {
    localStorage.setItem(TAB_KEY, t);
  } catch {
    /* ignore */
  }
  void refresh(undefined, true).then(() => { if (tab === t) document.getElementById(`pp-tab-${t}`)?.focus(); });
}

function tabsBar() {
  const btn = (t: Tab, label: string) =>
    h('button', {
      type: 'button',
      role: 'tab',
      id: `pp-tab-${t}`,
      class: 'pp-tab',
      'aria-selected': String(tab === t),
      'aria-controls': 'pp-panel',
      tabindex: tab === t ? 0 : -1,
      onclick: () => pickTab(t),
    }, label);
  return h(
    'div',
    {
      class: 'pp-tabs',
      role: 'tablist',
      'aria-label': '功能',
      // Arrow keys move between the two tabs (the usual tablist keyboard pattern).
      onkeydown: (e: Event) => {
        const k = (e as KeyboardEvent).key;
        if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
          e.preventDefault();
          pickTab(k === 'Home' ? 'site' : k === 'End' ? 'page' : tab === 'site' ? 'page' : 'site');
        }
      },
    },
    btn('site', '本地化'),
    btn('page', '网页翻译'),
  );
}

/** Header, tabs, the chosen tab's content, footer. */
type RenderContext = { generation: number; tab: Tab };
let renderGeneration = 0;
const currentRender = (ctx: RenderContext) => ctx.generation === renderGeneration && ctx.tab === tab;

async function frame(st: TabState | null, pageMain: HTMLElement, ctx: RenderContext) {
  const app = document.getElementById('app')!;
  const body =
    ctx.tab === 'site'
      ? h('main', { class: 'pp-main' }, isWebPage() ? await siteCard(ctx) : h('div', { class: 'card pp-empty' }, icon('alert', 22, 'var(--warn)'), h('p', {}, '这个页面不能本地化'), h('span', { class: 'hint' }, '浏览器内置页面和扩展商店不支持。')))
      : pageMain;
  body.id = 'pp-panel';
  body.setAttribute('role', 'tabpanel');
  body.setAttribute('aria-labelledby', `pp-tab-${ctx.tab}`);
  const foot = await footer();
  if (!currentRender(ctx)) return;
  app.replaceChildren(header(st), tabsBar(), body, foot);
}

async function footer() {
  const p = settings.providers.find((x) => x.id === settings.activeProviderId);
  const ready = !!p && providerReady(p);
  const cost = h('span', {}, '本月 …');
  void monthCost().then((c) => (cost.textContent = `本月 ${c}`));
  return h(
    'footer',
    { class: 'pp-foot' },
    p
      ? h('span', { class: 'pp-badge', title: ready ? '已配置' : '未配置 Key' }, providerLogo(p, 16), ready ? null : h('span', { class: 'pp-badge-warn' }))
      : null,
    h(
      'span',
      { class: 'pp-grow' },
      ready
        ? `${p!.name} · ${p!.model}${resolvedPrice(p!).offPeak ? (isDeepSeekPeak() ? ' · 高峰价' : ' · 空闲价') : ''}`
        : `${p?.name ?? '服务商'} 未配置 Key`,
    ),
    cost,
  );
}

function modeSeg(current: DisplayMode, onPick: (m: DisplayMode) => void) {
  const btns = (['bilingual', 'replace'] as DisplayMode[]).map((m) =>
    h(
      'button',
      { type: 'button', role: 'radio', 'aria-checked': String(current === m), onclick: () => onPick(m) },
      m === 'bilingual' ? '双语对照' : '只看译文',
    ),
  );
  const set = (m: DisplayMode) => btns.forEach((b, i) => b.setAttribute('aria-checked', String(['bilingual', 'replace'][i] === m)));
  return { el: h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '显示方式' }, ...btns), set };
}

function siteRuleSelect() {
  const rule = findSiteRule(settings.siteRules, host);
  return select(
    [
      ['default', '默认'],
      ['always', '总是翻译'],
      ['never', '从不自动翻译'],
    ],
    rule?.mode ?? 'default',
    { class: 'inp', 'aria-label': '本站规则', onchange: (e: Event) => void setSiteMode((e.target as HTMLSelectElement).value as SiteMode) },
  );
}

async function setSiteMode(mode: SiteMode) {
  const rule = findSiteRule(settings.siteRules, host);
  const rules = settings.siteRules.filter((r) => r !== rule);
  const next = rule ? { ...rule, mode } : { host, mode };
  if (next.mode !== 'default' || next.expertId || next.include || next.exclude || next.glossary) rules.push(next);
  settings = { ...settings, siteRules: rules };
  await saveSettings(settings);
  toast(mode === 'always' ? '已设为总是翻译此站点' : mode === 'never' ? '已设为不自动翻译此站点' : '已恢复默认');
}

async function packRequest(req: PackRequest): Promise<PackResponse> {
  try {
    return (await browser.runtime.sendMessage(req)) as PackResponse;
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

async function packTabState(): Promise<PackTabState | null> {
  if (tabId === undefined) return null;
  try {
    return ((await browser.tabs.sendMessage(tabId, { type: 'pack-state' })) as PackTabState | undefined) ?? null;
  } catch {
    return null;
  }
}

const sitesUrl = (hash: string) => browser.runtime.getURL(`/sites.html${hash}`);
const isWebPage = () => /^https?:/.test(tabUrl) && !!host;

/**
 * Site localization card (shown first, independent of page translation): one-click
 * scan with consent on first use, scan progress and stop, review, the
 * original/translated toggle, and region picking as the advanced option.
 */
async function siteCard(ctx: RenderContext): Promise<HTMLElement> {
  const card = h('div', { class: 'card pp-pack' });
  let consent = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let drawSequence = 0;
  const draw = async () => {
    if (!currentRender(ctx)) { clearInterval(poll); poll = undefined; return; }
    // The popup re-rendered and dropped this card: stop polling for it.
    if (poll && !card.isConnected) {
      clearInterval(poll);
      poll = undefined;
      return;
    }
    const sequence = ++drawSequence;
    const live = () => currentRender(ctx) && sequence === drawSequence;
    const lang = settings.packTargetLang || 'zh-CN';
    const id = packIdOf(host, lang);
    const [list, tabState, pending, scan] = await Promise.all([
      packRequest({ type: 'pack-list' }),
      packTabState(),
      packRequest({ type: 'pack-pending-get', id }),
      packRequest({ type: 'pack-scan-status', tabId, packId: id }),
    ]);
    if (!live()) return;
    const item = list.ok ? list.index?.find((p) => p.id === id) : undefined;
    // Rows, as the review page counts them ("Close" in five places is one string to review).
    const pendingCount = pending.ok ? new Set((pending.pending ?? []).map(reviewRowKey)).size : 0;
    const status = scan.ok ? scan.scan : undefined;
    const running = !!status?.running;
    if (running && !poll) poll = setInterval(() => void draw(), POLL_MS);
    if (!running && poll) {
      clearInterval(poll);
      poll = undefined;
    }
    const langSel = select(PACK_LANGS, lang, {
      class: 'inp',
      'aria-label': '目标语言',
      onchange: async (e: Event) => {
        settings = { ...settings, packTargetLang: (e.target as HTMLSelectElement).value };
        await saveSettings(settings);
        void refresh(undefined, true); // the header names the target too
      },
    });
    const open = (hash: string) => {
      void browser.tabs.create({ url: sitesUrl(hash) });
      window.close();
    };
    const startScan = async (agree: boolean) => {
      if (tabId === undefined) return;
      const r = await packRequest({ type: 'pack-scan-start', tabId, host, targetLang: lang, consent: agree });
      if (!r.ok && r.error === 'need-consent') {
        consent = true;
        return void draw();
      }
      consent = false;
      if (!r.ok) return toast(r.error, 'err');
      void draw();
    };
    const pick = async () => {
      if (tabId === undefined) return;
      const r = await packRequest({ type: 'pack-collect-start', tabId, host, targetLang: lang });
      if (!r.ok) return toast(r.error, 'err');
      window.close(); // the picker panel takes over in the page
    };
    const toggle = async () => {
      if (tabId === undefined) return;
      await browser.tabs.sendMessage(tabId, { type: 'pack-toggle' }).catch(() => undefined);
      void draw();
    };
    const showing = !!tabState?.active;
    const last = status?.last?.report;
    const packRes = item ? await packRequest({ type: 'pack-get', id }) : undefined;
    if (!live()) return;
    const pack = packRes?.ok ? packRes.pack : undefined;
    const variants = pack?.entries.filter((e) => e.ctx).length ?? 0;
    const head = h('div', { class: 'pp-pack-head' }, h('span', { class: 'lbl' }, '目标语言'), langSel);
    if (running) {
      const p = status?.progress;
      card.replaceChildren(
        head,
        h('div', { class: 'pp-strong' }, '正在扫描界面…'),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('b', {}, String(p?.visited ?? 0)), h('span', {}, '已打开')),
          h('div', { class: 'stat' }, h('b', {}, String(p?.strings ?? 0)), h('span', {}, '界面文字')),
          h('div', { class: 'stat' }, h('b', {}, String(p?.actions ?? 0)), h('span', {}, '步'))),
        h('p', { class: 'hint' }, '只打开导航和菜单，不改设置；设置值一旦变化就立即停止。'),
        h('button', { type: 'button', class: 'btn btn-lg btn-block', onclick: async () => { await packRequest({ type: 'pack-scan-cancel', tabId: tabId! }); void draw(); } }, '停止并恢复'),
      );
      return;
    }
    if (consent) {
      const li = (t: string) => h('li', {}, t);
      card.replaceChildren(
        h('div', { class: 'pp-strong' }, `第一次扫描 ${host}`),
        h('ul', { class: 'pp-list' },
          li('自动打开导航分区、菜单和下拉列表，像你自己点开一样'),
          li('不点保存、删除、发送、分享、购买；不改设置，结束后恢复原状'),
          li('找到的文字只存在本机；会话、名字、邮箱不收集；确认前不发送'),
          li('网站会看到正常的页面浏览，通知可能被标为已读')),
        h('div', { class: 'pp-pack-actions' },
          h('button', { type: 'button', class: 'btn btn-primary btn-lg pp-grow-btn', onclick: () => void startScan(true) }, '同意并开始'),
          h('button', { type: 'button', class: 'btn btn-lg', onclick: () => { consent = false; void draw(); } }, '取消')),
        h('p', { class: 'hint' }, '每个网站只问一次，可在配置 › 关于与隐私里撤回。'),
      );
      return;
    }
    const learn = pack?.options.learn;
    card.replaceChildren(
      head,
      item
        ? h('div', { class: 'stats' },
            h('div', { class: 'stat' }, h('b', {}, String(item.entries)), h('span', {}, '条译文')),
            h('div', { class: `stat${pendingCount ? ' amber' : ''}` }, h('b', {}, String(pendingCount)), h('span', {}, '待审核')),
            h('div', { class: 'stat' }, h('b', {}, String(variants)), h('span', {}, '按位置区分')))
        : h('p', { class: 'hint' }, '把这个网站的界面完整翻译成你的语言：自动找出菜单、设置和弹窗里的界面文字，按界面结构一起翻译，保存在本机。'),
      h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onclick: () => void startScan(false) }, icon('search', 18), item?.entries ? '再次扫描此站点' : '一键本地化此站点'),
      h('p', { class: 'hint' }, '先打开网站的设置窗口再扫描，所有设置分区会一起扫描。'),
      h(
        'div',
        { class: 'pp-pack-actions' },
        pendingCount ? h('button', { type: 'button', class: 'btn btn-amber btn-sm', onclick: () => open(`#/site/${encodeURIComponent(id)}/review`) }, `审核 ${pendingCount} 条`) : null,
        item?.entries && tabState ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => void toggle() }, showing ? '显示原文' : '显示译文') : null,
        item ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => open(`#/site/${encodeURIComponent(id)}/overview`) }, '管理') : null,
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', title: '手动圈选要收集或排除的区域；网页菜单开着时用快捷键，菜单不会被关掉', onclick: () => void pick() }, '调整范围', shortcut('pick-regions')),
      ),
      ...(pack
        ? [h('div', { class: 'pp-pack-foot' },
            h('label', { class: 'pp-switch-row' },
              h('span', { class: 'pp-grow' }, h('span', { class: 'pp-strong' }, '日常学习'), h('span', { class: 'hint' }, '记下新出现的界面文字，等你审核')),
              h('span', { class: 'sw' },
                h('input', {
                  type: 'checkbox',
                  checked: !!learn,
                  'aria-label': '日常学习',
                  onchange: async (e: Event) => {
                    const r = await packRequest({ type: 'pack-update', id, patch: { learn: (e.target as HTMLInputElement).checked } });
                    if (!r.ok) toast(r.error, 'err');
                  },
                }),
                h('span', {}))),
            last ? h('div', { class: 'hint' }, `上次扫描：打开 ${last.visited.length} 处，找到 ${last.strings} 条 · ${last.restore === 'full' ? '已恢复原状' : '部分恢复'}`) : null)]
        : []),
    );
  };
  await draw();
  return card;
}

const section = (label: string, ...body: Node[]) =>
  h('div', { class: 'pp-sec' }, h('span', { class: 'pp-label' }, label), ...body);

// ---------- views ----------

async function renderUnsupported(ctx: RenderContext) {
  await frame(
    null,
    h(
      'main',
      { class: 'pp-main' },
      h(
        'div',
        { class: 'card pp-empty' },
        icon('alert', 22, 'var(--warn)'),
        h('p', {}, isWebPage() ? '网页翻译在这个标签页暂不可用' : '这个页面不能翻译'),
        h('span', { class: 'hint' }, '浏览器内置页面、扩展商店和 PDF 不支持；扩展安装前就打开的标签页刷新一下即可。'),
      ),
    ),
    ctx,
  );
}

async function renderIdle(st: TabState, ctx: RenderContext) {
  const choice = explainExpert(settings.experts, tabUrl, settings.siteRules, 'general');
  const isChinese = st.lang.startsWith('zh');
  const rule = findSiteRule(settings.siteRules, host);
  const always = h('input', {
    type: 'checkbox',
    checked: rule?.mode === 'always',
    'aria-label': '总是翻译此站点',
    onchange: (e: Event) => void setSiteMode((e.target as HTMLInputElement).checked ? 'always' : 'default'),
  });
  const mode = modeSeg(settings.displayMode, async (m) => {
    mode.set(m);
    settings = { ...settings, displayMode: m };
    await saveSettings(settings);
  });
  const estimate = h('span', { class: 'pp-val' }, st.estimate === null ? '—' : `约 ${st.estimate} 段，先翻可见区域`);

  await frame(
    st,
    h(
      'main',
      { class: 'pp-main' },
      h(
        'div',
        { class: 'card pp-hero' },
        h(
          'div',
          { class: 'pp-langs' },
          h('span', { class: 'tag' }, isChinese ? '中文' : langName(st.lang)),
          icon('arrow', 16, 'var(--muted)'),
          h('span', { class: 'tag tag-accent' }, '简体中文'),
        ),
        h(
          'button',
          { type: 'button', class: 'pp-big pp-big-primary', onclick: () => void act({ type: 'set-enabled', enabled: true }) },
          '翻译此页',
          shortcut('toggle-translate'),
        ),
        isChinese ? h('p', { class: 'hint' }, '这个页面看起来已经是中文，仍然可以手动翻译其中的外文段落。') : null,
        h(
          'dl',
          { class: 'pp-rows' },
          h('div', {}, h('dt', {}, '将使用场景'), h('dd', { class: 'pp-val' }, choice ? `${choice.expert.name}` : '通用')),
          choice ? h('div', {}, h('dt', {}, '依据'), h('dd', { class: 'pp-val mono' }, choice.reason)) : null,
          h('div', {}, h('dt', {}, '待翻译'), h('dd', {}, estimate)),
        ),
      ),
      h(
        'label',
        { class: 'card pp-toggle-row' },
        h(
          'span',
          { class: 'pp-grow' },
          h('span', { class: 'pp-strong' }, '总是翻译此站点'),
          h('span', { class: 'hint' }, `打开 ${host} 的页面时自动翻译`),
        ),
        h('span', { class: 'sw' }, always, h('span', {})),
      ),
      section('默认显示方式', mode.el),
      h(
        'div',
        { class: 'card pp-keys' },
        h('span', { class: 'pp-label' }, '快捷键'),
        h('div', {}, h('span', {}, '翻译 / 恢复'), shortcut('toggle-translate')),
        h('div', {}, h('span', {}, '切换显示方式'), shortcut('toggle-mode')),
        h('div', {}, h('span', {}, '精翻某段'), h('span', { class: 'hint' }, '右键菜单')),
      ),
    ),
    ctx,
  );
  if (!currentRender(ctx)) return;
  update = (s) => {
    if (s.estimate !== null) estimate.textContent = `约 ${s.estimate} 段，先翻可见区域`;
  };
}

async function renderActive(st: TabState, ctx: RenderContext) {
  const progressText = h('span', { class: 'hint' });
  const bar = h('div', { class: 'pp-bar-fill' });
  const statusText = h('span', { class: 'pp-status' });
  const perf = h('span', {});
  const fails = h('span', { class: 'pp-fail' });
  // Text the page translation has not reached yet: a page frame left out by auto-translate.
  const restText = h('span', {});
  const rest = h(
    'div',
    { class: 'pp-rest', hidden: true },
    restText,
    h('button', { type: 'button', class: 'btn btn-sm', onclick: () => void act({ type: 'set-enabled', enabled: true }) }, '翻译内嵌页面'),
  );

  const mode = modeSeg(st.mode, async (m) => {
    mode.set(m);
    await act({ type: 'set-mode', mode: m });
    settings = { ...settings, displayMode: m };
    await saveSettings(settings);
  });

  const styleBtns = STYLES.map(([id, label]) =>
    h(
      'button',
      {
        type: 'button',
        class: 'pp-style',
        'aria-pressed': String(settings.transStyle === id),
        onclick: async () => {
          settings = { ...settings, transStyle: id };
          styleBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(STYLES[i]![0] === id)));
          await saveSettings(settings);
        },
      },
      h('span', { class: `pp-swatch pp-swatch-${id}` }),
      label,
    ),
  );

  const resolved = st.resolvedExpert?.name;
  const expertSel = select(
    [['', `自动${resolved ? `（${resolved}）` : ''}`], ...settings.experts.map((e) => [e.id, e.name] as [string, string])],
    st.expertOverride,
    {
      class: 'inp',
      'aria-label': '场景',
      onchange: async (e: Event) => {
        await act({ type: 'set-expert', expertId: (e.target as HTMLSelectElement).value });
        toast('已切换场景，正在重新翻译');
      },
    },
  );

  const refineBtn = actionBtn('sparkle', '精翻选中段落', '先在页面上选中一段文字', 'var(--accent)', async () => {
    await act({ type: 'refine-selection' });
    toast('已开始精翻，完成后会有绿色点状下划线');
  });
  const retryBtn = actionBtn('retry', '重试失败的段落', '没有失败的段落', 'var(--danger)', async () => {
    await act({ type: 'retry-failed' });
    toast('正在重试');
  });
  const purgeBtn = actionBtn('trash', '清除本页缓存', '改了规则或术语后重译', 'var(--text-2)', async () => {
    await act({ type: 'purge-page' });
    toast('已清除缓存，正在重新翻译');
  });
  const termsList = h('ul', { class: 'pp-terms', hidden: true });
  const termsBtn = actionBtn('book', '本页术语', '长文预处理后出现', 'var(--text-2)', () => {
    termsList.hidden = !termsList.hidden;
    termsBtn.el.setAttribute('aria-expanded', String(!termsList.hidden));
  });

  const toggle = h(
    'button',
    { type: 'button', class: 'pp-big', onclick: () => void act({ type: 'set-enabled', enabled: false }) },
    '显示原文',
    shortcut('toggle-translate'),
  );

  await frame(
    st,
    h(
      'main',
      { class: 'pp-main' },
      h(
        'div',
        { class: 'card pp-hero' },
        h('div', { class: 'pp-progress-head' }, statusText, progressText),
        h('div', { class: 'pp-bar', role: 'progressbar', 'aria-label': '翻译进度' }, bar),
        h('div', { class: 'pp-perf hint' }, perf, fails),
        rest,
        toggle,
      ),
      section('显示方式', mode.el, h('span', { class: 'hint pp-inline' }, '切换不会重新请求', shortcut('toggle-mode'))),
      section('译文样式', h('div', { class: 'pp-styles' }, ...styleBtns)),
      h(
        'div',
        { class: 'pp-two' },
        h('label', { class: 'pp-sec' }, h('span', { class: 'pp-label' }, '场景'), expertSel),
        h('label', { class: 'pp-sec' }, h('span', { class: 'pp-label' }, '本站'), siteRuleSelect()),
      ),
      section('快捷操作', h('div', { class: 'pp-actions' }, refineBtn.el, retryBtn.el, purgeBtn.el, termsBtn.el), termsList),
    ),
    ctx,
  );

  if (!currentRender(ctx)) return;
  update = (s) => {
    const { segments, done, errors, pending } = s.stats;
    const pct = segments ? Math.round((done / segments) * 100) : 0;
    bar.style.width = `${pct}%`;
    bar.parentElement!.setAttribute('aria-valuenow', String(pct));
    progressText.textContent = `${done} / ${segments} 段`;
    statusText.textContent = pending ? '正在翻译可见区域' : done ? '可见区域已翻译' : segments ? '等待页面滚动' : s.rest ? '内嵌页面尚未翻译' : '这个页面没有找到可翻译的文字';
    statusText.dataset.busy = String(pending > 0);
    perf.textContent = `首屏 ${ms(s.firstPaintMs)} · 平均首字 ${ms(s.avgTtftMs)}`;
    fails.textContent = errors ? `${errors} 段失败` : '';
    rest.hidden = !s.rest;
    restText.textContent = s.rest ? `内嵌页面里还有约 ${s.rest} 段未翻译` : '';
    retryBtn.setEnabled(errors > 0, errors ? `${errors} 段，逐段重新请求` : '没有失败的段落');
    refineBtn.setEnabled(s.selectionInSegment, s.selectionInSegment ? '两次调用，覆盖缓存' : '先在页面上选中一段文字');
    purgeBtn.setEnabled(done > 0 || errors > 0);
    const terms = s.pageInfo?.terms ?? [];
    termsBtn.setEnabled(terms.length > 0, terms.length ? `预处理抽到 ${terms.length} 条` : '长文预处理后出现');
    termsList.replaceChildren(
      ...terms.map((t) => h('li', {}, h('span', { class: 'mono' }, t.src), h('span', { class: 'muted' }, t.tgt === 'KEEP' ? '保留原文' : t.tgt))),
    );
  };
  update(st);
}

function actionBtn(name: string, title: string, sub: string, color: string, onClick: () => void) {
  const subEl = h('span', { class: 'pp-act-sub' }, sub);
  const el = h(
    'button',
    { type: 'button', class: 'pp-act', onclick: onClick },
    icon(name, 18, color),
    h('span', { class: 'pp-act-title' }, title),
    subEl,
  );
  return {
    el,
    setEnabled(on: boolean, text?: string) {
      el.disabled = !on;
      if (text) subEl.textContent = text;
    },
  };
}

async function act(cmd: TabCommand) {
  const st = await send(cmd);
  if (st) void refresh(st);
}

/** What is on screen: re-render when it changes (tab, translation on/off, page reachable). */
let shown = '';
let renderingKey = '';
let refreshSequence = 0;
export async function refresh(given?: TabState | null, force = false) {
  const requestedTab = tab;
  if (force) { ++renderGeneration; renderingKey = ''; }
  const sequence = ++refreshSequence;
  const st = given ?? (await send({ type: 'get-state' }));
  if (requestedTab !== tab || sequence !== refreshSequence) return;
  const key = requestedTab === 'site' ? `site|${st ? st.lang : 'none'}` : `page|${st ? String(st.enabled) : 'none'}`;
  if (!force && key === shown) {
    if (st && requestedTab === 'page') update(st);
    return;
  }
  // Polls do not continually replace a slower render of the same tab.
  if (!force && key === renderingKey) return;
  const ctx = { generation: ++renderGeneration, tab: requestedTab };
  renderingKey = key;
  try {
    if (!st) await renderUnsupported(ctx);
    else await (st.enabled ? renderActive(st, ctx) : renderIdle(st, ctx));
    if (currentRender(ctx)) shown = key;
  } finally {
    if (currentRender(ctx) && renderingKey === key) renderingKey = '';
  }
}

async function main() {
  settings = await loadSettings();
  onSettingsChanged((s) => (settings = s));
  const [active] = await Promise.all([browser.tabs.query({ active: true, currentWindow: true }).then((t) => t[0]), loadShortcuts()]);
  tabId = active?.id;
  tabUrl = active?.url ?? '';
  try {
    host = new URL(tabUrl).hostname;
  } catch {
    host = '';
  }
  await refresh();
  setInterval(() => void refresh(), POLL_MS);
}

void main();
