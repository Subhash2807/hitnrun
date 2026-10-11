import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, keymap, placeholder } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { foldedRanges, unfoldEffect } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { basicSetup } from '@uiw/react-codemirror';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { jsonFolding } from './jsonFold.js';

/**
 * CodeMirror pieces for the JSON viewer's raw pane: the highlight that shows
 * which value is picked in the tree, the marker on a syntax error, and a cache
 * of editor states so switching between files keeps undo history, cursor and
 * scroll position.
 */

/** Marks selection changes the tree made, so they aren't echoed back to the tree. */
export const fromTree = Annotation.define();

/** Highlight a range ({ from, to }), or clear it (null). */
export const setNodeHighlight = StateEffect.define();

/** Mark a syntax error at an offset, or clear it (null). */
export const setErrorAt = StateEffect.define();

const nodeMark = Decoration.mark({ class: 'cm-json-node' });

// The highlight stays until the text changes or you move the cursor yourself.
const nodeHighlight = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setNodeHighlight)) {
        const range = effect.value;
        return range && range.to > range.from ? Decoration.set([nodeMark.range(range.from, range.to)]) : Decoration.none;
      }
    }
    if (tr.docChanged || (tr.selection && !tr.annotation(fromTree))) return Decoration.none;
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class ErrorPoint extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-json-error-point';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }
}

function errorDecorations(state, offset) {
  const at = Math.max(0, Math.min(offset, state.doc.length));
  const line = state.doc.lineAt(at);
  const ranges = [Decoration.line({ class: 'cm-json-error-line' }).range(line.from)];
  if (at < line.to) {
    // Underline the character, or both halves of an emoji.
    const code = state.doc.sliceString(at, at + 1).charCodeAt(0);
    const end = code >= 0xd800 && code <= 0xdbff && at + 2 <= line.to ? at + 2 : at + 1;
    ranges.push(Decoration.mark({ class: 'cm-json-error-mark' }).range(at, end));
  } else {
    // At the end of a line or of the document there is no character to underline.
    ranges.push(Decoration.widget({ widget: new ErrorPoint(), side: 1 }).range(at));
  }
  return Decoration.set(ranges, true);
}

// Kept in step with edits until the next parse replaces it.
const errorMarker = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setErrorAt)) return effect.value == null ? Decoration.none : errorDecorations(tr.state, effect.value);
    }
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Shared by every state, so a cached state can be re-themed and re-wired when it comes back.
const themeSlot = new Compartment();
const wrapSlot = new Compartment();
const listenerSlot = new Compartment();

const themeFor = (theme) => (theme === 'light' ? vscodeLight : vscodeDark);

/**
 * @param {string} text
 * @param {{ theme: string, wrap: boolean, onUpdate: (update) => void }} options
 */
export function createJsonState(text, { theme, wrap, onUpdate }) {
  return EditorState.create({
    doc: text,
    extensions: [
      // The same setup as the app's other editors.
      basicSetup({ autocompletion: false, crosshairCursor: false }),
      keymap.of([indentWithTab]),
      json(),
      jsonFolding(),
      placeholder('Paste or type JSON here, then press Beautify'),
      nodeHighlight,
      errorMarker,
      themeSlot.of(themeFor(theme)),
      wrapSlot.of(wrap ? EditorView.lineWrapping : []),
      listenerSlot.of(EditorView.updateListener.of(onUpdate)),
    ],
  });
}

/** Point a view (perhaps on a cached state) at the current theme, wrapping and listener. */
export function configureJsonView(view, { theme, wrap, onUpdate }) {
  const effects = [themeSlot.reconfigure(themeFor(theme)), wrapSlot.reconfigure(wrap ? EditorView.lineWrapping : [])];
  if (onUpdate) effects.push(listenerSlot.reconfigure(EditorView.updateListener.of(onUpdate)));
  view.dispatch({ effects });
}

/**
 * Show a value from the tree: scroll to it, open any fold hiding its start,
 * and either highlight it (the tree keeps focus) or select it (the editor
 * takes focus, so it can be copied or typed over).
 */
export function revealRange(view, from, to, { select = false } = {}) {
  const effects = [];
  foldedRanges(view.state).between(from, from, (a, b) => {
    if (a < from && from < b) effects.push(unfoldEffect.of({ from: a, to: b }));
  });
  effects.push(setNodeHighlight.of(select ? null : { from, to }));
  // Head at the start, so a value taller than the pane shows its first line.
  effects.push(EditorView.scrollIntoView(EditorSelection.range(to, from), { y: 'nearest', yMargin: 48 }));
  view.dispatch({
    selection: select ? EditorSelection.range(from, to) : EditorSelection.cursor(from),
    effects,
    annotations: fromTree.of(true),
  });
}

/** Put the cursor somewhere and scroll it to the middle. */
export function placeCursor(view, pos, { center = true } = {}) {
  const at = Math.max(0, Math.min(pos, view.state.doc.length));
  view.dispatch({
    selection: EditorSelection.cursor(at),
    effects: EditorView.scrollIntoView(at, { y: center ? 'center' : 'nearest' }),
  });
}

/* ------------------------------------------------------- state cache */

// Recently open files, most recent last. Big documents aren't kept: a few of
// them would hold a lot of memory just to save a re-render.
const MAX_CACHED = 8;
const MAX_CACHED_CHARS = 5_000_000;
const cache = new Map();

/** Remember a file's editor as it is now (just before the view goes away). */
export function stashJsonState(fileId, view) {
  cache.delete(fileId);
  if (view.state.doc.length > MAX_CACHED_CHARS) return;
  cache.set(fileId, { state: view.state, scroll: view.scrollSnapshot() });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}

/** A remembered editor for this file, if it still matches the saved text. */
export function takeJsonState(fileId, text) {
  const hit = cache.get(fileId);
  cache.delete(fileId);
  if (!hit || hit.state.doc.length !== text.length || hit.state.doc.toString() !== text) return null;
  return hit;
}

/** Drop remembered editors for files that no longer exist. */
export function pruneJsonStates(liveIds) {
  for (const id of [...cache.keys()]) if (!liveIds.has(id)) cache.delete(id);
}
