// Prompts for site language packs: localizing a web app's UI strings into any
// target language. Independent of the zh-CN page-translation protocol; bump
// UI_PROMPT_VERSION whenever the text changes.
import type { ChatMessage } from './assemble';
import type { EntryKind, EntryWhere, PackGlossaryEntry } from '../pack/format';

export const UI_PROMPT_VERSION = 3;

export interface UiItem {
  kind: EntryKind;
  src: string;
  /** Region label (approved regions) for strings collected without structure. */
  area: string;
  /** Where the string sits in the interface (source-language labels). */
  where?: EntryWhere;
}

export interface UiBatchInput {
  targetLang: string;
  appName: string;
  host: string;
  description: string;
  glossary: PackGlossaryEntry[];
  /** Strings to translate, numbered 1..n in this order. */
  items: UiItem[];
  /** Read-only neighbours (same group, already handled elsewhere): context for retries and split groups. */
  context?: UiItem[];
  /** Labels allowed to appear as structure context (approved strings only). */
  labels?: ReadonlySet<string>;
}

/** English language name for prompts ("Japanese", "Brazilian Portuguese"). */
export function langName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Role words written in front of each string (outside the tags). */
const KIND_ROLE: Record<EntryKind, string> = {
  text: 'text',
  placeholder: 'placeholder',
  'aria-label': 'aria',
  'aria-description': 'description',
  title: 'tooltip',
  alt: 'image',
  value: 'button',
};
const ITEM_ROLE: Record<string, string> = {
  button: 'button', link: 'link', tab: 'tab', menuitem: 'menuitem', option: 'opt', radio: 'opt', switch: 'switch', checkbox: 'checkbox',
  heading: 'heading', label: 'label', legend: 'label', description: 'description', value: 'value', placeholder: 'placeholder',
  tooltip: 'tooltip', 'aria-label': 'aria', image: 'image', text: 'text',
};
const GROUP_WORD: Record<string, string> = {
  radiogroup: 'radios', select: 'select', listbox: 'select', menu: 'menu', tablist: 'tabs', toolbar: 'toolbar', group: 'group', field: 'field', nav: 'nav',
};

function typographyRule(code: string): string {
  const c = code.toLowerCase();
  if (c.startsWith('zh')) return '- Chinese typography: full-width punctuation; a space between Chinese characters and Latin letters or digits.';
  if (c.startsWith('ja')) return '- Japanese typography: full-width punctuation; no spaces between Japanese words.';
  if (c.startsWith('de')) return '- German: use the formal or neutral UI register common in software (Sie-forms or infinitives for actions).';
  if (c.startsWith('fr')) return '- French: use the infinitive for actions and French spacing before : ; ! ?';
  return '';
}

export function buildUiSystemPrompt(targetLang: string): string {
  const name = `${langName(targetLang)} (${targetLang})`;
  return [
    `You are a professional software localizer. Translate user-interface strings of a web application into ${name}.`,
    '',
    'Output protocol (MUST follow):',
    '- Strings to translate are wrapped as <1>…</1>, <2>…</2> inside <strings>. Output the SAME ids in order, one translation per id: <1>…</1><2>…</2>.',
    '- Never merge, split, skip or reorder. Output only the tagged translations, no notes or explanations.',
    '- <app>, <glossary> and everything in <strings> outside the tags (role words, quoted labels) are context only. Never translate or echo them.',
    '',
    'How <strings> is laid out:',
    '- One UI element per line. Indentation shows nesting: screen (page, dialog, menu) › section › group › element.',
    '- The word before each string is its role: heading, tab, button, link, menuitem, label, description, opt (an option or radio choice), value (the current value shown on a dropdown), switch, checkbox, placeholder, tooltip, aria (accessible name).',
    '- A group line names the question its elements answer: radios / select / menu / tabs / field / group / nav, followed by its label. Quoted text ("…") is read-only context.',
    '',
    'Localization rules:',
    `- Use the established software UI terminology of ${langName(targetLang)}, as in major operating systems and apps. Be concise: UI space is limited.`,
    '- Options and values answer their group\'s label: translate them as answers to that question (an occupation list wants occupations, a size setting wants sizes).',
    '- Items of a nav group and tabs are names of sections or pages, usually nouns; translate them the same way as the headings of the pages they open.',
    '- Headings and labels are titles; a description explains the setting it follows and is a full sentence in the target language.',
    '- Options of one group take the same grammatical form and are distinct from each other.',
    '- The same source text may need different translations in different groups; translate each occurrence for its own context.',
    '- Actions (buttons, menu items) use the usual verb form for software in the target language.',
    '- Keep product, brand, model and feature names unchanged unless an official localized name exists.',
    '- Keep placeholders exactly as written ({0}, {name}, {{x}}, %s, %1$d, ${x}), and keep keyboard shortcuts (⌘K, Ctrl+Enter) and URLs unchanged.',
    "- Follow the target language's capitalization and punctuation conventions; do not add punctuation the source does not have.",
    '- These strings are interface chrome, not user content. If a string is only a name, number or code, output it unchanged.',
    '- Follow the glossary exactly and keep each term consistent across strings.',
    typographyRule(targetLang),
    '',
    'Remember: same ids, same count, tagged translations only.',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
}

const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;

const ownScreen = (it: UiItem) => it.where?.surface ?? `area: ${it.area}`;
const groupId = (it: UiItem) => (it.where?.groupRole ? `${it.where.section ?? ''}\u0002${it.where.groupRole}\u0002${it.where.group ?? ''}` : '');

/** A question keeps all its parts together: options from a portalled list sit under the screen where the question first appears. */
function screens(items: UiItem[]): (it: UiItem) => string {
  const first = new Map<string, string>();
  for (const it of items) {
    const g = groupId(it);
    if (g && !first.has(g)) first.set(g, ownScreen(it));
  }
  return (it) => first.get(groupId(it)) ?? ownScreen(it);
}
const groupOf = (it: UiItem) => (it.where?.groupRole ? `${it.where.groupRole}\u0001${it.where.group ?? ''}` : '');
const isGroupLabel = (it: UiItem) => !!it.where?.group && it.src === it.where.group && (it.where.role === 'label' || it.where.role === 'legend');

interface OrderKey {
  i: number;
  screen: string;
  section: string;
  group: string;
  a: number;
  b: number;
  c: number;
  d: number;
}

/**
 * Page order, with every part of one question gathered where the question first appears (a group's
 * own label first). Screens and sections keep their first-seen order.
 */
function orderKeys(items: UiItem[]): OrderKey[] {
  const screenOf = screens(items);
  const rank = new Map<string, number>();
  const r = (k: string) => rank.get(k) ?? rank.set(k, rank.size).get(k)!;
  const anchor = new Map<string, number>();
  return items.map((it, i) => {
    const screen = screenOf(it);
    const section = it.where?.section ?? '';
    const group = groupOf(it);
    const gk = group ? `${screen}\u0002${section}\u0002${group}` : '';
    if (gk && !anchor.has(gk)) anchor.set(gk, i);
    return { i, screen, section, group, a: r(screen), b: r(`${screen}\u0002${section}`), c: gk ? anchor.get(gk)! : i, d: isGroupLabel(it) ? 0 : 1 };
  });
}

const byOrder = (x: OrderKey, y: OrderKey) => x.a - y.a || x.b - y.b || x.c - y.c || x.d - y.d || x.i - y.i;

/** Display order of the outline. Batches are stored in this order so the ids read 1, 2, 3… top to bottom. */
export function outlineOrder(items: UiItem[]): number[] {
  return orderKeys(items).sort(byOrder).map((k) => k.i);
}

/**
 * The <strings> outline: screen › section › group › element, in page order. Labels appear only when
 * approved; a group label that is itself being translated in this batch becomes the group line.
 */
export function buildOutline(items: UiItem[], context: UiItem[] = [], labels: ReadonlySet<string> = new Set()): string {
  type Row = { item: UiItem; id?: number };
  const rows: Row[] = [...items.map((item, i) => ({ item, id: i + 1 })), ...context.map((item) => ({ item }))];
  const ok = (s: string | undefined) => (s && (labels.has(s) || items.some((i) => i.src === s)) ? s : undefined);
  const line = (depth: number, s: string) => ' '.repeat(depth) + s;
  const tagged = (r: Row) => (r.id ? `<${r.id}>${r.item.src}</${r.id}>` : quote(r.item.src));
  const keys = orderKeys(rows.map((r) => r.item)).sort(byOrder);
  const out: string[] = [];
  let screen: string | undefined;
  let section: string | undefined;
  let group: string | undefined;
  let groupOwn: Row | undefined;
  for (let n = 0; n < keys.length; n++) {
    const k = keys[n]!;
    const row = rows[k.i]!;
    if (k.screen !== screen) {
      screen = k.screen;
      section = group = undefined;
      const [kind, ...rest] = screen.split(': ');
      const label = ok(rest.join(': '));
      out.push(label ? `${kind} ${quote(label)}` : kind!);
    }
    if (k.section !== section) {
      section = k.section;
      group = undefined;
      if (section) {
        const sl = ok(section);
        out.push(line(1, sl ? `section ${quote(sl)}` : 'section'));
      }
    }
    const depth = section ? 2 : 1;
    if (k.group !== group) {
      group = k.group;
      groupOwn = undefined;
      if (group) {
        const [role, glabel] = group.split('\u0001');
        const word = GROUP_WORD[role!] ?? 'group';
        // The label being translated here doubles as the group line (rows are sorted label first).
        if (isGroupLabel(row.item)) groupOwn = row;
        const head = groupOwn ? tagged(groupOwn) : ok(glabel) ? quote(glabel!) : '';
        out.push(line(depth, head ? `${word} ${head}` : word));
        if (groupOwn) continue;
      }
    }
    out.push(line(group ? depth + 1 : depth, `${roleWord(row.item)} ${tagged(row)}`));
  }
  return out.join('\n');
}

const roleWord = (it: UiItem) => (it.where?.role ? (ITEM_ROLE[it.where.role] ?? 'text') : KIND_ROLE[it.kind]);

export function buildUiBatchMessages(input: UiBatchInput): ChatMessage[] {
  const parts: string[] = [];
  const app = [`name: ${input.appName}`, `host: ${input.host}`];
  if (input.description) app.push(`what it is: ${input.description}`);
  parts.push(`<app>\n${app.join('\n')}\n</app>`);
  if (input.glossary.length) {
    parts.push(`<glossary>\n${input.glossary.map((g) => `${g.src} => ${g.tgt}`).join('\n')}\n</glossary>`);
  }
  parts.push(`<strings>\n${buildOutline(input.items, input.context, input.labels)}\n</strings>`);
  return [
    { role: 'system', content: buildUiSystemPrompt(input.targetLang) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** Optional: draft an app description from approved strings only (the user confirms or edits it). */
export function buildAppDescriptionMessages(appName: string, host: string, strings: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You describe web applications for translators. Based only on the interface strings given, write one or two plain sentences in English saying what the application is and what its main features are. Do not guess personal details. Output only the description.',
    },
    { role: 'user', content: `App: ${appName} (${host})\nInterface strings:\n${strings.slice(0, 80).map((s) => `- ${s}`).join('\n')}` },
  ];
}
