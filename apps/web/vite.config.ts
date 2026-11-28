import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Standalone build of the mobile shell.
 *
 * Electron packages the renderer through electron-vite from `apps/desktop`, which writes
 * the same `apps/web/dist` tree with relative asset paths. This config builds the shell
 * for the mobile server instead, so `pnpm --filter @tuffcode/web build` produces a tree
 * that is served from the server root with absolute `/assets/` URLs.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
