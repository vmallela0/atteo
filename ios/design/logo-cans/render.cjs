// Renders the cans logo (board #2944, vedu yes #2968: an oxblood cone wired to two cans) to the app's PNGs with Chromium, so the feTurbulence wobble renders as designed.
// From the repo root: node ios/design/logo-cans/render.cjs <out dir>, then
// xcrun swift ios/design/logo-cans/flatten.swift <out>/icon-1024*.png, and copy into AppIcon / AtteoMark.
const fs = require("fs"), path = require("path");
const { chromium } = require(require.resolve("playwright-core", { paths: [process.cwd()] }));
const S = __dirname, OUT = process.argv[2];
const read = f => fs.readFileSync(path.join(S, f), "utf8");
const light = read("atteo-icon-light.svg"), dark = read("atteo-icon-dark.svg"), mark = read("atteo-mark.svg");
// Tinted (iOS 18): grayscale on black; the system tints it. The cone (you) is the brightest, as oxblood is in colour.
const tinted = light.replace('fill="#FAFAF7"', 'fill="#000000"').replaceAll("#0E0E0E", "#BDBDBD").replaceAll("#6A1B24", "#FFFFFF");
const markDark = mark.replaceAll("#0E0E0E", "#FAFAF7").replaceAll("#6A1B24", "#C2414D");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent("<html><body style='margin:0'></body></html>");
  // Draws an SVG on a canvas; icons fill the whole square (iOS masks the corners), marks are trimmed to their ink.
  const draw = (svg, opts) => p.evaluate(async ({ svg, opts }) => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64," + btoa(svg);
    await img.decode();
    const big = opts.big, c = document.createElement("canvas"); c.width = c.height = big;
    const x = c.getContext("2d");
    if (opts.ground) { x.fillStyle = opts.ground; x.fillRect(0, 0, big, big); }
    x.drawImage(img, 0, 0, big, big);
    const outs = [];
    if (opts.trim) {
      const d = x.getImageData(0, 0, big, big).data;
      let x0 = big, y0 = big, x1 = 0, y1 = 0;
      for (let yy = 0; yy < big; yy++) for (let xx = 0; xx < big; xx++) if (d[(yy * big + xx) * 4 + 3] > 8) {
        if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
      const pad = Math.round(big * 0.01); x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      const w = x1 - x0, h = y1 - y0;
      for (const long of opts.sizes) {
        const k = long / Math.max(w, h), o = document.createElement("canvas");
        o.width = Math.round(w * k); o.height = Math.round(h * k);
        const ox = o.getContext("2d"); ox.imageSmoothingQuality = "high";
        ox.drawImage(c, x0, y0, w, h, 0, 0, o.width, o.height);
        outs.push(o.toDataURL("image/png"));
      }
    } else {
      const o = document.createElement("canvas"); o.width = o.height = opts.sizes[0];
      const ox = o.getContext("2d"); ox.imageSmoothingQuality = "high";
      ox.drawImage(c, 0, 0, o.width, o.height);
      outs.push(o.toDataURL("image/png"));
    }
    return outs;
  }, { svg, opts });
  const save = (f, url) => fs.writeFileSync(path.join(OUT, f), Buffer.from(url.split(",")[1], "base64"));
  save("icon-1024.png", (await draw(light, { big: 2048, ground: "#FAFAF7", sizes: [1024] }))[0]);
  save("icon-1024-dark.png", (await draw(dark, { big: 2048, ground: "#0E0E0E", sizes: [1024] }))[0]);
  save("icon-1024-tinted.png", (await draw(tinted, { big: 2048, ground: "#000000", sizes: [1024] }))[0]);
  const [m2, m3] = await draw(mark, { big: 1800, trim: true, sizes: [240, 360] });
  save("mark@2x.png", m2); save("mark@3x.png", m3);
  const [d2, d3] = await draw(markDark, { big: 1800, trim: true, sizes: [240, 360] });
  save("mark-dark@2x.png", d2); save("mark-dark@3x.png", d3);
  await b.close();
})();
