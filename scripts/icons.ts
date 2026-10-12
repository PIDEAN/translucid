// Rasterize the extension icon (src/ui/brand.ts) into public/icon/{16,32,48,128}.png.
//   pnpm icons
import { Resvg } from '@resvg/resvg-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { APP_ICON_SVG } from '../src/ui/brand';

mkdirSync('public/icon', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = new Resvg(APP_ICON_SVG, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(`public/icon/${size}.png`, png);
  console.log(`public/icon/${size}.png  ${png.length} bytes`);
}
