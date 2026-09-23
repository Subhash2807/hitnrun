'use strict';

/**
 * Renders the app icon — the same mark as the top bar: a sky-blue disc with a
 * white "H" — to build/icon.png. electron-builder derives the Windows .ico and
 * the macOS .icns from it.
 *
 *   npm run icon
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZE = 1024;
const ACCENT = '#0284c7'; // --accent-solid in src/styles.css
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

const html = `<!doctype html>
<html style="background:transparent;overflow:hidden"><body style="margin:0;background:transparent;overflow:hidden">
<svg style="display:block" xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 8}" fill="${ACCENT}"/>
  <text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#fff"
        font-family="Segoe UI, -apple-system, Inter, Roboto, sans-serif"
        font-weight="700" font-size="${Math.round(SIZE * 0.56)}">H</text>
</svg>
</body></html>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));

  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const png = image.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, png);
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${SIZE}x${SIZE}, ${png.length} bytes)`);
  app.quit();
});
