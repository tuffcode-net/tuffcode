import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@tuffcode/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@tuffcode/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
      '@tuffcode/adapters/acp': fileURLToPath(
        new URL('./packages/adapters/src/acp/index.ts', import.meta.url),
      ),
      '@tuffcode/adapters/anthropic': fileURLToPath(
        new URL('./packages/adapters/src/anthropic/index.ts', import.meta.url),
      ),
      '@tuffcode/adapters/claude': fileURLToPath(
        new URL('./packages/adapters/src/claude/index.ts', import.meta.url),
      ),
      '@tuffcode/adapters/codex': fileURLToPath(
        new URL('./packages/adapters/src/codex/index.ts', import.meta.url),
      ),
      '@tuffcode/adapters/openai': fileURLToPath(
        new URL('./packages/adapters/src/openai/index.ts', import.meta.url),
      ),
      '@tuffcode/adapters': fileURLToPath(
        new URL('./packages/adapters/src/index.ts', import.meta.url),
      ),
      '@tuffcode/prompt': fileURLToPath(new URL('./packages/prompt/src/index.ts', import.meta.url)),
      '@tuffcode/ui/markdown': fileURLToPath(
        new URL('./packages/ui/src/markdown.tsx', import.meta.url),
      ),
      '@tuffcode/ui/diff': fileURLToPath(new URL('./packages/ui/src/diff.tsx', import.meta.url)),
      '@tuffcode/ui/terminal': fileURLToPath(
        new URL('./packages/ui/src/terminal.tsx', import.meta.url),
      ),
      '@tuffcode/ui': fileURLToPath(new URL('./packages/ui/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Windows CI runners are slow; give tests and hooks extra headroom.
    testTimeout: 20000,
    hookTimeout: 20000,
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
    passWithNoTests: true,
  },
});
