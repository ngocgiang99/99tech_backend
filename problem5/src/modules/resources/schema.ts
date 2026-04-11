import { z } from 'zod';

// UUID regex validator
const uuidSchema = z.string().uuid('Must be a valid UUID');

// Resource response shape
export const ResourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: z.string(),
  status: z.string(),
  tags: z.array(z.string()),
  ownerId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ResourceDto = z.infer<typeof ResourceSchema>;

// Create input
export const CreateResourceSchema = z
  .object({
    name: z.string().min(1, 'name is required').max(200, 'name must be ≤ 200 chars'),
    type: z.string().min(1, 'type is required').max(64, 'type must be ≤ 64 chars'),
    status: z
      .string()
      .min(1)
      .max(32, 'status must be ≤ 32 chars')
      .optional()
      .default('active'),
    tags: z
      .array(
        z.string().min(1).max(64, 'each tag must be ≤ 64 chars'),
      )
      .max(32, 'tags array must have ≤ 32 items')
      .optional()
      .default([]),
    ownerId: uuidSchema.nullable().optional().default(null),
    metadata: z
      .record(z.unknown())
      .optional()
      .default({})
      .refine(
        (val) => JSON.stringify(val).length <= 16384,
        'metadata must be ≤ 16 KB when serialized',
      ),
  })
  .strict();

export type CreateResourceInput = z.infer<typeof CreateResourceSchema>;

// Update input
export const UpdateResourceSchema = z
  .object({
    name: z.string().min(1).max(200, 'name must be ≤ 200 chars').optional(),
    type: z.string().min(1).max(64, 'type must be ≤ 64 chars').optional(),
    status: z.string().min(1).max(32, 'status must be ≤ 32 chars').optional(),
    tags: z
      .array(z.string().min(1).max(64, 'each tag must be ≤ 64 chars'))
      .max(32, 'tags array must have ≤ 32 items')
      .optional(),
    ownerId: uuidSchema.nullable().optional(),
    metadata: z
      .record(z.unknown())
      .optional()
      .refine(
        (val) => val === undefined || JSON.stringify(val).length <= 16384,
        'metadata must be ≤ 16 KB when serialized',
      ),
  })
  .strict();

export type UpdateResourceInput = z.infer<typeof UpdateResourceSchema>;

// Sort values
export const SORT_VALUES = [
  '-createdAt',
  'createdAt',
  '-updatedAt',
  'updatedAt',
  'name',
  '-name',
] as const;
export type SortValue = (typeof SORT_VALUES)[number];

// List query
export const ListResourcesQuerySchema = z
  .object({
    type: z.string().max(64).optional(),
    status: z
      .union([z.string(), z.array(z.string())])
      .transform((val) => (Array.isArray(val) ? val : [val]))
      .optional(),
    tag: z
      .union([z.string(), z.array(z.string())])
      .transform((val) => (Array.isArray(val) ? val : [val]))
      .optional(),
    ownerId: uuidSchema.optional(),
    createdAfter: z.string().datetime().optional(),
    createdBefore: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    sort: z.enum(SORT_VALUES).default('-createdAt'),
  })
  .strict();

export type ListResourcesQuery = z.infer<typeof ListResourcesQuerySchema>;
