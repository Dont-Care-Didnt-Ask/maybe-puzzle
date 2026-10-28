import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyThemes, BOARD_THEMES, PIECE_THEMES } from '../web/themes.js';

function root() {
  const properties = new Map();
  return { dataset: {}, properties, style: {
    setProperty: (key, value) => properties.set(key, value),
    removeProperty: (key) => properties.delete(key),
  } };
}

test('themes use local subpath-safe assets and restore the existing defaults', () => {
  const element = root();
  const base = 'https://example.test/chess-puzzle-not-puzzle/';
  for (const board of Object.keys(BOARD_THEMES)) for (const pieces of PIECE_THEMES) {
    applyThemes(board, pieces, element, base);
    assert.equal(element.dataset.boardTheme, board);
    assert.equal(element.dataset.pieceTheme, pieces);
    if (pieces !== 'cburnett') {
      assert.equal(element.properties.get('--piece-wK'), `url("${base}themes/pieces/${pieces}/wK.svg")`);
      for (const color of 'wb') for (const role of 'KQRBNP') {
        const svg = fs.readFileSync(`public/themes/pieces/${pieces}/${color}${role}.svg`, 'utf8');
        assert.match(svg, /<svg/);
        assert.doesNotMatch(svg, /<script|<image|href="https?:/);
      }
    }
  }
  applyThemes('brown', 'cburnett', element, base);
  assert.equal(element.properties.size, 0);
  assert.throws(() => applyThemes('pink', 'cburnett', element, base), /Unknown/);
  assert.throws(() => applyThemes('brown', '../other', element, base), /Unknown/);
});
