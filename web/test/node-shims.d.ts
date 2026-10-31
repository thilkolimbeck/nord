/**
 * Minimal type declarations for the Node built-ins the tests use. The package allows no
 * dependency besides typescript and vite, so @types/node is not installed; engine code under
 * src/ must not use Node APIs at all (engine.test.ts checks its imports).
 */
declare module 'node:test' {
  interface TestContext {
    diagnostic(message: string): void;
  }
  interface TestOptions {
    skip?: boolean | string;
  }
  export function test(name: string, fn: (t: TestContext) => void | Promise<void>): Promise<void>;
  export function test(name: string, options: TestOptions, fn: (t: TestContext) => void | Promise<void>): Promise<void>;
  export function describe(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: ((err: unknown) => boolean) | RegExp | object, message?: string): void;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare module 'node:fs' {
  export function existsSync(path: string | URL): boolean;
  export function readdirSync(path: string | URL): string[];
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function readdirSync(path: string | URL, options: { recursive: true }): string[];
}

declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}

interface ImportMeta {
  readonly url: string;
}
