/**
 * The API's zod. Import `z` from here, not from 'zod' (eslint enforces it).
 *
 * zod 4 gives a schema its methods when the schema is created, so zod has
 * to be set up before the first schema exists, whichever entrypoint loads
 * first: the server, a script, a test file. Importing z from this module
 * guarantees that. It sets up:
 *   - zod 3's validation messages (zod-compat.ts), and
 *   - `.openapi()` from @asteasolutions/zod-to-openapi, which openapi/
 *     calls on the request schemas the route modules export.
 */

import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import './zod-compat.js';

extendZodWithOpenApi(z);

export { z };
export { offsetDateTime, utcDateTime } from './zod-compat.js';
