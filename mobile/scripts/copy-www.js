// Copies ../pwa into ./www for the native apps:
//  - skips the service worker (unused in native; game.js also skips registration),
//  - adds native-bridge.js and injects it into index.html before game.js.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const src = path.resolve(root, '..', 'pwa');
const dest = path.join(root, 'www');
const EXCLUDE = new Set(['sw.js']);
const BRIDGE = 'native-bridge.js';

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (EXCLUDE.has(f)) continue;
  fs.cpSync(path.join(src, f), path.join(dest, f), { recursive: true });
}
fs.copyFileSync(path.join(root, BRIDGE), path.join(dest, BRIDGE));

const indexPath = path.join(dest, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const tag = `<script src="${BRIDGE}"></script>`;
if (!html.includes(tag)) {
  const gameScript = /<script\b[^>]*\bsrc=["']?(\.\/)?game\.js["']?[^>]*>/i;
  if (gameScript.test(html)) html = html.replace(gameScript, m => `${tag}\n${m}`);
  else if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, `${tag}\n</body>`);
  else html += `\n${tag}\n`;
  fs.writeFileSync(indexPath, html);
}
console.log('Copied', src, '->', dest, '(+ ' + BRIDGE + ')');
