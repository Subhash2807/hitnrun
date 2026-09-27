'use strict';

/**
 * Test documentation: an ordered record of the requests you ran while testing a
 * feature, with the full request and response of each, plus your notes.
 *
 * Kept in its own file (docs.json) so response bodies never bloat the
 * workspace, and deleting a doc can't touch a collection.
 *
 * One recording at a time. In `auto` mode every send lands in the recording
 * doc; in `manual` mode only the ones you (or Claude) explicitly add.
 *
 * Screenshots are steps too (`kind: 'shot'`). Their PNGs live as files in
 * `doc-assets/` next to docs.json, never inside it, and go when their step does.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

// Bodies beyond this are cut, so one huge download can't make docs.json unusable.
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const STEP_STATUSES = ['untested', 'pass', 'fail'];
const MODES = ['auto', 'manual'];
// Only names we generated ever resolve to a file, so a crafted name can't escape the folder.
const SHOT_FILE = /^shot_[0-9a-f]{16}\.png$/;

const emptyState = () => ({ version: 1, docs: [], recording: null });

class DocStore extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.assetsDir = path.join(path.dirname(filePath), 'doc-assets');
    this.state = emptyState();
    this._saveTimer = null;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        this.state = { ...emptyState(), ...parsed };
        // A recording pointing at a doc that no longer exists is just stale.
        if (this.state.recording && !this.get(this.state.recording.docId)) this.state.recording = null;
      }
      this.pruneShots();
    } catch (err) {
      try {
        fs.copyFileSync(this.filePath, this.filePath + '.corrupt-' + Date.now());
      } catch { /* best effort */ }
      this.state = emptyState();
      this.emit('error', err);
    }
    return this.state;
  }

  scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      this.emit('error', err);
    }
  }

  touch(reason, docId) {
    const doc = docId && this.get(docId);
    if (doc) doc.updatedAt = Date.now();
    this.scheduleSave();
    this.emit('changed', { reason, docId: docId ?? null });
  }

  /* ---------------------------------------------------------------- reads */

  get(id) {
    return this.state.docs.find((d) => d.id === id) || null;
  }

  /** Lightweight list for the sidebar — no request or response bodies. */
  list() {
    return this.state.docs.map(summarize);
  }

  recording() {
    const rec = this.state.recording;
    if (!rec) return null;
    const doc = this.get(rec.docId);
    return doc ? { ...rec, name: doc.name, stepCount: doc.steps.length } : null;
  }

  /* ----------------------------------------------------------------- docs */

  create({ name, description } = {}) {
    const now = Date.now();
    const doc = {
      id: uid('doc'),
      name: String(name || '').trim() || `Test run ${new Date(now).toLocaleString()}`,
      description: description || '',
      createdAt: now,
      updatedAt: now,
      steps: [],
    };
    this.state.docs.unshift(doc);
    this.touch('doc:create', doc.id);
    return doc;
  }

  update(id, patch = {}) {
    const doc = this.get(id);
    if (!doc) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) doc.name = patch.name.trim();
    if (typeof patch.description === 'string') doc.description = patch.description;
    this.touch('doc:update', id);
    return doc;
  }

  remove(id) {
    const idx = this.state.docs.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    const [doc] = this.state.docs.splice(idx, 1);
    if (this.state.recording?.docId === id) this.state.recording = null;
    for (const step of doc.steps) this._dropShot(step);
    this.touch('doc:delete', id);
    return true;
  }

  duplicate(id) {
    const doc = this.get(id);
    if (!doc) return null;
    const now = Date.now();
    const copy = JSON.parse(JSON.stringify(doc));
    copy.id = uid('doc');
    copy.name = `${doc.name} (copy)`;
    copy.createdAt = now;
    copy.updatedAt = now;
    for (const step of copy.steps) {
      step.id = uid('stp');
      // Each doc owns its images, so deleting one copy can't break the other.
      if (step.kind === 'shot') step.shot.file = this._copyShot(step.shot.file);
    }
    const idx = this.state.docs.indexOf(doc);
    this.state.docs.splice(idx + 1, 0, copy);
    this.touch('doc:create', copy.id);
    return copy;
  }

  /* ------------------------------------------------------------ recording */

  /** Start a new doc, or resume an existing one with `docId`. Stops any other recording. */
  startRecording({ name, description, mode = 'auto', docId } = {}) {
    const doc = docId ? this.get(docId) : this.create({ name, description });
    if (!doc) return null;
    this.state.recording = { docId: doc.id, mode: MODES.includes(mode) ? mode : 'auto', paused: false, startedAt: Date.now() };
    this.touch('recording:start', doc.id);
    return this.recording();
  }

  setRecording(patch = {}) {
    const rec = this.state.recording;
    if (!rec) return null;
    if (MODES.includes(patch.mode)) rec.mode = patch.mode;
    if (typeof patch.paused === 'boolean') rec.paused = patch.paused;
    this.touch('recording:update', rec.docId);
    return this.recording();
  }

  stopRecording() {
    const rec = this.state.recording;
    if (!rec) return false;
    this.state.recording = null;
    this.touch('recording:stop', rec.docId);
    return true;
  }

  /**
   * Called after every send. Records it when a recording is running in auto
   * mode, or when `force` is set (the "Add to doc" button, or an agent asking).
   */
  capture(result, meta = {}) {
    const rec = this.state.recording;
    if (!rec || rec.paused) return null;
    if (rec.mode !== 'auto' && !meta.force) return null;
    return this.addStep(rec.docId, result, meta);
  }

  addStep(docId, result, meta = {}) {
    const doc = this.get(docId);
    if (!doc || !result) return null;
    const step = buildStep(result, meta);
    doc.steps.push(step);
    this.touch('step:add', docId);
    return step;
  }

    /* ---------------------------------------------------------- screenshots */

  /**
   * Save a PNG as a new screenshot step at the end of the doc.
   * @param {Buffer} png
   * @param {{ title?, source?, width?, height? }} meta  source = the screen or window it came from
   */
  addShot(docId, png, meta = {}) {
    const doc = this.get(docId);
    if (!doc || !png?.length) return null;
    const file = `${uid('shot')}.png`;
    fs.mkdirSync(this.assetsDir, { recursive: true });
    fs.writeFileSync(path.join(this.assetsDir, file), png);
    const step = {
      id: uid('stp'),
      kind: 'shot',
      at: Date.now(),
      source: 'user',
      title: String(meta.title || '').trim() || `Screenshot${meta.source ? ` — ${meta.source}` : ''}`,
      note: '',
      expected: '',
      status: 'untested',
      shot: { file, width: meta.width || null, height: meta.height || null, source: meta.source || null, bytes: png.length },
    };
    doc.steps.push(step);
    this.touch('step:add', docId);
    return step;
  }

  /** Absolute path of a screenshot file, or null for anything that isn't one of ours. */
  shotPath(file) {
    if (!SHOT_FILE.test(String(file || ''))) return null;
    const full = path.join(this.assetsDir, file);
    return fs.existsSync(full) ? full : null;
  }

  readShot(file) {
    const full = this.shotPath(file);
    return full ? fs.readFileSync(full) : null;
  }

  /** Delete image files no step points at (left behind by a crash or an old copy of docs.json). */
  pruneShots() {
    let names;
    try {
      names = fs.readdirSync(this.assetsDir);
    } catch {
      return 0;
    }
    const used = new Set();
    for (const doc of this.state.docs) for (const s of doc.steps) if (s.kind === 'shot') used.add(s.shot?.file);
    let removed = 0;
    for (const name of names) {
      if (SHOT_FILE.test(name) && !used.has(name)) {
        try {
          fs.rmSync(path.join(this.assetsDir, name), { force: true });
          removed++;
        } catch { /* try again next start */ }
      }
    }
    return removed;
  }

  _dropShot(step) {
    const full = step?.kind === 'shot' ? this.shotPath(step.shot?.file) : null;
    if (full) fs.rm(full, { force: true }, () => {});
  }

  _copyShot(file) {
    const from = this.shotPath(file);
    if (!from) return file;
    const next = `${uid('shot')}.png`;
    fs.copyFileSync(from, path.join(this.assetsDir, next));
    return next;
  }

  /* ---------------------------------------------------------------- steps */

  findStep(docId, stepId) {
    const doc = this.get(docId);
    const step = doc?.steps.find((s) => s.id === stepId);
    return step ? { doc, step } : null;
  }

  updateStep(docId, stepId, patch = {}) {
    const hit = this.findStep(docId, stepId);
    if (!hit) return null;
    const { step } = hit;
    for (const key of ['title', 'note', 'expected']) {
      if (typeof patch[key] === 'string') step[key] = patch[key];
    }
    if (STEP_STATUSES.includes(patch.status)) step.status = patch.status;
    this.touch('step:update', docId);
    return step;
  }

  deleteStep(docId, stepId) {
    const doc = this.get(docId);
    const idx = doc ? doc.steps.findIndex((s) => s.id === stepId) : -1;
    if (idx === -1) return false;
    const [step] = doc.steps.splice(idx, 1);
    this._dropShot(step);
    this.touch('step:delete', docId);
    return true;
  }

  /** Move a step to a zero-based position. Out-of-range positions clamp. */
  moveStep(docId, stepId, toIndex) {
    const doc = this.get(docId);
    const from = doc ? doc.steps.findIndex((s) => s.id === stepId) : -1;
    if (from === -1) return false;
    const to = Math.max(0, Math.min(doc.steps.length - 1, Number(toIndex) || 0));
    const [step] = doc.steps.splice(from, 1);
    doc.steps.splice(to, 0, step);
    this.touch('step:move', docId);
    return true;
  }
}

function summarize(doc) {
  const counts = { pass: 0, fail: 0, untested: 0 };
  for (const s of doc.steps) counts[s.status] = (counts[s.status] || 0) + 1;
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    stepCount: doc.steps.length,
    counts,
  };
}

/* ----------------------------------------------------------- step building */

function capText(text) {
  if (text == null) return { text: null, truncated: false };
  const s = String(text);
  return s.length > MAX_BODY_CHARS
    ? { text: s.slice(0, MAX_BODY_CHARS), truncated: true }
    : { text: s, truncated: false };
}

const lookup = (pairs, name) => {
  const lower = name.toLowerCase();
  const hit = (pairs || []).find(([k]) => String(k).toLowerCase() === lower);
  return hit ? hit[1] : '';
};

const isTextType = (ct) => !ct || /json|text|xml|javascript|urlencoded|html|csv|yaml|graphql/i.test(ct);

function describeRequestBody(body) {
  if (!body) return { text: null, contentType: null };
  if (body.kind === 'text') return { text: body.text, contentType: body.contentType };
  if (body.kind === 'urlencoded') {
    return {
      text: body.fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
      contentType: 'application/x-www-form-urlencoded',
    };
  }
  if (body.kind === 'form') {
    return { text: body.fields.map(([k, v]) => `${k}: ${v}`).join('\n'), contentType: 'multipart/form-data' };
  }
  if (body.kind === 'file') return { text: `(file) ${body.src}`, contentType: null };
  return { text: null, contentType: null };
}

/** Freeze a run result into a self-contained documentation step. */
function buildStep(result, meta = {}) {
  const req = result.request || {};
  const res = result.response || null;
  const method = req.method || 'GET';
  const url = req.fullUrl || res?.finalUrl || req.url || '';

  let title = meta.title || req.name || '';
  if (!title || title === 'New Request') {
    try {
      title = `${method} ${new URL(url).pathname}`;
    } catch {
      title = `${method} ${url}`;
    }
  }

  const reqBody = describeRequestBody(req.body);
  const reqCapped = capText(reqBody.text ?? req.bodyPreview ?? null);

  let response = null;
  let error = null;
  if (res && !res.error) {
    const contentType = lookup(res.headers, 'content-type') || '';
    const buf = Buffer.from(res.bodyBase64 || '', 'base64');
    const binary = !isTextType(contentType);
    const capped = binary ? { text: null, truncated: false } : capText(buf.toString('utf8'));
    response = {
      status: res.status,
      statusText: res.statusText || '',
      timeMs: res.timeMs ?? null,
      size: res.size?.decoded ?? buf.length,
      headers: res.headers || [],
      contentType,
      body: capped.text,
      binary,
      truncated: capped.truncated,
      redirects: (res.redirects || []).length,
    };
  } else {
    error = (res && res.error?.message) || result.error?.message || 'The request did not complete';
  }

  return {
    id: uid('stp'),
    at: Date.now(),
    source: meta.source === 'ai' ? 'ai' : 'user',
    requestId: meta.requestId || req.id || null,
    environment: meta.environment || null,
    title,
    note: '',
    expected: '',
    status: 'untested',
    request: {
      method,
      url,
      headers: req.sentHeaders || req.headers || [],
      body: reqCapped.text,
      bodyContentType: reqBody.contentType,
      bodyTruncated: reqCapped.truncated,
    },
    response,
    error,
    tests: (result.tests || []).map((t) => ({ name: t.name, passed: !!t.passed, error: t.error || null })),
  };
}

module.exports = { DocStore, buildStep, summarize, STEP_STATUSES, MAX_BODY_CHARS, SHOT_FILE };
