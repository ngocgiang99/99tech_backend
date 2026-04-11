import { ScoreCredited } from '../events/score-credited.event';
import { UserScore } from '../user-score.aggregate';
import { UserId } from '../value-objects/user-id';

export interface UserScoreRepository {
  findByUserId(userId: UserId): Promise<UserScore | null>;
  credit(aggregate: UserScore, event: ScoreCredited): Promise<void>;
}
