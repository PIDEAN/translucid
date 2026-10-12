import type { Expert } from '../../shared/types';

// Each expert only carries domain semantics. Output protocol, tags and
// typography live in protocol.ts so experts stay short and swappable.
// Rules are concrete and example-driven: research and community experience
// show personas/briefs barely help, specific do/don't rules do.

export const GENERAL_EXPERT_ID = 'general';

export const BUILTIN_EXPERTS: Expert[] = [
  {
    id: GENERAL_EXPERT_ID,
    name: '通用',
    matches: [],
    version: 1,
    builtin: true,
    rules: [
      'Be faithful to the meaning first, then make it read like text originally written in Chinese.',
      'Proper nouns without a widely accepted Chinese name stay in the original language.',
      'Keep the register of the source: formal stays formal, casual stays casual.',
    ].join('\n'),
  },
  {
    id: 'tech',
    name: '科技/开发',
    matches: [
      'github.com', 'gitlab.com', 'stackoverflow.com', '*.stackexchange.com',
      'news.ycombinator.com', 'techcrunch.com', 'theverge.com', 'arstechnica.com',
      'developer.mozilla.org', '*.dev', 'docs.*', 'developer.*', 'dev.to', 'medium.com',
      'lobste.rs', 'npmjs.com', 'pypi.org', 'readthedocs.io', '*.readthedocs.io',
      // Hardware and PC news (dense spec talk, product codenames, enthusiast comments).
      'techpowerup.com', 'tomshardware.com', 'anandtech.com', 'videocardz.com', 'wccftech.com', 'guru3d.com',
      'notebookcheck.net', 'phoronix.com', 'servethehome.com', 'overclock3d.net', 'kitguru.net', 'hothardware.com',
    ],
    version: 2,
    builtin: true,
    rules: [
      'Never translate code, commands, flags, API/function/class names, file names, product and library names (React, Kubernetes, `npm install`).',
      'Keep well-known technical terms in English when Chinese developers normally do: token, commit, pull request, prompt, Transformer, embedding, runtime. For other terms use the standard Chinese term; if a term is ambiguous, write it once as 中文（English）.',
      'UI strings use the localized wording Chinese software actually ships: Settings → 设置, Sign in → 登录, Repository → 仓库, Issue → Issue.',
      'Headings and README titles are short noun phrases, not sentences ("Getting Started" → 快速开始).',
      'Keep version numbers, units and benchmark figures exactly as written.',
    ].join('\n'),
  },
  {
    id: 'news',
    name: '新闻',
    matches: [
      'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com',
      'washingtonpost.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'economist.com', 'cnn.com',
      'npr.org', 'aljazeera.com', 'axios.com', 'politico.com', 'theatlantic.com',
    ],
    version: 1,
    builtin: true,
    rules: [
      'Use Chinese news register (新闻语体): concise, neutral, information first.',
      'Headlines are short and punchy; drop articles and filler ("Officials say talks have stalled" → 官员称谈判陷入僵局).',
      'Quotes, attributions (said/according to → 表示/据), datelines, numbers, currencies and units must be exact; never round or reinterpret.',
      'Use Xinhua-standard Chinese names for people, places and organizations when one exists; otherwise keep the original.',
      'Do not add evaluative words that are not in the source.',
    ].join('\n'),
  },
  {
    id: 'academic',
    name: '学术',
    matches: [
      'arxiv.org', '*.edu', 'nature.com', 'science.org', 'sciencedirect.com', 'springer.com',
      'link.springer.com', 'dl.acm.org', 'ieeexplore.ieee.org', 'openreview.net',
      'aclanthology.org', 'semanticscholar.org', 'wiley.com', 'jstor.org', 'pnas.org',
    ],
    version: 1,
    builtin: true,
    rules: [
      'Use formal academic Chinese (学术书面语); no colloquialisms.',
      'Copy formulas, variables, statistics and citations verbatim: "p < 0.05", "n = 120", "Smith et al. (2021)", "[12]", "Eq. 3".',
      'On first occurrence write specialized terms as 中文（English）, e.g. 注意力机制（attention mechanism）; afterwards use the Chinese term.',
      'Preserve hedging strength exactly: may/might → 可能, suggest → 表明/提示, demonstrate → 证明; never upgrade "suggests" to "proves".',
      'Keep section names conventional: Abstract → 摘要, Related Work → 相关工作, Ablation Study → 消融实验.',
    ].join('\n'),
  },
  {
    id: 'rigorous',
    name: '严谨（法律/医疗/金融）',
    matches: [
      '*.gov', '*.gov.uk', 'pubmed.ncbi.nlm.nih.gov', '*.nih.gov', 'who.int', 'sec.gov',
      'law.cornell.edu', 'eur-lex.europa.eu', 'fda.gov', 'mayoclinic.org',
      // Path rules match anywhere in the path: /github-terms-of-service, /legal/privacy-policy.
      '*/*terms*', '*/tos', '*/tos/*', '*/*privacy*', '*/*legal*', '*/*policy*', '*/*policies*', '*/*license*',
    ],
    version: 2,
    builtin: true,
    rules: [
      'Accuracy over fluency: translate literally where meaning could shift. No paraphrasing, no omissions, no merging of conditions.',
      'Modal verbs are distinct obligations: shall/must → 应当/必须, may → 可以, should → 应, shall not/must not → 不得. Keep them consistent.',
      'Numbers, amounts, currencies, doses, units, dates, percentages and clause/section numbers must match the source exactly.',
      'Keep every negation, exception and qualifier (unless, except, provided that, notwithstanding, to the extent) and its scope.',
      'Use the standard industry term; if unsure, keep the original in parentheses after the Chinese, e.g. 赔偿（indemnification）.',
      'Defined terms (capitalized, e.g. "Services", "User Content") get one fixed Chinese rendering used everywhere, in 「」 or quotes as the source does.',
    ].join('\n'),
  },
  {
    id: 'social',
    name: '社区/娱乐',
    matches: [
      'reddit.com', '*.reddit.com', 'twitter.com', 'x.com', 'youtube.com', 'discord.com',
      'tumblr.com', 'quora.com', 'twitch.tv', 'bsky.app', 'threads.net', 'mastodon.social',
      '9gag.com', 'imgur.com', 'fandom.com', '*.fandom.com',
    ],
    version: 1,
    builtin: true,
    rules: [
      'Write like a native Chinese netizen: casual, lively, keep the emotion, sarcasm and jokes. No stiff written register.',
      'Translate slang by meaning, not word by word: chef\'s kiss → 绝了, ngl → 说实话, lmao → 笑死, based → 有种/说得好, cope → 嘴硬, W/L → 赢麻了/寄了.',
      'Keep OP, @mentions, u/ and r/ names, #hashtags, $TICKERS, emoji and URLs unchanged.',
      'Do not sanitize profanity; match its intensity with natural Chinese equivalents.',
      'Short replies stay short. Do not explain memes.',
    ].join('\n'),
  },
  {
    id: 'fiction',
    name: '小说/文学',
    matches: [
      'archiveofourown.org', 'royalroad.com', 'fanfiction.net', 'wattpad.com',
      'gutenberg.org', 'scribblehub.com', 'novelupdates.com',
    ],
    version: 1,
    builtin: true,
    rules: [
      'Preserve the narrative voice, tense feel and rhythm; dialogue must sound like real people talking.',
      'Keep each character\'s speech style distinct (formal, rough, childish).',
      'Character names and invented terms: transliterate once and keep identical everywhere; do not translate names that are ordinary words.',
      'Do not add pronouns or subjects the source omits; do not over-explain.',
      'Do not sanitize violence, romance or profanity.',
    ].join('\n'),
  },
];
