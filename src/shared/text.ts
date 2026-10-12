const CJK_RE = /[㐀-鿿豈-﫿]/g;
const KANA_HANGUL_RE = /[぀-ヿ가-힯]/;
const LETTER_RE = /\p{L}/gu;

export const TAG_RE = /<\/?[a-z]\d+>/g;
export const ATOM_RE = /\{\{\d+\}\}/g;

/** Drop inline tags and atoms, keeping only human text. */
export function stripMarkup(s: string): string {
  return s.replace(TAG_RE, '').replace(ATOM_RE, ' ');
}

/** Share of letters that are Han characters. */
export function cjkRatio(s: string): number {
  const letters = s.match(LETTER_RE)?.length ?? 0;
  if (!letters) return 0;
  return (s.match(CJK_RE)?.length ?? 0) / letters;
}

/** Already Chinese (Japanese with kana is not). */
export function isMostlyChinese(s: string): boolean {
  return cjkRatio(s) > 0.5 && !KANA_HANGUL_RE.test(s);
}

export function countLetters(s: string): number {
  return s.match(LETTER_RE)?.length ?? 0;
}

/** Text that is worth sending to a model at all. */
export function isTranslatable(text: string): boolean {
  const t = stripMarkup(text).trim();
  if (countLetters(t) < 2) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return false;
  if (isMostlyChinese(t)) return false;
  if (looksLikeIdentifier(t)) return false;
  if (looksLikeNameList(t)) return false;
  return true;
}

/**
 * File names, paths, package and repo names (`requirements.txt`, `.github/workflows`,
 * `bilingual_book_maker`, `useState`): a single token with code punctuation, digits or
 * camelCase. Plain words ("Readme", "Done.") still count as prose.
 */
export function looksLikeIdentifier(t: string): boolean {
  const core = t.trim().replace(/[.!?:;,]+$/, '');
  if (!core || /\s/.test(core)) return false;
  return /[._\/\\]/.test(core) || /\d/.test(core) || /[a-z][A-Z]/.test(core);
}

const NAME = "[A-Z][\\p{L}'’.-]*(?: [A-Z][\\p{L}'’.-]*){0,3}";
const NAME_LIST_RE = new RegExp(`^${NAME}(?:,? (?:and |& )?${NAME}|, ${NAME}){2,}(?:,? et al\\.?)?$`, 'u');

/** Author lines like "Ashish Vaswani, Noam Shazeer, Niki Parmar": three or more capitalised names. */
export function looksLikeNameList(t: string): boolean {
  const s = t.trim();
  return s.includes(',') && NAME_LIST_RE.test(s);
}

export function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const HAN = '\\u3400-\\u9fff\\uf900-\\ufaff';
const LATIN = 'A-Za-z0-9';
const OPEN_TAGS = '(?:<[a-z]\\d+>|\\{\\{\\d+\\}\\})*';
const CLOSE_TAGS = '(?:<\\/[a-z]\\d+>|\\{\\{\\d+\\}\\})*';
const HAN_THEN_LATIN = new RegExp(`([${HAN}])(${OPEN_TAGS})([${LATIN}])`, 'g');
const LATIN_THEN_HAN = new RegExp(`([${LATIN}%])(${CLOSE_TAGS})([${HAN}])`, 'g');

// Half-width punctuation right after a Han character ("绝了,OP") becomes full-width.
// Requiring the Han neighbour leaves "1,000", "a.b" and code untouched.
const HAN_GAP = new RegExp(`([${HAN}]${CLOSE_TAGS}) +(${OPEN_TAGS}[${HAN}])`, 'g');
const HALF_PUNCT = new RegExp(`([${HAN}])(${CLOSE_TAGS})([,;:!?]) ?`, 'g');
const FULL: Record<string, string> = { ',': '，', ';': '；', ':': '：', '!': '！', '?': '？' };

const HAN_CHAR = new RegExp(`[${HAN}]`);
const CJK_PUNCT = '，。！？；：、（）《》〈〉【】…—';
const isCjkSide = (ch: string | undefined) => !!ch && (HAN_CHAR.test(ch) || CJK_PUNCT.includes(ch));
const LATIN_CHAR = /[A-Za-z0-9]/;

/** Nearest non-space character before (dir -1) or after (dir 1) index i. */
function neighbor(s: string, i: number, dir: -1 | 1): string | undefined {
  for (let j = i + dir; j >= 0 && j < s.length; j += dir) if (s[j] !== ' ') return s[j];
  return undefined;
}

/**
 * Straight quotes around Chinese text become curly (“…” / ‘…’). Quotes pair up
 * in order within the segment. A double-quote pair converts when its content
 * has Han characters or it sits next to Chinese text (运行 "npm i" 命令); a
 * single-quote pair only when its content has Han, and apostrophes between
 * letters (OP's) never count. A lone opening quote at the segment start is kept
 * as “ for dialogue that continues into the next paragraph. English-only quotes
 * are left alone.
 */
function curlyQuotes(s: string): string {
  if (!s.includes('"') && !s.includes("'")) return s;
  const out = s.split('');
  const convert = (marks: number[], open: string, close: string, loose: boolean) => {
    let start = 0;
    if (marks.length % 2 === 1 && marks[0] === s.search(/\S/) && HAN_CHAR.test(s)) {
      out[marks[0]!] = open;
      start = 1;
    }
    for (let k = start; k + 1 < marks.length; k += 2) {
      const a = marks[k]!;
      const b = marks[k + 1]!;
      // Code-like values (lang="zh", x"y") stay straight.
      if (s[a - 1] === '=' || LATIN_CHAR.test(s[a - 1] ?? '') || LATIN_CHAR.test(s[b + 1] ?? '')) continue;
      const inner = HAN_CHAR.test(s.slice(a + 1, b));
      if (inner || (loose && (isCjkSide(neighbor(s, a, -1)) || isCjkSide(neighbor(s, b, 1))))) {
        out[a] = open;
        out[b] = close;
      }
    }
  };
  const doubles: number[] = [];
  const singles: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') doubles.push(i);
    else if (s[i] === "'" && !(LATIN_CHAR.test(s[i - 1] ?? '') && LATIN_CHAR.test(s[i + 1] ?? ''))) singles.push(i);
  }
  convert(doubles, '“', '”', true);
  convert(singles, '‘', '’', false);
  // Full-width quotes take no spaces next to Chinese text: 运行 “npm i” 命令 → 运行“npm i”命令.
  return out
    .join('')
    .replace(new RegExp(`([${HAN}${CJK_PUNCT}]) +([“‘])`, 'g'), '$1$2')
    .replace(new RegExp(`([”’]) +([${HAN}${CJK_PUNCT}])`, 'g'), '$1$2');
}

/**
 * Pangu-style spacing between Han characters and Latin letters/digits, plus
 * full-width punctuation and curly quotes around Han text, applied locally
 * because models follow the prompt rules only most of the time
 * ("Grok和DeepSeek"). Spaces go outside inline tags so links stay tight.
 */
export function polishChinese(s: string): string {
  return curlyQuotes(s)
    .replace(HALF_PUNCT, (_, han: string, tags: string, p: string) => han + tags + FULL[p])
    // Machine translation often leaves a space after full-width punctuation (排序方式： 最新).
    .replace(/([，。！？；：、]) +/g, '$1')
    // Chinese never puts spaces between Han characters, including around inline tags (编写 <a1>盲文</a1> 文本).
    .replace(HAN_GAP, '$1$2')
    .replace(/ {2,}/g, ' ')
    .replace(HAN_THEN_LATIN, '$1 $2$3')
    .replace(LATIN_THEN_HAN, '$1$2 $3');
}
