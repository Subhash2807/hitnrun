'use strict';

/**
 * Files for the JSON viewer: scratch JSON you paste, open from disk, or send
 * there from a response.
 *
 * Each file's text lives in its own file (json-files/<id>.json) and the names
 * and dates in json-files/index.json, so typing in one big file never
 * rewrites the others. Like the other stores it auto-saves: changes are
 * written on a short debounce, and anything pending is flushed on quit.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const uid = () => `jsn_${crypto.randomBytes(8).toString('hex')}`;
// Only ids we generated ever become a path, so a crafted id can't escape the folder.
const ID = /^jsn_[0-9a-f]{16}$/;
const MAX_NAME = 200;
// Bigger than this and the editor and tree slow to a crawl, so it is refused.
const MAX_BYTES = 50 * 1024 * 1024;

const byteLength = (text) => Buffer.byteLength(text, 'utf8');

/** One line ending style everywhere, so offsets in the text match the editor's. */
function normalizeText(text) {
  const s = String(text ?? '');
  return s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s;
}

function cleanName(name) {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME);
}

class JsonFileStore extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.indexPath = path.join(dir, 'index.json');
    this.files = []; // metadata, newest first
    this._text = new Map(); // id -> text, read from disk on first use
    this._dirtyText = new Set();
    this._indexDirty = false;
    this._saveTimer = null;
  }

  textPath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  load() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return this.files; // first run: nothing saved yet
    }
    const onDisk = names.filter((name) => name.endsWith('.json') && ID.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
    // A temp file only survives a write that never finished; the real file is intact.
    for (const name of names) {
      if (name.endsWith('.tmp')) fs.rm(path.join(this.dir, name), { force: true }, () => {});
    }

    let index = null;
    try {
      if (fs.existsSync(this.indexPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
        if (!Array.isArray(parsed?.files)) throw new Error('index.json has no file list');
        index = parsed;
      }
    } catch (err) {
      try {
        fs.copyFileSync(this.indexPath, `${this.indexPath}.corrupt-${Date.now()}`);
      } catch { /* best effort */ }
      this.emit('error', err);
    }

    if (index) {
      const seen = new Set();
      this.files = index.files
        .filter((f) => f && ID.test(f.id) && !seen.has(f.id) && seen.add(f.id))
        .map((f) => ({
          id: f.id,
          name: cleanName(f.name) || 'Untitled.json',
          size: Number(f.size) || 0,
          createdAt: Number(f.createdAt) || Date.now(),
          updatedAt: Number(f.updatedAt) || Date.now(),
        }));
      // Text files the index doesn't know were left behind by a delete that was cut short.
      for (const id of onDisk) {
        if (!seen.has(id)) fs.rm(this.textPath(id), { force: true }, () => {});
      }
    } else {
      // No usable index, but the texts are still there: keep them rather than lose work.
      this.files = onDisk.map((id, i) => {
        let stat = null;
        try {
          stat = fs.statSync(this.textPath(id));
        } catch { /* listed a moment ago */ }
        return {
          id,
          name: `Recovered ${i + 1}.json`,
          size: stat?.size || 0,
          createdAt: stat?.birthtimeMs || stat?.mtimeMs || Date.now(),
          updatedAt: stat?.mtimeMs || Date.now(),
        };
      });
      this.files.sort((a, b) => b.updatedAt - a.updatedAt);
      if (this.files.length) {
        this._indexDirty = true;
        this.saveNow();
      }
    }
    return this.files;
  }

  /* --------------------------------------------------------------- saving */

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  /** Write everything pending. Texts go first, so the index never names a file that isn't there. */
  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (!this._dirtyText.size && !this._indexDirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const id of this._dirtyText) {
        if (!this.meta(id)) continue; // deleted while waiting
        writeAtomic(this.textPath(id), this._text.get(id) ?? '');
      }
      this._dirtyText.clear();
      if (this._indexDirty) {
        writeAtomic(this.indexPath, JSON.stringify({ version: 1, files: this.files }, null, 2));
        this._indexDirty = false;
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  touch(reason, id) {
    this._indexDirty = true;
    this.scheduleSave();
    this.emit('changed', { reason, id: id ?? null });
  }

  /* ---------------------------------------------------------------- reads */

  meta(id) {
    return this.files.find((f) => f.id === id) || null;
  }

  /** Names, sizes and dates for the sidebar — no text. */
  list() {
    return this.files.map((f) => ({ ...f }));
  }

  /** A file with its text, or null. */
  get(id) {
    const meta = this.meta(id);
    return meta ? { ...meta, content: this.readText(id) } : null;
  }

  readText(id) {
    if (!this._text.has(id)) {
      let text = '';
      try {
        text = normalizeText(fs.readFileSync(this.textPath(id), 'utf8'));
      } catch { /* never written: an empty file */ }
      this._text.set(id, text);
    }
    return this._text.get(id);
  }

  /* --------------------------------------------------------------- writes */

  /**
   * A new file at the top of the list. Returns its metadata, or null when the text is too big.
   * `unique` numbers the name when another file has it already.
   */
  create(fields) {
    const { name, content = '', unique = false } = fields || {};
    const text = normalizeText(content);
    if (byteLength(text) > MAX_BYTES) return null;
    const clean = cleanName(name);
    const now = Date.now();
    const meta = {
      id: uid(),
      name: !clean ? this.untitledName() : unique ? this.uniqueName(clean) : clean,
      size: byteLength(text),
      createdAt: now,
      updatedAt: now,
    };
    this.files.unshift(meta);
    this._text.set(meta.id, text);
    this._dirtyText.add(meta.id);
    this.touch('file:create', meta.id);
    return { ...meta };
  }

  /** Rename and/or replace the text. Returns the metadata, or null (unknown id, text too big). */
  update(id, patch) {
    const meta = this.meta(id);
    if (!meta || !patch) return meta ? { ...meta } : null;
    let changed = false;
    const name = typeof patch.name === 'string' ? cleanName(patch.name) : '';
    if (name && name !== meta.name) {
      meta.name = name;
      changed = true;
    }
    if (typeof patch.content === 'string') {
      const text = normalizeText(patch.content);
      const size = byteLength(text);
      if (size > MAX_BYTES) return null;
      if (text !== this.readText(id)) {
        this._text.set(id, text);
        this._dirtyText.add(id);
        meta.size = size;
        meta.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.touch('file:update', id);
    return { ...meta };
  }

  remove(id) {
    const idx = this.files.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    this.files.splice(idx, 1);
    this._text.delete(id);
    this._dirtyText.delete(id);
    // Index first: if we stop between the two, the leftover text is cleaned up on the next start.
    this._indexDirty = true;
    this.saveNow();
    fs.rm(this.textPath(id), { force: true }, () => {});
    this.emit('changed', { reason: 'file:delete', id });
    return true;
  }

  /** A copy placed right after the original. */
  duplicate(id) {
    const meta = this.meta(id);
    if (!meta) return null;
    const now = Date.now();
    const copy = { ...meta, id: uid(), name: this.copyName(meta.name), createdAt: now, updatedAt: now };
    this.files.splice(this.files.indexOf(meta) + 1, 0, copy);
    this._text.set(copy.id, this.readText(id));
    this._dirtyText.add(copy.id);
    this.touch('file:create', copy.id);
    return { ...copy };
  }

  /* ---------------------------------------------------------------- names */

  /** "Untitled 1.json", or the lowest number not already taken. */
  untitledName() {
    const taken = new Set(this.files.map((f) => f.name.toLowerCase()));
    let n = 1;
    while (taken.has(`untitled ${n}.json`)) n++;
    return `Untitled ${n}.json`;
  }

  /** "orders.json" -> "orders copy.json", then "orders copy 2.json"… */
  copyName(name) {
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0 && dot >= name.length - 6;
    const ext = hasExt ? name.slice(dot) : '';
    const base = (hasExt ? name.slice(0, dot) : name).replace(/ copy( \d+)?$/, '');
    const taken = new Set(this.files.map((f) => f.name.toLowerCase()));
    let candidate = `${base} copy${ext}`;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} copy ${n}${ext}`;
    return candidate;
  }

  /** "orders.json" while it's free, then "orders 2.json", "orders 3.json"… */
  uniqueName(name) {
    const taken = new Set(this.files.map((f) => f.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0 && dot >= name.length - 6;
    const ext = hasExt ? name.slice(dot) : '';
    const base = hasExt ? name.slice(0, dot) : name;
    let n = 2;
    while (taken.has(`${base} ${n}${ext}`.toLowerCase())) n++;
    return `${base} ${n}${ext}`;
  }
}

/** Write via a temp file and rename, so a crash never leaves half a file. */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/** A name that is safe to offer in a save dialog, ending in .json. */
function exportFileName(name) {
  const safe = String(name || 'data').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'data';
  return /\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(safe) ? safe : `${safe}.json`;
}

module.exports = { JsonFileStore, normalizeText, exportFileName, MAX_BYTES, ID };
