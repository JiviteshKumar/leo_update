import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // The e2e suite builds its own flavour (mocked backend + test hook) into a
  // separate folder so it never overwrites the real build.
  outDir: process.env.WXT_LEO_E2E === 'true' ? '.output-e2e' : '.output',
  modules: ['@wxt-dev/module-react'],
  browser: 'chrome',
  webExt: { disabled: true },
  imports: {
    dirsScanOptions: { types: true },
    dirs: [],
  },
  manifest: {
    name: 'Leo',
    description:
      'Teach your browser a task once. Leo replays it for you, and AI keeps it working when websites change.',
    version: '0.2.0',
    // `debugger` gives replay real (trusted) mouse/keyboard input — see
    // src/utils/cdp.ts.
    permissions: ['storage', 'tabs', 'scripting', 'downloads', 'webNavigation', 'debugger'],
    // Leo automates arbitrary third-party sites the user records on, so it
    // needs to run its recorder/replayer content script everywhere.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open Leo' },
  },
});
