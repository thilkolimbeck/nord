/**
 * Releases every note when the page loses the keyboard or goes out of sight (AC 8): window blur,
 * visibilitychange to hidden, pagehide. A keyup that happens while the page has no focus never
 * arrives, so without this a note would hang.
 */

interface WindowLike {
  addEventListener(type: 'blur' | 'pagehide', fn: () => void): void;
  removeEventListener(type: 'blur' | 'pagehide', fn: () => void): void;
}

interface DocumentLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

/** Calls `release` on blur, on pagehide and when the document becomes hidden. Returns the unbind. */
export function bindReleaseOnHide(win: WindowLike, doc: DocumentLike, release: () => void): () => void {
  const onBlur = (): void => release();
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') release();
  };
  win.addEventListener('blur', onBlur);
  win.addEventListener('pagehide', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('pagehide', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
