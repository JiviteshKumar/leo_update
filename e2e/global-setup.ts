import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the e2e flavour of the extension once per test run: AI and account
// calls point at the fixture server (which mocks them), and the background
// exposes a `leoTest` hook for the tests to drive it.

const here = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = join(here, '..', 'extension', '.output-e2e', 'chrome-mv3');

export default function globalSetup() {
  if (process.env.LEO_E2E_SKIP_BUILD === '1' && existsSync(EXTENSION_DIR)) return;
  const res = spawnSync('bun', ['run', 'build'], {
    cwd: join(here, '..', 'extension'),
    env: { ...process.env, WXT_LEO_E2E: 'true', WXT_LEO_FE_URL: 'http://127.0.0.1:4321' },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) throw new Error('e2e extension build failed');
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`e2e build did not produce ${EXTENSION_DIR}`);
  }
}
