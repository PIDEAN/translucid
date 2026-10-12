import { browser } from 'wxt/browser';
import { BUILTIN_EXPERTS } from '../../src/prompt/experts/builtin';
import { KEEP, parseGlossary, serializeGlossary } from '../../src/prompt/glossary';
import { type CostLine, estimateCost, formatCost, formatCostLines, monthKey } from '../../src/shared/cost';
import type { RuntimeRequest } from '../../src/shared/messages';
import { PROVIDER_PRESETS } from '../../src/shared/presets';
import {
  defaultPrice,
  isDeepSeekPeak,
  isMachineTranslation,
  localTimeZone,
  MODEL_SUGGESTIONS,
  peakWindowsIn,
  providerReady,
  resolvedPrice,
  vendorOf,
} from '../../src/shared/pricing';
import { loadSettings, onSettingsChanged, saveSettings } from '../../src/shared/settings';
import { SITE_DEFAULTS } from '../../src/shared/site-defaults';
import type { Expert, GlossaryEntry, PriceOverride, ProviderConfig, Settings, SiteRule, UsageStats } from '../../src/shared/types';
import { mergeSettings, syncSettingsDraft } from '../../src/ui/settings-merge';
import { h, select, toast } from '../../src/ui/dom';
import { icon } from '../../src/ui/icons';
import { providerLogo } from '../../src/ui/provider-logos';
import '../../src/ui/ui.css';
import '../../src/ui/app.css';
import './options.css';
import { CONFIG_ITEMS, IMMERSIVE_ITEMS, pageHead, providerStatus, rail } from '../../src/ui/rail';
import type { PackIndexItem } from '../../src/pack/format';

// ---------- state ----------

let s: Settings;
let saved = '';
let saving = false;
let pointerPressed = false;
let renderDeferred = false;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
const tests = new Map<string, { ok: boolean; text: string; pending?: boolean }>();
const openProviders = new Set<string>();
let openRouterModels: string[] = MODEL_SUGGESTIONS.openrouter;
let loadingOpenRouterModels = false;
let selectedExpertId = '';
let glossaryScope = ''; // '' = global, otherwise a site rule host
let glossaryBatch = false;
/** The glossary row being edited (by its source text, so deleting another row cannot shift it) and the
 *  text typed so far; the add form's text lives here too. Both survive renderAll(). */
let editingTerm: string | null = null;
let termDraft = { src: '', tgt: '', note: '' };
const addDraft = { src: '', tgt: '', note: '' };
let usage: UsageStats = {};
let cacheCount = 0;

const rt = <T>(req: RuntimeRequest) => browser.runtime.sendMessage(req) as Promise<T>;
const isDirty = () => JSON.stringify(s) !== saved;

// ---------- small controls ----------

type Attrs = Parameters<typeof h>[1];

const field = (label: string, control: HTMLElement, hint?: string) =>
  h('label', { class: 'op-field' }, h('span', { class: 'lbl' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);

const text = (value: string, set: (v: string) => void, attrs: Attrs = {}) =>
  h('input', { class: 'inp', type: 'text', value, oninput: (e: Event) => set((e.target as HTMLInputElement).value), ...attrs });

const num = (value: number, set: (v: number) => void, attrs: Attrs = {}) =>
  h('input', {
    class: 'inp',
    type: 'number',
    value,
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(v)) set(v);
    },
    ...attrs,
  });

const area = (value: string, set: (v: string) => void, rows = 4, attrs: Attrs = {}) =>
  h('textarea', { class: 'inp mono', rows, oninput: (e: Event) => set((e.target as HTMLTextAreaElement).value), ...attrs }, value);

const sel = (options: [string, string][], value: string, set: (v: string) => void, attrs: Attrs = {}) =>
  select(options, value, { class: 'inp', onchange: (e: Event) => set((e.target as HTMLSelectElement).value), ...attrs });

function switchRow(title: string, hint: string, value: boolean, set: (v: boolean) => void) {
  return h(
    'label',
    { class: 'op-switch-row' },
    h('span', { class: 'op-grow' }, h('span', { class: 'op-strong' }, title), h('span', { class: 'hint' }, hint)),
    h(
      'span',
      { class: 'sw' },
      h('input', { type: 'checkbox', checked: value, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }),
      h('span', {}),
    ),
  );
}

/** Disclosure that stays open or closed across re-renders (renderAll rebuilds the page). */
const detailsOpen = new Map<string, boolean>();
function disclosure(key: string, summary: string, defaultOpen: boolean, ...body: (Node | null)[]) {
  const el = h('details', { class: 'op-details', open: detailsOpen.get(key) ?? defaultOpen }, h('summary', {}, summary), ...body);
  el.addEventListener('toggle', () => detailsOpen.set(key, el.open));
  return el;
}

function sectionHead(title: string, desc: string, ...actions: (Node | null)[]) {
  return h(
    'div',
    { class: 'op-sec-head' },
    h('div', { class: 'op-sec-title' }, h('h2', {}, title), desc ? h('p', { class: 'hint' }, desc) : null),
    actions.length ? h('div', { class: 'op-actions' }, ...actions) : null,
  );
}

// ---------- providers ----------

function testState(p: ProviderConfig): { label: string; cls: string } {
  // Unconfigured presets are normal; only flag the ones a role points at.
  const used = [s.activeProviderId, s.shortTextProviderId, s.refineProviderId, s.fallbackProviderId].includes(p.id);
  if (!providerReady(p)) return { label: '未配置', cls: used ? 'tag tag-warn' : 'tag' };
  const t = tests.get(p.id);
  if (!t) return { label: '未测试', cls: 'tag' };
  if (t.pending) return { label: '测试中', cls: 'tag tag-accent' };
  return t.ok ? { label: '已连接', cls: 'tag tag-ok' } : { label: '连接失败', cls: 'tag tag-danger' };
}

async function testProvider(p: ProviderConfig) {
  tests.set(p.id, { ok: true, text: '测试中…', pending: true });
  renderAll();
  const r = await rt<any>({ type: 'test-provider', provider: p }).catch((e) => ({ error: String(e) }));
  if (r?.error) tests.set(p.id, { ok: false, text: r.error });
  else {
    if (r.region) p.detectedRegion = r.region;
    const region = r.region ? ` · 已识别为${r.region === 'cn' ? '国内账户（人民币）' : '国际账户（美元）'}` : '';
    tests.set(p.id, { ok: true, text: `首字 ${r.ms} ms，「${r.text}」${r.usage ? ` · 输入 ${r.usage.promptTokens} / 输出 ${r.usage.completionTokens}` : ''}${region}` });
  }
  renderAll();
}

function providerCard(p: ProviderConfig): HTMLElement {
  const open = openProviders.has(p.id);
  const status = testState(p);
  const roles = [
    p.id === s.activeProviderId ? '正文' : null,
    p.id === s.shortTextProviderId ? '短文本' : null,
    p.id === s.refineProviderId ? '精翻' : null,
    p.id === s.fallbackProviderId ? '备用' : null,
  ].filter(Boolean) as string[];
  const builtin = PROVIDER_PRESETS.some((x) => x.id === p.id);
  const t = tests.get(p.id);
  const vendor = vendorOf(p);
  const suggestions = vendor === 'openrouter' ? openRouterModels : MODEL_SUGGESTIONS[vendor];
  const listId = `models-${p.id}`;

  const extra = area(JSON.stringify(p.extraBody, null, 2), (v) => {
    try {
      p.extraBody = v.trim() ? JSON.parse(v) : {};
      extra.classList.remove('invalid');
      extraHint.textContent = '用于关闭 thinking 等开关，合并进请求体';
    } catch {
      extra.classList.add('invalid');
      extraHint.textContent = 'JSON 格式有误，保存时会保留上一次有效的值';
    }
  }, 3);
  const extraHint = h('span', { class: 'hint' }, '用于关闭 thinking 等开关，合并进请求体');
  const testBtn = h('button', { class: 'btn btn-sm', type: 'button', 'data-focus': `prov-test:${p.id}`, disabled: !providerReady(p) || !!t?.pending, onclick: () => void testProvider(p) }, t?.pending ? '测试中…' : '测试连接');
  // Key/model edits enable the test button immediately, without a full re-render.
  const syncTest = () => (testBtn.disabled = !providerReady(p) || !!tests.get(p.id)?.pending);
  const mt = isMachineTranslation(p);

  const head = h(
    'div',
    { class: 'op-prov-head' },
    h('span', { class: 'op-avatar' }, providerLogo(p, 36)),
    h(
      'div',
      { class: 'op-grow' },
      h(
        'div',
        { class: 'op-prov-name' },
        h('span', {}, p.name || p.id),
        ...roles.map((r) => h('span', { class: 'tag tag-accent' }, r)),
        h('span', { class: status.cls }, status.label),
      ),
      h('span', { class: 'hint mono op-ellipsis' }, `${p.baseURL} · ${p.model || '未填模型'}`),
    ),
    testBtn,
    h(
      'button',
      {
        class: 'btn btn-sm op-icon-btn',
        type: 'button',
        'aria-label': `${p.name || p.id} 详情`,
        'aria-expanded': String(open),
        'data-focus': `prov-toggle:${p.id}`,
        onclick: () => {
          if (open) openProviders.delete(p.id);
          else openProviders.add(p.id);
          renderAll();
        },
      },
      icon('chevron', 16),
    ),
  );
  head.classList.toggle('op-prov-head-open', open);

  if (!open) return h('div', { class: 'op-prov' }, head);

  return h(
    'div',
    { class: 'op-prov op-prov-open' },
    head,
    h(
      'div',
      { class: 'op-prov-body' },
      h(
        'div',
        { class: 'op-grid2' },
        field('名称', text(p.name, (v) => (p.name = v))),
        mt ? null : field(
          '模型',
          h(
            'span',
            { class: 'op-field' },
            text(p.model, (v) => ((p.model = v), syncTest()), { class: 'inp mono', placeholder: suggestions[0] ?? 'model-id', list: listId, onchange: () => renderAll() }),
            h('datalist', { id: listId }, ...suggestions.map((m) => h('option', { value: m }))),
          ),
          suggestions.length ? '可从下拉建议中选择，价格会随模型自动更新' : undefined,
        ),
        field('Base URL', text(p.baseURL, (v) => (p.baseURL = v), { class: 'inp mono' }), mt ? '一般无需修改' : vendor === 'anthropic' ? '不含 /v1/messages，SDK 会自动拼接' : '不含 /chat/completions'),
        mt ? null : field(
          'API Key',
          h('input', {
            class: 'inp mono',
            type: 'password',
            value: p.apiKey,
            autocomplete: 'off',
            'aria-label': `${p.name} API Key`,
            oninput: (e: Event) => {
              p.apiKey = (e.target as HTMLInputElement).value;
              syncTest();
            },
          }),
          '只保存在本机浏览器里',
        ),
      ),
      t && !t.pending ? h('div', { class: `op-test ${t.ok ? 'op-test-ok' : 'op-test-err'}`, role: 'status' }, icon(t.ok ? 'check' : 'alert', 16), h('span', {}, t.text)) : null,
      vendor === 'openrouter' ? h(
        'div', { class: 'callout', role: 'note' },
        h('span', {}, '默认 openrouter/free 自动选择免费模型；也可获取列表后，在模型输入框选择固定的 :free 模型。仍需填写 OpenRouter API Key。'),
        h('span', { class: 'hint' }, '免费模型有每分钟、每日和上游容量限制；测试连接、预处理、精翻及重试也会消耗请求额度。填写不带 :free 的其他模型 ID 可能收费，请核对价格。'),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: loadingOpenRouterModels, onclick: () => void refreshOpenRouterModels() }, loadingOpenRouterModels ? '获取中…' : '获取最新免费模型'),
      ) : null,
      vendor === 'deepseek' ? regionBlock(p) : null,
      vendor === 'nvidia' ? h(
        'div', { class: 'callout', role: 'note' },
        h('span', {}, '在 NVIDIA Build 获取 API Key。默认使用支持中文的 Nemotron 3 Super，并关闭 thinking；其他模型请使用 Build 页 hosted API 示例中的模型 ID 和参数。'),
        h('span', { class: 'hint' }, '免费试用受账户额度、限流和模型可用性约束；测试连接、预处理、精翻和重试也会消耗额度。本地按试用零费用估算，以 NVIDIA 账户实际规则为准。'),
        h('a', { href: 'https://build.nvidia.com/', target: '_blank', rel: 'noopener noreferrer' }, '打开 NVIDIA Build'),
      ) : null,
      mt ? h(
        'div', { class: 'callout', role: 'note' },
        h('span', {}, '免费，无需 API Key。只能用作「短文本」服务商：翻译不带链接、格式和术语的按钮、菜单、标签；其余文本以及机翻失败的条目会自动交给正文服务商。'),
        h('span', { class: 'hint' }, vendor === 'google-translate'
          ? '使用谷歌网页翻译组件的接口（非公开 API），按 IP 限流，短时间请求过密会返回 429。菜单类词汇的译法通常比微软准确。'
          : '使用 Edge 浏览器内置翻译的接口（非公开 API），每次最多 100 条，限流宽松；脱离上下文的单词偶有误译（如 Settings → 背景设定）。'),
      ) : null,
      vendor === 'anthropic' ? h(
        'div', { class: 'callout', role: 'note' },
        h('span', {}, '走 Claude Messages API（官方 SDK），不是 OpenAI 兼容接口。正文批量翻译关闭 thinking，effort 设为 medium；精翻启用 adaptive thinking，effort 设为 medium。系统提示会自动缓存。'),
        h('span', { class: 'hint' }, '在额外请求参数里可以覆盖批量翻译的参数，例如 {"output_config":{"effort":"low"}}。temperature 和 top_p 会被忽略，因为 Haiku 5.5 只接受默认值。'),
        h('a', { href: 'https://platform.claude.com/settings/keys', target: '_blank', rel: 'noopener noreferrer' }, '获取 Claude API Key'),
      ) : null,
      mt ? null : pricingBlock(p),
      disclosure(
        `${p.id}:advanced`,
        '高级：请求参数与并发',
        false,
        h(
          'div',
          { class: 'op-grid4' },
          field('并发', num(p.concurrency, (v) => (p.concurrency = Math.max(1, Math.round(v))), { min: 1 }), '同时进行的请求数'),
          field('每分钟请求上限', num(p.rpm ?? 0, (v) => (p.rpm = Math.max(0, Math.round(v))), { min: 0 }), '0 表示不限；免费档按官方 RPM 设置'),
          // Claude always reports usage; the OpenAI stream_options switch does not apply.
          vendor === 'anthropic' || mt ? null : h(
            'label',
            { class: 'op-check' },
            h('input', { type: 'checkbox', checked: p.includeUsage, onchange: (e: Event) => (p.includeUsage = (e.target as HTMLInputElement).checked) }),
            '请求 usage（stream_options）',
          ),
        ),
        mt ? null : h('label', { class: 'op-field' }, h('span', { class: 'lbl' }, '额外请求参数（JSON）'), extra, extraHint),
        builtin
          ? null
          : h(
              'div',
              { class: 'op-row-end' },
              h(
                'button',
                {
                  class: 'btn btn-sm btn-danger',
                  type: 'button',
                  onclick: () => {
                    if (!confirmInline(`删除服务商「${p.name}」？`)) return;
                    s.providers = s.providers.filter((x) => x !== p);
                    for (const k of ['activeProviderId', 'shortTextProviderId', 'refineProviderId', 'fallbackProviderId'] as const) {
                      if (s[k] === p.id) s[k] = k === 'activeProviderId' ? s.providers[0]!.id : '';
                    }
                    renderAll();
                  },
                },
                '删除这个服务商',
              ),
            ),
      ),
    ),
  );
}

async function refreshOpenRouterModels() {
  loadingOpenRouterModels = true;
  renderAll();
  try {
    const res = await rt<{ models?: string[]; error?: string }>({ type: 'openrouter-free-models' });
    if (res?.error || !res?.models) throw new Error(res?.error ?? '未收到模型列表');
    openRouterModels = res.models;
    toast(`已获取 ${res.models.length - 1} 个免费模型及自动路由`);
  } catch (e) {
    toast(`获取失败：${String(e instanceof Error ? e.message : e)}`);
  } finally {
    loadingOpenRouterModels = false;
    renderAll();
  }
}

function regionBlock(p: ProviderConfig): HTMLElement {
  const detected = p.detectedRegion;
  return h(
    'div',
    { class: 'op-grid2' },
    field(
      '接入站点',
      sel(
        [
          ['auto', '自动识别（按账户币种）'],
          ['cn', '国内站 · 人民币计价'],
          ['global', '国际站 · 美元计价'],
        ],
        p.region ?? 'auto',
        (v) => {
          p.region = v as ProviderConfig['region'];
          renderAll();
        },
        { 'aria-label': 'DeepSeek 接入站点' },
      ),
      '两个站点接口地址相同，计费币种不同；自动识别通过 /user/balance 读取账户币种',
    ),
    h(
      'div',
      { class: 'op-field' },
      h('span', { class: 'lbl' }, '识别结果'),
      h(
        'div',
        { class: `op-region ${detected ? 'op-region-ok' : ''}` },
        detected
          ? `${detected === 'cn' ? '国内账户（CNY）' : '国际账户（USD）'}${(p.region ?? 'auto') === 'auto' ? '' : ' · 已手动指定，按所选站点计价'}`
          : (p.region ?? 'auto') === 'auto'
            ? '尚未识别：测试连接或首次翻译时自动识别，暂按国内站价格显示'
            : '尚未识别（已手动指定站点）',
      ),
    ),
  );
}

/** Price inputs: empty means "use the catalog default", which shows as placeholder. */
function pricingBlock(p: ProviderConfig): HTMLElement {
  const def = defaultPrice(p);
  const spec = resolvedPrice(p);
  const o: PriceOverride = p.price ?? {};
  const cur = spec.currency;
  const set = (key: keyof PriceOverride, raw: string) => {
    const next: PriceOverride = { ...(p.price ?? {}) };
    const v = raw.trim();
    if (v === '') delete next[key];
    else if (key === 'currency') next.currency = v;
    else if (Number.isFinite(Number(v))) (next as Record<string, number>)[key] = Number(v);
    p.price = Object.keys(next).length ? next : undefined;
  };
  const input = (key: keyof PriceOverride, placeholder: number | string | undefined, label: string) =>
    h('input', {
      class: 'inp',
      type: key === 'currency' ? 'text' : 'number',
      step: '0.001',
      min: 0,
      value: o[key] ?? '',
      placeholder: placeholder === undefined ? '未知，请填写' : String(placeholder),
      'aria-label': `${p.name} ${label}`,
      oninput: (e: Event) => set(key, (e.target as HTMLInputElement).value),
    });

  const rows: HTMLElement[] = [
    h('span', { class: 'hint' }, ''),
    h('span', { class: 'lbl' }, `输入（未命中）/ 1M`),
    h('span', { class: 'lbl' }, `缓存命中 / 1M`),
    h('span', { class: 'lbl' }, `输出 / 1M`),
    h('span', { class: 'lbl op-price-row' }, def?.offPeak ? '高峰' : '价格'),
    input('input', def?.input, '输入价格'),
    input('cacheHit', def?.cacheHit, '缓存命中价格'),
    input('output', def?.output, '输出价格'),
  ];
  if (def?.offPeak) {
    rows.push(
      h('span', { class: 'lbl op-price-row' }, '空闲'),
      input('offInput', def.offPeak.input, '空闲输入价格'),
      input('offCacheHit', def.offPeak.cacheHit, '空闲缓存命中价格'),
      input('offOutput', def.offPeak.output, '空闲输出价格'),
    );
  }

  const tz = localTimeZone();
  const sign = tz.offsetMin >= 0 ? '+' : '-';
  const off = `UTC${sign}${Math.floor(Math.abs(tz.offsetMin) / 60)}${Math.abs(tz.offsetMin) % 60 ? `:${String(Math.abs(tz.offsetMin) % 60).padStart(2, '0')}` : ''}`;
  const peakNow = isDeepSeekPeak();

  const custom = !!p.price && Object.keys(p.price).length > 0;
  const state = !def ? '不在价格目录中，请手动填写' : custom ? '已自定义' : '官方默认价';
  return disclosure(
    `${p.id}:pricing`,
    `计价 · ${cur === '¥' ? '人民币' : '美元'} · ${state}`,
    false,
    h(
    'div',
    { class: 'op-pricing' },
    h('p', { class: 'hint' }, def ? '留空即用官方默认价；价格只用于本地估算费用。' : '该模型不在价格目录中，填写后才能估算费用；不填不影响翻译。'),
    h('div', { class: 'op-price-grid' }, ...rows),
    h(
      'div',
      { class: 'op-price-meta' },
      field('货币符号', input('currency', def?.currency ?? '$', '货币符号'), '一般无需修改'),
      def?.offPeak
        ? h(
            'div',
            { class: 'op-schedule', role: 'note' },
            h('span', { class: `tag ${peakNow ? 'tag-warn' : 'tag-ok'}` }, peakNow ? '当前：高峰价' : '当前：空闲价（5 折）'),
            h('span', {}, '高峰：北京时间周一至周五 09:00–12:00、14:00–18:00；其余时段（含周末、法定节假日）为空闲价。'),
            h(
              'span',
              { class: 'hint' },
              tz.offsetMin === 480
                ? `你的时区 ${tz.name}（${off}）与北京时间一致。`
                : `换算到你的时区 ${tz.name}（${off}）：${peakWindowsIn(tz.offsetMin)}。`,
            ),
            h('span', { class: 'hint' }, '法定节假日无法自动判断，按高峰估算，实际费用只会更低。'),
          )
        : null,
      def?.note ? h('div', { class: 'op-schedule', role: 'note' }, h('span', { class: 'hint' }, def.note)) : null,
      spec.subscription
        ? h(
            'div',
            { class: 'op-schedule', role: 'note' },
            h('span', { class: 'tag tag-accent' }, '订阅计费'),
            h('span', {}, `${spec.subscription.fee}，翻译用量不按 token 扣费。`),
            h('span', { class: 'hint' }, `${spec.subscription.note}。上面的价格是 Zen 按量价，用来折算订阅额度的消耗。`),
          )
        : null,
    ),
    ),
  );
}

/** Deletions are reversible until Save, so a plain confirm is enough. */
const confirmInline = (msg: string) => window.confirm(msg);

function providersSection() {
  const opt = (p: ProviderConfig) => [p.id, isMachineTranslation(p) ? p.name : `${p.name}${p.model ? ` · ${p.model}` : ''}`] as [string, string];
  // Machine translation only handles short plain strings, so it is offered for that role alone.
  const llmOpts = s.providers.filter((p) => !isMachineTranslation(p)).map(opt);
  const allOpts = s.providers.map(opt);
  const role = (key: 'activeProviderId' | 'shortTextProviderId' | 'refineProviderId' | 'fallbackProviderId', allowSame: boolean, emptyLabel = '同正文') =>
    sel(allowSame ? [['', emptyLabel], ...(key === 'shortTextProviderId' ? allOpts : llmOpts)] : llmOpts, s[key] ?? '', (v) => {
      s[key] = v;
      renderAll();
    });
  return h(
    'section',
    { id: 'providers', class: 'card op-sec' },
    sectionHead('服务商与路由', '正文、短文本和精翻可以分别选用不同的服务商；短文本还可以用免费的谷歌 / 微软机翻。'),
    h(
      'div',
      { class: 'op-grid4' },
      field('正文翻译', role('activeProviderId', false), '段落、标题、正文'),
      field('短文本', role('shortTextProviderId', true), `不超过 ${s.shortTextMaxChars} 字的按钮、菜单、标签`),
      field('精翻', role('refineProviderId', true), '右键「精翻此段」，两次调用'),
      field('备用', role('fallbackProviderId', true, '不使用'), '主服务商限流、过载或出错时自动改用'),
    ),
    h('div', { class: 'op-provs' }, ...s.providers.map(providerCard)),
    h(
      'button',
      {
        class: 'op-add',
        type: 'button',
        onclick: () => {
          const id = `custom-${Date.now().toString(36)}`;
          s.providers.push({ ...PROVIDER_PRESETS.find((p) => p.id === 'custom')!, id, name: '新服务商', extraBody: {} });
          openProviders.add(id);
          renderAll();
        },
      },
      icon('plus', 16),
      '添加 OpenAI 兼容服务',
    ),
  );
}

// ---------- display ----------

const STYLE_OPTS: [Settings['transStyle'], string][] = [
  ['faded', '淡化'],
  ['border', '左边框'],
  ['dashed', '虚线'],
  ['tint', '底色'],
  ['plain', '无样式'],
];

function displaySection() {
  const preview = h('div', { class: 'op-preview' });
  const paintPreview = () => {
    preview.className = `op-preview op-pv-${s.transStyle} op-pv-lh-${s.transLineHeight} op-pv-fs-${s.transFontSize}`;
    const parts: (HTMLElement | null)[] = [
      h('span', { class: 'hint op-pv-cap' }, `预览 · ${STYLE_OPTS.find((x) => x[0] === s.transStyle)?.[1]} · ${s.displayMode === 'bilingual' ? '双语对照' : '只看译文'}`),
      s.displayMode === 'bilingual' ? h('div', { class: 'op-pv-en op-pv-h' }, 'Batching keeps latency low') : null,
      h('div', { class: 'op-pv-zh op-pv-h' }, '批处理让延迟保持在低位'),
      s.displayMode === 'bilingual'
        ? h('p', { class: 'op-pv-en' }, 'The first request is small, so the opening paragraphs appear within about one second, while later batches run in parallel.')
        : null,
      h('p', { class: 'op-pv-zh' }, `首个请求很小，开头几段大约${s.autoSpace ? ' 1 ' : '1'}秒内就会出现，后续批次再并行发出。`),
    ];
    preview.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
  };
  paintPreview();

  const modeCard = (m: Settings['displayMode'], title: string, sub: string) =>
    h(
      'label',
      { class: 'op-choice' },
      h('input', {
        type: 'radio',
        name: 'mode',
        checked: s.displayMode === m,
        onchange: () => {
          s.displayMode = m;
          paintPreview();
        },
      }),
      h('span', { class: 'op-choice-title' }, title),
      h('span', { class: 'hint' }, sub),
    );

  const styleCard = ([id, label]: [Settings['transStyle'], string]) =>
    h(
      'label',
      { class: 'op-swatch-card' },
      h('input', {
        type: 'radio',
        name: 'style',
        class: 'sr-only',
        checked: s.transStyle === id,
        onchange: () => {
          s.transStyle = id;
          paintPreview();
        },
      }),
      h('span', { class: `op-swatch op-swatch-${id}` }),
      label,
    );

  return h(
    'section',
    { id: 'display', class: 'card op-sec' },
    sectionHead('显示与样式', '右侧实时预览所选样式；在网页上切换不会重新请求翻译。'),
    h(
      'div',
      { class: 'op-split' },
      h(
        'div',
        { class: 'op-col' },
        h('fieldset', { class: 'op-fieldset' }, h('legend', { class: 'lbl' }, '默认显示方式'), h('div', { class: 'op-grid2' }, modeCard('bilingual', '双语对照', '原文下方显示译文'), modeCard('replace', '只看译文', '译文替换原文，可随时切回'))),
        h('fieldset', { class: 'op-fieldset' }, h('legend', { class: 'lbl' }, '译文样式'), h('div', { class: 'op-swatches' }, ...STYLE_OPTS.map(styleCard))),
        h(
          'div',
          { class: 'op-grid2' },
          field(
            '译文字号',
            sel([['same', '与原文相同'], ['small', '小一号（0.94em）']], s.transFontSize, (v) => {
              s.transFontSize = v as Settings['transFontSize'];
              paintPreview();
            }),
          ),
          field(
            '译文行高',
            sel([['comfortable', '舒适 1.75'], ['compact', '紧凑 1.6'], ['inherit', '继承原文']], s.transLineHeight, (v) => {
              s.transLineHeight = v as Settings['transLineHeight'];
              paintPreview();
            }),
            '只作用于正文块，标题保持原样',
          ),
        ),
      ),
      preview,
    ),
    h(
      'div',
      { class: 'op-switches' },
      switchRow('自动翻译非中文页面', '站点规则设为「从不」的网站除外', s.autoTranslate, (v) => (s.autoTranslate = v)),
      switchRow(
        '启用内置站点排除规则',
        `${SITE_DEFAULTS.length} 个常见站点的菜单、侧栏和界面文字不翻译`,
        s.builtinSiteRules,
        (v) => (s.builtinSiteRules = v),
      ),
      switchRow('中英文之间自动加空格', '本地处理，不额外调用模型；同时把中文后的半角标点改为全角、直引号改为中文弯引号', s.autoSpace, (v) => {
        s.autoSpace = v;
        paintPreview();
      }),
      h(
        'label',
        { class: 'op-switch-row' },
        h('span', { class: 'op-grow' }, h('span', { class: 'op-strong' }, '页面预处理'), h('span', { class: 'hint' }, '长文先做一次便宜调用：提取主题、页面术语，猜测场景')),
        sel([['auto', '长文自动'], ['on', '总是'], ['off', '关闭']], s.preprocess, (v) => (s.preprocess = v as Settings['preprocess']), { style: 'width: 140px' }),
      ),
    ),
    disclosure(
      'display:perf',
      '性能参数',
      false,
      h(
        'div',
        { class: 'op-grid4' },
        field('首批字符', num(s.firstBatchChars, (v) => (s.firstBatchChars = Math.max(100, v)), { min: 100, step: 100 }), '越小首屏越快'),
        field('首批段数', num(s.firstBatchSegments, (v) => (s.firstBatchSegments = Math.max(1, v)), { min: 1 })),
        field('后续批字符', num(s.batchChars, (v) => (s.batchChars = Math.max(200, v)), { min: 200, step: 100 })),
        field('后续批段数', num(s.batchSegments, (v) => (s.batchSegments = Math.max(1, v)), { min: 1 })),
        field('短文本阈值', num(s.shortTextMaxChars, (v) => (s.shortTextMaxChars = Math.max(1, v)), { min: 1 }), '字符数'),
      ),
    ),
  );
}

// ---------- experts ----------

function expertEditor(e: Expert): HTMLElement {
  const builtin = BUILTIN_EXPERTS.find((b) => b.id === e.id);
  const touch = () => (e.builtin = false); // edited builtin experts stop following code updates
  const chipInput = h('input', {
    class: 'inp op-chip-input',
    type: 'text',
    placeholder: '域名或 */路径*，回车添加',
    'aria-label': '添加匹配规则',
    onkeydown: (ev: Event) => {
      const k = ev as KeyboardEvent;
      if (k.key !== 'Enter') return;
      k.preventDefault();
      const v = chipInput.value.trim();
      if (v && !e.matches.includes(v)) {
        e.matches.push(v);
        touch();
        renderAll();
      }
    },
  });
  return h(
    'div',
    { class: 'op-expert-editor' },
    h(
      'div',
      { class: 'op-grid2' },
      field('名称', text(e.name, (v) => {
        e.name = v;
        touch();
      })),
      field('ID', text(e.id, (v) => {
        // Keep the selection and the site rules that use this expert pointing at it.
        for (const r of s.siteRules) if (r.expertId === e.id) r.expertId = v;
        if (selectedExpertId === e.id) selectedExpertId = v;
        e.id = v;
      }, builtin ? { class: 'inp mono', disabled: true } : { class: 'inp mono' })),
    ),
    h(
      'div',
      { class: 'op-field' },
      h('span', { class: 'lbl' }, '匹配规则'),
      h(
        'div',
        { class: 'op-chips' },
        ...e.matches.map((m, i) =>
          h(
            'span',
            { class: `tag mono op-chip ${m.includes('/') ? 'tag-warn' : ''}` },
            m,
            h(
              'button',
              {
                type: 'button',
                'aria-label': `删除 ${m}`,
                onclick: () => {
                  e.matches.splice(i, 1);
                  touch();
                  renderAll();
                },
              },
              icon('close', 12),
            ),
          ),
        ),
        chipInput,
      ),
      h('span', { class: 'hint' }, '域名规则（github.com 含子域名，*.edu，docs.*）；橙色为路径规则（*/*terms*），优先于域名规则'),
    ),
    field('领域规则（每行一条，英文更稳）', area(e.rules, (v) => {
      e.rules = v;
      touch();
    }, 7)),
    h(
      'div',
      { class: 'op-row-between' },
      h('span', { class: 'hint' }, builtin ? (e.builtin ? '内置专家，跟随版本更新' : '已修改，不再随版本自动更新') : '自定义专家'),
      builtin
        ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => (Object.assign(e, structuredClone(builtin)), renderAll()) }, '恢复内置')
        : h(
            'button',
            {
              class: 'btn btn-sm btn-danger',
              type: 'button',
              onclick: () => {
                if (!confirmInline(`删除场景「${e.name}」？`)) return;
                s.experts = s.experts.filter((x) => x !== e);
                selectedExpertId = s.experts[0]?.id ?? '';
                renderAll();
              },
            },
            '删除场景',
          ),
    ),
  );
}

function expertsSection() {
  if (!s.experts.some((e) => e.id === selectedExpertId)) selectedExpertId = s.experts[0]?.id ?? '';
  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json',
    class: 'sr-only',
    'aria-label': '导入场景 JSON',
    onchange: async (ev: Event) => {
      const f = (ev.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        const list = JSON.parse(await f.text()) as Expert[];
        let n = 0;
        for (const e of Array.isArray(list) ? list : []) {
          if (!e?.id || !e.name || typeof e.rules !== 'string') continue;
          const clean: Expert = { id: String(e.id), name: String(e.name), matches: Array.isArray(e.matches) ? e.matches.map(String) : [], rules: e.rules, version: Number(e.version) || 1 };
          const i = s.experts.findIndex((x) => x.id === clean.id);
          if (i >= 0) s.experts[i] = clean;
          else s.experts.push(clean);
          n++;
        }
        renderAll();
        toast(n ? `已导入 ${n} 个场景，记得保存` : '文件里没有可用的场景', n ? 'ok' : 'err');
      } catch {
        toast('JSON 格式不对', 'err');
      }
    },
  });
  const current = s.experts.find((e) => e.id === selectedExpertId);
  return h(
    'section',
    { id: 'experts', class: 'card op-sec' },
    sectionHead(
      '场景专家',
      '按域名自动选择，路径规则优先。专家只写领域规则，输出格式由代码统一追加。',
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, '导入'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            const url = URL.createObjectURL(new Blob([JSON.stringify(s.experts, null, 2)], { type: 'application/json' }));
            h('a', { href: url, download: 'translucid-experts.json' }).click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        },
        '导出',
      ),
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => {
            const id = `custom-${Date.now().toString(36)}`;
            s.experts.push({ id, name: '新场景', matches: [], rules: '', version: 1 });
            selectedExpertId = id;
            renderAll();
          },
        },
        '新建场景',
      ),
      fileInput,
    ),
    h(
      'div',
      { class: 'op-split op-split-experts' },
      h(
        'div',
        { class: 'op-expert-list', role: 'listbox', 'aria-label': '场景列表' },
        ...s.experts.map((e) => {
          const active = e.id === selectedExpertId;
          const domains = e.matches.slice(0, 2).join('、');
          return h(
            'button',
            {
              type: 'button',
              role: 'option',
              'aria-selected': String(active),
              class: 'op-expert-item',
              onclick: () => {
                selectedExpertId = e.id;
                renderAll();
              },
            },
            h('span', { class: 'op-strong' }, e.name || '未命名'),
            h('span', { class: 'hint' }, e.matches.length ? `${e.matches.length} 条匹配 · ${domains}` : '未匹配时使用 / 手动选择'),
          );
        }),
      ),
      current ? expertEditor(current) : h('p', { class: 'hint' }, '还没有场景'),
    ),
  );
}

// ---------- glossary ----------

function glossaryText(): string {
  if (!glossaryScope) return s.glossary;
  return s.siteRules.find((r) => r.host === glossaryScope)?.glossary ?? '';
}

function setGlossaryText(v: string) {
  if (!glossaryScope) s.glossary = v;
  else {
    const r = s.siteRules.find((x) => x.host === glossaryScope);
    if (r) r.glossary = v;
  }
}

function glossarySection() {
  if (glossaryScope && !s.siteRules.some((r) => r.host === glossaryScope)) glossaryScope = '';
  const entries = parseGlossary(glossaryText());
  const write = (list: GlossaryEntry[]) => {
    setGlossaryText(serializeGlossary(list));
    renderAll();
  };
  const scopeSel = sel(
    [['', '全局'], ...s.siteRules.filter((r) => r.host).map((r) => [r.host, r.host] as [string, string])],
    glossaryScope,
    (v) => {
      glossaryScope = v;
      editingTerm = null;
      renderAll();
    },
    { style: 'width: 180px', 'aria-label': '术语表范围' },
  );

  const row = (e: GlossaryEntry, i: number) => {
    if (editingTerm === e.src) {
      const keep = (k: keyof typeof termDraft) => (ev: Event) => (termDraft[k] = (ev.target as HTMLInputElement).value);
      const src = h('input', { class: 'inp', value: termDraft.src, 'aria-label': '原文', 'data-focus': 'term-edit:src', oninput: keep('src') });
      const tgt = h('input', { class: 'inp', value: termDraft.tgt, placeholder: '留空 = 保留原文', 'aria-label': '译文', 'data-focus': 'term-edit:tgt', oninput: keep('tgt') });
      const note = h('input', { class: 'inp', value: termDraft.note, 'aria-label': '备注', 'data-focus': 'term-edit:note', oninput: keep('note') });
      return h(
        'tr',
        { class: 'op-editing' },
        h('td', {}, src),
        h('td', {}, tgt),
        h('td', {}, note),
        h(
          'td',
          { class: 'op-td-actions' },
          h(
            'button',
            {
              class: 'btn btn-sm btn-primary',
              type: 'button',
              onclick: () => {
                if (!src.value.trim()) return toast('原文不能为空', 'err');
                const next = [...entries];
                next[i] = { src: src.value.trim(), tgt: tgt.value.trim() || KEEP, ...(note.value.trim() ? { note: note.value.trim() } : {}) };
                editingTerm = null;
                write(next);
              },
            },
            '完成',
          ),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ((editingTerm = null), renderAll()) }, '取消'),
        ),
      );
    }
    return h(
      'tr',
      {},
      h('td', { class: 'mono' }, e.src),
      h('td', {}, e.tgt === KEEP ? h('span', { class: 'tag tag-warn' }, '保留原文') : e.tgt),
      h('td', { class: 'muted' }, e.note ?? '—'),
      h(
        'td',
        { class: 'op-td-actions' },
        h('button', {
          class: 'btn btn-sm',
          type: 'button',
          onclick: () => {
            editingTerm = e.src;
            termDraft = { src: e.src, tgt: e.tgt === KEEP ? '' : e.tgt, note: e.note ?? '' };
            renderAll();
          },
        }, '编辑'),
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            'aria-label': `删除 ${e.src}`,
            onclick: () => write(entries.filter((_, j) => j !== i)),
          },
          '删除',
        ),
      ),
    );
  };

  const keepAdd = (k: keyof typeof addDraft) => (ev: Event) => (addDraft[k] = (ev.target as HTMLInputElement).value);
  const addSrc = h('input', { class: 'inp', type: 'text', value: addDraft.src, placeholder: '例如 embedding', required: true, 'data-focus': 'term-add:src', oninput: keepAdd('src') });
  const addTgt = h('input', { class: 'inp', type: 'text', value: addDraft.tgt, placeholder: '例如 嵌入；留空保留原文', 'data-focus': 'term-add:tgt', oninput: keepAdd('tgt') });
  const addNote = h('input', { class: 'inp', type: 'text', value: addDraft.note, 'data-focus': 'term-add:note', oninput: keepAdd('note') });
  const addForm = h(
    'form',
    {
      class: 'op-term-form',
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        const srcV = addSrc.value.trim();
        if (!srcV) return;
        if (entries.some((x) => x.src.toLowerCase() === srcV.toLowerCase())) return toast('这个术语已经存在', 'err');
        const entry = { src: srcV, tgt: addTgt.value.trim() || KEEP, ...(addNote.value.trim() ? { note: addNote.value.trim() } : {}) };
        Object.assign(addDraft, { src: '', tgt: '', note: '' });
        write([...entries, entry]);
        toast('已添加，记得保存');
      },
    },
    field('原文', addSrc),
    field('译文', addTgt),
    field('备注（可选）', addNote),
    h('button', { class: 'btn btn-primary', type: 'submit' }, '添加'),
  );

  return h(
    'section',
    { id: 'glossary', class: 'card op-sec' },
    sectionHead(
      '术语表',
      '每批只注入命中的条目，译后检查是否用上。只收专有名词和领域术语，常用词不要放。站点术语会覆盖全局术语。',
      h('label', { class: 'op-inline-field' }, h('span', { class: 'hint' }, '范围'), scopeSel),
      h(
        'button',
        { class: 'btn', type: 'button', 'aria-pressed': String(glossaryBatch), onclick: () => ((glossaryBatch = !glossaryBatch), renderAll()) },
        glossaryBatch ? '返回表格' : '批量编辑',
      ),
    ),
    glossaryBatch
      ? h(
          'div',
          { class: 'op-field' },
          area(glossaryText(), (v) => setGlossaryText(v), 10, { placeholder: 'LLM => 大语言模型\nTransformer => KEEP\nagent => 智能体 # 指 AI agent', 'aria-label': '术语表文本' }),
          h('span', { class: 'hint' }, '每行一条：原文 => 译文 # 备注。译文写 KEEP 表示保留原文。'),
        )
      : h(
          'div',
          { class: 'op-table-wrap' },
          entries.length
            ? h(
                'table',
                {},
                h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, '原文'), h('th', { scope: 'col' }, '译文'), h('th', { scope: 'col' }, '备注'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '操作')))),
                h('tbody', {}, ...entries.map(row)),
              )
            : h('p', { class: 'hint op-empty' }, glossaryScope ? `${glossaryScope} 还没有站点术语` : '还没有术语，在下面添加第一条'),
        ),
    glossaryBatch ? null : addForm,
  );
}

// ---------- sites ----------

function sitesSection() {
  const expertOpts: [string, string][] = [['', '自动'], ...s.experts.map((e) => [e.id, e.name] as [string, string])];
  const rows = s.siteRules.map((r, i) => {
    const n = i + 1;
    const terms = h(
      'button',
      {
        class: 'btn btn-sm',
        type: 'button',
        disabled: !r.host,
        onclick: () => {
          glossaryScope = r.host;
          glossaryBatch = false;
          renderAll();
          go('#/immersive/glossary');
        },
      },
      `术语 ${parseGlossary(r.glossary).length}`,
    );
    return h(
      'tr',
      {},
      h('td', {}, text(r.host, (v) => {
        r.host = v.trim();
        terms.disabled = !r.host; // the glossary scope list follows on change (renderAll)
      }, { class: 'inp mono', placeholder: '*.example.com', 'aria-label': `域名 ${n}`, 'data-focus': `rule:${i}:host`, onchange: () => renderAll() })),
      h('td', {}, sel([['default', '默认'], ['always', '总是'], ['never', '从不']], r.mode, (v) => (r.mode = v as SiteRule['mode']), { 'aria-label': `自动翻译 ${n}`, 'data-focus': `rule:${i}:mode` })),
      h('td', {}, sel(expertOpts, r.expertId ?? '', (v) => (r.expertId = v || undefined), { 'aria-label': `场景 ${n}`, 'data-focus': `rule:${i}:expert` })),
      h('td', {}, text(r.exclude ?? '', (v) => (r.exclude = v), { class: 'inp mono', placeholder: 'nav, .sidebar', 'aria-label': `排除区域 ${n}`, 'data-focus': `rule:${i}:exclude` })),
      h(
        'td',
        { class: 'op-td-actions' },
        terms,
        h(
          'button',
          {
            class: 'btn btn-sm btn-danger',
            type: 'button',
            'aria-label': `删除 ${r.host || '这条规则'}`,
            onclick: () => {
              s.siteRules = s.siteRules.filter((x) => x !== r);
              renderAll();
            },
          },
          '删除',
        ),
      ),
    );
  });
  return h(
    'section',
    { id: 'sites', class: 'card op-sec' },
    sectionHead(
      '站点规则',
      '你的规则和内置排除规则叠加生效。排除区域填 CSS 选择器，逗号分隔。',
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => {
            s.siteRules.push({ host: '', mode: 'default' });
            renderAll();
            document.querySelector<HTMLInputElement>('#sites tbody tr:last-child input')?.focus();
          },
        },
        '添加站点',
      ),
    ),
    rows.length
      ? h(
          'div',
          { class: 'op-table-wrap' },
          h(
            'table',
            { class: 'op-sites' },
            h('thead', {}, h('tr', {}, ...['域名', '自动翻译', '场景', '排除区域'].map((t) => h('th', { scope: 'col' }, t)), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '操作')))),
            h('tbody', {}, ...rows),
          ),
        )
      : h('p', { class: 'hint op-empty' }, '还没有站点规则。也可以在网页上打开弹出菜单，直接设置「本站」。'),
    disclosure(
      'sites:builtin',
      `内置排除规则覆盖的 ${SITE_DEFAULTS.length} 个站点${s.builtinSiteRules ? '' : '（已关闭）'}`,
      false,
      h('div', { class: 'op-chips' }, ...SITE_DEFAULTS.map((d) => h('span', { class: 'tag mono', title: d.exclude.join(', ') }, d.host))),
    ),
  );
}

// ---------- usage ----------

function usageSection() {
  const month = usage[monthKey()] ?? {};
  const total = { requests: 0, promptTokens: 0, cacheHitTokens: 0, completionTokens: 0, ttftMs: 0, ttftCount: 0, subscriptionEquiv: 0 };
  const costs: CostLine[] = [];
  for (const [id, b] of Object.entries(month)) {
    total.requests += b.requests;
    total.promptTokens += b.promptTokens;
    total.cacheHitTokens += b.cacheHitTokens;
    total.completionTokens += b.completionTokens;
    total.ttftMs += b.ttftMs ?? 0;
    total.ttftCount += b.ttftCount ?? 0;
    total.subscriptionEquiv += b.subscriptionEquiv ?? 0;
    costs.push(estimateCost(b, s.providers.find((p) => p.id === id)));
  }
  const fallbackCur = (() => {
    const p = s.providers.find((x) => x.id === s.activeProviderId);
    return p ? resolvedPrice(p).currency : '¥';
  })();
  const tile = (label: string, value: string, sub?: string) =>
    h('div', { class: 'op-tile' }, h('span', { class: 'hint' }, label), h('span', { class: 'op-tile-v' }, value), sub ? h('span', { class: 'hint' }, sub) : null);
  const months = Object.keys(usage).sort().reverse().slice(0, 6);
  return h(
    'section',
    { id: 'usage', class: 'card op-sec' },
    sectionHead('用量与缓存', '费用按服务商单价估算，以账单为准。'),
    import.meta.env.MODE === 'debug'
      ? field('调试：允许页面调试接口的域名', text((s.debugHosts ?? []).join(', '), (v) => (s.debugHosts = v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)), { class: 'inp mono', placeholder: 'claude.ai, app.devin.ai' }), '仅调试版可见；用于真实站点测试，测完请清空')
      : null,
    h(
      'div',
      { class: 'op-grid4' },
      tile(
        '本月估算费用',
        formatCostLines(costs, fallbackCur),
        total.subscriptionEquiv > 0 ? `另有订阅等价消耗 ${formatCost(total.subscriptionEquiv, '$')}（不计入）` : '按请求发生时的峰谷价累计',
      ),
      tile('本月请求数', total.requests.toLocaleString()),
      tile('前缀缓存命中率', total.promptTokens ? `${Math.round((total.cacheHitTokens / total.promptTokens) * 100)}%` : '—', `${total.cacheHitTokens.toLocaleString()} / ${total.promptTokens.toLocaleString()} token`),
      tile('平均首字延迟', total.ttftCount ? `${(total.ttftMs / total.ttftCount / 1000).toFixed(2)} s` : '—'),
    ),
    months.length
      ? disclosure(
          'usage:months',
          '按月和服务商的明细',
          false,
          h(
            'div',
            { class: 'op-table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ...['月份', '服务商', '请求', '输入 token', '缓存命中', '输出 token', '估算费用'].map((t) => h('th', { scope: 'col' }, t)))),
              h(
                'tbody',
                {},
                ...months.flatMap((m) =>
                  Object.entries(usage[m] ?? {}).map(([id, b]) => {
                    const p = s.providers.find((x) => x.id === id);
                    return h(
                      'tr',
                      {},
                      h('td', {}, m),
                      h('td', {}, p?.name ?? id),
                      h('td', {}, b.requests.toLocaleString()),
                      h('td', {}, b.promptTokens.toLocaleString()),
                      h('td', {}, b.promptTokens ? `${Math.round((b.cacheHitTokens / b.promptTokens) * 100)}%` : '—'),
                      h('td', {}, b.completionTokens.toLocaleString()),
                      h(
                        'td',
                        {},
                        b.subscriptionEquiv ? `订阅（等价 ${formatCost(b.subscriptionEquiv, '$')}）` : (() => {
                          const c = estimateCost(b, p);
                          return formatCost(c.amount, c.currency);
                        })(),
                      ),
                    );
                  }),
                ),
              ),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'op-row-between op-cache' },
      h('span', {}, '本地译文缓存 ', h('strong', {}, cacheCount.toLocaleString()), ' 条，刷新页面时直接复用'),
      h(
        'button',
        {
          class: 'btn btn-danger',
          type: 'button',
          disabled: cacheCount === 0,
          onclick: async () => {
            if (!confirmInline('清空全部本地译文缓存？之后打开的页面会重新请求翻译。')) return;
            await rt({ type: 'cache-clear' });
            cacheCount = 0;
            toast('缓存已清空');
            renderAll();
          },
        },
        '清空缓存',
      ),
    ),
  );
}

// ---------- shell ----------

type Group = 'immersive' | 'config';
let group: Group = 'immersive';
let activeNav = '';
let packIndex: PackIndexItem[] = [];

/** Route of this page; the workbench (default) lives on the sites page. */
function parseRoute(): { group: Group; item: string } | 'workbench' {
  const m = location.hash.match(/^#\/(immersive|config)(?:\/(\w+))?/);
  if (m) return { group: m[1] as Group, item: m[2] ?? '' };
  // Anchors of the earlier single-page settings.
  const old = location.hash.replace(/^#/, '');
  if (CONFIG_ITEMS.some(([id]) => id === old)) return { group: 'config', item: old };
  if (IMMERSIVE_ITEMS.some(([id]) => id === old)) return { group: 'immersive', item: old };
  return 'workbench';
}

const groupItems = () => (group === 'immersive' ? IMMERSIVE_ITEMS : CONFIG_ITEMS);

function railStatus() {
  const t = tests.get(s.activeProviderId);
  return providerStatus(s, t && !t.pending ? t : undefined);
}

async function loadPackIndex() {
  const r = (await browser.runtime.sendMessage({ type: 'pack-list' }).catch(() => undefined)) as { ok?: boolean; index?: PackIndexItem[] } | undefined;
  packIndex = r?.ok ? (r.index ?? []) : [];
}

/** Privacy summary, scan consents and version. */
function aboutSection() {
  const li = (t: string) => h('li', {}, t);
  return h(
    'section',
    { id: 'about', class: 'card op-sec' },
    sectionHead('关于与隐私', `Translucid 透译 v${browser.runtime.getManifest().version} · MIT 许可。数据流的完整说明见项目里的 PRIVACY.md。`),
    h(
      'ul',
      { class: 'op-list' },
      li('没有自己的服务器，不收集遥测；网络请求只发往你配置的服务商。'),
      li('API Key 只保存在本机浏览器（未加密），不进入网页。'),
      li('站点本地化找到的文字只存在本机，确认预览后才发送；会话、名字、邮箱不收集；导出前自动清洗个人信息。'),
      li('一键扫描会让网站看到正常的页面浏览；每个网站第一次扫描前都会请你同意。'),
    ),
    h(
      'div',
      { class: 'op-row-end' },
      h('button', {
        class: 'btn btn-sm',
        type: 'button',
        onclick: async () => {
          if (!window.confirm('撤回所有网站的扫描同意？下次扫描前会重新询问。')) return;
          await browser.storage.local.remove('scanConsent');
          toast('已撤回');
        },
      }, '撤回扫描同意'),
    ),
  );
}

function refreshRail() {
  document.querySelector('.app-rail')?.replaceWith(rail({ group, item: activeNav, sites: packIndex, status: railStatus() }));
}

function saveBar() {
  const dirty = isDirty();
  const head = pageHead(
    group === 'immersive' ? '沉浸翻译' : '配置',
    group === 'immersive' ? '阅读任意网页时的译文呈现、场景与术语。保存后同步到所有已打开的标签页' : '服务商、用量与隐私。保存后同步到所有已打开的标签页',
    h('span', { class: 'op-dirty', id: 'op-dirty', role: 'status' }, dirty ? '有未保存的更改' : '所有更改已保存'),
    h('button', { class: 'btn', type: 'button', id: 'op-undo', disabled: !dirty, onclick: () => void undo() }, '撤销'),
    h('button', { class: 'btn btn-primary', type: 'button', id: 'op-save', disabled: !dirty || saving, onclick: () => void save() }, '保存'),
  );
  head.classList.add('op-top');
  return head;
}

function refreshDirty() {
  const dirty = isDirty();
  const label = document.getElementById('op-dirty');
  if (label) {
    label.textContent = dirty ? '有未保存的更改' : '所有更改已保存';
    label.dataset.dirty = String(dirty);
  }
  for (const id of ['op-undo', 'op-save']) {
    const b = document.getElementById(id) as HTMLButtonElement | null;
    if (b) b.disabled = !dirty || (id === 'op-save' && saving);
  }
}

async function save() {
  if (saving) return;
  const local = structuredClone(s);
  const snapshot = structuredClone(local);
  snapshot.siteRules = snapshot.siteRules.map((r) => ({ ...r, host: r.host.trim() }));
  if (snapshot.siteRules.some((r) => !r.host)) return toast('有站点规则还没填域名', 'err');
  const base = JSON.parse(saved) as Settings;
  saving = true;
  refreshDirty();
  try {
    const written = mergeSettings(base, snapshot, await loadSettings());
    await saveSettings(written);
    saved = JSON.stringify(written);
    // Preserve edits during both the storage read and write, including callbacks holding provider objects.
    syncSettingsDraft(s, mergeSettings(local, s, written));
    toast('已保存');
    renderAll();
  } catch (e) {
    toast(`保存失败：${String((e as Error).message ?? e)}`, 'err');
  } finally {
    saving = false;
    refreshDirty();
  }
}

async function undo() {
  s = JSON.parse(saved);
  editingTerm = null;
  renderAll();
  toast('已撤销未保存的更改');
}

function renderAll() {
  if (pointerPressed) { renderDeferred = true; return; }
  renderDeferred = false;
  const app = document.getElementById('app')!;
  const y = window.scrollY;
  // Focus comes back to the same control: by its stable key, else by a label that is unique on the page.
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active?.closest<HTMLElement>('[data-focus]')?.dataset.focus;
  const label = active?.getAttribute('aria-label');
  const focusLabel = label && document.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`).length === 1 ? label : null;
  const sections = group === 'immersive' ? [displaySection(), expertsSection(), glossarySection(), sitesSection()] : [providersSection(), usageSection(), aboutSection()];
  app.replaceChildren(
    h('div', { class: 'app-shell' }, rail({ group, item: activeNav, sites: packIndex, status: railStatus() }), h('main', { class: 'op-main app-main' }, saveBar(), ...sections)),
  );
  window.scrollTo(0, y);
  const again = focusKey
    ? document.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)
    : focusLabel
      ? document.querySelector<HTMLElement>(`[aria-label="${CSS.escape(focusLabel)}"]`)
      : null;
  again?.focus({ preventScroll: true });
  refreshDirty();
}

// ---------- section navigation ----------

/** A section the user just picked in the rail: it stays highlighted until they scroll by hand,
 *  even when it is too short (or too close to the bottom) to reach the top of the window. */
let pinnedNav = '';

function markNav(id: string) {
  activeNav = id;
  for (const a of document.querySelectorAll<HTMLElement>('.rail-sublink[data-nav]')) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'true');
    else a.removeAttribute('aria-current');
  }
}

/** Highlight the section under the sticky header; at the very bottom, the last one on screen. */
function spySections() {
  if (pinnedNav) return markNav(pinnedNav);
  const els = groupItems()
    .map(([id]) => document.getElementById(id))
    .filter((el): el is HTMLElement => !!el);
  if (!els.length) return;
  // Below the sticky save bar; on narrow windows the bar scrolls away, so never above the window top.
  const line = Math.max(0, document.querySelector('.op-top')?.getBoundingClientRect().bottom ?? 0) + 24;
  let current = els[0]!;
  for (const el of els) if (el.getBoundingClientRect().top <= line) current = el;
  const root = document.documentElement;
  if (window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2) {
    current = els.filter((el) => el.getBoundingClientRect().top < window.innerHeight).at(-1) ?? current;
  }
  markNav(current.id);
}

let spyFrame = 0;
const onScroll = () => {
  cancelAnimationFrame(spyFrame);
  spyFrame = requestAnimationFrame(spySections);
};
/** Scrolling by hand (wheel, touch, keys, the scrollbar) hands the highlight back to the spy. */
const unpin = (e: Event) => {
  if (e.type === 'pointerdown' && e.target !== document.documentElement) return;
  if (pinnedNav) {
    pinnedNav = '';
    onScroll();
  }
};

const scrollBehavior = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** Follow the route: switch group (re-render), scroll to the section and highlight it. */
function route(first = false) {
  const r = parseRoute();
  if (r === 'workbench') {
    location.replace(browser.runtime.getURL('/sites.html#/'));
    return;
  }
  const switched = r.group !== group;
  group = r.group;
  const item = groupItems().some(([id]) => id === r.item) ? r.item : '';
  activeNav = item || groupItems()[0]![0];
  if (switched || first) renderAll();
  const behavior = switched || first ? 'auto' : scrollBehavior();
  pinnedNav = item;
  // The first section sits right under the header: going to it means going to the top.
  if (item && item !== groupItems()[0]![0]) document.getElementById(item)?.scrollIntoView({ block: 'start', behavior });
  else window.scrollTo({ top: 0, behavior });
  markNav(activeNav);
}

/** Go to a section; the same link clicked twice scrolls back to it (no hashchange fires). */
function go(hash: string) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function main() {
  // Old links into the packs section open the new page.
  const legacy = location.hash.match(/^#packs\/(.+)$/);
  if (legacy) {
    location.replace(browser.runtime.getURL(`/sites.html#/site/${legacy[1]}/review`));
    return;
  }
  s = await loadSettings();
  saved = JSON.stringify(s);
  usage = await rt<UsageStats>({ type: 'usage' }).catch(() => ({}));
  cacheCount = (await rt<{ count: number }>({ type: 'cache-count' }).catch(() => ({ count: 0 })))?.count ?? 0;
  await loadPackIndex();
  route(true);
  window.addEventListener('hashchange', () => route());
  window.addEventListener('scroll', onScroll, { passive: true });
  for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) window.addEventListener(type, unpin, { passive: true });
  const endPress = () => {
    pointerPressed = false;
    clearTimeout(pressTimer);
    clearTimeout(renderTimer);
    // Run after the complete pointerup → mouseup → click sequence.
    renderTimer = setTimeout(() => { if (renderDeferred) renderAll(); }, 0);
  };
  document.addEventListener('pointerdown', () => {
    pointerPressed = true;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(endPress, 1500);
  }, true);
  document.addEventListener('pointerup', endPress, true);
  document.addEventListener('pointercancel', endPress, true);
  document.addEventListener('contextmenu', endPress, true);
  document.addEventListener('dragend', endPress, true);
  window.addEventListener('blur', endPress);
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="#/"]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(a.getAttribute('href')!);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    // Only the rail shows sites: replace it alone, so nothing being typed on the page is lost.
    if (area === 'local' && 'packIndex' in changes) void loadPackIndex().then(refreshRail);
  });
  // Changes made elsewhere show up here when there is nothing unsaved; with unsaved edits, save merges them.
  onSettingsChanged((next) => {
    if (saving || isDirty() || JSON.stringify(next) === saved) return;
    s = next;
    saved = JSON.stringify(s);
    renderAll();
  });
  // Any edit anywhere updates the save bar without a full re-render.
  document.addEventListener('input', refreshDirty);
  document.addEventListener('change', refreshDirty);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (isDirty()) void save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });
}

void main();
