import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // Reuse a few processes to share transforms without oversubscribing busy machines.
    // Forks are required by the tests that change the local timezone through TZ.
    pool: "forks",
    maxWorkers: 6,
    isolate: false,
  },
});
