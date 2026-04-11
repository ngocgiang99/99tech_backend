import { z } from 'zod';

export const LeaderboardTopQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type LeaderboardTopQuery = z.infer<typeof LeaderboardTopQuerySchema>;
