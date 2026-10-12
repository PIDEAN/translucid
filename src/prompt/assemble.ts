import type { Expert, GlossaryEntry } from '../shared/types';
import { formatGlossary } from './glossary';
import { ATOM_RULE, PROTOCOL_HEAD, PROTOCOL_TAIL, SKIP_RULE, TAG_RULE } from './protocol';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BatchPromptInput {
  expert: Expert;
  glossary: GlossaryEntry[];
  title: string;
  topic?: string;
  segments: string[];
}

/** System prompt depends only on the expert, so it is identical across every batch of a page. */
export function buildSystemPrompt(expert: Expert): string {
  const rules = expert.rules
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('-') ? l : `- ${l}`))
    .join('\n');
  const markup = [TAG_RULE, ATOM_RULE, SKIP_RULE].map((r) => `- ${r}`).join('\n');
  return `${PROTOCOL_HEAD}\n\nMarkup:\n${markup}\n\nDomain rules (${expert.name}):\n${rules}\n\n${PROTOCOL_TAIL}`;
}

/**
 * Layout, most stable first, so prefix caches (DeepSeek) hit as often as possible:
 * system (protocol + markup rules + expert, fixed per expert) → glossary → page context → segments → reminder.
 * Markup rules used to be conditional; keeping them in the system prompt makes the
 * whole system prompt a cacheable prefix (measured: 128–256 of ~450 tokens hit before).
 * Context goes before the task: weak models translate trailing context.
 */
export function buildBatchMessages(input: BatchPromptInput): ChatMessage[] {
  const parts: string[] = [];
  if (input.glossary.length) parts.push(`<glossary>\n${formatGlossary(input.glossary)}\n</glossary>`);
  const ctx = [`Page title: ${input.title || '(none)'}`];
  if (input.topic) ctx.push(`Topic: ${input.topic}`);
  parts.push(`<context>\n${ctx.join('\n')}\n</context>`);

  const body = input.segments.map((s, i) => `<${i + 1}>${s}</${i + 1}>`).join('\n');
  parts.push(`Translate these ${input.segments.length} segment(s):\n${body}`);
  parts.push(PROTOCOL_TAIL);

  return [
    { role: 'system', content: buildSystemPrompt(input.expert) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

export interface RefineInput {
  expert: Expert;
  glossary: GlossaryEntry[];
  title: string;
  topic?: string;
  source: string;
}

function refineContext(input: RefineInput): string {
  const parts: string[] = [];
  if (input.glossary.length) parts.push(`<glossary>\n${formatGlossary(input.glossary)}\n</glossary>`);
  parts.push(`<context>\nPage title: ${input.title || '(none)'}${input.topic ? `\nTopic: ${input.topic}` : ''}\n</context>`);
  return parts.join('\n\n');
}

function refineSystem(expert: Expert): string {
  const notes = [
    'You are a senior translator producing a publication-quality Simplified Chinese translation of one passage from a web page.',
    `Domain rules (${expert.name}):\n${expert.rules}`,
    TAG_RULE,
    ATOM_RULE,
    'Put a space between Chinese and Latin letters/digits; use full-width Chinese punctuation.',
  ];
  return notes.join('\n\n');
}

/** 精翻 step 1: careful translation with an explicit self-check list. */
export function buildRefineDraftMessages(input: RefineInput): ChatMessage[] {
  return [
    { role: 'system', content: refineSystem(input.expert) },
    {
      role: 'user',
      content: `${refineContext(input)}\n\nTranslate the passage below. Before answering, check silently: accuracy (no additions/omissions/mistranslations), fluency (natural Chinese, no 翻译腔), style (matches the source register), terminology (glossary and consistency). Output only the translation.\n\n<source>\n${input.source}\n</source>`,
    },
  ];
}

/** 精翻 step 2: one round of critique-and-rewrite. More rounds tend to accumulate errors. */
export function buildRefineImproveMessages(input: RefineInput, draft: string): ChatMessage[] {
  return [
    { role: 'system', content: refineSystem(input.expert) },
    {
      role: 'user',
      content: `${refineContext(input)}\n\n<source>\n${input.source}\n</source>\n\n<draft>\n${draft}\n</draft>\n\nReview the draft against the source on four axes: accuracy, fluency, style, terminology. Fix every problem you find, keep what is already good, and keep all inline tags and {{n}} tokens. Output only the final translation, nothing else.`,
    },
  ];
}

/** Preprocess: one cheap call per long page for topic, page terms and scene. */
export function buildPreprocessMessages(title: string, article: string, sceneIds: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You analyse a web page before it is translated into Simplified Chinese. Reply with a single JSON object and nothing else.',
    },
    {
      role: 'user',
      content: `Page title: ${title}\n\n<article>\n${article}\n</article>\n\nReturn JSON with keys:\n- "topic": one English sentence describing what the page is about.\n- "scene": the best fit among ${sceneIds.map((s) => `"${s}"`).join(', ')}.\n- "terms": up to 15 items {"src": term, "tgt": Simplified Chinese rendering}. Only named entities and domain noun phrases of at most 5 words that need a consistent translation. Exclude variables, formulas, code, whole sentences and generic words. Use "KEEP" as tgt when the term should stay in the original language.`,
    },
  ];
}
