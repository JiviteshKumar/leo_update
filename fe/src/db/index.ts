import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

// Neon's HTTP driver: stateless per-query fetches, no pool to manage —
// ideal for server actions and route handlers.
//
// Without a DATABASE_URL the client is a stub that fails each query with a
// clear message. That keeps `next build` (which evaluates route modules, and
// better-auth's adapter reads the db object at import) working without
// secrets, while a misconfigured server still fails loudly on first use.

const missingDatabase = (() => {
  throw new Error('DATABASE_URL is not set (see fe/.env.example).');
}) as unknown as NeonQueryFunction<false, false>;

const url = process.env.DATABASE_URL;

export const db = drizzle(url ? neon(url) : missingDatabase, { schema });
