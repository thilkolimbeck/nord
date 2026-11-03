/** Vite's import.meta.env flags the editor reads (replaced at build time). */
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
