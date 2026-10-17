import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  use: { baseURL: process.env.BASE_URL || 'http://127.0.0.1:4173/tuck/', trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['iPhone 13'], defaultBrowserType: 'webkit' } }
  ],
  webServer: process.env.BASE_URL ? undefined : {
    command: 'npm run dev', url: 'http://127.0.0.1:4173/tuck/', reuseExistingServer: !process.env.CI
  }
});
