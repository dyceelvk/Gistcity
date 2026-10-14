import { defineConfig } from 'vite';

// Relative base so the same dist/ serves from Cloudflare Pages, a Capacitor
// Android WebView (file://) and the Crushly app's embedded WebView.
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 1200 },
});
