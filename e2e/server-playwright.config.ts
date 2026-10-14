import { defineConfig } from '@playwright/test';
import path from 'node:path';

const evidence = process.env.BNOC_TEST_EVIDENCE_DIR ?? 'runtime/evidence/backend-implementation-20261013';

export default defineConfig({
  testDir: '.',
  testMatch: 'server-ui.spec.ts',
  timeout: 120000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: path.resolve(evidence, 'server-browser-results.json') }]],
  outputDir: path.resolve(evidence, 'server-browser-artifacts'),
  use: {
    baseURL: process.env.BNOC_TEST_URL ?? 'http://127.0.0.1:8083',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 12000,
  },
  projects: ['chromium', 'firefox'].flatMap(browserName => [1280, 1440].map(width => ({
    name: `${browserName}-${width}`,
    use: { browserName: browserName as 'chromium' | 'firefox', viewport: { width, height: 900 } },
  }))),
});
