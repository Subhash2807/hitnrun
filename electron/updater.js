'use strict';

/**
 * In-app updates from GitHub Releases.
 *
 * hitnrun is not code-signed, so Electron's built-in updater (which insists on
 * a signature on macOS) can't be used. Instead:
 *
 *   - Windows: download the NSIS installer and run it silently. An all-users
 *     install asks for admin through the normal UAC prompt.
 *   - macOS: download the DMG, copy the app out of it, and swap it in for the
 *     running one from a small script that waits for hitnrun to quit. A file
 *     downloaded by the app itself never gets the quarantine flag (that comes
 *     from browsers), and the script clears it anyway, so no `xattr` is needed.
 *
 * Anything that goes wrong falls back to opening the downloaded installer, or
 * the release page, so the user can finish by hand.
 */

const { EventEmitter } = require('node:events');
const { execFile, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = 'Subhash2807/hitnrun';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const FIRST_CHECK_MS = 8_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- versions */

/** "v1.8.0-beta.2" -> { nums: [1, 8, 0], pre: ['beta', 2] } */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** Semver order: < 0 when a is older than b. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  // A release outranks its own pre-releases.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

const isPrerelease = (v) => !!parseVersion(v)?.pre.length;

/** The installer to download for this machine, or null. */
function pickAsset(assets, platform, arch) {
  const list = assets || [];
  if (platform === 'win32') return list.find((a) => /setup.*\.exe$/i.test(a.name)) || null;
  if (platform === 'darwin') return list.find((a) => a.name.toLowerCase().endsWith(`-${arch}.dmg`)) || null;
  return null;
}

/**
 * The newest release worth offering. Someone on a beta also gets newer betas;
 * someone on a full release only gets full releases.
 */
function pickRelease(releases, current, platform, arch) {
  const wantBetas = isPrerelease(current);
  let best = null;
  for (const r of releases || []) {
    if (r.draft || (r.prerelease && !wantBetas)) continue;
    const version = String(r.tag_name || '').replace(/^v/, '');
    if (!parseVersion(version) || compareVersions(version, current) <= 0) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;
    best = {
      version,
      name: r.name || r.tag_name,
      notes: r.body || '',
      url: r.html_url || `${RELEASES_PAGE}/tag/${r.tag_name}`,
      publishedAt: r.published_at,
      asset: pickAsset(r.assets, platform, arch),
    };
  }
  if (best?.asset) best.asset = { name: best.asset.name, url: best.asset.browser_download_url, size: best.asset.size };
  return best;
}

/* ----------------------------------------------------------------- updater */

const run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout));
  });

class Updater extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.app       Electron's app
   * @param {Function} o.fetch   Electron's net.fetch (follows the system proxy)
   * @param {object} o.shell     Electron's shell
   * @param {object} [o.testing] { appPath, pid } stand-ins for the tests
   */
  constructor({ app, fetch, shell, testing = null }) {
    super();
    this.testing = testing;
    this.app = app;
    this.fetch = fetch;
    this.shell = shell;
    this.current = app.getVersion();
    this.state = { status: 'idle', current: this.current, latest: null, progress: 0, error: null, checkedAt: null };
    this.timer = null;
    this.busy = null;
  }

  getState() {
    return { ...this.state, canInstall: this.canInstall(), releasesPage: RELEASES_PAGE };
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('changed', this.getState());
  }

  /** Check now, then again every few hours. */
  start() {
    if (this.timer) return;
    setTimeout(() => this.check().catch(() => {}), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check().catch(() => {}), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  /** Only an installed copy can replace itself; `electron .` can't. */
  canInstall() {
    if (!this.app.isPackaged) return false;
    if (process.platform === 'win32') return true;
    if (process.platform === 'darwin') return !!this.macAppPath();
    return false;
  }

  /** /Applications/hitnrun.app, or null when running somewhere we can't update. */
  macAppPath() {
    if (this.testing?.appPath) return this.testing.appPath;
    const appPath = path.resolve(process.execPath, '..', '..', '..');
    // Launched from the DMG or translocated by Gatekeeper: there is nothing stable to replace.
    if (!appPath.endsWith('.app') || appPath.includes('/AppTranslocation/') || appPath.startsWith('/Volumes/')) return null;
    return appPath;
  }

  async check({ manual = false } = {}) {
    if (this.busy) return this.getState();
    if (['downloading', 'installing'].includes(this.state.status)) return this.getState();
    this._set({ status: 'checking', error: null });
    try {
      const res = await this.fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `hitnrun/${this.current}` },
      });
      if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is rate limiting update checks. Try again in a while.' : `GitHub answered ${res.status}`);
      const latest = pickRelease(await res.json(), this.current, process.platform, process.arch);
      this._set({ status: latest ? 'available' : 'latest', latest, checkedAt: Date.now() });
    } catch (err) {
      // A failed background check shouldn't nag; only a manual one reports it.
      this._set({ status: manual ? 'error' : 'idle', error: manual ? `Could not check for updates: ${err.message}` : null });
    }
    return this.getState();
  }

  /** Download the installer, then install it and restart. */
  install() {
    if (!this.busy) this.busy = this._install().finally(() => { this.busy = null; });
    return this.busy;
  }

  async _install() {
    const latest = this.state.latest;
    if (!latest) return { ok: false, error: 'No update to install' };
    if (!latest.asset || !this.canInstall()) {
      this.shell.openExternal(latest.url);
      return { ok: true, openedPage: true };
    }
    let file = null;
    try {
      file = await this._download(latest.asset);
      this._set({ status: 'installing', progress: 1 });
      if (process.platform === 'win32') await this._installWindows(file);
      else await this._installMac(file);
      return { ok: true };
    } catch (err) {
      if (err.declined) {
        this._set({ status: 'available', progress: 0, error: err.message });
        return { ok: false, error: err.message };
      }
      // Leave the user a way to finish by hand.
      if (file && fs.existsSync(file)) this.shell.openPath(file);
      else this.shell.openExternal(latest.url);
      const msg = file ? `${err.message}. The installer has been opened so you can finish by hand.` : err.message;
      this._set({ status: 'error', error: msg });
      return { ok: false, error: msg };
    }
  }

  async _download(asset) {
    const dir = path.join(this.app.getPath('temp'), 'hitnrun-update');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(asset.name));

    this._set({ status: 'downloading', progress: 0, error: null });
    const res = await this.fetch(asset.url, { headers: { 'User-Agent': `hitnrun/${this.current}` } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;

    const out = fs.createWriteStream(file);
    let got = 0;
    let lastEmit = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise((r) => out.once('drain', r));
        if (total && Date.now() - lastEmit > 150) {
          lastEmit = Date.now();
          this._set({ progress: Math.min(0.99, got / total) });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (asset.size && got !== asset.size) throw new Error('The download was incomplete. Try again.');
    return file;
  }

  async _installWindows(installer) {
    // An all-users install lives under Program Files and needs admin.
    const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter(Boolean)
      .map((p) => p.toLowerCase());
    const allUsers = roots.some((r) => process.execPath.toLowerCase().startsWith(r));
    // --updated: an upgrade, keep settings. /S: no wizard. --force-run: start hitnrun when done.
    const args = ['--updated', '/S', '--force-run', allUsers ? '/allusers' : '/currentuser'];

    if (allUsers) {
      // Ask for admin up front, so a "No" at the UAC prompt leaves hitnrun running.
      const quoted = args.map((a) => `'${a}'`).join(',');
      const ps = `Start-Process -FilePath '${installer.replace(/'/g, "''")}' -ArgumentList ${quoted} -Verb RunAs`;
      try {
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      } catch {
        throw Object.assign(new Error('The update needs admin permission'), { declined: true });
      }
    } else {
      spawn(installer, args, { detached: true, stdio: 'ignore' }).unref();
    }
    // The installer replaces files once hitnrun has quit, then starts it again.
    setTimeout(() => this.app.quit(), 300);
  }

  async _installMac(dmg) {
    const appPath = this.macAppPath();
    const work = path.dirname(dmg);
    const mount = path.join(work, 'mnt');
    const staged = path.join(work, path.basename(appPath));

    fs.mkdirSync(mount, { recursive: true });
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, dmg]);
    try {
      const inside = fs.readdirSync(mount).find((n) => n.endsWith('.app'));
      if (!inside) throw new Error('The download has no app in it');
      await run('/usr/bin/ditto', [path.join(mount, inside), staged]);
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => {});
    }
    if (!fs.existsSync(path.join(staged, 'Contents', 'MacOS'))) throw new Error('The downloaded app looks incomplete');
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});

    // The swap happens after we quit; a running app can't replace itself cleanly.
    const script = path.join(work, 'install.sh');
    fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
    const log = path.join(work, 'install.log');
    spawn('/bin/bash', [script, appPath, staged, String(this.testing?.pid ?? process.pid), dmg, log], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => this.app.quit(), 300);
  }
}

/*
 * Runs after hitnrun quits: put the new app where the old one was, keeping the
 * old one until the copy has worked, then start it. If the swap fails (no write
 * access to /Applications, say), open the DMG so it can be dragged across.
 */
const MAC_SWAP_SCRIPT = `#!/bin/bash
APP="$1"; NEW="$2"; PID="$3"; DMG="$4"; LOG="$5"
exec >>"$LOG" 2>&1
echo "$(date) updating $APP"
for _ in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
OLD="$APP.updating"
rm -rf "$OLD"
if mv "$APP" "$OLD"; then
  if /usr/bin/ditto "$NEW" "$APP"; then
    rm -rf "$OLD"
  else
    echo "copy failed, restoring"
    rm -rf "$APP"; mv "$OLD" "$APP"
    open "$DMG"; open "$APP"; exit 1
  fi
else
  echo "cannot replace $APP"
  open "$DMG"; exit 1
fi
/usr/bin/xattr -dr com.apple.quarantine "$APP" 2>/dev/null
rm -rf "$NEW"
open "$APP"
echo "$(date) done"
`;

module.exports = { Updater, compareVersions, pickRelease, pickAsset, RELEASES_PAGE };
