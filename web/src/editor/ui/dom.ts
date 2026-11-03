/**
 * A small DOM helper for the editor UI: build elements with attributes and children, listen with
 * an unsubscribe function, and make unique ids. No inline styles: `style` is refused here, so the
 * page stays within a strict CSP (dynamic values go through CSS custom properties via CSSOM).
 */

export type Child = Node | string | null | undefined | false;
export type Attrs = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** An element with attributes ('class' sets the class list; true sets an empty attribute; false and null skip). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]):
  HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'style') throw new Error('inline styles are not allowed (CSP): use a class or a custom property');
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') node.className = String(value);
      else node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** addEventListener that returns its own removal. */
export function listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K,
  fn: (ev: HTMLElementEventMap[K]) => void): () => void {
  target.addEventListener(type, fn);
  return () => target.removeEventListener(type, fn);
}

let counter = 0;

/** A page-unique id: 'ctl-fltFreq-12'. */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix.replace(/[^A-Za-z0-9_-]/g, '-')}-${counter}`;
}
