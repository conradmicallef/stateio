// Rasterises ../pwa/icon.svg into the source PNGs that @capacitor/assets expects
// (mobile/assets/*), so no hand-made PNG has to be committed. Runs in CI before
// `capacitor-assets generate`. Needs `sharp` (devDependency).
const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('make-assets: `sharp` is not installed (run npm install in mobile/).');
  process.exit(1);
}

const BG = '#1b2433';
const root = path.resolve(__dirname, '..');
const svgPath = path.resolve(root, '..', 'pwa', 'icon.svg');
const outDir = path.join(root, 'assets');
const svg = fs.readFileSync(svgPath, 'utf8');

// Intrinsic width from the viewBox (fallback: width attr, then 512).
const vb = svg.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
const vbW = vb ? parseFloat(vb[1]) : parseFloat((svg.match(/\bwidth=["']([\d.]+)/) || [])[1]) || 512;

// Foreground for Android adaptive icons: the SVG without its full-bleed background rect.
const fullRect = new RegExp(`<rect\\b(?=[^>]*\\bwidth=["'](?:100%|${vbW})["'])[^>]*/>`, 'i');
const fgSvg = svg.replace(fullRect, '');

function render(svgText, size) {
  const density = Math.min(2400, Math.max(72, Math.ceil((72 * size) / vbW)));
  return sharp(Buffer.from(svgText), { density }).resize(size, size).png().toBuffer();
}
function canvas(size, background) {
  return sharp({ create: { width: size, height: size, channels: 4, background } });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const out = f => path.join(outDir, f);
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

  // iOS / legacy icon: opaque, no alpha channel (App Store requirement).
  await sharp(await render(svg, 1024)).flatten({ background: BG }).png().toFile(out('icon-only.png'));

  // Android adaptive icon: artwork shrunk into the ~66% safe zone on a transparent layer.
  await canvas(1024, transparent)
    .composite([{ input: await render(fgSvg, 640), gravity: 'center' }])
    .png().toFile(out('icon-foreground.png'));
  await canvas(1024, BG).png().toFile(out('icon-background.png'));

  // Splash (light + dark identical): dark #1b2433 with the icon art centred.
  const splash = await canvas(2732, BG)
    .composite([{ input: await render(fgSvg, 640), gravity: 'center' }])
    .flatten({ background: BG })
    .png().toBuffer();
  fs.writeFileSync(out('splash.png'), splash);
  fs.writeFileSync(out('splash-dark.png'), splash);

  console.log('make-assets: wrote icon-only, icon-foreground, icon-background, splash, splash-dark to', outDir);
})().catch(err => {
  console.error('make-assets failed:', err);
  process.exit(1);
});
