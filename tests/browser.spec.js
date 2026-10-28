import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import { Chess, play as chessMove } from '../web/chess.js';
import { makeAssets } from './data-fixtures.js';
import { ordinary, puzzle, START } from './fixtures.js';

const directory = 'dist/training';
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
function initialFen(record) {
  const board = new Chess(record.fen);
  chessMove(board, record.moves[0]);
  return board.fen();
}
let errors, forbidden, requests;
function sourceFor(kind, fen) {
  const group = manifest[kind === 'puzzle' ? 'puzzles' : 'ordinary'];
  const fetched = new Set(requests.map((url) => path.basename(url)));
  for (const shard of group.shards) {
    if (!fetched.has(shard.file)) continue;
    const records = JSON.parse(new TextDecoder().decode(gunzipSync(fs.readFileSync(path.join(directory, shard.file)))));
    const record = records.find((record) => initialFen(record) === fen);
    if (record) return record;
  }
}

test.beforeEach(async ({ page }) => {
  errors = []; forbidden = []; requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  page.on('request', (request) => {
    if (!request.url().startsWith('http')) return;
    const url = new URL(request.url());
    requests.push(url.pathname);
    if (url.origin !== 'http://127.0.0.1:8765'
        || !url.pathname.startsWith('/chess-puzzle-not-puzzle/')
        || /\/api\/|\.wasm|\.nnue/.test(url.pathname)) forbidden.push(request.url());
  });
});
test.afterEach(() => { expect(errors).toEqual([]); expect(forbidden).toEqual([]); });

async function start(page, fraction = null) {
  await page.goto('./');
  await expect(page.locator('#start')).toBeEnabled();
  if (fraction !== null) {
    await page.locator('[name=ratio_mode][value=fixed]').check();
    await page.locator('#fraction').evaluate((input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(fraction));
  }
  await page.locator('#start').click();
  await expect(page.locator('#training')).toBeVisible();
  await expect(page.locator('#next')).toBeEnabled();
  return page.locator('#board').getAttribute('data-fen');
}

async function play(page, uci) {
  await page.locator('#uci-move').fill(uci);
  await page.locator('#play-move').click();
  await expect(page.locator('#next')).toBeEnabled();
}

async function clickMove(page, uci) {
  await page.locator('#board').scrollIntoViewIfNeeded();
  const box = await page.locator('#board').boundingBox();
  const orientation = await page.locator('#board').getAttribute('data-orientation');
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  for (const square of [uci.slice(0, 2), uci.slice(2, 4)]) {
    const file = square.charCodeAt(0) - 97, rank = Number(square[1]) - 1;
    const column = orientation === 'white' ? file : 7 - file;
    const row = orientation === 'white' ? 7 - rank : rank;
    const x = box.x + (column + 0.5) * box.width / 8, y = box.y + (row + 0.5) * box.height / 8;
    if (touch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  }
}

async function fixtureRoutes(page, assets, block = () => false) {
  await page.route('**/training/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    if (block(name)) { await route.abort(); return; }
    const bytes = assets.files.get(name);
    await route.fulfill(bytes ? { status: 200, body: Buffer.from(bytes),
      contentType: name.endsWith('.gz') ? 'application/gzip' : 'application/json' } : { status: 404 });
  });
}

test('startup is lazy, subpath-safe, and stores no session data', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#start')).toBeEnabled();
  expect(requests.filter((url) => url.endsWith('.json.gz'))).toHaveLength(0);
  expect(requests.filter((url) => url.endsWith('/manifest.json'))).toHaveLength(1);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })))
    .toEqual({ local: 0, session: 0, cookies: '' });
  const source = await page.request.head('./source.zip');
  expect(source.ok()).toBeTruthy();
  const files = [];
  // Read only ZIP headers; don't inflate a second copy of millions of puzzles.
  unzipSync(fs.readFileSync('dist/source.zip'), { filter: (file) => { files.push(file.name); return false; } });
  expect(files).toContain('chess-puzzle-not-puzzle/web/session.js');
  expect(files).toContain('chess-puzzle-not-puzzle/export_static.py');
  expect(files.some((file) => /static-checkpoints|games\.pgn|\/cache\//.test(file))).toBe(false);
  const licenses = await page.request.get('./licenses.txt');
  expect(licenses.ok()).toBeTruthy();
  expect(await licenses.text()).toContain('Jeff Hlywa');
  await page.goto('./index.html');
  await expect(page.locator('#start')).toBeEnabled();
});

test('ordinary position: board input, immediate grade, next, and finish', async ({ page }) => {
  const fen = await start(page, 0);
  await expect(page.locator('#item-info')).toBeHidden();
  const source = sourceFor('ordinary', fen);
  expect(source).toBeTruthy();
  await clickMove(page, source.line[0]);
  if (source.line[0].length === 5) {
    const names = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
    await page.getByRole('button', { name: names[source.line[0][4]], exact: true }).click();
  }
  await expect(page.locator('#feedback')).toContainText('Well played.');
  await expect(page.locator('#next')).toBeEnabled();
  await page.locator('#next').click();
  await expect(page.locator('#position-number')).toHaveText('Position 2');
  await expect(page.locator('#finish')).toBeEnabled();
  await page.locator('#finish').click();
  await expect(page.locator('#summary')).toBeVisible();
  await expect(page.locator('#overall-rate')).toHaveText('100.0%');
  await expect(page.locator('#summary-rows tr').nth(1)).toContainText('1 / 1');
  await expect(page.locator('#summary-note')).toContainText('1 untouched');
  expect(requests.filter((url) => url.endsWith('.json.gz')).length).toBeLessThanOrEqual(3);
});

test('real puzzle: complete line, automatic replies, replay, and summary', async ({ page }) => {
  const fen = await start(page, 100);
  const source = sourceFor('puzzle', fen);
  expect(source).toBeTruthy();
  for (let cursor = 1; cursor < source.moves.length; cursor += 2) await play(page, source.moves[cursor]);
  await expect(page.locator('#feedback')).toContainText('Well played.');
  await expect(page.locator('#review')).toBeVisible();
  await page.locator('#review-start').click();
  await expect(page.locator('#review-start')).toHaveText(`0 / ${source.moves.length - 1} · Restart`);
  await page.locator('#review-forward').click();
  await expect(page.locator('#review-start')).toHaveText(`1 / ${source.moves.length - 1} · Restart`);
  await page.locator('#finish').click();
  await expect(page.locator('#overall-rate')).toHaveText('100.0%');
});

test('the complete catalog supports an exact 2400 rating session', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#start')).toBeEnabled();
  await page.locator('[name=ratio_mode][value=fixed]').check();
  await page.locator('#fraction').evaluate((input) => { input.value = '100'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#anchor').fill('2400');
  await page.locator('#margin').fill('0');
  await page.locator('#start').click();
  await expect(page.locator('#training')).toBeVisible();
  await expect(page.locator('#next')).toBeEnabled();
  const source = sourceFor('puzzle', await page.locator('#board').getAttribute('data-fen'));
  expect(source.rating).toBe(2400);
  await expect(page.locator('#item-info')).toBeHidden();
  await page.locator('#reveal').click();
  await expect(page.locator('#item-info')).toContainText('2400');
});

test('random fraction stays out of the UI until finish; reload starts fresh', async ({ page }) => {
  await start(page);
  await expect(page.locator('#session-mixture')).toHaveText('Puzzle probability: hidden until you finish');
  await page.locator('#finish').click();
  await expect(page.locator('#revealed-fraction')).toHaveText('Varies');
  await expect(page.locator('#overall-rate')).toHaveText('—');
  await page.locator('#again').click();
  await expect(page.locator('#setup')).toBeVisible();
  await page.locator('#start').click();
  await expect(page.locator('#finish')).toBeEnabled();
  await page.reload();
  await expect(page.locator('#setup')).toBeVisible();
  await expect(page.locator('#training')).toBeHidden();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test('reveal and skip count as failures; mobile layout fits', async ({ page }) => {
  await start(page, 100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#reveal').click();
  await expect(page.locator('#feedback')).toContainText('Solution revealed');
  await expect(page.locator('#next')).toBeEnabled();
  await page.locator('#next').click();
  await expect(page.locator('#position-number')).toHaveText('Position 2');
  await expect(page.locator('#next')).toBeEnabled();
  await page.locator('#next').click();
  await expect(page.locator('#position-number')).toHaveText('Position 3');
  await expect(page.locator('#finish')).toBeEnabled();
  await page.locator('#finish').click();
  await expect(page.locator('#summary-rows tr').first()).toContainText('0 / 2');
  await expect(page.locator('#overall-rate')).toHaveText('0.0%');
});

test('drag artwork and destination circle are touch-only, including flipped boards', async ({ page, context }) => {
  await fixtureRoutes(page, makeAssets([puzzle], [ordinary()]));
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0);
  const client = touch ? await context.newCDPSession(page) : null;
  for (const flipped of [false, true]) {
    await start(page, 0);
    if (flipped) await page.locator('#flip').click();
    await page.locator('#board').scrollIntoViewIfNeeded();
    const board = page.locator('#board');
    const box = await board.boundingBox();
    const white = await board.getAttribute('data-orientation') === 'white';
    const center = (rank) => ({
      x: box.x + ((white ? 4 : 3) + 0.5) * box.width / 8,
      y: box.y + ((white ? 8 - rank : rank - 1) + 0.5) * box.height / 8,
    });
    const from = center(7), to = center(5);
    if (touch) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
    } else {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 5 });
    }
    const piece = board.locator('piece.dragging');
    await expect(piece).toHaveCount(1);
    const target = board.locator('.touch-drag-target');
    if (touch) {
      await expect(board).toHaveClass(/touch-dragging/);
      await expect(target).toBeVisible();
      const circle = await target.boundingBox();
      expect(circle.x + circle.width / 2).toBeCloseTo(to.x, 0);
      expect(circle.y + circle.height / 2).toBeCloseTo(to.y, 0);
      expect(circle.width / (box.width / 8)).toBeCloseTo(Math.SQRT2, 2);
      const artwork = await piece.evaluate((el) => {
        const style = getComputedStyle(el, '::after');
        return { width: parseFloat(style.width), pieceWidth: el.getBoundingClientRect().width };
      });
      expect(artwork.width / artwork.pieceWidth).toBeCloseTo(2, 2);
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x - 5, y: to.y }] });
      await expect(target).toBeHidden();
      if (flipped) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await expect(board).not.toHaveClass(/touch-dragging/);
        await expect(board.locator('piece.dragging')).toHaveCount(0);
        await expect(page.locator('#feedback')).toContainText('Your turn');
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      }
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
      await expect(target).toBeVisible();
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await expect(board).not.toHaveClass(/touch-dragging/);
      await expect(target).toBeHidden();
      await page.mouse.up();
    }
    await expect(target).toBeHidden();
    await expect(board).not.toHaveClass(/touch-dragging/);
    await expect(page.locator('#feedback')).toContainText('Well played.');
  }
});

test('promotion dialog supports underpromotion without an engine', async ({ page }) => {
  const source = ordinary('7k/P7/8/8/8/8/8/6K1 b - - 0 1', 'h8h7', ['a7a8n', 'a7a8q']);
  await fixtureRoutes(page, makeAssets([puzzle], [source]));
  await start(page, 0);
  await clickMove(page, 'a7a8');
  await expect(page.locator('#promotion-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Knight', exact: true }).click();
  await expect(page.locator('#feedback')).toContainText('Well played.');
  expect(new Chess(await page.locator('#board').getAttribute('data-fen')).get('a8').type).toBe('n');
});

test('failed shard fetch does not skip, resample, or lose the current position', async ({ page }) => {
  const one = ordinary(START, 'd2d4', ['d7d5', 'g8f6']);
  const two = { ...ordinary(START, 'c2c4', ['e7e5', 'c7c5']), id: 'two' };
  const assets = makeAssets([puzzle], [one, two], 1);
  let first = null, blocked = true;
  const failures = new Set();
  await fixtureRoutes(page, assets, (name) => {
    if (!name.endsWith('.gz')) return false;
    first ||= name;
    if (name !== first && blocked) { failures.add(name); return true; }
    return false;
  });
  const fen = await start(page, 0);
  await page.locator('#next').click();
  await expect(page.locator('#error')).toBeVisible();
  await expect(page.locator('#position-number')).toHaveText('Position 1');
  expect(await page.locator('#board').getAttribute('data-fen')).toBe(fen);
  expect(failures.size).toBe(1);
  blocked = false;
  await expect(page.locator('#next')).toBeEnabled();
  await page.locator('#next').click();
  await expect(page.locator('#position-number')).toHaveText('Position 2');
  await expect(page.locator('#finish')).toBeEnabled();
  await page.locator('#finish').click();
  await expect(page.locator('#summary-rows tr').nth(1)).toContainText('0 / 1');
});
