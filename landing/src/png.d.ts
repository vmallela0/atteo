// PNGs are bundled as bytes (wrangler "rules": Data).
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}

// jxn's landing page (landing/landing-jxn.html) is bundled as text (wrangler "rules": Text).
declare module "*.html" {
  const text: string;
  export default text;
}
