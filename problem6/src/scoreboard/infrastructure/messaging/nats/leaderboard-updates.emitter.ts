import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import type {
  LeaderboardUpdateCallback,
  LeaderboardUpdateEvent,
  LeaderboardUpdatesPort,
  Unsubscribe,
} from '../../../domain/ports/leaderboard-updates.port';

@Injectable()
export class LeaderboardUpdatesInProcessAdapter implements LeaderboardUpdatesPort {
  private readonly EVENT_NAME = 'scoreboard.leaderboard.updated';

  constructor(private readonly emitter: EventEmitter2) {}

  subscribe(callback: LeaderboardUpdateCallback): Unsubscribe {
    const listener = (event: LeaderboardUpdateEvent): void => callback(event);
    this.emitter.on(this.EVENT_NAME, listener);
    return () => this.emitter.off(this.EVENT_NAME, listener);
  }

  emit(event: LeaderboardUpdateEvent): void {
    this.emitter.emit(this.EVENT_NAME, event);
  }
}
