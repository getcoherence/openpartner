import { z } from './zod.js';
import { clickDestinationProblem, clickDestinationWarning } from '@openpartner/db';

/**
 * A tracking-link destination: Program.destinationUrl or a Link's deep-link
 * override. Optionally carries the {click_id} macro, which the click router
 * replaces with the click id instead of appending `cref`
 * (see packages/db/src/click-destination.ts).
 */
export const destinationUrlSchema = z
  .string()
  .url()
  .superRefine((url, ctx) => {
    const problem = clickDestinationProblem(url);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

export interface SaveWarning {
  field: 'destinationUrl';
  message: string;
}

/**
 * What a saved destination will probably get wrong, without refusing it:
 * a Stripe Payment Link without `client_reference_id={click_id}`. Spread into
 * the save response; absent when there's nothing to say, so existing
 * responses keep their shape.
 */
export function destinationWarnings(url: string | null | undefined): { warnings?: SaveWarning[] } {
  const message = url ? clickDestinationWarning(url) : null;
  return message ? { warnings: [{ field: 'destinationUrl', message }] } : {};
}
