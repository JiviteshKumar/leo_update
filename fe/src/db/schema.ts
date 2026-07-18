import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { Step } from '@/lib/types';
import { user } from './auth-schema';

export * from './auth-schema';

// Cloud copy of the extension's Workflow. `id` is the UUID the extension
// minted at record time, so syncing is a natural upsert.
export const workflows = pgTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // One-line AI-derived summary of the workflow; may be absent on older rows.
    objective: text('objective'),
    startUrl: text('start_url').notNull(),
    steps: jsonb('steps').$type<Step[]>().notNull(),
    healCount: integer('heal_count').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('workflows_user_id_idx').on(t.userId)],
);
