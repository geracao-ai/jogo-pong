const { defineConfig, devices } = require('@playwright/test');

const phones = [
  'iPhone SE',
  'iPhone 14',
  'iPhone 14 landscape',
  'iPhone 14 Pro Max',
  'iPhone 14 Pro Max landscape',
  'Pixel 7',
  'Pixel 7 landscape',
  'Galaxy S9+',
  'Galaxy S9+ landscape',
];

module.exports = defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'python3 -m http.server 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
  projects: [
    ...phones.map((name) => ({
      name,
      use: {
        ...devices[name],
        // Chromium denies motion sensors by default in tests; WebKit rejects these names
        permissions: devices[name].defaultBrowserType === 'chromium' ? ['accelerometer', 'gyroscope'] : [],
      },
    })),
    { name: 'Desktop', use: { ...devices['Desktop Chrome'] } },
  ],
});
