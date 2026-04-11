import { Injectable } from '@nestjs/common';

@Injectable()
export class ReadinessService {
  private _leaderboardReady = false;
  public jetstreamReady = false;

  get leaderboardReady(): boolean {
    return this._leaderboardReady;
  }

  set leaderboardReady(value: boolean) {
    this._leaderboardReady = value;
  }

  isReady(): boolean {
    return this._leaderboardReady && this.jetstreamReady;
  }
}
