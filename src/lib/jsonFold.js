import { codeFolding } from '@codemirror/language';
import { describeFold } from './foldLabel.mjs';

/**
 * JSON folding that says what it hid: a folded array shows "3 items", a folded
 * object "5 keys", instead of a bare "…".
 */

export const jsonFolding = () =>
  codeFolding({
    preparePlaceholder: (state, range) =>
      describeFold(state.sliceDoc(range.from - 1, range.from), state.sliceDoc(range.from, range.to)),
    placeholderDOM: (_view, onclick, label) => {
      const el = document.createElement('span');
      el.className = 'cm-foldPlaceholder';
      el.textContent = ` ${label} `;
      el.title = 'Click to expand';
      el.onclick = onclick;
      return el;
    },
  });
