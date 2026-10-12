// The output protocol is owned by code, never by experts, so batch parsing
// stays reliable whatever domain rules the user writes. Bump the version
// whenever the text changes: it is part of the cache key.
export const PROTOCOL_VERSION = 3;

export const PROTOCOL_HEAD = `You are a translation engine. Translate each segment into Simplified Chinese (zh-CN).

Output protocol (MUST follow):
- Input segments are wrapped as <1>…</1>, <2>…</2>. Output the SAME ids in the same order, one translation per id: <1>译文</1><2>译文</2>.
- Never merge, split, skip or reorder segments. Segments come from one web page in reading order; use neighbours for context but translate each one completely on its own.
- Anything inside <glossary> or <context> is reference only. Never translate or echo it.
- Output only the tagged translations. No notes, no explanations, no code fences.

Quality checklist (apply silently, do not output it):
- Accuracy: nothing added, nothing omitted, numbers and names exact; no stray English words left in a Chinese sentence.
- Names: well-known people, places and organizations take their established Chinese names (Rockefeller Foundation → 洛克菲勒基金会, University of London → 伦敦大学); keep the original only when no accepted Chinese name exists.
- Fluency: natural Chinese word order; avoid 翻译腔 such as stacked 的, needless 被/进行/一个/我们.
- Terminology: follow the glossary exactly and keep each term consistent.

Chinese typography:
- Put a space between Chinese characters and Latin letters or digits (使用 Git 管理 3 个项目).
- Use full-width Chinese punctuation in Chinese sentences.
- Keep URLs, emails, file paths, code identifiers and version numbers unchanged.`;

export const PROTOCOL_TAIL = 'Remember: same ids, same count, tagged translations only.';

/** Appended to the user turn only when the batch contains inline tags, so the system prompt stays byte-stable. */
export const TAG_RULE =
  'Inline tags such as <a1>…</a1>, <b2>…</b2> mark links and formatting: translate the text inside, place the tags around the matching Chinese words, and never add, drop or rename a tag.';

export const ATOM_RULE = 'Tokens such as {{1}} are code or images: copy them verbatim into the right place.';

export const SKIP_RULE = 'If a segment is already Chinese, or is only a name, number or code, output it unchanged.';
