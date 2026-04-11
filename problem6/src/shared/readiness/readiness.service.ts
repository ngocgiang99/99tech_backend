import { Injectable } from '@nestjs/common';

@Injectable()
export class ReadinessService {
  private _leaderboardReady = false;

  get leaderboardReady(): boolean {
    return this._leaderboardReady;
  }

  set leaderboardReady(value: boolean) {
    this._leaderboardReady = value;
  }
}
