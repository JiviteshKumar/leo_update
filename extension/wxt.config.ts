import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
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
    permissions: [
      'sidePanel',
      'storage',
      'tabs',
      'scripting',
      'downloads',
      'webNavigation',
    ],
    // Leo automates arbitrary third-party sites the user records on, so it
    // needs to run its recorder/replayer content script everywhere.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open Leo' },
    side_panel: { default_path: 'sidepanel.html' },
  },
});
