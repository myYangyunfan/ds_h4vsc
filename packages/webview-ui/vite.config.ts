import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the chat panel bundle consumed by the extension webview
// (dist/assets/index.{js,css}) plus standalone dev mode via `pnpm dev`.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    // The extension webview loads assets from <extension>/dist/webview.
    outDir: '../extension/dist/webview',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/index.js',
        assetFileNames: 'assets/index.[ext]',
        manualChunks: undefined,
      },
    },
  },
});
