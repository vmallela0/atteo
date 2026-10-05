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

// The web's fonts, served at /fonts/* (wrangler bundles them as Data modules: an ArrayBuffer).
declare module "*.woff2" {
  const data: ArrayBuffer;
  export default data;
}
