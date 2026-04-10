import type { Kysely, SelectQueryBuilder } from 'kysely';
import { sql } from 'kysely';

import type { Database, Resource } from '../../db/schema.js';

import type { CreateResourceInput, UpdateResourceInput, ListResourcesQuery, SortValue } from './schema.js';
import type { CursorPayload } from './cursor.js';
import type { RequestContext } from './request-context.js';

export interface ListResult {
  data: Resource[];
  nextCursor: CursorPayload | null;
}

export interface ResourceRepository {
  create(input: CreateResourceInput, ctx?: RequestContext): Promise<Resource>;
  findById(id: string, ctx?: RequestContext): Promise<Resource | null>;
  list(query: ListResourcesQuery, ctx?: RequestContext): Promise<ListResult>;
  update(id: string, input: UpdateResourceInput, ctx?: RequestContext): Promise<Resource | null>;
  delete(id: string, ctx?: RequestContext): Promise<boolean>;
}

type ResourceSelectQuery = SelectQueryBuilder<Database, 'resources', Resource>;

interface SortConfig {
  column: 'created_at' | 'updated_at' | 'name';
  direction: 'asc' | 'desc';
  secondaryColumn: 'id';
  secondaryDirection: 'asc' | 'desc';
}

function getSortConfig(sort: SortValue): SortConfig {
  switch (sort) {
    case '-createdAt':
      return { column: 'created_at', direction: 'desc', secondaryColumn: 'id', secondaryDirection: 'desc' };
    case 'createdAt':
      return { column: 'created_at', direction: 'asc', secondaryColumn: 'id', secondaryDirection: 'asc' };
    case '-updatedAt':
      return { column: 'updated_at', direction: 'desc', secondaryColumn: 'id', secondaryDirection: 'desc' };
    case 'updatedAt':
      return { column: 'updated_at', direction: 'asc', secondaryColumn: 'id', secondaryDirection: 'asc' };
    case '-name':
      return { column: 'name', direction: 'desc', secondaryColumn: 'id', secondaryDirection: 'desc' };
    case 'name':
      return { column: 'name', direction: 'asc', secondaryColumn: 'id', secondaryDirection: 'asc' };
  }
}

function applyCursorPredicate(
  qb: ResourceSelectQuery,
  cursor: CursorPayload,
  sortConfig: SortConfig,
): ResourceSelectQuery {
  const { column, direction, secondaryColumn, secondaryDirection } = sortConfig;
  const op = direction === 'desc' ? '<' as const : '>' as const;
  const secondaryOp = secondaryDirection === 'desc' ? '<' as const : '>' as const;

  // For non-timestamp sorts, use createdAt as the cursor value
  const cursorColValue: Date | string =
    column === 'created_at' || column === 'updated_at'
      ? new Date(cursor.createdAt)
      : cursor.createdAt;

  return qb.where((eb) =>
    eb.or([
      // First sort key changes
      eb(column, op, cursorColValue as never),
      // First sort key same, secondary (id) changes
      eb.and([
        eb(column, '=', cursorColValue as never),
        eb(secondaryColumn, secondaryOp, cursor.id),
      ]),
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

      if (!row) throw new Error('Insert did not return a row');
      return row;
    },

    async findById(id: string): Promise<Resource | null> {
      const row = await db
        .selectFrom('resources')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row ?? null;
    },

    async list(query: ListResourcesQuery): Promise<ListResult> {
      const { type, status, tag, ownerId, createdAfter, createdBefore, limit, cursor, sort } = query;

      // cursor is already decoded CursorPayload (injected by service) or undefined
      const cursorPayload = cursor as unknown as CursorPayload | undefined;

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

      const sortConfig = getSortConfig(sort);

      // Apply keyset cursor predicate
      if (cursorPayload) {
        qb = applyCursorPredicate(qb, cursorPayload, sortConfig);
      }

      // Apply sort + limit+1
      qb = applySortOrder(qb, sortConfig);
      const rows = await qb.limit(limit + 1).execute();

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = data[data.length - 1];

      let nextCursor: CursorPayload | null = null;
      if (hasMore && lastRow) {
        nextCursor = {
          createdAt: lastRow.created_at.toISOString(),
          id: lastRow.id,
          sort,
        };
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

      const [row] = await db
        .updateTable('resources')
        .set(updates)
        .where('id', '=', id)
        .returningAll()
        .execute();

      return row ?? null;
    },

    async delete(id: string): Promise<boolean> {
      const result = await db
        .deleteFrom('resources')
        .where('id', '=', id)
        .returning('id')
        .execute();

      return result.length > 0;
    },
  };
}
