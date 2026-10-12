# README media

Everything in `docs/images` comes from test data: the real, built extension working on two made-up pages, the notes app **Notara** (`notara.html`) and its blog (`journal.html`). No real site content and no real model are involved.

## How the animations are made

1. **Capture** (`features.media.ts`, Playwright): a fresh browser profile per scene loads `dist/chrome-mv3`. The pages are served by `page.route()` at made-up addresses (`app.notara.example`, `journal.notara.example`), so requests never leave the browser and the popup shows a believable site name.
   - Translations come from `mock-translate.mjs`, an OpenAI-compatible endpoint that answers with hand-written Chinese (`zh-dictionary.json`). It uses the question each option belongs to, so "Medium" becomes 中 under Text size and 适中 under Page width.
   - The browser maps the DeepSeek preset's address (`api.deepseek.com`) to that local endpoint (`--host-resolver-rules`, plus a throwaway self-signed certificate), so the request preview shows a real-looking provider URL.
   - The languages scene imports hand-written packs for six languages (`notara-translations.json`).
   - The scan scene starts the scan with consent already given, so the one-time consent step in the popup is not shown (the README caption says so).
   - Each scene writes its frames and a JSON timeline (`.out/<scene>.json`: per shot the screenshot, popup, pointer target, click, zoom box, outlines, caption, keys, transition) to `docs/media/.out` (ignored by git). Identical consecutive frames are merged.
2. **Compose** (`remotion/`, [Remotion](https://www.remotion.dev)): one composition per scene draws the frames in a browser window and adds the pointer, the popup under the toolbar icon, camera moves, outlines, keycaps and captions. Amber marks the user's language: page changes caused by a translation reveal the new frame behind an amber edge.
3. **Encode** (`remotion/render.mjs`): each composition is rendered to PNGs and turned into `docs/images/<scene>.gif` by ffmpeg with one palette per animation. Holds collapse into long frames; camera moves step every 80 ms and fades in thirds, because a GIF repaints every changed pixel.

`screenshots.media.ts` takes the one still screenshot (`config.png`).

## Regenerate

```bash
pnpm readme:media
```

This builds the extension, runs the captures, installs the Remotion project (`docs/media/remotion`, its own lockfile) and renders all GIFs. It needs `ffmpeg` and `openssl` on the PATH and Playwright's Chromium (`pnpm exec playwright install chromium`). Remotion renders with Playwright's headless shell when it finds one, otherwise it downloads its own.

To work on one animation, preview it in Remotion Studio and render only that scene:

```bash
pnpm --dir docs/media/remotion studio
pnpm --dir docs/media/remotion render scan
```

Remotion is used only to make these files; it is not part of the extension. It has its own license: free for individuals and small companies, see [remotion.dev/license](https://www.remotion.dev/license).
