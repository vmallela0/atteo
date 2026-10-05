import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // landing/src/index.ts bundles og.png as bytes (wrangler Data). Vitest has no PNG loader; empty bytes are enough
      // for the landing CSP tests, which never fetch /og.png.
      name: "landing-png-bytes",
      load(id) {
        const file = id.split("?")[0].replace(/\\/g, "/");
        if (file.endsWith("/landing/og.png")) return "export default new ArrayBuffer(0);";
      },
    },
  ],
  test: {
    include: ["test/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // Forks are required by the tests that change the local timezone through TZ. Each file stays isolated:
    // tests that vi.mock a module (searchFanout mocks registry) leak into the next file in a reused worker.
    pool: "forks",
    maxWorkers: 6,
  },
});
