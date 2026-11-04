/**
 * The same-origin URL of the worklet module, built by Vite from processor.ts (`?worker&url`: a
 * separate bundle with its imports inlined, no blob: or data: URL, so `script-src 'self'` allows
 * it). Only main imports this file: the Node tests cannot resolve the `?worker&url` query.
 */
import url from './processor.ts?worker&url';

export const WORKLET_MODULE_URL: string = url;
