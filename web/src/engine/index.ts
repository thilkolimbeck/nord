/**
 * nord-convert web engine: Nord Stage 3 (.ns3f) to Nord Stage 4 (.ns4p) program conversion,
 * a faithful TypeScript port of the Python package nordconv. No Node or DOM APIs: it runs in
 * the browser as well as in Node.
 *
 * Copyright (C) 2026 Thilko Limbeck. AGPL-3.0-or-later. The generated data modules derive
 * from OpenNord (AGPL-3.0-or-later) and ns4decode (MIT); their headers carry the notices.
 */
export { convert, convertBytes, ns4Category, verify, OUTPUT_SUFFIX } from './convert.ts';
export type { Converted, ConvertResult } from './convert.ts';
export { ConversionError, NordFormatError } from './errors.ts';
export { Ns3Program, Ns4Program } from './program.ts';
export { loadTemplate, neutralise, TEMPLATE_BYTES } from './template.ts';
