import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { trace, SpanStatusCode } from '@opentelemetry/api';

import { DATABASE, type Database } from '../../../../database';
import { IdempotencyViolationError } from '../../../domain/errors/idempotency-violation.error';
import { ScoreCredited } from '../../../domain/events/score-credited.event';
import type {
  OutboxRow,
  ScoreEventRecord,
  UserScoreRepository,
} from '../../../domain/ports/user-score.repository';
import { UserScore } from '../../../domain/user-score.aggregate';
import { ActionId } from '../../../domain/value-objects/action-id';
import { UserId } from '../../../domain/value-objects/user-id';

const tracer = trace.getTracer('scoreboard');

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
        row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at),
    });
  }

  async findScoreEventByActionId(
    actionId: ActionId,
  ): Promise<ScoreEventRecord | null> {
    // v1 simplification (design.md Decision 4): totalScoreAfter reads the CURRENT
    // user_scores.total_score, not the total at the time of the original credit.
    // Post-credit drift is accepted for MVP — the replay path only needs an approximate score.
    const row = await this.db
      .selectFrom('score_events as se')
      .innerJoin('user_scores as us', 'us.user_id', 'se.user_id')
      .where('se.action_id', '=', actionId.value)
      .select([
        'se.action_id',
        'se.user_id',
        'se.delta',
        'se.created_at',
        'us.total_score',
      ])
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return {
      actionId: row.action_id,
      userId: row.user_id,
      delta: row.delta,
      totalScoreAfter: Number(row.total_score),
      occurredAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    };
  }

  async credit(
    aggregate: UserScore,
    event: ScoreCredited,
    outboxRow: OutboxRow,
  ): Promise<void> {
    await tracer.startActiveSpan('db.tx', async (span) => {
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
                  eb(
                    'user_scores.total_score',
                    '+',
                    eb.ref('excluded.total_score'),
                  ),
                last_action_id: (eb) => eb.ref('excluded.last_action_id'),
                updated_at: (eb) => eb.ref('excluded.updated_at'),
              }),
            )
            .execute();

          await trx
            .insertInto('outbox_events')
            .values({
              aggregate_id: outboxRow.aggregateId,
              event_type: outboxRow.eventType,
              payload: JSON.stringify(outboxRow.payload),
            })
            .execute();
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        if (isUniqueViolationOnActionId(error)) {
          throw new IdempotencyViolationError(event.actionId);
        }
        throw error;
      } finally {
        span.end();
      }
    });
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
  return (
    typeof e.constraint === 'string' &&
    e.constraint.includes('score_events_action')
  );
}
