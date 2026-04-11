import { z } from 'zod';

import { MAX_DELTA } from '../../../domain/value-objects/score-delta';

export const IncrementScoreSchema = z.object({
  actionId: z.string().uuid(),
  delta: z.number().int().positive().max(MAX_DELTA),
});

export type IncrementScoreDto = z.infer<typeof IncrementScoreSchema>;
