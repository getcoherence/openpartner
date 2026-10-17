import { z } from 'zod';
import { clickDestinationProblem } from '@openpartner/db';

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
