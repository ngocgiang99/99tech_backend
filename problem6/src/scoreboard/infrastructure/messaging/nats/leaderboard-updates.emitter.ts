import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import type { LeaderboardEntry } from '../../../domain';

export interface LeaderboardUpdateEvent {
  top: LeaderboardEntry[];
}

@Injectable()
export class LeaderboardUpdatesEmitter {
  private readonly EVENT_NAME = 'scoreboard.leaderboard.updated';

  constructor(private readonly emitter: EventEmitter2) {}

  subscribe(callback: (event: LeaderboardUpdateEvent) => void): () => void {
    const listener = (event: LeaderboardUpdateEvent): void => callback(event);
    this.emitter.on(this.EVENT_NAME, listener);
    return () => this.emitter.off(this.EVENT_NAME, listener);
  }

  emit(event: LeaderboardUpdateEvent): void {
    this.emitter.emit(this.EVENT_NAME, event);
  }
}
