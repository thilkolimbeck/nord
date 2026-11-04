/** Vite's import.meta.env flags the editor reads (replaced at build time). */
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Vite's worker URL import (plan section 15.7): the bundled worker or worklet module's same-origin URL. */
declare module '*?worker&url' {
  const url: string;
  export default url;
}
