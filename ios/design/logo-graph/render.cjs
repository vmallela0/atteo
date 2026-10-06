// Renders the graph mark (jxn's atteo_design.pdf; src/mark.ts markFile) to the app icon's PNGs with Chromium.
// The SVGs here are markFile("#FAFAF7", "#0E0E0E") (light, the web's ICON_LIGHT_SVG), the colours swapped (dark) and
// white on black (tinted: iOS 18 tints it). Icons are full-bleed: the tile's colour fills the square and iOS rounds it.
// From the repo root: node ios/design/logo-graph/render.cjs <out dir>, then
// xcrun swift ios/design/logo-b2/flatten.swift <out>/icon-1024*.png, and copy into AppIcon.
// The in-app mark isn't an image: it's drawn as vector by AtteoMark (Theme.swift) from the same path.
const fs = require("fs"), path = require("path");
const { chromium } = require(require.resolve("playwright-core", { paths: [process.cwd()] }));
const S = __dirname, OUT = process.argv[2];
const read = f => fs.readFileSync(path.join(S, f), "utf8");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent("<html><body style='margin:0'></body></html>");
  const draw = (svg, ground) => p.evaluate(async ({ svg, ground }) => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(svg);
    await img.decode();
    const big = 2048, c = document.createElement("canvas"); c.width = c.height = big;
    const x = c.getContext("2d");
    x.fillStyle = ground; x.fillRect(0, 0, big, big);
    x.drawImage(img, 0, 0, big, big);
    const o = document.createElement("canvas"); o.width = o.height = 1024;
    const ox = o.getContext("2d"); ox.imageSmoothingQuality = "high";
    ox.drawImage(c, 0, 0, 1024, 1024);
    return o.toDataURL("image/png");
  }, { svg, ground });
  const save = (f, url) => fs.writeFileSync(path.join(OUT, f), Buffer.from(url.split(",")[1], "base64"));
  save("icon-1024.png", await draw(read("atteo-icon-light.svg"), "#FAFAF7"));
  save("icon-1024-dark.png", await draw(read("atteo-icon-dark.svg"), "#0E0E0E"));
  save("icon-1024-tinted.png", await draw(read("atteo-icon-tinted.svg"), "#000000"));
  await b.close();
})();
