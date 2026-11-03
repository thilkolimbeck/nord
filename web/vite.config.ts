import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

const BASE = '/nordconvert/';
const EDITOR = `${BASE}editor`;

/**
 * Locally, /nordconvert/editor (no trailing slash) would fall through to the converter page:
 * Vite's HTML fallback maps only /editor/ to editor/index.html. Rewrite it, in dev and preview,
 * so the link the converter will carry works as it does in production.
 */
function editorRewrite(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const url = req.url ?? '';
    const q = url.search(/[?#]/);
    const path = q === -1 ? url : url.slice(0, q);
    if (path === EDITOR || path === `${EDITOR}/`) req.url = `${EDITOR}/index.html${q === -1 ? '' : url.slice(q)}`;
    next();
  };
  return {
    name: 'nordconvert-editor-rewrite',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

// Served as a static site under /nordconvert/: the converter (index.html) and the Stage 4 editor
// (editor/index.html, built to dist/editor/index.html). The engine version in the strip's legend
// comes from package.json at build time.
export default defineConfig({
  base: BASE,
  define: {
    __ENGINE_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [editorRewrite()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        editor: fileURLToPath(new URL('./editor/index.html', import.meta.url)),
      },
    },
  },
});
