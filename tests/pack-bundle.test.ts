import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pack script runs at document_start on every page of a pack host: its
// import graph must stay small (no settings, presets, prompts or providers).
const ROOT = resolve(__dirname, '..');
const ALLOWED = [/^wxt\//, /^src\/pack\//, /^src\/shared\/dom-tags\.ts$/, /^src\/shared\/text\.ts$/];

function importsOf(file: string): string[] {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  return [...src.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
}

function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith('.')) {
        seen.add(spec);
        continue;
      }
      let target = resolve(dirname(resolve(ROOT, file)), spec).slice(ROOT.length + 1);
      if (!target.endsWith('.ts')) target += '.ts';
      visit(target);
    }
  };
  visit(entry);
  return seen;
}

describe('pack content script bundle', () => {
  it('imports only wxt, src/pack and tiny shared helpers', () => {
    const deps = [...graph('entrypoints/pack.content.ts')].filter((d) => d !== 'entrypoints/pack.content.ts');
    const bad = deps.filter((d) => !ALLOWED.some((re) => re.test(d)));
    expect(bad).toEqual([]);
  });
});
