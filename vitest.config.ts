import { defineConfig } from 'vitest/config';

// Node-environment unit tests for the pure PK / pharmacokinetic layer.
// UI components are intentionally out of scope here; these tests import the
// root-level PK modules directly (avoiding the browser-only logic.ts chain).
export default defineConfig({
    test: {
        environment: 'node',
        include: ['**/*.test.ts'],
        exclude: ['node_modules/**', 'src-tauri/**', 'dist/**'],
    },
});
