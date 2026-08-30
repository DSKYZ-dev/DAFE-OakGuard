import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: { port: 5174, host: true, open: false },
  base: './',
  // es2017: maximum WebView parse compatibility. Async/await is the newest
  // syntax kept; everything newer is transpiled away.
  build: { outDir: 'dist', target: 'es2017' },
});