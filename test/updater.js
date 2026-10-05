'use strict';

/**
 * In-app updates: version order, picking the release and installer, the
 * download, and (on macOS only) the real DMG-to-/Applications swap.
 *
 *   node test/updater.js
 */

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { Updater, compareVersions, pickRelease, pickAsset } = require('../electron/updater');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.stack}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hitnrun-update-test-'));

const asset = (name, size = 10) => ({ name, size, browser_download_url: `https://example.test/${name}` });
const release = (tag, { prerelease = false, draft = false } = {}) => ({
  tag_name: `v${tag}`,
  name: `v${tag}`,
  body: `Notes for ${tag}`,
  html_url: `https://github.com/x/y/releases/tag/v${tag}`,
  prerelease,
  draft,
  assets: [asset(`hitnrun-Setup-${tag}.exe`), asset(`hitnrun-${tag}-arm64.dmg`), asset(`hitnrun-${tag}-x64.dmg`)],
});

function fakeApp(version = '1.7.0') {
  return {
    quits: 0,
    isPackaged: true,
    getVersion: () => version,
    getPath: () => root,
    quit() { this.quits++; },
  };
}

(async () => {
  console.log('updater');

  await test('versions sort like semver, betas before their release', () => {
    assert.ok(compareVersions('1.7.0', '1.8.0') < 0);
    assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.8.0-beta.1', '1.8.0') < 0);
    assert.ok(compareVersions('1.8.0-beta.2', '1.8.0-beta.10') < 0);
    assert.ok(compareVersions('1.8.0-beta.1', '1.7.0') > 0);
    assert.equal(compareVersions('v1.7.0', '1.7.0'), 0);
  });

  await test('picks the newest full release, and betas only for beta users', () => {
    const list = [release('1.9.0-beta.1', { prerelease: true }), release('1.8.1'), release('1.8.0'), release('2.0.0', { draft: true }), release('1.6.0')];
    assert.equal(pickRelease(list, '1.7.0', 'win32', 'x64').version, '1.8.1');
    assert.equal(pickRelease(list, '1.8.1', 'win32', 'x64'), null);
    assert.equal(pickRelease(list, '1.8.0-beta.1', 'darwin', 'arm64').version, '1.9.0-beta.1');
    const best = pickRelease(list, '1.7.0', 'darwin', 'arm64');
    assert.equal(best.asset.name, 'hitnrun-1.8.1-arm64.dmg');
    assert.equal(best.asset.url, 'https://example.test/hitnrun-1.8.1-arm64.dmg');
    assert.equal(best.notes, 'Notes for 1.8.1');
  });

  await test('the installer matches the platform and chip', () => {
    const assets = release('1.8.0').assets;
    assert.equal(pickAsset(assets, 'win32', 'x64').name, 'hitnrun-Setup-1.8.0.exe');
    assert.equal(pickAsset(assets, 'darwin', 'x64').name, 'hitnrun-1.8.0-x64.dmg');
    assert.equal(pickAsset(assets, 'darwin', 'arm64').name, 'hitnrun-1.8.0-arm64.dmg');
    assert.equal(pickAsset(assets, 'linux', 'x64'), null);
  });

  await test('check reports available, latest, and errors only when asked', async () => {
    let answer = [release('1.8.0')];
    let status = 200;
    const fetch = async () => new Response(JSON.stringify(answer), { status });
    const u = new Updater({ app: fakeApp(), fetch, shell: {} });
    const seen = [];
    u.on('changed', (s) => seen.push(s.status));

    let s = await u.check();
    assert.equal(s.status, 'available');
    assert.equal(s.latest.version, '1.8.0');
    assert.deepEqual(seen, ['checking', 'available']);

    answer = [release('1.7.0')];
    assert.equal((await u.check()).status, 'latest');

    status = 403;
    s = await u.check();
    assert.equal(s.status, 'idle');
    assert.equal(s.error, null);
    s = await u.check({ manual: true });
    assert.equal(s.status, 'error');
    assert.match(s.error, /rate limiting/);
  });

  await test('downloads the installer with progress, and rejects a short file', async () => {
    const bytes = Buffer.alloc(300_000, 7);
    const fetch = async () => new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    const u = new Updater({ app: fakeApp(), fetch, shell: {} });
    const file = await u._download({ name: 'hitnrun-Setup-1.8.0.exe', url: 'x', size: bytes.length });
    assert.equal(fs.readFileSync(file).length, bytes.length);
    assert.equal(u.state.status, 'downloading');
    await assert.rejects(u._download({ name: 'a.exe', url: 'x', size: bytes.length + 1 }), /incomplete/);
  });

  await test('without an installer for this machine, install opens the release page', async () => {
    const opened = [];
    const fetch = async () => new Response(JSON.stringify([{ ...release('1.8.0'), assets: [] }]));
    const u = new Updater({ app: fakeApp(), fetch, shell: { openExternal: (url) => opened.push(url) } });
    await u.check();
    const out = await u.install();
    assert.equal(out.openedPage, true);
    assert.deepEqual(opened, ['https://github.com/x/y/releases/tag/v1.8.0']);
  });

  if (process.platform === 'darwin') {
    await test('macOS: swaps the app from the DMG after quitting, without quarantine', async () => {
      // An "installed" 1.7.0 and a DMG holding 1.8.0.
      const make = (dir, version) => {
        const bin = path.join(dir, 'hitnrun.app', 'Contents', 'MacOS');
        fs.mkdirSync(bin, { recursive: true });
        fs.writeFileSync(path.join(bin, 'hitnrun'), version);
        return path.join(dir, 'hitnrun.app');
      };
      const installed = make(path.join(root, 'Applications'), '1.7.0');
      make(path.join(root, 'dmg-src'), '1.8.0');
      const dmg = path.join(root, 'built.dmg');
      execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', path.join(root, 'dmg-src'), '-volname', 'hitnrun', '-format', 'UDZO', dmg]);
      const bytes = fs.readFileSync(dmg);

      const answer = [{ ...release('1.8.0'), assets: [asset(`hitnrun-1.8.0-${process.arch}.dmg`, bytes.length)] }];
      const fetch = async (url) => new Response(url.includes('api.github.com') ? JSON.stringify(answer) : bytes);
      const app = fakeApp();
      const u = new Updater({ app, fetch, shell: { openPath() {}, openExternal() {} }, testing: { appPath: installed, pid: 999999 } });
      await u.check();
      const out = await u.install();
      assert.deepEqual(out, { ok: true }, u.state.error);

      const log = path.join(root, 'hitnrun-update', 'install.log');
      const bin = path.join(installed, 'Contents', 'MacOS', 'hitnrun');
      for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('done')); i++) await sleep(200);
      assert.equal(fs.readFileSync(bin, 'utf8'), '1.8.0', fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : 'no log');
      assert.ok(!fs.existsSync(`${installed}.updating`), 'old copy removed');
      assert.equal(app.quits, 1);
      const attrs = execFileSync('/usr/bin/xattr', [installed]).toString();
      assert.ok(!attrs.includes('com.apple.quarantine'));
    });
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
