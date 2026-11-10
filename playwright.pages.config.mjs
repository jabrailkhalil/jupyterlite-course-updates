import { defineConfig } from '@playwright/test';

const configured = process.env.PAGES_BASE_URL || 'http://127.0.0.1:4173/jupyterlite-course-updates/';
const base = new URL(configured.endsWith('/') ? configured : `${configured}/`);
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('PAGES_BASE_URL must be an HTTP(S) site base URL.');
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);

export default defineConfig({
  testDir: './tests', testMatch: 'pages.spec.mjs', timeout: 180000,
  outputDir: 'artifacts/pages-test-results', expect: { timeout: 30000 },
  workers: 1, retries: 0,
  reporter: [['list'], ['json', { outputFile: 'artifacts/pages-results.json' }],
    ['html', { outputFolder: 'artifacts/pages-report', open: 'never' }]],
  use: {
    baseURL: base.href, browserName: 'chromium', serviceWorkers: 'allow',
    viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: local ? {
    command: 'node scripts/serve_site.mjs',
    url: new URL('lab/index.html', base).href,
    timeout: 30000, reuseExistingServer: false,
    env: { HTTP_BASE_PATH: base.pathname.replace(/\/$/, ''), HTTP_NO_COI: 'true' }
  } : undefined
});
