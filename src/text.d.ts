// Markdown files are bundled as text (wrangler "rules", esbuild --loader:.md=text).
declare module "*.md" {
  const text: string;
  export default text;
}

// The bundled CLI, served at /cli/agent-soup.mjs (wrangler imports it as text).
declare module "*/agent-soup.mjs" {
  const text: string;
  export default text;
}
