import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: the tests cover pure logic only (no
// components, no e2e — see Phase 3 §3), so they don't want the react plugin or
// the three-entry-point rollup input.
//
// Everything under test that touches a `Date` is local-time by design — the app
// has no per-event timezone — so a run has to pin one, or the DST tests would
// quietly pass anywhere that doesn't observe daylight saving. Sydney, because
// that's where the app runs and Sun 4 Oct 2026 is the 23-hour day the skeleton
// math has to survive. test/dst.test.ts asserts the timezone actually took.
process.env.TZ = 'Australia/Melbourne';

export default defineConfig({
  // src/addons-private links to the private add-ons repo (Phase 9.3): keep its
  // linked paths so its imports resolve in this project. Its tests run here too.
  resolve: { preserveSymlinks: true },
  test: {
    include: ['test/**/*.test.ts', 'src/addons-private/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'Australia/Melbourne' },
  },
});
