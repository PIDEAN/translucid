import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '../src/shared/presets';
import { APP_ICON_SVG, PROVIDER_BADGES } from '../src/ui/brand';
import { appIcon, providerLogo } from '../src/ui/provider-logos';

describe('brand assets', () => {
  it('has a badge for every preset vendor, labelled for screen readers', () => {
    for (const p of PROVIDER_PRESETS) {
      const svg = providerLogo(p, 36);
      expect(svg.tagName.toLowerCase()).toBe('svg');
      expect(svg.getAttribute('width')).toBe('36');
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.getAttribute('aria-label')).toBe(PROVIDER_BADGES[p.vendor!].label);
    }
  });
  it('infers the badge from the base URL for providers saved without a vendor', () => {
    expect(providerLogo({ baseURL: 'https://opencode.ai/zen/go/v1' }).getAttribute('aria-label')).toBe('OpenCode Go');
    expect(providerLogo({ baseURL: 'https://example.com/v1' }).getAttribute('aria-label')).toBe('自定义');
  });
  it('bundles a self-contained official vector for every named provider', () => {
    // Keyless machine translation has no standalone official SVG; it keeps a generic badge.
    const generic = new Set(['custom', 'google-translate', 'microsoft-translator']);
    for (const p of PROVIDER_PRESETS.filter((p) => !generic.has(p.vendor!))) {
      const svg = providerLogo(p, 16);
      expect(svg.classList.contains('provider-logo-official')).toBe(true);
      expect(svg.querySelector('path, polygon')).not.toBeNull();
      expect(svg.querySelector('parsererror, script, foreignObject, image, text, style')).toBeNull();
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        for (const attr of [...el.attributes]) {
          expect(attr.name).not.toMatch(/^on/i);
          if (/^(?:xlink:)?href$/.test(attr.name)) expect(attr.value).toMatch(/^#/);
        }
      }
    }
    expect(providerLogo({ vendor: 'custom', baseURL: '' }).classList.contains('provider-logo-official')).toBe(false);
  });
  it('keeps repeated SVG masks, gradients and clips local to each logo', () => {
    const logos = [...PROVIDER_PRESETS, ...PROVIDER_PRESETS].map((p) => providerLogo(p));
    const ids = logos.flatMap((svg) => [...svg.querySelectorAll('[id]')].map((el) => el.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of logos) {
      const localIds = new Set([...svg.querySelectorAll('[id]')].map((el) => el.id));
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        for (const attr of [...el.attributes]) {
          for (const match of attr.value.matchAll(/url\(#([^)]+)\)/g)) expect(localIds.has(match[1]!)).toBe(true);
          if (/^(?:xlink:)?href$/.test(attr.name)) expect(localIds.has(attr.value.slice(1))).toBe(true);
        }
      }
    }
  });
  it('renders the app icon from the same source as the PNGs', () => {
    const svg = appIcon(30);
    expect(svg.getAttribute('width')).toBe('30');
    // Two layers (cobalt interface, amber language, their see-through overlap) and three lines.
    expect(svg.querySelectorAll('rect')).toHaveLength(5);
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(APP_ICON_SVG).toContain('#2F56D6');
    expect(APP_ICON_SVG).toContain('#F2B33D');
  });
});
