import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { DATABASE, type Database } from '../../../../database';
import { IdempotencyViolationError } from '../../../domain/errors/idempotency-violation.error';
import { ScoreCredited } from '../../../domain/events/score-credited.event';
import type { UserScoreRepository } from '../../../domain/ports/user-score.repository';
import { UserScore } from '../../../domain/user-score.aggregate';
import { UserId } from '../../../domain/value-objects/user-id';

interface PgDatabaseError {
  code?: string;
  constraint?: string;
}

@Injectable()
export class KyselyUserScoreRepository implements UserScoreRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findByUserId(userId: UserId): Promise<UserScore | null> {
    const row = await this.db
      .selectFrom('user_scores')
      .where('user_id', '=', userId.value)
      .selectAll()
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return UserScore.rehydrate({
      userId,
      totalScore: Number(row.total_score),
      lastActionId: row.last_action_id,
      updatedAt:
        row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    });
  }

  async credit(aggregate: UserScore, event: ScoreCredited): Promise<void> {
    try {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .selectFrom('user_scores')
          .where('user_id', '=', event.userId)
          .select('user_id')
          .forUpdate()
          .executeTakeFirst();

        await trx
          .insertInto('score_events')
          .values({
            id: randomUUID(),
            user_id: event.userId,
            action_id: event.actionId,
            delta: event.delta,
            created_at: event.occurredAt,
          })
          .execute();

        await trx
          .insertInto('user_scores')
          .values({
            user_id: event.userId,
            total_score: event.delta,
            last_action_id: event.actionId,
            updated_at: aggregate.updatedAt,
          })
          .onConflict((oc) =>
            oc.column('user_id').doUpdateSet({
              total_score: (eb) =>
                eb('user_scores.total_score', '+', eb.ref('excluded.total_score')),
              last_action_id: (eb) => eb.ref('excluded.last_action_id'),
              updated_at: (eb) => eb.ref('excluded.updated_at'),
            }),
          )
          .execute();
      });
    } catch (error) {
      if (isUniqueViolationOnActionId(error)) {
        throw new IdempotencyViolationError(event.actionId);
      }
      throw error;
    }
  }
}

function isUniqueViolationOnActionId(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const e = error as PgDatabaseError;
  if (e.code !== '23505') {
    return false;
  }
  return typeof e.constraint === 'string' && e.constraint.includes('score_events_action');
}
