import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // Forks are required by the tests that change the local timezone through TZ. Each file stays isolated:
    // tests that vi.mock a module (searchFanout mocks registry) leak into the next file in a reused worker.
    pool: "forks",
    maxWorkers: 6,
  },
});
