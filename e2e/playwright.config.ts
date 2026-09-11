import { defineConfig } from '@playwright/test';

// Each test gets its own Chromium with the e2e build of the extension loaded
// (see harness.ts). Runs are serial: the extension drives real tabs and the
// fixture server's AI mock is shared state.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bun run fixtures/server.ts',
    url: 'http://127.0.0.1:4321/__health',
    reuseExistingServer: true,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
