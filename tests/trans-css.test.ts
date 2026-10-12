// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles/trans.css'), 'utf8');

describe('trans.css: translation-only mode', () => {
  it('keeps unchanged translations (brand names) hidden, so the name is not shown twice', () => {
    document.head.innerHTML = `<style>${css}</style>`;
    document.documentElement.className = 'xt-on xt-replace';
    document.body.innerHTML = `<header><b id="brand">Notara Journal<xt-trans class="xt-inline xt-fit" data-state="done" data-same>Notara Journal</xt-trans></b>
      <a><xt-orig>Product</xt-orig><xt-trans id="t" class="xt-inline xt-fit" data-state="done">产品</xt-trans></a></header>`;
    const display = (sel: string) => getComputedStyle(document.querySelector(sel)!).display;
    expect(display('#brand xt-trans')).toBe('none');
    expect(display('#t')).toBe('inline-block');
    expect(display('xt-orig')).toBe('none');
    document.documentElement.className = 'xt-on';
    expect(display('#brand xt-trans')).toBe('none');
  });
});
