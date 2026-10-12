import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Local pages for the extension end-to-end tests (served on localhost:5300).
export default defineConfig({
  root: __dirname,
  // IPv4 explicitly: localhost reaches it too, and 127.0.0.1 serves as a second origin (frames.html).
  server: { host: '127.0.0.1', port: 5300, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        static: resolve(__dirname, 'static.html'),
        react: resolve(__dirname, 'react.html'),
        ssr: resolve(__dirname, 'ssr.html'),
        shadow: resolve(__dirname, 'shadow.html'),
        claude: resolve(__dirname, 'claude-like.html'),
        devin: resolve(__dirname, 'devin-like.html'),
        frames: resolve(__dirname, 'frames.html'),
        frameArticle: resolve(__dirname, 'frame-article.html'),
        frameAd: resolve(__dirname, 'frame-ad.html'),
        frameArticle2: resolve(__dirname, 'frame-article-2.html'),
        frameLogin: resolve(__dirname, 'frame-login.html'),
        chinese: resolve(__dirname, 'chinese.html'),
      },
    },
  },
});
