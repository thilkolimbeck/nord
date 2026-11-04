/**
 * The inline confirmations of the files box, without the DOM (plan section 15.8; the export
 * confirmation's pattern): a delete key asks first, the files box shows one line
 * `delete "<name>"? confirm / cancel`, and only `confirm` deletes. One question at a time: asking
 * about another item replaces the open one. The working copy is never offered for deletion.
 */

/** One pending question: what would be deleted, and the line that asks. */
export interface Pending<T> {
  readonly item: T;
  readonly text: string;
}

export class InlineConfirm<T> {
  readonly #describe: (item: T) => string;
  #pending: Pending<T> | null = null;

  /** `describe`: the name the question shows ('pad.wav', 'Warm Pad'). */
  constructor(describe: (item: T) => string) {
    this.#describe = describe;
  }

  get pending(): Pending<T> | null {
    return this.#pending;
  }

  /** A delete key was pressed: ask about this item (an open question about another one is dropped). */
  ask(item: T): Pending<T> {
    this.#pending = { item, text: deleteQuestion(this.#describe(item)) };
    return this.#pending;
  }

  /** `cancel`: nothing is deleted. */
  cancel(): void {
    this.#pending = null;
  }

  /** `confirm`: the item to delete now, or null when nothing was asked. */
  confirm(): T | null {
    const item = this.#pending?.item ?? null;
    this.#pending = null;
    return item;
  }
}

/** 'delete "Warm Pad"?' */
export function deleteQuestion(name: string): string {
  return `delete "${name}"?`;
}
