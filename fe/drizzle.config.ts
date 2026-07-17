import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Next.js keeps secrets in .env.local; drizzle-kit doesn't load it on its own.
config({ path: '.env.local' });

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/auth-schema.ts'],
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
