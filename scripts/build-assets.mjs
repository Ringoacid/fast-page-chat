// Reproducible PNGs from the project's editable vector mark (no external assets).
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || 'sharp');
const mark = await readFile(new URL('../assets/icon.svg', import.meta.url));
await mkdir('extension/icons', { recursive: true });
await mkdir('docs/assets', { recursive: true });
for (const size of [16, 32, 48, 128]) await sharp(mark).resize(size, size).png().toFile(`extension/icons/icon-${size}.png`);
await sharp(mark).resize(256, 256).png().toFile('docs/assets/icon-256.png');
const promo = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="280" viewBox="0 0 440 280"><rect width="440" height="280" fill="#e6f2ee"/><circle cx="364" cy="15" r="176" fill="#c8e5de"/><circle cx="34" cy="310" r="130" fill="#d4e9e2"/><g transform="translate(160 46) scale(.9375)">${mark.toString().replace(/<svg[^>]*>|<\/svg>/g, '')}</g><text x="220" y="210" text-anchor="middle" fill="#143e3a" font-family="Segoe UI, Arial, sans-serif" font-size="30" font-weight="600">Fast Page Chat</text><text x="220" y="240" text-anchor="middle" fill="#426660" font-family="Segoe UI, Arial, sans-serif" font-size="14">Read. Ask. Understand.</text></svg>`;
await sharp(Buffer.from(promo)).png().toFile('docs/assets/promo-440x280.png');
console.log('Built extension icons and store promo assets.');
