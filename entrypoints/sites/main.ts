// Site localization: the standalone home of per-site language packs. Routes:
//   #/                                  all sites, how it works, import
//   #/site/<id>/overview                status, next step, learning, last scan
//   #/site/<id>/review                  what was found, by screen › section › question; one confirmation
//   #/site/<id>/entries                 translations, per context; edit, mark stale, clean up
//   #/site/<id>/history                 last scan report and generation run
//   #/site/<id>/share                   scrubbed export and import
//   #/site/<id>/settings                scope, learning, hosts, regions, delete
import { browser } from 'wxt/browser';
import type { PackJob } from '../../src/background/pack-gen';
import { parsePackFile, type EntryKind, type PackEntry, type PackIndexItem, type SitePack } from '../../src/pack/format';
import { settingsDraftPatch } from '../../src/pack/patch';
import { flagText } from '../../src/pack/harvest';
import { langLabel } from '../../src/pack/langs';
import type { PackRequest, PackResponse, PendingView, PlanView, ScanStatusView } from '../../src/pack/messages';
import { scrubForExport } from '../../src/pack/privacy';
import { reviewRowKey } from '../../src/pack/units';
import { h, toast } from '../../src/ui/dom';
import '../../src/ui/ui.css';
import '../../src/ui/app.css';
import '../options/options.css';
import './sites.css';
import { pageHead, providerStatus, rail, type RailStatus } from '../../src/ui/rail';
import { loadSettings } from '../../src/shared/settings';

type Tab = 'overview' | 'review' | 'entries' | 'history' | 'share' | 'settings';
const TABS: [Tab, string][] = [
  ['overview', '概览'],
  ['review', '审核'],
  ['entries', '译文'],
  ['history', '记录'],
  ['share', '分享'],
  ['settings', '设置'],
];

const KIND_LABEL: Record<EntryKind, string> = {
  text: '文字',
  placeholder: '输入提示',
  'aria-label': '无障碍标签',
  'aria-description': '无障碍说明',
  title: '悬停提示',
  alt: '图片说明',
  value: '按钮',
};
const SURFACE_ZH: Record<string, string> = { page: '页面', dialog: '对话框', menu: '菜单', listbox: '下拉列表', popover: '弹出层', drawer: '抽屉' };
const ROLE_ZH: Record<string, string> = {
  button: '按钮', link: '链接', tab: '标签页', menuitem: '菜单项', option: '选项', radio: '单选项', switch: '开关', checkbox: '复选框',
  heading: '标题', label: '标签', legend: '标签', description: '说明', value: '当前值', placeholder: '输入提示', tooltip: '悬停提示',
  'aria-label': '无障碍标签', image: '图片说明', text: '文字',
};
const GROUP_ZH: Record<string, string> = {
  radiogroup: '单选组', select: '下拉选择', listbox: '列表', menu: '菜单', tablist: '标签页', toolbar: '工具栏', group: '分组', field: '设置项', nav: '导航',
};
const JOB_STATE: Record<PackJob['state'], string> = { running: '正在生成', paused: '已暂停', done: '已完成', cancelled: '已取消', failed: '失败' };
const ENTRY_LIMIT = 300;

type Filter = 'all' | 'uncertain' | 'new';

const st = {
  index: [] as PackIndexItem[],
  id: '',
  tab: 'overview' as Tab,
  pack: undefined as SitePack | undefined,
  pending: [] as PendingView[],
  job: undefined as PackJob | undefined,
  scan: undefined as ScanStatusView | undefined,
  checked: new Set<string>(),
  seen: new Set<string>(),
  visibleKeys: new Set<string>(),
  description: '',
  /** The stored description `description` started from: while they match, the field follows the pack. */
  descriptionFrom: '',
  plan: undefined as PlanView | undefined,
  planFor: '',
  describePlan: undefined as PlanView | undefined,
  describePlanFor: '',
  query: '',
  filter: 'all' as Filter,
  busy: false,
  /** The settings tab's unsaved form (a copy of the pack), kept across redraws, and what it started from. */
  draft: undefined as SitePack | undefined,
  draftFrom: '',
  draftBase: undefined as SitePack | undefined,
};

/** Review selections and descriptions per site, so leaving a site and coming back keeps them. */
const reviewMemory = new Map<string, { checked: Set<string>; seen: Set<string>; description: string; descriptionFrom: string; lifecycleId?: string }>();

const settingsMemory = new Map<string, { draft: SitePack; base: SitePack }>();
let detailSequence = 0;
let mutationSequence = 0;
let routeSequence = 0;
let indexSequence = 0;
const currentSite = (id: string, sequence: number) => st.id === id && routeSequence === sequence;
const selectedKeys = () => [...st.visibleKeys].filter((key) => st.checked.has(key));
const reviewRequestKey = () => JSON.stringify([st.id, selectedKeys().sort(), st.description]);

/** The fields the settings form edits. */
const formOf = (x: SitePack) => JSON.stringify([x.site.name, x.site.hosts, x.site.scopes, x.site.description, x.options.hydration, x.options.scope, x.regions.map((r) => r.id), x.excludes]);
const draftDirty = () => !!st.draft && st.draft.id === st.pack?.id && formOf(st.draft) !== st.draftFrom;

/** Something the user is typing or a form they have not saved: a background redraw would throw it away. */
const editing = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement || (st.tab === 'settings' && draftDirty());
};

let drawLater = false;
/** Redraw for data that changed elsewhere, unless the user is in the middle of an edit (then on focus out). */
function softDraw() {
  if (editing()) drawLater = true;
  else {
    drawLater = false;
    draw();
  }
}

async function req(r: PackRequest): Promise<PackResponse> {
  try {
    return ((await browser.runtime.sendMessage(r)) as PackResponse) ?? { ok: false, error: '没有响应' };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}

const siteLink = (id: string, tab: Tab = 'overview') => `#/site/${encodeURIComponent(id)}/${tab}`;

function parseRoute(): { id: string; tab: Tab } {
  const m = location.hash.match(/^#\/site\/([^/]+)(?:\/(\w+))?/);
  if (!m) return { id: '', tab: 'overview' };
  const tab = TABS.some(([t]) => t === m[2]) ? (m[2] as Tab) : 'overview';
  return { id: decodeURIComponent(m[1]!), tab };
}

// ---------- data ----------

async function loadIndex() {
  const sequence = ++indexSequence;
  const r = await req({ type: 'pack-list' });
  if (sequence !== indexSequence) return;
  st.index = r.ok ? (r.index ?? []) : [];
}

async function loadDetail(id = st.id): Promise<boolean> {
  if (!id || id !== st.id) return false;
  const sequence = ++detailSequence;
  const [p, pend, job, scan] = await Promise.all([
    req({ type: 'pack-get', id }),
    req({ type: 'pack-pending-get', id }),
    req({ type: 'pack-job-get', id }),
    req({ type: 'pack-scan-status', packId: id }),
  ]);
  if (id !== st.id || sequence !== detailSequence) return false;
  clearTimeout(scanPoll);
  st.pack = p.ok ? p.pack : undefined;
  if (st.pack?.lifecycleId) {
    const memory = reviewMemory.get(id);
    if (memory && memory.lifecycleId !== st.pack.lifecycleId) {
      reviewMemory.delete(id);
      st.checked.clear(); st.seen.clear();
      st.description = st.descriptionFrom = '';
      st.plan = st.describePlan = undefined;
    }
    if (st.draftBase && st.draftBase.lifecycleId !== st.pack.lifecycleId) {
      settingsMemory.delete(id);
      st.draft = st.draftBase = undefined;
    }
  }
  st.pending = pend.ok ? (pend.pending ?? []) : [];
  st.job = job.ok ? (job.job as PackJob | undefined) : undefined;
  st.scan = scan.ok ? scan.scan : undefined;
  if (st.scan?.running) {
    clearTimeout(scanPoll);
    scanPoll = setTimeout(async () => {
      if (await loadDetail(id)) softDraw();
    }, 1200);
  }
  const live = new Set(st.pending.map((x) => x.key));
  for (const k of [...st.checked]) if (!live.has(k)) st.checked.delete(k);
  followDescription();
  if (st.filter === 'new' && !st.pending.some((x) => x.newContext)) st.filter = 'all';
  return true;
}

/** A description saved elsewhere (the settings tab, another window) replaces the review field,
 *  unless the user has typed their own there. */
function followDescription() {
  const stored = st.pack?.site.description ?? '';
  if (st.description === st.descriptionFrom) st.description = stored;
  st.descriptionFrom = stored;
}

/** Rows waiting for review (the unit every "N 条" on this page counts). */
const reviewRows = (filter: (p: PendingView) => boolean = () => true) => new Set(st.pending.filter(filter).map(reviewRowKey)).size;

async function route() {
  const sequence = ++routeSequence;
  const r = parseRoute();
  const changed = r.id !== st.id;
  if (changed && st.id) {
    reviewMemory.set(st.id, { checked: new Set(st.checked), seen: new Set(st.seen), description: st.description, descriptionFrom: st.descriptionFrom, lifecycleId: st.pack?.lifecycleId });
  }
  st.id = r.id;
  st.tab = r.tab;
  st.busy = false;
  st.visibleKeys.clear();
  if (changed) {
    ++detailSequence;
    clearTimeout(scanPoll);
    clearTimeout(searchTimer);
    st.pack = undefined;
    st.pending = [];
    st.job = st.scan = undefined;
    st.plan = st.describePlan = undefined;
    st.planFor = st.describePlanFor = '';
    const draft = settingsMemory.get(st.id);
    st.draft = draft?.draft;
    st.draftBase = draft?.base;
    st.draftFrom = draft ? formOf(draft.base) : '';
    st.query = '';
    st.filter = 'all';
    const kept = reviewMemory.get(st.id);
    st.checked = new Set(kept?.checked);
    st.seen = new Set(kept?.seen);
    st.description = kept?.description ?? '';
    st.descriptionFrom = kept?.descriptionFrom ?? '';
    draw();
    if (st.id && !(await loadDetail(r.id))) return;
  }
  if (!currentSite(r.id, sequence)) return;
  draw();
  window.scrollTo(0, 0);
}

let redraw: ReturnType<typeof setTimeout> | undefined;
let scanPoll: ReturnType<typeof setTimeout> | undefined;
function onStorage(changes: Record<string, unknown>, area: string) {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  const mine = st.id && keys.some((k) => [`pack:${st.id}`, `pending:${st.id}`, `job:${st.id}`, `scanReport:${st.id}`].includes(k));
  if (!keys.includes('packIndex') && !mine) return;
  clearTimeout(redraw);
  redraw = setTimeout(async () => {
    const id = st.id;
    const sequence = routeSequence;
    await loadIndex();
    if (!currentSite(id, sequence)) return;
    if (id && !st.index.some((p) => p.id === id)) {
      settingsMemory.delete(id);
      reviewMemory.delete(id);
      location.hash = '#/';
      return;
    }
    if (id && !(await loadDetail(id))) return;
    softDraw();
  }, 200);
}

/** Send one field-level change; the background applies it to the current pack in a transaction. */
async function change(r: PackRequest, okMsg?: string): Promise<boolean> {
  const id = 'id' in r ? r.id : st.id;
  if (id !== st.id) return false;
  const detailAtStart = ++detailSequence;
  const sequence = ++mutationSequence;
  const routeAtStart = routeSequence;
  const res = await req(r);
  if (!currentSite(id, routeAtStart) || sequence !== mutationSequence) return false;
  if (!res.ok) {
    toast(res.error, 'err');
    if (await loadDetail(id)) softDraw();
    return false;
  }
  // A later storage reload owns the displayed data, but this successful edit still commits its draft.
  if (res.pack && detailAtStart === detailSequence) {
    st.pack = res.pack;
    followDescription();
  }
  if (okMsg) toast(okMsg);
  return true;
}

// ---------- shell ----------

let status: RailStatus | undefined;

async function loadStatus() {
  status = providerStatus(await loadSettings());
}

function draw() {
  drawLater = false;
  st.visibleKeys.clear();
  const app = document.getElementById('app')!;
  app.replaceChildren(
    h('div', { class: 'app-shell' }, rail({ group: 'workbench', item: st.id || undefined, sites: st.index, status }), h('main', { class: 'app-main' }, ...(st.id ? siteView() : home()))),
  );
}

function importButton() {
  const input = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      (e.target as HTMLInputElement).value = '';
      if (!file) return;
      const v = parsePackFile(await file.text());
      if (!v.ok) return toast(`无法导入：${v.errors.join('；')}`, 'err');
      const exists = st.index.some((p) => p.id === v.pack.id);
      const msg = [
        `导入「${v.pack.site.name}」（${v.pack.site.hosts.join(', ')} → ${langLabel(v.pack.targetLang)}），${v.pack.entries.length} 条译文。`,
        v.warnings.length ? `已忽略 ${v.warnings.length} 处无效内容。` : '',
        exists ? '同名语言包已存在，导入会覆盖它（可先在「分享」里导出备份）。' : '',
      ].join('\n');
      if (!window.confirm(msg)) return;
      const r = await req({ type: 'pack-save', pack: v.pack, enabled: true });
      if (!r.ok) return toast(r.error, 'err');
      toast('已导入');
      await loadIndex();
      location.hash = siteLink(v.pack.id, 'entries');
    },
  });
  // A real button (keyboard reachable) that opens the hidden file field.
  return h('span', { class: 'st-import' }, h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, '导入语言包'), input);
}

// ---------- home ----------

function home(): HTMLElement[] {
  return [
    pageHead('工作台', '为没有你的语言的网页应用生成完整的界面译文，保存在本机，以后打开即显示，不再重复请求。', importButton()),
    h(
      'section',
      { class: 'card op-sec' },
      sectionTitle('怎么用'),
      h(
        'ol',
        { class: 'st-steps' },
        h('li', {}, '打开要本地化的网站；想连设置一起翻译，就先打开它的设置窗口。'),
        h('li', {}, '点扩展图标 →「一键本地化此站点」。扫描只打开导航和菜单，不改任何设置，按 Esc 可随时停止。'),
        h('li', {}, '回到这里查看找到的界面文字（按页面结构分组，个人内容不会被收集），确认一次即开始翻译。'),
        h('li', {}, '之后日常使用中出现的新界面文字会自动记下，等你确认后补充翻译。'),
      ),
    ),
    h(
      'section',
      { class: 'card op-sec' },
      sectionTitle('已本地化的网站', st.index.length ? `${st.index.length} 个` : ''),
      st.index.length
        ? h(
            'div',
            { class: 'op-table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ...['网站', '语言', '译文', '更新于', '启用'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '操作')))),
              h(
                'tbody',
                {},
                ...st.index.map((p) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('a', { class: 'st-site-link', href: siteLink(p.id) }, p.hosts.join(', '))),
                    h('td', {}, langLabel(p.targetLang)),
                    h('td', {}, String(p.entries)),
                    h('td', {}, p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('zh-CN') : '—'),
                    h('td', {}, enabledSwitch(p)),
                    h('td', { class: 'op-td-actions' }, h('a', { class: 'btn btn-sm', href: siteLink(p.id) }, '打开')),
                  ),
                ),
              ),
            ),
          )
        : h('p', { class: 'hint op-empty' }, '还没有本地化过的网站。打开一个网站，点扩展图标开始。'),
    ),
  ];
}

const sectionTitle = (title: string, meta = '') => h('div', { class: 'op-sec-head' }, h('div', { class: 'op-sec-title' }, h('h2', {}, title, meta ? h('span', { class: 'st-meta' }, meta) : null)));

function enabledSwitch(p: PackIndexItem) {
  return h(
    'label',
    { class: 'sw' },
    h('input', {
      type: 'checkbox',
      checked: p.enabled,
      'aria-label': `启用 ${p.hosts[0]} 的本地化`,
      onchange: async (e: Event) => {
        const r = await req({ type: 'pack-set-enabled', id: p.id, enabled: (e.target as HTMLInputElement).checked });
        if (!r.ok) toast(r.error, 'err');
      },
    }),
    h('span', {}),
  );
}

// ---------- site ----------

function siteView(): HTMLElement[] {
  const pack = st.pack;
  if (!pack) return [pageHead('工作台', null), h('section', { class: 'card op-sec' }, h('p', { class: 'hint' }, '这个网站的语言包不存在或已删除。'), h('div', {}, h('a', { class: 'btn btn-sm', href: '#/' }, '返回工作台')))];
  const item = st.index.find((p) => p.id === pack.id);
  const counts: Partial<Record<Tab, number>> = { review: reviewRows(), entries: pack.entries.length };
  const body =
    st.tab === 'overview'
      ? overview(pack)
      : st.tab === 'review'
        ? review(pack)
        : st.tab === 'entries'
          ? entries(pack)
          : st.tab === 'history'
            ? history()
            : st.tab === 'share'
              ? share(pack)
              : settings(pack);
  const banner = jobBanner();
  return [
    pageHead(
      pack.site.name,
      h('span', { class: 'mono' }, `${pack.site.hosts.join(', ')} → ${langLabel(pack.targetLang)} · 修订 ${pack.rev}`),
      item ? h('div', { class: 'st-enabled' }, h('span', { class: 'hint' }, '在网站上显示译文'), enabledSwitch(item)) : null,
    ),
    h(
      'nav',
      { class: 'st-tabs', 'aria-label': '语言包' },
      ...TABS.map(([t, label]) =>
        h(
          'a',
          { class: 'st-tab', href: siteLink(pack.id, t), 'aria-current': st.tab === t ? 'page' : null },
          label,
          counts[t] ? h('span', { class: `st-count${t === 'review' ? ' st-count-amber' : ''}` }, String(counts[t])) : null,
        ),
      ),
    ),
    ...(banner ? [banner] : []),
    // The review lays out its own cards (one per screen and a sticky confirmation).
    st.tab === 'review' ? body : h('section', { class: 'card op-sec' }, body),
  ];
}

/** A running or paused generation shows on every tab; a finished one only on the overview. */
function jobBanner() {
  const job = st.job;
  if (!job || job.state === 'cancelled') return null;
  const live = job.state === 'running' || job.state === 'paused';
  if (!live && st.tab !== 'overview') return null;
  const total = job.snapshot.items.length;
  const done = Object.keys(job.results).length;
  const cls = job.state === 'failed' ? 'tag-danger' : job.state === 'done' ? 'tag-ok' : job.state === 'paused' ? 'tag-warn' : 'tag-accent';
  const act = (label: string, type: 'pack-job-cancel' | 'pack-job-resume', primary = false) =>
    h('button', {
      class: `btn btn-sm${primary ? ' btn-primary' : ''}`,
      type: 'button',
      onclick: async () => {
        const r = await req({ type, id: job.packId });
        if (!r.ok) toast(r.error, 'err');
      },
    }, label);
  return h(
    'div',
    { class: 'callout st-banner', role: 'status' },
    h(
      'div',
      { class: 'st-banner-row' },
      h('span', { class: `tag ${cls}` }, JOB_STATE[job.state]),
      h('span', { class: 'op-grow' }, `已翻译 ${done} / ${total} 条${job.failed.length ? `，${job.failed.length} 条未通过校验` : ''}`),
      job.state === 'paused' ? act('取消任务', 'pack-job-cancel') : null,
      job.state === 'paused' ? act('继续', 'pack-job-resume', true) : null,
      job.state === 'running' ? act('取消任务', 'pack-job-cancel') : null,
    ),
    live ? h('div', { class: 'st-bar', role: 'progressbar', 'aria-label': '生成进度', 'aria-valuenow': String(total ? Math.round((done / total) * 100) : 0) }, h('span', { style: `width: ${total ? (done / total) * 100 : 0}%` })) : null,
    job.error ? h('span', { class: 'hint' }, job.error) : null,
  );
}

// ---------- overview ----------

function stat(value: string | number, label: string, amber = false) {
  return h('div', { class: `stat${amber ? ' amber' : ''}` }, h('b', {}, String(value)), h('span', {}, label));
}

function overview(pack: SitePack) {
  const waiting = reviewRows();
  const high = reviewRows((p) => p.tier === 'high' && !p.flags.length);
  const fresh = reviewRows((p) => !!p.newContext);
  const variants = pack.entries.filter((e) => e.ctx).length;
  const last = st.scan?.last;
  return h(
    'div',
    { class: 'op-pack-review' },
    h(
      'div',
      { class: 'stats' },
      stat(pack.entries.length, '条界面译文'),
      stat(waiting, `条待审核（${high} 条高置信度）`, waiting > 0),
      stat(variants, '条按位置区分的译文'),
      stat(last ? new Date(last.at).toLocaleDateString('zh-CN') : '—', '最近一次扫描'),
    ),
    st.scan?.running
      ? h('div', { class: 'callout callout-row', role: 'status' }, h('span', { class: 'st-banner-row' }, h('span', { class: 'tag tag-accent' }, '正在扫描'), st.scan.progress ? `已打开 ${st.scan.progress.visited} 处，找到 ${st.scan.progress.strings} 条文字` : '准备中…'))
      : null,
    st.pending.length
      ? h(
          'div',
          { class: 'callout callout-amber callout-row' },
          h('span', {}, `找到 ${waiting} 条新的界面文字${fresh ? `，其中 ${fresh} 条出现在新的位置` : ''}，确认后才会翻译。`),
          h('a', { class: 'btn btn-amber', href: siteLink(pack.id, 'review') }, `审核 ${waiting} 条`),
        )
      : h('p', { class: 'hint' }, pack.entries.length ? '没有待审核的文字。' : '还没有找到界面文字：在这个网站上点扩展图标 →「一键本地化此站点」。'),
    h(
      'div',
      { class: 'op-switch-row' },
      h('span', { class: 'op-grow' }, h('span', { class: 'op-strong' }, '日常使用中继续学习'), h('span', { class: 'hint' }, '平时浏览这个网站时，把尚未翻译的界面文字记下来等你审核（只在本机，不会自动发送；正文和个人内容不收集）。')),
      learnSwitch(pack),
    ),
    last?.refused ? h('p', { class: 'hint' }, refusedText(last.refused)) : last?.report ? scanSummary(last.report, last.at) : null,
  );
}

function learnSwitch(pack: SitePack) {
  return h(
    'label',
    { class: 'sw' },
    h('input', {
      type: 'checkbox',
      checked: pack.options.learn,
      'aria-label': '日常使用中继续学习',
      onchange: async (e: Event) => {
        const learn = (e.target as HTMLInputElement).checked;
        await change({ type: 'pack-update', id: pack.id, patch: { learn } }, learn ? '已开启日常学习' : '已关闭日常学习');
      },
    }),
    h('span', {}),
  );
}

function refusedText(r: 'draft' | 'error' | 'interrupted'): string {
  return r === 'draft' ? '没有扫描：页面或窗口里可能有未保存的修改（先保存或关闭它）。' : r === 'interrupted' ? '扫描中断：页面在扫描时刷新、跳转或关闭了。' : '扫描出错，未完成。';
}

function scanSummary(r: NonNullable<NonNullable<ScanStatusView['last']>['report']>, at: number) {
  if (r.refused) return h('p', { class: 'hint' }, `${new Date(at).toLocaleString('zh-CN')}：${refusedText(r.refused)}`);
  const outcome = r.guard
    ? `检测到设置被改动（${r.guard}），已立即停止`
    : r.stopped
      ? '已手动停止'
      : r.budgetHit
        ? `达到${r.budgetHit === 'time' ? '时间' : '操作次数'}上限，部分界面未打开`
        : '已完成';
  return h(
    'div',
    { class: 'callout' },
    h('span', { class: `tag ${r.guard ? 'tag-danger' : r.restore === 'partial' ? 'tag-warn' : 'tag-ok'}` }, r.restore === 'partial' ? '部分恢复' : '已恢复原状'),
    h('span', {}, `${new Date(at).toLocaleString('zh-CN')} 扫描${outcome}：打开 ${r.visited.length} 处，找到 ${r.strings} 条界面文字，跳过 ${r.content} 条个人或正文内容。`),
    r.unrestored.length ? h('span', { class: 'hint' }, `未能恢复：${r.unrestored.join('、')}`) : null,
  );
}

// ---------- review ----------

function screenLabel(p: PendingView, regionName: Map<string, string>): string {
  const s = p.where?.surface;
  if (!s) return regionName.get(p.region) ?? '界面';
  const [kind, ...rest] = s.split(': ');
  const k = SURFACE_ZH[kind!] ?? kind!;
  return rest.length ? `${k} · ${rest.join(': ')}` : k;
}

function review(pack: SitePack) {
  if (!st.pending.length) {
    return h('section', { class: 'card op-sec' }, h('p', { class: 'hint op-empty' }, '没有待审核的文字。在网站上点扩展图标 →「一键本地化此站点」，或者在设置里开启日常学习。'));
  }
  const regionName = new Map<string, string>([['auto', '自动识别'], ...pack.regions.map((r) => [r.id, r.builtin ? '弹出菜单 / 对话框 / 提示' : r.label] as [string, string])]);
  const shows = (p: PendingView) => (st.filter === 'uncertain' ? p.tier !== 'high' || p.flags.length > 0 : st.filter === 'new' ? !!p.newContext : true);
  // A string whose translation does not depend on its place ("Close" in every section) is one row,
  // shown where it was first seen; its checkbox covers every occurrence.
  type Row = { p: PendingView; keys: string[]; all: PendingView[] };
  const rowOf = new Map<string, Row>();
  const rows: Row[] = [];
  for (const p of st.pending) {
    const id = reviewRowKey(p);
    const r = rowOf.get(id);
    if (r) {
      r.keys.push(p.key);
      r.all.push(p);
    } else {
      const row = { p, keys: [p.key], all: [p] };
      rowOf.set(id, row);
      rows.push(row);
    }
  }
  // The filter picks rows; the counts below always cover every row.
  const visibleRows = rows.filter((r) => r.all.some(shows));
  // Defaults become active only when this row is actually presented to the user.
  st.visibleKeys = new Set(visibleRows.flatMap((r) => r.keys));
  for (const row of visibleRows) for (const p of row.all) {
    if (!st.seen.has(p.key) && p.tier === 'high' && !p.flags.length) st.checked.add(p.key);
    st.seen.add(p.key);
  }
  // screen › section › group, in collection order.
  const tree = new Map<string, Map<string, Map<string, Row[]>>>();
  for (const row of visibleRows) {
    const p = row.p;
    const screen = screenLabel(p, regionName);
    const section = p.where?.section ?? '';
    const group = p.where?.groupRole ? `${p.where.groupRole}\u0001${p.where.group ?? ''}` : '';
    const secs = tree.get(screen) ?? tree.set(screen, new Map()).get(screen)!;
    const groups = secs.get(section) ?? secs.set(section, new Map()).get(section)!;
    (groups.get(group) ?? groups.set(group, []).get(group)!).push(row);
  }
  const screenCount = new Set(rows.map((r) => screenLabel(r.p, regionName))).size;
  const sections = new Set(st.pending.map((p) => `${p.where?.surface}\u0001${p.where?.section ?? ''}`)).size;
  const questions = new Set(st.pending.filter((p) => p.where?.group).map((p) => `${p.where?.section}\u0001${p.where?.group}`)).size;
  const doubtful = (p: PendingView) => p.tier !== 'high' || p.flags.length > 0;
  const uncertain = rows.filter((r) => r.all.some(doubtful)).length;
  const fresh = rows.filter((r) => r.all.some((p) => p.newContext)).length;
  /** Bulk actions under a filter touch only the rows on screen. */
  const targets = () => visibleRows.flatMap((r) => r.keys.filter((k) => st.checked.has(k)));
  const targetRows = () => visibleRows.filter((r) => r.keys.some((k) => st.checked.has(k))).length;

  const count = h('span', { class: 'op-strong' });
  const confirmBox = h('div', { class: 'card st-confirm' });
  const planKey = reviewRequestKey;
  const picked = () => visibleRows.filter((r) => r.keys.some((k) => st.checked.has(k))).length;
  const refresh = () => {
    const n = picked();
    count.textContent = `已选 ${n} / ${rows.length} 条${targets().length !== n ? `（覆盖 ${targets().length} 处）` : ''}`;
    drawConfirm();
  };

  const isChecked = (row: Row) => row.keys.every((k) => st.checked.has(k));
  const setChecked = (row: Row, on: boolean) => row.keys.forEach((k) => (on ? st.checked.add(k) : st.checked.delete(k)));
  const itemRow = (row: Row, onToggle: () => void) => {
    const p = row.p;
    const reason = p.flags.length ? flagText(p.flags) : p.tier !== 'high' ? p.reason : undefined;
    const box = h('input', {
      type: 'checkbox',
      checked: isChecked(row),
      onchange: (e: Event) => {
        setChecked(row, (e.target as HTMLInputElement).checked);
        onToggle();
      },
    });
    // Some occurrences picked by default and some not (one place looked like a name).
    box.indeterminate = !box.checked && row.keys.some((k) => st.checked.has(k));
    return h(
      'label',
      { class: `st-item ${reason ? 'uncertain' : ''}` },
      box,
      h('span', { class: 'st-src' }, p.src),
      row.keys.length > 1 ? h('span', { class: 'hint', title: '同一段文字出现在多个位置，译文相同' }, `另有 ${row.keys.length - 1} 处`) : null,
      h('span', { class: 'tag' }, p.where?.role ? (ROLE_ZH[p.where.role] ?? p.where.role) : KIND_LABEL[p.kind]),
      p.newContext ? h('span', { class: 'tag tag-accent', title: '这段文字已有译文，但出现在了新的位置，可能需要不同的译法' }, '新语境') : null,
      reason ? h('span', { class: 'tag tag-warn', title: '默认不勾选' }, reason) : null,
    );
  };

  const groupBox = (gkey: string, items: Row[]) => {
    const [role, label] = gkey.split('\u0001');
    const box = h('input', { type: 'checkbox', 'aria-label': `全选：${label || GROUP_ZH[role!] || '分组'}` });
    const sync = () => {
      const n = items.filter(isChecked).length;
      box.checked = n === items.length;
      box.indeterminate = !box.checked && items.some((r) => r.keys.some((k) => st.checked.has(k)));
    };
    const els = items.map((r) => itemRow(r, () => { sync(); refresh(); }));
    box.addEventListener('change', () => {
      for (const r of items) setChecked(r, box.checked);
      els.forEach((el, i) => {
        const input = el.querySelector('input') as HTMLInputElement;
        input.checked = isChecked(items[i]!);
        input.indeterminate = false;
      });
      sync();
      refresh();
    });
    sync();
    return h(
      'div',
      { class: 'st-group' },
      h('label', { class: 'st-group-head' }, box, h('span', {}, label || '（无标签）'), h('span', { class: 'tag' }, GROUP_ZH[role!] ?? role!)),
      ...els,
    );
  };

  const screens = [...tree].map(([screen, secs]) =>
    h(
      'div',
      { class: 'card st-screen' },
      h('h3', {}, screen),
      ...[...secs].map(([section, groups]) =>
        h(
          'div',
          { class: section ? 'st-section' : 'op-pack-group' },
          section ? h('h4', {}, section) : null,
          ...[...groups].map(([gkey, items]) => (gkey ? groupBox(gkey, items) : h('div', { class: 'op-pack-group' }, ...items.map((r) => itemRow(r, refresh))))),
        ),
      ),
    ),
  );

  const filterBtn = (f: Filter, label: string) =>
    h('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': String(st.filter === f), onclick: () => { st.filter = f; draw(); } }, label);

  // The description field is built once: typing never rebuilds it (cursor and IME stay put);
  // only the preview and the buttons below it are redrawn.
  const desc = h('textarea', {
    class: 'inp',
    rows: 2,
    placeholder: '这个应用是做什么的（例如：一个 AI 对话助手，左侧是会话列表，设置里有外观、账户和隐私选项）。可留空。',
    'aria-label': '应用描述',
    oninput: (e: Event) => {
      st.description = (e.target as HTMLTextAreaElement).value;
      if (st.plan || st.describePlan) drawConfirm(); // the preview no longer matches: drop it
    },
  }, st.description);
  const below = h('div', { class: 'st-confirm-below' });
  confirmBox.append(h('div', { class: 'st-confirm-head' }, count, h('span', { class: 'hint' }, '确认前不会发送任何内容')), desc, below);
  /** Disable the clicked button at once so a double click sends one request. */
  const once = (run: () => Promise<void>) => async (e: Event) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await run();
    } finally {
      btn.disabled = false;
    }
  };

  const drawConfirm = () => {
    if (st.plan && st.planFor !== planKey()) st.plan = undefined;
    if (st.describePlan && st.describePlanFor !== planKey()) st.describePlan = undefined;
    const plan = st.plan;
    const dplan = st.describePlan;
    const describeBox = dplan
      ? h(
          'div',
          { class: 'op-pack-review' },
          planView(dplan, '起草应用描述'),
          h(
            'div',
            { class: 'op-row-end st-actions' },
            h('button', { class: 'btn', type: 'button', onclick: () => { st.describePlan = undefined; drawConfirm(); } }, '取消'),
            h('button', {
              class: 'btn btn-primary',
              type: 'button',
              onclick: once(async () => {
                const requestKey = planKey();
                const sequence = routeSequence;
                const r = await req({ type: 'pack-describe', id: pack.id, planId: dplan.planId });
                if (!currentSite(pack.id, sequence) || requestKey !== planKey()) return;
                st.describePlan = undefined;
                if (!r.ok) {
                  toast(r.error, 'err');
                  return drawConfirm();
                }
                st.description = desc.value = r.text ?? '';
                st.plan = undefined;
                drawConfirm();
              }),
            }, '确认发送'),
          ),
        )
      : null;
    below.replaceChildren(
      ...(describeBox ? [describeBox] : []),
      ...(plan ? [planView(plan)] : []),
      h(
        'div',
        { class: 'op-row-end st-actions' },
        h('button', {
          class: 'btn',
          type: 'button',
          disabled: !!dplan || !targets().length,
          onclick: once(async () => {
            if (!targets().length) return toast('先勾选一些文字', 'err');
            const requestKey = planKey();
            const sequence = routeSequence;
            // Same rule as generation: the user sees the exact request before it is sent.
            const r = await req({ type: 'pack-describe-plan', id: pack.id, keys: targets() });
            if (!currentSite(pack.id, sequence) || requestKey !== planKey()) return;
            if (!r.ok) return toast(r.error, 'err');
            st.describePlan = r.plan;
            st.describePlanFor = requestKey;
            if (confirmBox.isConnected) drawConfirm(); else softDraw();
          }),
        }, '根据已选文字起草描述…'),
        plan
          ? h('button', {
              class: 'btn btn-primary',
              type: 'button',
              disabled: st.busy,
              onclick: once(async () => {
                if (st.busy) return;
                st.busy = true;
                const sequence = routeSequence;
                const r = await req({ type: 'pack-generate', id: pack.id, planId: plan.planId });
                if (!currentSite(pack.id, sequence)) return;
                st.busy = false;
                if (!r.ok) return toast(r.error, 'err');
                toast('已开始生成，完成的条目会立即在已打开的页面生效');
                st.plan = undefined;
                if (await loadDetail(pack.id)) draw();
              }),
            }, '确认发送并生成')
          : h('button', {
              class: 'btn btn-primary',
              type: 'button',
              disabled: !targets().length,
              onclick: once(async () => {
                if (!targets().length) return toast('先勾选要翻译的文字', 'err');
                const requestKey = planKey();
                const sequence = routeSequence;
                const r = await req({ type: 'pack-plan', id: pack.id, keys: targets(), description: st.description });
                if (!currentSite(pack.id, sequence) || requestKey !== planKey()) return;
                if (!r.ok) return toast(r.error, 'err');
                st.plan = r.plan;
                st.planFor = requestKey;
                if (confirmBox.isConnected) drawConfirm(); else softDraw();
              }),
            }, `翻译已选的 ${picked()} 条…`),
      ),
    );
  };

  const allUncertain = uncertain === rows.length;
  const intro = h(
    'section',
    { class: 'card op-sec st-review-head' },
    h('p', {}, `找到 ${rows.length} 条界面文字${rows.length !== st.pending.length ? `（出现在 ${st.pending.length} 处）` : ''}，分布在 ${screenCount} 个界面、${sections} 个分区、${questions} 个问题组。高置信度的已默认勾选；${uncertain} 条可能是内容或名字，默认不勾选${fresh ? `；${fresh} 条已翻译过的文字出现在新位置` : ''}。`),
    allUncertain
      ? h('div', { class: 'callout callout-amber' }, h('span', {}, '剩下的都是「需要留意」的条目（可能是名字、数字、标识符或过长的文字），所以一条都没有自动勾选。确认是界面文字的再手动勾选；不需要的可以「不再收集」。'))
      : null,
    h(
      'div',
      { class: 'st-filters' },
      filterBtn('all', '全部'),
      filterBtn('uncertain', `需要留意 ${uncertain}`),
      fresh ? filterBtn('new', `新语境 ${fresh}`) : null,
      h('span', { class: 'op-grow' }),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { for (const r of visibleRows) for (const p of r.all) { if (p.tier === 'high' && !p.flags.length) st.checked.add(p.key); else st.checked.delete(p.key); } draw(); } }, '恢复默认勾选'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { for (const key of st.visibleKeys) st.checked.delete(key); draw(); } }, '全不选'),
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async () => {
          const keys = targets();
          if (!keys.length) return toast(st.filter === 'all' ? '先勾选一些文字' : '这个筛选下没有勾选的文字', 'err');
          if (!window.confirm(`从待审核中移除已选的 ${targetRows()} 条？以后再出现还会被记下。`)) return;
          const sequence = routeSequence;
          const res = await req({ type: 'pack-pending-clear', id: pack.id, keys });
          if (!currentSite(pack.id, sequence)) return;
          if (!res.ok) return toast(res.error, 'err');
          for (const k of keys) st.checked.delete(k);
          if (await loadDetail(pack.id)) draw();
        },
      }, '移除所选'),
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async () => {
          const keys = targets();
          if (!keys.length) return toast(st.filter === 'all' ? '先勾选一些文字' : '这个筛选下没有勾选的文字', 'err');
          if (!window.confirm(`移除已选的 ${targetRows()} 条，并且以后不再收集这些文字？`)) return;
          const sequence = routeSequence;
          const res = await req({ type: 'pack-pending-ignore', id: pack.id, keys });
          if (!currentSite(pack.id, sequence)) return;
          if (!res.ok) return toast(res.error, 'err');
          for (const k of keys) st.checked.delete(k);
          if (await loadDetail(pack.id)) draw();
        },
      }, '不再收集所选'),
    ),
  );
  const empty = visibleRows.length ? null : h('section', { class: 'card op-sec' }, h('p', { class: 'hint op-empty' }, '这个筛选下没有条目。'));
  const node = h('div', { class: 'st-review' }, intro, ...screens, empty, confirmBox);
  refresh();
  return node;
}

function planView(plan: PlanView, purpose = '翻译') {
  const dest = (d: PlanView['destination']) => `${d.name}（${d.baseURL}，${d.model}）`;
  return h(
    'div',
    { class: 'callout' },
    h('span', { class: 'op-strong' }, `${purpose}：将发送 ${plan.items} 条界面文字，分 ${plan.messages.length} 次请求，到：${dest(plan.destination)}`),
    plan.fallback ? h('span', { class: 'hint' }, `主服务商失败时改用：${dest(plan.fallback)}`) : null,
    h('span', { class: 'hint' }, `预估：${plan.estimate}。下面就是会发送的全部内容，不含页面标题、网址或正文。个别条目未通过校验时，会连同所在分组再请求最多两次。`),
    ...plan.messages.map((msgs, i) =>
      h(
        'details',
        {},
        h('summary', {}, `第 ${i + 1} 次请求`),
        ...msgs.map((m) => h('div', {}, h('div', { class: 'hint' }, m.role === 'system' ? '系统提示' : '用户消息'), h('pre', { class: 'op-pre' }, m.content))),
      ),
    ),
  );
}

// ---------- entries ----------

let searchTimer: ReturnType<typeof setTimeout> | undefined;

const whereText = (e: PackEntry) => [e.where?.section, e.where?.group].filter(Boolean).join(' › ');

function entries(pack: SitePack) {
  const q = st.query.trim().toLowerCase();
  const list = pack.entries.filter((e) => !q || e.src.toLowerCase().includes(q) || e.t.toLowerCase().includes(q) || whereText(e).toLowerCase().includes(q));
  const shown = list.slice(0, ENTRY_LIMIT);
  const search = h('input', {
    class: 'inp',
    type: 'search',
    placeholder: '搜索原文、译文或位置',
    value: st.query,
    'aria-label': '搜索条目',
    oninput: (e: Event) => {
      st.query = (e.target as HTMLInputElement).value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        draw();
        const el = document.querySelector<HTMLInputElement>('input[type="search"]');
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      }, 250);
    },
  });
  const stale = pack.entries.filter((e) => e.status === 'stale').length;
  return h(
    'div',
    { class: 'op-pack-review' },
    h(
      'div',
      { class: 'op-row-end op-pack-toolbar' },
      search,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (await change({ type: 'pack-entries-stale', id: pack.id, op: 'mark' })) {
          toast(`${st.pack?.entries.filter((e) => e.status === 'stale').length ?? 0} 条标记为过期（60 天没出现过）`);
          draw();
        }
      } }, '标记过期'),
      stale
        ? h('button', { class: 'btn', type: 'button', onclick: async () => {
            if (!window.confirm(`删除 ${stale} 条过期条目？`)) return;
            if (await change({ type: 'pack-entries-stale', id: pack.id, op: 'clean' }, '已清理')) draw();
          } }, `清理过期 ${stale}`)
        : null,
    ),
    list.length > ENTRY_LIMIT ? h('p', { class: 'hint' }, `共 ${list.length} 条，只显示前 ${ENTRY_LIMIT} 条，请用搜索缩小范围。`) : null,
    !list.length
      ? h('p', { class: 'hint op-empty' }, q ? '没有匹配的条目。' : '还没有译文：先在「审核」里确认要翻译的文字。')
      : h(
      'div',
      { class: 'op-table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, ...['原文', '位置', '类型', '译文', '状态'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '操作')))),
        h(
          'tbody',
          {},
          ...shown.map((e) =>
            h(
              'tr',
              {},
              h('td', { class: 'op-cand-text' }, e.src),
              h('td', { class: 'hint st-where' }, h('span', {}, whereText(e) || (e.ctx ? '特定位置' : '所有位置')), e.ctx ? h('span', { class: 'tag', title: '这条译文只用于这个位置；同一原文在别处可以有不同译法' }, '按位置') : null),
              h('td', {}, h('span', { class: 'tag' }, e.where?.role ? (ROLE_ZH[e.where.role] ?? KIND_LABEL[e.kind]) : KIND_LABEL[e.kind])),
              h(
                'td',
                {},
                h('input', {
                  class: 'inp',
                  value: e.t,
                  'aria-label': `${e.src} 的译文（${[KIND_LABEL[e.kind], whereText(e)].filter(Boolean).join('，')}）`,
                  onchange: async (ev: Event) => {
                    const t = (ev.target as HTMLInputElement).value.trim();
                    if (!t || t === e.t) return;
                    await change({ type: 'pack-entry-edit', id: pack.id, kind: e.kind, src: e.src, ...(e.ctx ? { ctx: e.ctx } : {}), t }, '已保存');
                  },
                }),
                e.t.length > e.src.length * 1.6 + 4 ? h('span', { class: 'hint' }, '译文较长，可能撑破布局') : null,
              ),
              h('td', {}, h('span', { class: `tag ${e.status === 'edited' ? 'tag-accent' : e.status === 'stale' ? 'tag-warn' : ''}` }, e.status === 'edited' ? '已修改' : e.status === 'stale' ? '过期' : '自动')),
              h('td', { class: 'op-td-actions' }, h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': `删除 ${e.src}`, onclick: async () => {
                if (await change({ type: 'pack-entry-edit', id: pack.id, kind: e.kind, src: e.src, ...(e.ctx ? { ctx: e.ctx } : {}), remove: true })) draw();
              } }, '删除')),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------- history ----------

function history() {
  const last = st.scan?.last;
  const job = st.job;
  const r = last?.report;
  return h(
    'div',
    { class: 'op-pack-review' },
    h('h3', {}, '最近一次扫描'),
    !last
      ? h('p', { class: 'hint' }, '还没有扫描记录（记录保留 30 天）。')
      : last.refused
        ? h('p', { class: 'hint' }, `${new Date(last.at).toLocaleString('zh-CN')}：${refusedText(last.refused)}`)
        : r
          ? h(
              'div',
              { class: 'op-pack-review' },
              scanSummary(r, last.at),
              h('span', { class: 'hint' }, `用时 ${(r.ms / 1000).toFixed(1)} 秒，${r.actions} 次操作。`),
              r.visited.length ? h('details', {}, h('summary', {}, `打开过的界面 ${r.visited.length}`), h('ul', { class: 'st-list' }, ...r.visited.map((v) => h('li', {}, v)))) : null,
              r.skipped.length ? h('details', {}, h('summary', {}, `跳过 ${r.skipped.length}`), h('ul', { class: 'st-list' }, ...r.skipped.map((s) => h('li', {}, `${s.label}${s.count ? `（${s.count} 处）` : ''} — ${s.reason}`)))) : null,
            )
          : null,
    last
      ? h('div', { class: 'op-row-end' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { const id = st.id; const sequence = routeSequence; await req({ type: 'pack-scan-clear', id }); if (currentSite(id, sequence) && await loadDetail(id)) draw(); } }, '清除扫描记录'))
      : null,
    h('h3', {}, '最近一次生成'),
    job
      ? h(
          'div',
          { class: 'callout' },
          h('span', {}, `${JOB_STATE[job.state]}：${Object.keys(job.results).length} / ${job.snapshot.items.length} 条，${new Date(job.createdAt).toLocaleString('zh-CN')}`),
          job.metrics
            ? h('span', { class: 'hint' }, `${job.metrics.requests} 次请求（含 ${job.metrics.retries} 次重试），用时 ${(job.metrics.ms / 1000).toFixed(1)} 秒，${job.tokens.prompt + job.tokens.completion} tokens${job.metrics.cachedTokens ? `（缓存命中 ${job.metrics.cachedTokens}）` : ''}`)
            : null,
        )
      : h('p', { class: 'hint' }, '还没有生成过。'),
  );
}

// ---------- share ----------

function share(pack: SitePack) {
  let exported: ReturnType<typeof scrubForExport>;
  try { exported = scrubForExport(pack); } catch (e) {
    return h('div', { class: 'callout callout-amber', role: 'alert' }, h('span', {}, `暂不能导出：${String((e as Error).message ?? e)}`), h('a', { class: 'btn', href: siteLink(pack.id, 'settings') }, '修改设置'));
  }
  const { pack: clean, report } = exported;
  const json = JSON.stringify(clean, null, 2);
  return h(
    'div',
    { class: 'op-pack-export' },
    h('p', { class: 'hint' }, '导出前已自动清洗：只保留已批准的界面译文，去掉时间戳，移除疑似个人信息的条目、位置信息、区域选择器、术语和备注。分享前请再看一遍下面的内容。'),
    report.removed.length
      ? h('details', { open: true }, h('summary', {}, `已移除 ${report.removed.length} 项`), h('ul', { class: 'st-list' }, ...report.removed.map((r) => h('li', {}, h('span', { class: 'op-cand-text' }, r.what), ' — ', r.reason))))
      : h('p', { class: 'hint' }, '没有需要移除的内容。'),
    h('details', {}, h('summary', {}, `预览 JSON（${clean.entries.length} 条，${(new Blob([json]).size / 1024).toFixed(1)} KB）`), h('pre', { class: 'op-pre' }, json)),
    h(
      'div',
      { class: 'op-row-end' },
      importButton(),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
        const a = h('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: `${pack.site.hosts[0]}.${pack.targetLang}.translucid-pack.json` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, '下载 JSON'),
    ),
  );
}

// ---------- settings ----------

function settings(pack: SitePack) {
  // One form per site, kept across redraws; it follows the pack while the user has not changed it.
  if (!st.draft || st.draft.id !== pack.id || (!draftDirty() && formOf(pack) !== st.draftFrom)) {
    st.draft = structuredClone(pack);
    st.draftFrom = formOf(pack);
    st.draftBase = structuredClone(pack);
    settingsMemory.set(pack.id, { draft: st.draft, base: st.draftBase });
  }
  const draft = st.draft;
  const input = (value: string, set: (v: string) => void, label: string) =>
    h('input', { class: 'inp', value, 'aria-label': label, oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  return h(
    'div',
    { class: 'op-pack-settings' },
    h(
      'div',
      { class: 'op-switch-row' },
      h('span', { class: 'op-grow' }, h('span', { class: 'op-strong' }, '日常使用中继续学习'), h('span', { class: 'hint' }, '只在本机记录新出现的界面文字，等你审核；扫描期间自动暂停。')),
      learnSwitch(pack),
    ),
    h(
      'label',
      { class: 'op-field' },
      h('span', { class: 'lbl' }, '收集范围'),
      h(
        'select',
        { class: 'inp', onchange: (e: Event) => (draft.options.scope = (e.target as HTMLSelectElement).value as SitePack['options']['scope']) },
        h('option', { value: 'auto', selected: draft.options.scope === 'auto' }, '自动识别界面（推荐）'),
        h('option', { value: 'regions', selected: draft.options.scope === 'regions' }, '只在我圈选的区域'),
      ),
      h('span', { class: 'hint' }, '自动识别会跳过正文、编辑器、会话列表和账户信息。需要精确控制时，可在网站上用扩展菜单里的「调整范围」圈选区域。'),
    ),
    h(
      'div',
      { class: 'op-grid2' },
      h('label', { class: 'op-field' }, h('span', { class: 'lbl' }, '名称'), input(draft.site.name, (v) => (draft.site.name = v), '名称')),
      h('label', { class: 'op-field' }, h('span', { class: 'lbl' }, '域名（逗号分隔）'), input(draft.site.hosts.join(', '), (v) => (draft.site.hosts = v.split(',').map((x) => x.trim()).filter(Boolean)), '域名')),
      h('label', { class: 'op-field' }, h('span', { class: 'lbl' }, '路径范围（逗号分隔）'), input(draft.site.scopes.join(', '), (v) => (draft.site.scopes = v.split(',').map((x) => x.trim()).filter(Boolean)), '路径范围')),
      h(
        'label',
        { class: 'op-field' },
        h('span', { class: 'lbl' }, '应用时机'),
        h(
          'select',
          { class: 'inp', onchange: (e: Event) => (draft.options.hydration = (e.target as HTMLSelectElement).value as SitePack['options']['hydration']) },
          h('option', { value: 'after-idle', selected: draft.options.hydration === 'after-idle' }, '页面加载并稳定后（推荐，兼容服务端渲染）'),
          h('option', { value: 'immediate', selected: draft.options.hydration === 'immediate' }, '立即（更快，可能干扰服务端渲染的应用）'),
        ),
      ),
    ),
    h('label', { class: 'op-field' }, h('span', { class: 'lbl' }, '应用描述'), h('textarea', { class: 'inp', rows: 2, 'aria-label': '应用描述', oninput: (e: Event) => (draft.site.description = (e.target as HTMLTextAreaElement).value) }, draft.site.description)),
    h(
      'div',
      { class: 'op-field' },
      h('span', { class: 'lbl' }, '圈选的界面区域（总是收集）'),
      ...draft.regions.map((r) =>
        h('div', { class: 'op-cand' }, h('span', {}, r.builtin ? '弹出菜单 / 对话框 / 提示' : r.label), r.selector ? h('code', { class: 'mono' }, r.selector) : null,
          h('button', { class: 'btn btn-sm', type: 'button', onclick: (e: Event) => { draft.regions = draft.regions.filter((x) => x !== r); (e.target as HTMLElement).closest('.op-cand')?.remove(); } }, '移除'))),
      draft.regions.length ? null : h('span', { class: 'hint' }, '无'),
    ),
    h(
      'div',
      { class: 'op-field' },
      h('span', { class: 'lbl' }, '排除的内容区域（从不收集）'),
      ...draft.excludes.map((sel) =>
        h('div', { class: 'op-cand' }, h('code', { class: 'mono' }, sel),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: (e: Event) => { draft.excludes = draft.excludes.filter((x) => x !== sel); (e.target as HTMLElement).closest('.op-cand')?.remove(); } }, '移除'))),
      draft.excludes.length ? null : h('span', { class: 'hint' }, '无'),
    ),
    h(
      'div',
      { class: 'op-row-between st-settings-actions' },
      h('div', { class: 'op-row-end' },
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!window.confirm('清空所有待审核的文字和「不再收集」列表？')) return;
        const sequence = routeSequence;
        await req({ type: 'pack-pending-clear', id: pack.id });
        if (currentSite(pack.id, sequence) && await loadDetail(pack.id)) draw();
      } }, '清空待审核'),
      h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
        if (!window.confirm(`删除「${pack.site.name}」语言包？已打开的页面会恢复原文，此操作无法撤销（可先在「分享」里导出备份）。`)) return;
        const sequence = routeSequence;
        const r = await req({ type: 'pack-delete', id: pack.id });
        if (r.ok) { settingsMemory.delete(pack.id); reviewMemory.delete(pack.id); }
        if (!currentSite(pack.id, sequence)) return;
        if (!r.ok) return toast(r.error, 'err');
        toast('已删除');
        await loadIndex();
        if (currentSite(pack.id, sequence)) location.hash = '#/';
      } }, '删除语言包'),
      ),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => {
        const base = st.draftBase!;
        const submitted = structuredClone(draft);
        const patch = settingsDraftPatch(base, submitted);
        if (!Object.keys(patch).length) return toast('没有改动');
        void change({ type: 'pack-update', id: pack.id, patch }, '设置已保存').then((ok) => {
          if (!ok || st.draft !== draft) return;
          if (formOf(draft) === formOf(submitted)) {
            settingsMemory.delete(pack.id);
            st.draft = st.draftBase = undefined;
          } else {
            st.draftBase = submitted;
            st.draftFrom = formOf(submitted);
            settingsMemory.set(pack.id, { draft, base: submitted });
          }
          draw();
        });
      } }, '保存设置'),
    ),
  );
}

async function main() {
  await Promise.all([loadIndex(), loadStatus()]);
  browser.storage.onChanged.addListener(onStorage);
  // A redraw put off while the user was typing happens once they leave the field; never between
  // pressing and releasing the mouse, so the click that moved focus still lands.
  let pointerDown = false;
  const flush = () => setTimeout(() => {
    if (drawLater && !pointerDown && !editing()) {
      drawLater = false;
      draw();
    }
  }, 120);
  document.addEventListener('pointerdown', () => (pointerDown = true), true);
  document.addEventListener('pointerup', () => {
    pointerDown = false;
    flush();
  }, true);
  document.addEventListener('pointercancel', () => { pointerDown = false; flush(); }, true);
  document.addEventListener('focusout', flush);
  window.addEventListener('beforeunload', (e) => {
    if ([...settingsMemory.values()].some(({ draft, base }) => formOf(draft) !== formOf(base))) e.preventDefault();
  });
  window.addEventListener('hashchange', () => void route());
  await route();
}

void main();
