import { z } from 'zod';

export const IssueActionTokenSchema = z.object({
  actionType: z.enum(['level-complete', 'boss-defeat', 'achievement-unlock']),
});

export type IssueActionTokenDto = z.infer<typeof IssueActionTokenSchema>;
