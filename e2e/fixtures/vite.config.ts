import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Local pages for the extension end-to-end tests (served on localhost:5300).
export default defineConfig({
  root: __dirname,
  server: { port: 5300, strictPort: true },
  build: {
    rollupOptions: {
      input: {
        static: resolve(__dirname, 'static.html'),
        react: resolve(__dirname, 'react.html'),
        ssr: resolve(__dirname, 'ssr.html'),
        shadow: resolve(__dirname, 'shadow.html'),
        claude: resolve(__dirname, 'claude-like.html'),
        devin: resolve(__dirname, 'devin-like.html'),
      },
    },
  },
});
