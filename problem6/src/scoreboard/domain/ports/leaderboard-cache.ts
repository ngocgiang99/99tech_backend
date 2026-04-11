import { Score } from '../value-objects/score';
import { UserId } from '../value-objects/user-id';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  score: number;
  updatedAt: Date;
}

export interface LeaderboardCache {
  upsert(userId: UserId, score: Score, updatedAt: Date): Promise<void>;
  getTop(n: number): Promise<LeaderboardEntry[]>;
  getRank(userId: UserId): Promise<number | null>;
}

export const LEADERBOARD_CACHE_TOKEN = 'LeaderboardCache';
