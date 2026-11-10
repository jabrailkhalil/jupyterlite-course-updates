import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'browser.spec.*', timeout: 180000,
  outputDir: 'artifacts/test-results',
  expect: { timeout: 30000 }, workers: 1, retries: 0,
  reporter: [['list'],['json',{outputFile:'artifacts/browser-results.json'}],['html',{outputFolder:'artifacts/browser-report',open:'never'}]],
  use: { baseURL:'http://127.0.0.1:4173', browserName:'chromium', viewport:{width:1440,height:1000}, screenshot:'only-on-failure', trace:'retain-on-failure' },
  webServer: {command:'node scripts/serve_site.mjs',url:'http://127.0.0.1:4173/lab/index.html',timeout:30000,reuseExistingServer:false}
});
