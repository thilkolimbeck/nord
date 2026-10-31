import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Served as a static site under /nordconvert/. The engine version in the strip's legend
// comes from package.json at build time.
export default defineConfig({
  base: '/nordconvert/',
  define: {
    __ENGINE_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
