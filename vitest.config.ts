import { defineConfig } from 'vitest/config';

// Node-environment unit tests for the pure PK / pharmacokinetic layer.
// UI components are intentionally out of scope here; these tests import the
// root-level PK modules directly (avoiding the browser-only logic.ts chain).
export default defineConfig({
    test: {
        environment: 'node',
        include: ['**/*.test.ts'],
        exclude: ['node_modules/**', 'src-tauri/**', 'dist/**'],
        // The synthetic MIPD benchmark is CPU-heavy; running test files in
        // parallel let it starve the short-timeout numerical tests in pk.test.ts.
        // Run files sequentially (deterministic) and give numerical tests a
        // comfortable timeout cushion for slower CI machines.
        fileParallelism: false,
        testTimeout: 15000,
    },
});
