import { describe, expect, it } from 'vitest';
import { packBatches } from '../src/background/batching';
import { parsePreprocess } from '../src/background/session';
import { SegmentStreamParser } from '../src/background/stream-parser';
import { validateTranslation } from '../src/background/validate';
import { buildBatchMessages, buildSystemPrompt } from '../src/prompt/assemble';
import { BUILTIN_EXPERTS } from '../src/prompt/experts/builtin';
import { findHits, formatGlossary, parseGlossary } from '../src/prompt/glossary';
import { matchHost, resolveExpert } from '../src/shared/match';
import { isTranslatable } from '../src/shared/text';

const expert = (id: string) => BUILTIN_EXPERTS.find((e) => e.id === id)!;

describe('SegmentStreamParser', () => {
  it('emits segments as soon as their closing tag arrives', () => {
    const p = new SegmentStreamParser();
    expect(p.push('<1>你')).toEqual([]);
    expect(p.push('好</1>\n<2>世')).toEqual([{ id: 1, text: '你好' }]);
    expect(p.push('界</2>')).toEqual([{ id: 2, text: '世界' }]);
  });

  it('keeps inline tags inside segments and ignores think blocks', () => {
    const p = new SegmentStreamParser();
    const out = p.push('<think>hmm <1>x</1></think><1>点击<a1>这里</a1></1>');
    expect(out).toEqual([{ id: 1, text: '点击<a1>这里</a1>' }]);
  });

  it('recovers an unterminated last segment on end()', () => {
    const p = new SegmentStreamParser();
    p.push('<1>一</1><2>二');
    expect(p.end()).toEqual([{ id: 2, text: '二' }]);
  });
});

describe('validateTranslation', () => {
  it('accepts a normal translation', () => {
    expect(validateTranslation('Read <a1>the docs</a1> first.', '先阅读<a1>文档</a1>。').ok).toBe(true);
  });
  it('rejects missing or invented tags', () => {
    expect(validateTranslation('Read <a1>the docs</a1> first.', '先阅读文档。')).toMatchObject({ ok: false, soft: true, reason: 'missing links' });
    expect(validateTranslation('Use {{1}} now', '现在使用')).toMatchObject({ ok: false });
  });
  it('rejects echoed English', () => {
    const src = 'The quick brown fox jumps over the lazy dog.';
    expect(validateTranslation(src, src)).toMatchObject({ ok: false });
  });
  it('accepts terms that compress a lot', () => {
    expect(validateTranslation('<a1>Dimensionality reduction</a1>', '<a1>降维</a1>').ok).toBe(true);
  });
  it('flags glossary misses as soft', () => {
    const hits = parseGlossary('agent => 智能体');
    const v = validateTranslation('The agent calls tools on its own.', '代理会自行调用工具。', hits);
    expect(v).toMatchObject({ ok: false, soft: true });
  });
  it('rejects a leaked segment wrapper', () => {
    expect(validateTranslation('Hello there friend', '<2>你好朋友')).toMatchObject({ ok: false });
  });
});

describe('glossary', () => {
  const g = parseGlossary('# comment\nLLM => 大语言模型\nTransformer => KEEP # architecture\nagent → 智能体');
  it('parses entries, KEEP and notes', () => {
    expect(g).toEqual([
      { src: 'LLM', tgt: '大语言模型' },
      { src: 'Transformer', tgt: 'KEEP', note: 'architecture' },
      { src: 'agent', tgt: '智能体' },
    ]);
  });
  it('matches on word boundaries, case-sensitive for proper nouns', () => {
    expect(findHits(g, 'Large LLMs and the Transformer').map((e) => e.src)).toEqual(['Transformer']);
    expect(findHits(g, 'An Agent and an agentic loop').map((e) => e.src)).toEqual(['agent']);
  });
  it('formats deterministically', () => {
    expect(formatGlossary([g[2]!, g[0]!])).toBe(formatGlossary([g[0]!, g[2]!]));
  });
});

describe('expert matching', () => {
  it('matches hosts and subdomains', () => {
    expect(matchHost('github.com', 'gist.github.com')).toBe(true);
    expect(matchHost('*.edu', 'cs.stanford.edu')).toBe(true);
    expect(matchHost('docs.*', 'docs.python.org')).toBe(true);
    expect(matchHost('x.com', 'netflix.com')).toBe(false);
  });
  it('prefers path rules over host rules', () => {
    expect(resolveExpert(BUILTIN_EXPERTS, 'https://github.com/site/terms', 'general')!.id).toBe('rigorous');
    expect(resolveExpert(BUILTIN_EXPERTS, 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service', 'general')!.id).toBe('rigorous');
    expect(resolveExpert(BUILTIN_EXPERTS, 'https://www.apple.com/legal/privacy/en-ww/', 'general')!.id).toBe('rigorous');
    expect(resolveExpert(BUILTIN_EXPERTS, 'https://github.com/vercel/next.js', 'general')!.id).toBe('tech');
    expect(resolveExpert(BUILTIN_EXPERTS, 'https://old.reddit.com/r/rust', 'general')!.id).toBe('social');
    expect(resolveExpert(BUILTIN_EXPERTS, 'https://example.org/', 'general')!.id).toBe('general');
  });
});

describe('prompt assembly', () => {
  it('keeps the system prompt byte-stable across batches', () => {
    const a = buildBatchMessages({ expert: expert('tech'), glossary: [], title: 'A', segments: ['x <a1>y</a1>'] });
    const b = buildBatchMessages({ expert: expert('tech'), glossary: [], title: 'B', segments: ['plain'] });
    expect(a[0]!.content).toBe(b[0]!.content);
    expect(a[0]!.content).toBe(buildSystemPrompt(expert('tech')));
  });
  it('keeps markup rules in the system prompt and puts context before segments', () => {
    const [sys, plain] = buildBatchMessages({ expert: expert('general'), glossary: [], title: 'T', segments: ['hello world'] });
    const [, tagged] = buildBatchMessages({
      expert: expert('general'),
      glossary: parseGlossary('LLM => 大语言模型'),
      title: 'T',
      topic: 'About LLMs',
      segments: ['see <a1>link</a1>', 'run {{2}}'],
    });
    expect(sys!.content).toContain('<a1>…</a1>');
    expect(sys!.content).toContain('{{1}}');
    expect(plain!.content).not.toContain('<a1>…</a1>');
    const c = tagged!.content;
    expect(c.indexOf('<glossary>')).toBeLessThan(c.indexOf('<context>'));
    expect(c.indexOf('<context>')).toBeLessThan(c.indexOf('<1>see'));
    expect(c).toContain('<2>run {{2}}</2>');
  });
});

describe('batching', () => {
  it('packs by chars and count', () => {
    const items = ['aaaa', 'bbbb', 'cccc', 'dd', 'e'].map((text) => ({ text }));
    expect(packBatches(items, 8, 10).map((b) => b.length)).toEqual([2, 3]);
    expect(packBatches(items, 100, 2).map((b) => b.length)).toEqual([2, 2, 1]);
  });
});

describe('text filters', () => {
  it('skips Chinese, urls, numbers', () => {
    expect(isTranslatable('Hello world')).toBe(true);
    expect(isTranslatable('这是中文段落，不需要翻译')).toBe(false);
    expect(isTranslatable('https://example.com/a')).toBe(false);
    expect(isTranslatable('2024-10-03')).toBe(false);
    expect(isTranslatable('これは日本語です')).toBe(true);
    expect(isTranslatable('requirements.txt')).toBe(false);
    expect(isTranslatable('.github/workflows')).toBe(false);
    expect(isTranslatable('bilingual_book_maker')).toBe(false);
    expect(isTranslatable('useState')).toBe(false);
    expect(isTranslatable('Readme')).toBe(true);
    expect(isTranslatable('Done.')).toBe(true);
  });
});

describe('parsePreprocess', () => {
  it('extracts topic, terms and a known scene from noisy output', () => {
    const raw = 'Sure!\n```json\n{"topic":"A paper on diffusion models","scene":"academic","terms":[{"src":"diffusion model","tgt":"扩散模型"},{"src":"<a1>","tgt":"x"},{"src":"DDPM","tgt":"KEEP"}]}\n```';
    const r = parsePreprocess(raw, BUILTIN_EXPERTS);
    expect(r.topic).toBe('A paper on diffusion models');
    expect(r.scene).toBe('academic');
    expect(r.terms.map((t) => t.src)).toEqual(['diffusion model', 'DDPM']);
    expect(parsePreprocess('{"scene":"nope"}', BUILTIN_EXPERTS).scene).toBeUndefined();
  });
});

describe('tag loss severity', () => {
  const src = 'See <a1>docs</a1>, it is <i2>not</i2> {{3}} optional';
  it('accepts dropped emphasis', () => {
    expect(validateTranslation(src, '见<a1>文档</a1>，它{{3}}不是可选的').ok).toBe(true);
  });
  it('treats dropped links as soft and dropped atoms as hard', () => {
    expect(validateTranslation(src, '见文档，它<i2>不</i2>{{3}}是可选的')).toMatchObject({ ok: false, soft: true, reason: 'missing links' });
    expect(validateTranslation(src, '见<a1>文档</a1>，它<i2>不</i2>是可选的')).toMatchObject({ ok: false, reason: 'missing atoms' });
  });
});

describe('site defaults', () => {
  it('merges builtin, global and user selectors and drops invalid ones', async () => {
    const { builtinExcludeList, joinSelectors } = await import('../src/shared/site-defaults');
    const list = builtinExcludeList('en.wikipedia.org');
    expect(list).toContain('.mw-editsection');
    expect(list).toContain('[class*="sr-only"]');
    expect(builtinExcludeList('en.wikipedia.org', false)).not.toContain('.mw-editsection');
    const joined = joinSelectors(['.a, [data-x="1,2"]', 'div[[bad', '.b'])!;
    expect(joined).toBe('.a, [data-x="1,2"], .b');
  });
});

describe('polishChinese', () => {
  it('adds spaces between Han and Latin, outside inline tags', async () => {
    const { polishChinese } = await import('../src/shared/text');
    expect(polishChinese('Grok和DeepSeek')).toBe('Grok 和 DeepSeek');
    expect(polishChinese('使用<a1>Claude</a1>的3个模型')).toBe('使用 <a1>Claude</a1> 的 3 个模型');
    expect(polishChinese('提升50%以上')).toBe('提升 50% 以上');
    expect(polishChinese('已经 正确 的 Git')).toBe('已经正确的 Git');
    expect(polishChinese('（GPT）是')).toBe('（GPT）是');
    expect(polishChinese('说实话这次重构绝了,OP 真是神仙操作')).toBe('说实话这次重构绝了，OP 真是神仙操作');
    expect(polishChinese('笑死,构建又挂了!真的吗?')).toBe('笑死，构建又挂了！真的吗？');
    expect(polishChinese('打开<a1>设置</a1>:端口')).toBe('打开<a1>设置</a1>：端口');
    expect(polishChinese('共 1,000 个, version 2.0: a,b')).toBe('共 1,000 个，version 2.0: a,b');
  });

  it('turns straight quotes around Chinese text into curly quotes', async () => {
    const { polishChinese } = await import('../src/shared/text');
    // Sweep outputs from Claude Haiku 5.5 (fiction / news).
    expect(polishChinese('"你迟到了。"米拉说，眼睛没离开地图。')).toBe('“你迟到了。”米拉说，眼睛没离开地图。');
    expect(polishChinese('凯尔耸了耸肩。"河水比我记得的要急。或者是我太慢了。"')).toBe('凯尔耸了耸肩。“河水比我记得的要急。或者是我太慢了。”');
    expect(polishChinese('行长周二对记者表示:"我们尚未达到应有的水平。"')).toBe('行长周二对记者表示：“我们尚未达到应有的水平。”');
    expect(polishChinese('"你来晚了,"米拉说')).toBe('“你来晚了，”米拉说');
    // English inside Chinese, nested single quotes, inline tags.
    expect(polishChinese('运行 "npm install" 命令')).toBe('运行“npm install”命令');
    expect(polishChinese('他说："她回答\'好的\'。"')).toBe('他说：“她回答‘好的’。”');
    expect(polishChinese('点击"<a1>设置</a1>"按钮')).toBe('点击“<a1>设置</a1>”按钮');
    // Dialogue continuing into the next paragraph: lone opening quote.
    expect(polishChinese('"我们走吧，她说，天快黑了。')).toBe('“我们走吧，她说，天快黑了。');
    // Left alone: English-only text, apostrophes, untouched English quotes.
    expect(polishChinese('He said "hello" to OP\'s team')).toBe('He said "hello" to OP\'s team');
    expect(polishChinese('OP\'s 重构绝了')).toBe('OP\'s 重构绝了');
    expect(polishChinese("it's 'fine'")).toBe("it's 'fine'");
    expect(polishChinese('将 lang="zh" 添加到根元素')).toBe('将 lang="zh" 添加到根元素');
    expect(polishChinese('设置 title="标题" 属性')).toBe('设置 title="标题" 属性');
  });
});

describe('markup sanitizing and name lists', () => {
  it('repairs spaced tags and drops invented ones', async () => {
    const { sanitizeMarkup } = await import('../src/background/validate');
    expect(sanitizeMarkup('he <i1>may</i1> fall', '他< i1>可能</ i1 >会<b7>爱上</b7>')).toBe('他<i1>可能</i1>会爱上');
  });
  it('skips author lists but not title-case headings', async () => {
    const { isTranslatable } = await import('../src/shared/text');
    expect(isTranslatable('Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit')).toBe(false);
    expect(isTranslatable('Smith, Jones and Brown')).toBe(false);
    expect(isTranslatable('Attention Is All You Need')).toBe(true);
    expect(isTranslatable('Apples, oranges and bananas are fruit')).toBe(true);
  });
});

describe('real-page fixes (Claude on Wikipedia, 2026-10-11)', () => {
  it('flags English function words left between Chinese characters', async () => {
    const { strayEnglish, validateTranslation } = await import('../src/background/validate');
    expect(strayEnglish('机器翻译的构想 later 在 17 世纪再次出现。')).toBe('later');
    expect(strayEnglish('每次 commit 都会触发 pull request 预览')).toBeUndefined();
    expect(strayEnglish('当 a 大于 b 时成立')).toBeUndefined();
    expect(strayEnglish('99 条评论 on NVIDIA 据称')).toBe('on');
    expect(strayEnglish('使用 React 和 Vue')).toBeUndefined();
    const v = validateTranslation('The idea of machine translation later appeared in the 17th century.', '机器翻译的构想 later 在 17 世纪再次出现。');
    expect(v).toMatchObject({ ok: false, soft: true });
  });

  it('removes spaces between Han characters, also around inline tags', async () => {
    const { polishChinese } = await import('../src/shared/text');
    expect(polishChinese('用计算机阅读和编写 <a1>盲文</a1> 文本')).toBe('用计算机阅读和编写<a1>盲文</a1>文本');
    expect(polishChinese('编写 盲文 文本')).toBe('编写盲文文本');
    expect(polishChinese('使用 <a1>Git</a1> 管理')).toBe('使用 <a1>Git</a1> 管理');
  });
});

describe('untranslated check (TechPowerUp, 2026-10-11)', () => {
  it('accepts echoed names and products but not echoed sentences', async () => {
    const { validateTranslation } = await import('../src/background/validate');
    expect(validateTranslation('NVIDIA GeForce 617.42 WHQL', 'NVIDIA GeForce 617.42 WHQL').ok).toBe(true);
    expect(validateTranslation('<a1>Quiet Harbor Lamp</a1>', '<a1>Quiet Harbor Lamp</a1>').ok).toBe(true);
    expect(validateTranslation('Prices keep going up', 'Prices keep going up')).toMatchObject({ ok: false, soft: true });
  });
});
