import { defineConfig } from "@playwright/test";

// Drives the real Electron app against fake app servers (tests/fixtures/fake-app.cjs). One worker: each test starts its own host.
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
