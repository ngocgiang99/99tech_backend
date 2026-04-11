import type { Kysely, SelectQueryBuilder } from 'kysely';
import { sql } from 'kysely';

import { mapDbError } from '../../../infrastructure/db/error-mapper.js';
import { InternalError } from '../../../shared/errors.js';
import type { Database, Resource } from '../../../infrastructure/db/schema.js';
import type { CreateResourceInput, UpdateResourceInput, ListResourcesQuery } from '../schema.js';
import type { RequestContext } from '../application/request-context.js';

import type { CursorPayload, SortConfig } from './cursor.js';
import { sortConfigFor, decodeCursor, encodeCursor } from './cursor.js';

export interface ListResult {
  data: Resource[];
  /**
   * Already-encoded next-page cursor (opaque base64url string), or `null`
   * if this page is the last one. The repository is responsible for both
   * decoding incoming cursors and encoding outgoing ones so the layers
   * above it (cached decorator, service, controller) never touch the
   * decoded `CursorPayload` — it is a local concept inside the SQL layer.
   */
  nextCursor: string | null;
}

/**
 * Single repository interface for the resources module. `list` takes the
 * request-shaped `ListResourcesQuery` (with an opaque base64url cursor
 * string), which is also what the cached decorator uses for cache-key
 * derivation. The raw implementation decodes `query.cursor` internally
 * when building the SQL keyset predicate; the decoded `CursorPayload` is
 * a purely local variable inside the SQL function and never escapes.
 *
 * Design rationale: `openspec/changes/type-clean-resources-list-query/design.md`
 * §D1 — decoded cursor is local to the raw repository.
 */
export interface ResourceRepository {
  create(input: CreateResourceInput, ctx?: RequestContext): Promise<Resource>;
  findById(id: string, ctx?: RequestContext): Promise<Resource | null>;
  list(query: ListResourcesQuery, ctx?: RequestContext): Promise<ListResult>;
  update(id: string, input: UpdateResourceInput, ctx?: RequestContext): Promise<Resource | null>;
  delete(id: string, ctx?: RequestContext): Promise<boolean>;
}

type ResourceSelectQuery = SelectQueryBuilder<Database, 'resources', Resource>;

/**
 * Generic keyset-pagination predicate. `column` carries the specific column
 * name the `value` belongs to, so the compiler can check `eb(column, op, value)`
 * without a cast. The caller discriminates on `cursor.kind` to pick the
 * matching column and value type.
 *
 * `V` is constrained to `Date | string` — the union of value types across
 * the sortable columns (`created_at`, `updated_at` are `Date`; `name` is
 * `string`). The caller always passes a concrete `Date` or `string` at
 * each call site, so `V` stays monomorphic per call and Kysely typechecks
 * `eb(column, op, value)` cleanly.
 */
function applyCursorPredicate<V extends Date | string>(
  qb: ResourceSelectQuery,
  column: 'created_at' | 'updated_at' | 'name',
  op: '<' | '>',
  value: V,
  secondaryOp: '<' | '>',
  secondaryId: string,
): ResourceSelectQuery {
  return qb.where((eb) =>
    eb.or([
      eb(column, op, value),
      eb.and([eb(column, '=', value), eb('id', secondaryOp, secondaryId)]),
    ]),
  );
}

function applySortOrder(qb: ResourceSelectQuery, sortConfig: SortConfig): ResourceSelectQuery {
  const { column, direction, secondaryColumn, secondaryDirection } = sortConfig;
  return qb.orderBy(column, direction).orderBy(secondaryColumn, secondaryDirection);
}

export function createResourceRepository(db: Kysely<Database>): ResourceRepository {
  return {
    async create(input: CreateResourceInput): Promise<Resource> {
      try {
        const [row] = await db
          .insertInto('resources')
          .values({
            name: input.name,
            type: input.type,
            status: input.status ?? 'active',
            tags: input.tags ?? [],
            owner_id: input.ownerId ?? null,
            metadata: input.metadata ?? {},
          })
          .returningAll()
          .execute();

        if (!row) throw new InternalError('Insert did not return a row');
        return row;
      } catch (err) {
        throw mapDbError(err);
      }
    },

    async findById(id: string): Promise<Resource | null> {
      try {
        const row = await db
          .selectFrom('resources')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        return row ?? null;
      } catch (err) {
        throw mapDbError(err);
      }
    },

    async list(query: ListResourcesQuery): Promise<ListResult> {
      const { type, status, tag, ownerId, createdAfter, createdBefore, limit, cursor, sort } = query;

      // Decode the cursor on entry — the decoded payload is a purely local
      // variable inside this function and never escapes. Above this layer,
      // every caller (service, cached decorator, controller) speaks only
      // the opaque string form.
      const decodedCursor: CursorPayload | undefined = cursor
        ? decodeCursor(cursor, sort)
        : undefined;

      let qb: ResourceSelectQuery = db.selectFrom('resources').selectAll();

      // Apply filters
      if (type !== undefined) {
        qb = qb.where('type', '=', type);
      }
      if (status !== undefined && status.length > 0) {
        qb = qb.where('status', 'in', status);
      }
      if (tag !== undefined && tag.length > 0) {
        // AND semantics: tags @> ARRAY['x','y']
        qb = qb.where(({ eb }) => eb(sql`tags`, '@>', sql`${sql.val(tag)}::text[]`));
      }
      if (ownerId !== undefined) {
        qb = qb.where('owner_id', '=', ownerId);
      }
      if (createdAfter !== undefined) {
        qb = qb.where('created_at', '>=', new Date(createdAfter));
      }
      if (createdBefore !== undefined) {
        qb = qb.where('created_at', '<', new Date(createdBefore));
      }

      const sortConfig = sortConfigFor(sort);

      // Apply the keyset predicate. Dispatch on decodedCursor.kind so the
      // compiler can pair each variant with a statically-typed value — the
      // old code used `as never` here.
      if (decodedCursor) {
        const op = sortConfig.direction === 'desc' ? ('<' as const) : ('>' as const);
        const secondaryOp = sortConfig.secondaryDirection === 'desc' ? ('<' as const) : ('>' as const);
        switch (decodedCursor.kind) {
          case 'timestamp':
            qb = applyCursorPredicate(
              qb,
              sortConfig.column,
              op,
              decodedCursor.value,
              secondaryOp,
              decodedCursor.id,
            );
            break;
          case 'name':
            qb = applyCursorPredicate(
              qb,
              'name',
              op,
              decodedCursor.value,
              secondaryOp,
              decodedCursor.id,
            );
            break;
          default: {
            const _exhaustive: never = decodedCursor;
            throw new InternalError(`Unhandled cursor kind: ${String(_exhaustive)}`);
          }
        }
      }

      // Apply sort + limit+1
      qb = applySortOrder(qb, sortConfig);

      let rows: Resource[];
      try {
        rows = await qb.limit(limit + 1).execute();
      } catch (err) {
        throw mapDbError(err);
      }

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = data[data.length - 1];

      // Build the next-page cursor as the variant matching the sort, then
      // encode it immediately so callers above this layer never see the
      // decoded form. For name sort, `value` is the last row's `name` —
      // this is the fix for the latent sort=name+cursor bug where the
      // pre-refactor code put a timestamp there regardless.
      let nextCursor: string | null = null;
      if (hasMore && lastRow) {
        let payload: CursorPayload;
        switch (sort) {
          case '-createdAt':
          case 'createdAt':
            payload = { kind: 'timestamp', value: lastRow.created_at, id: lastRow.id, sort };
            break;
          case '-updatedAt':
          case 'updatedAt':
            payload = { kind: 'timestamp', value: lastRow.updated_at, id: lastRow.id, sort };
            break;
          case 'name':
          case '-name':
            payload = { kind: 'name', value: lastRow.name, id: lastRow.id, sort };
            break;
          default: {
            const _exhaustive: never = sort;
            throw new InternalError(`Unhandled sort value: ${String(_exhaustive)}`);
          }
        }
        nextCursor = encodeCursor(payload);
      }

      return { data, nextCursor };
    },

    async update(id: string, input: UpdateResourceInput): Promise<Resource | null> {
      // Build update payload — always bump updated_at
      type UpdatePayload = {
        updated_at: Date;
        name?: string;
        type?: string;
        status?: string;
        tags?: string[];
        owner_id?: string | null;
        metadata?: Record<string, unknown>;
      };

      const updates: UpdatePayload = { updated_at: new Date() };

      if (input.name !== undefined) updates.name = input.name;
      if (input.type !== undefined) updates.type = input.type;
      if (input.status !== undefined) updates.status = input.status;
      if (input.tags !== undefined) updates.tags = input.tags;
      if ('ownerId' in input) updates.owner_id = input.ownerId ?? null;
      if (input.metadata !== undefined) updates.metadata = input.metadata;

      try {
        const [row] = await db
          .updateTable('resources')
          .set(updates)
          .where('id', '=', id)
          .returningAll()
          .execute();

        return row ?? null;
      } catch (err) {
        throw mapDbError(err);
      }
    },

    async delete(id: string): Promise<boolean> {
      try {
        const result = await db
          .deleteFrom('resources')
          .where('id', '=', id)
          .returning('id')
          .execute();

        return result.length > 0;
      } catch (err) {
        throw mapDbError(err);
      }
    },
  };
}
