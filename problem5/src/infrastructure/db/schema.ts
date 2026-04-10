import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export interface ResourceTable {
  id: Generated<string>;
  name: string;
  type: string;
  status: ColumnType<string, string | undefined, string>;
  tags: ColumnType<string[], string[] | undefined, string[]>;
  owner_id: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, Record<string, unknown>>;
  created_at: ColumnType<Date, never, never>;
  updated_at: ColumnType<Date, never, Date>;
}

export type Resource = Selectable<ResourceTable>;
export type NewResource = Insertable<ResourceTable>;
export type ResourceUpdate = Updateable<ResourceTable>;

export interface Database {
  resources: ResourceTable;
}
