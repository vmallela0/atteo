#!/usr/bin/env node
// Writes the web's CSS, JS and fonts into dist/web for Workers static assets (wrangler.jsonc assets.directory).
// wrangler runs this before `dev` and `deploy`. Pages keep versioned URLs (/app.css?v=<hash> from src/ui.ts); the
// files themselves are unhashed so a new deploy replaces them and the query string busts browser caches.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const out = join(root, "dist", "web");
const bundlePath = join(root, "dist", "web-assets-bundle.mjs");

const bundled = await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: `export { builtTextAssets, staticAssetHeadersFile } from "./src/webAssets.ts";\nexport { FONT_FACES } from "./src/fontfaces.ts";\n`,
    resolveDir: root,
    sourcefile: "web-assets-bundle.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
  loader: { ".md": "text", ".woff2": "empty", ".mjs": "text", ".png": "empty" },
});

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const { builtTextAssets, staticAssetHeadersFile, FONT_FACES } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "fonts"), { recursive: true });

for (const a of builtTextAssets()) {
  writeFileSync(join(out, a.path.slice(1)), a.body);
}

for (const f of FONT_FACES) {
  cpSync(join(root, "src", "fonts", f.file), join(out, "fonts", f.file));
}

cpSync(join(root, "public", "mermaid.min.js"), join(out, "mermaid.min.js"));
writeFileSync(join(out, "_headers"), staticAssetHeadersFile());

const files = readdirSync(out, { recursive: true }).filter((n) => n !== "_headers").length;
console.warn(`build:assets: ${files} files in dist/web`);
