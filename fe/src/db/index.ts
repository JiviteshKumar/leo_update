import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

// Neon's HTTP driver: stateless per-query fetches, no pool to manage —
// ideal for server actions and route handlers.
export const db = drizzle(neon(process.env.DATABASE_URL!), { schema });
