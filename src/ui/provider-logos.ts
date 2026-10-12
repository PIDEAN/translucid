import { vendorOf } from '../shared/pricing';
import type { ProviderConfig, ProviderVendor } from '../shared/types';
import { APP_ICON_SVG, PROVIDER_BADGES } from './brand';

// Official logos dropped into src/ui/logos/<vendor>.svg replace the built-in badges at build time.
const overrides = import.meta.glob('./logos/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function overrideFor(vendor: ProviderVendor): string | undefined {
  return overrides[`./logos/${vendor}.svg`];
}

let svgInstance = 0;

/** Parse trusted, bundled SVG markup into an element (no innerHTML on live DOM). */
function parseSvg(markup: string, size: number, label: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  // Strip anything executable an external file could carry.
  svg.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  }
  // Inline SVG IDs share the document namespace. Keep repeated logos' masks,
  // gradients and clip paths independent, including Zen and Go's shared mark.
  const prefix = `provider-svg-${++svgInstance}-`;
  const ids = new Map<string, string>();
  for (const el of svg.querySelectorAll('[id]')) {
    const id = el.getAttribute('id')!;
    ids.set(id, `${prefix}${id}`);
    el.setAttribute('id', `${prefix}${id}`);
  }
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const value = attr.value.replace(/url\(#([^)]+)\)/g, (ref, id: string) =>
        ids.has(id) ? `url(#${ids.get(id)})` : ref,
      );
      attr.value = /^(?:xlink:)?href$/.test(attr.name) && value.startsWith('#') && ids.has(value.slice(1))
        ? `#${ids.get(value.slice(1))}`
        : value;
    }
  }
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  return svg;
}

export function providerLogo(p: Pick<ProviderConfig, 'vendor' | 'baseURL'>, size = 36): SVGSVGElement {
  const vendor = vendorOf(p);
  const badge = PROVIDER_BADGES[vendor];
  const official = overrideFor(vendor);
  const svg = parseSvg(official ?? badge.svg, size, badge.label);
  if (official) {
    svg.classList.add('provider-logo-official');
    if (vendor === 'openrouter' || vendor === 'nvidia') svg.classList.add('provider-logo-transparent');
    // Preserve official colours on a neutral tile, even in dark mode.
    svg.style.padding = `${size / 9}px`;
  }
  return svg;
}

export function appIcon(size = 32): SVGSVGElement {
  return parseSvg(APP_ICON_SVG, size, 'Translucid');
}
