// PNGs are bundled as bytes (wrangler "rules": Data).
declare module "*.png" {
  const data: ArrayBuffer;
  export default data;
}
