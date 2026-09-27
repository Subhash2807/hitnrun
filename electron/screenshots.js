'use strict';

/**
 * Screenshots for test docs: list the screens and windows you can capture, and
 * grab one at full resolution.
 *
 * hitnrun's own window is kept out of the pictures: it is left out of the
 * window list, and hidden for a moment while a whole screen is captured.
 *
 * On macOS this needs the Screen Recording permission. Without it macOS still
 * answers, but with only the wallpaper and no windows, so we check first.
 */

const { desktopCapturer, screen, systemPreferences, shell } = require('electron');

const THUMB = { width: 320, height: 200 };
// Long enough for the window's hide animation to finish before the picture.
const HIDE_DELAY_MS = process.platform === 'darwin' ? 450 : 250;
const MAC_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 'granted' everywhere except a Mac that hasn't allowed Screen Recording yet. */
function permission() {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
}

function openPermissionSettings() {
  if (process.platform === 'darwin') shell.openExternal(MAC_SETTINGS);
}

const ownIds = (win) => {
  const ids = new Set();
  try {
    if (win && !win.isDestroyed()) ids.add(win.getMediaSourceId());
  } catch { /* not capturable yet */ }
  return ids;
};

/** Screens first, then windows, each with a small preview. Excludes hitnrun itself. */
async function listSources(ownWindow) {
  // Asking is what makes macOS add hitnrun to the Screen Recording list, so ask
  // even when not granted yet; the answer then tells the UI to explain.
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: THUMB });
  const status = permission();
  if (status !== 'granted') return { ok: false, permission: status };
  const skip = ownIds(ownWindow);
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  return {
    ok: true,
    sources: sources
      .filter((s) => !skip.has(s.id) && !s.thumbnail.isEmpty())
      .map((s) => ({
        id: s.id,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        // Electron names screens "Entire screen" or "Screen 1"; number them when there are several.
        name: s.id.startsWith('screen:') && screens.length > 1 ? `Screen ${screens.indexOf(s) + 1}` : s.name,
        thumbnail: s.thumbnail.toDataURL(),
      })),
  };
}

/** The pixel size to ask for so the picture comes back at full resolution. */
function fullSize(displayId) {
  const displays = screen.getAllDisplays();
  const px = (d) => ({ width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) });
  const match = displayId && displays.find((d) => String(d.id) === String(displayId));
  if (match) return px(match);
  // A window can be as big as the largest screen.
  return displays.map(px).reduce((a, b) => ({ width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) }), THUMB);
}

/**
 * Take the picture.
 * @param {string} sourceId  from listSources, or 'screen:cursor' for the screen under the mouse
 * @param {BrowserWindow} ownWindow  hidden while a screen is captured
 * @returns {{ ok, png?, width?, height?, source?, error?, permission? }}
 */
async function capture(sourceId, ownWindow) {
  const status = permission();
  if (status !== 'granted') return { ok: false, permission: status };

  const isScreen = String(sourceId).startsWith('screen:');
  let displayId = null;
  if (sourceId === 'screen:cursor') displayId = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);

  // Hide hitnrun only when it could be in the picture.
  const win = ownWindow && !ownWindow.isDestroyed() ? ownWindow : null;
  const wasVisible = !!(win && win.isVisible() && !win.isMinimized());
  const wasFocused = !!(win && win.isFocused());
  const hide = isScreen && wasVisible;
  if (hide) {
    win.hide();
    await sleep(HIDE_DELAY_MS);
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: [isScreen ? 'screen' : 'window'],
      thumbnailSize: fullSize(displayId || (isScreen ? sourceDisplay(sourceId) : null)),
    });
    const hit = displayId
      ? sources.find((s) => String(s.display_id) === displayId) || sources[0]
      : sources.find((s) => s.id === sourceId);
    if (!hit) return { ok: false, error: isScreen ? 'That screen is no longer connected' : 'That window was closed' };
    if (hit.thumbnail.isEmpty()) return { ok: false, error: 'The picture came back empty. Is the window minimized?' };
    const { width, height } = hit.thumbnail.getSize();
    const screens = sources.length;
    const source = isScreen ? (screens > 1 ? `Screen ${sources.indexOf(hit) + 1}` : 'Screen') : hit.name;
    return { ok: true, png: hit.thumbnail.toPNG(), width, height, source };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (hide && !win.isDestroyed()) {
      // Come back the way we were: in front if the user was in hitnrun, behind otherwise.
      if (wasFocused) win.show();
      else win.showInactive();
    }
  }
}

/** The display a "screen:<n>:0" source belongs to, when Electron tells us. */
function sourceDisplay(sourceId) {
  const displays = screen.getAllDisplays();
  const n = Number(String(sourceId).split(':')[1]);
  // On Windows and macOS the number is the display id; if not, fall back to the largest.
  return displays.some((d) => d.id === n) ? String(n) : null;
}

module.exports = { listSources, capture, permission, openPermissionSettings };
