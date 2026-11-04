import { defineConfig, type Connect, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

const BASE = '/nord/';
const ROOT_URL = BASE.slice(0, -1);

/**
 * Production serves the editor at /nord, without a trailing slash (web/vercel.json rewrites it).
 * Vite's dev and preview servers answer only below /nord/, so rewrite /nord to /nord/ there too.
 */
function rootRewrite(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    const url = req.url ?? '';
    const q = url.search(/[?#]/);
    if ((q === -1 ? url : url.slice(0, q)) === ROOT_URL) req.url = `${BASE}${q === -1 ? '' : url.slice(q)}`;
    next();
  };
  return {
    name: 'nord-root-rewrite',
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}

// Served as a static site under /nord/: the Stage 4 editor (index.html). The app version in the
// presets and the report comes from package.json at build time.
export default defineConfig({
  base: BASE,
  define: {
    __ENGINE_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [rootRewrite()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
