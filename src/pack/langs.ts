/** Target languages offered for site language packs (any valid BCP 47 code works in files). */
export const PACK_LANGS: [code: string, label: string][] = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['en', 'English'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['pt-BR', 'Português (Brasil)'],
  ['it', 'Italiano'],
  ['ru', 'Русский'],
  ['uk', 'Українська'],
  ['pl', 'Polski'],
  ['tr', 'Türkçe'],
  ['vi', 'Tiếng Việt'],
  ['th', 'ไทย'],
  ['id', 'Bahasa Indonesia'],
  ['ar', 'العربية'],
  ['he', 'עברית'],
  ['hi', 'हिन्दी'],
];

export const langLabel = (code: string) => PACK_LANGS.find(([c]) => c === code)?.[1] ?? code;
