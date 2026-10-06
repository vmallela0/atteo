// Markdown files are bundled as text (wrangler "rules", esbuild --loader:.md=text).
declare module "*.md" {
  const text: string;
  export default text;
}

// The bundled CLI, served at /cli/atteo.mjs (wrangler imports it as text).
declare module "*/atteo.mjs" {
  const text: string;
  export default text;
}

// The web's fonts, copied to dist/web/fonts at build (scripts/build-web-assets.mjs).
declare module "*.woff2" {
  const data: ArrayBuffer;
  export default data;
}
