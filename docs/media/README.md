# README media

The pictures in `docs/images` come from test data only: the e2e fixture pages and a made-up notes app, **Notara** (`notara.html`). No real site content is involved.

- `screenshots.media.ts` takes the workbench, popup, config and picker screenshots.
- `hero.media.ts` loads the built extension, imports hand-written language packs for Notara (`notara-translations.json`) and lets the extension apply them one language at a time. It saves one frame per language in `.out/frames` (ignored by git).
- `compose_hero.py` turns those frames into `docs/images/hero.gif`. Between languages, an amber band sweeps across the app; amber stands for the user's language.

To regenerate everything, run:

```bash
pnpm readme:media
```

This needs Pillow (`pip install pillow`) and `ffmpeg` on the PATH.
