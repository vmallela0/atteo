// Markdown files are bundled as text (wrangler "rules", esbuild --loader:.md=text).
declare module "*.md" {
  const text: string;
  export default text;
}
