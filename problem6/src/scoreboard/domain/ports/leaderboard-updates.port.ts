import { LeaderboardEntry } from './leaderboard-cache';

export interface LeaderboardUpdateEvent {
  top: LeaderboardEntry[];
  updatedAt?: Date;
}

export type LeaderboardUpdateCallback = (event: LeaderboardUpdateEvent) => void;

export type Unsubscribe = () => void;

export interface LeaderboardUpdatesPort {
  subscribe(callback: LeaderboardUpdateCallback): Unsubscribe;
  emit(event: LeaderboardUpdateEvent): void;
}

export const LEADERBOARD_UPDATES_PORT = Symbol('LEADERBOARD_UPDATES_PORT');
