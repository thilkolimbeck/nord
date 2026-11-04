/**
 * nord's Stage 4 program code: the CBIN container, the Stage 4 layout, the program reader and
 * writer, the neutral donor template and the verify step. No Node or DOM APIs: it runs in the
 * browser as well as in Node.
 *
 * Copyright (C) 2026 Thilko Limbeck. AGPL-3.0-or-later. The generated data modules derive
 * from OpenNord (AGPL-3.0-or-later) and ns4decode (MIT); their headers carry the notices.
 */
export { ConversionError, NordFormatError } from './errors.ts';
export { Ns4Program } from './program.ts';
export { loadTemplate, neutralise, TEMPLATE_BYTES } from './template.ts';
export { verify } from './verify.ts';
