import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../web/chess.js';
import { createController, Deck, Item, Session, randomFraction, validateSettings } from '../web/session.js';
import { FakeCatalog, ordinary, puzzle, settings } from './fixtures.js';

const controller = (catalog = new FakeCatalog(), random = () => 0.4) => createController(async () => catalog, random);
const start = (api, fraction = 1) => api('session', settings(fraction));
const action = (api, name, state, extra = {}) => api(`session/${name}`, { revision: state.revision, ...extra });

test('complete puzzle, automatic replies, review, and cleanup', async () => {
  const api = controller();
  let state = await start(api);
  assert.equal(state.item.kind, undefined);
  assert.equal(state.item.review, undefined);
  state = await action(api, 'move', state, { uci: 'e7e5' });
  assert.deepEqual(state.animation.map((frame) => frame.uci), ['e7e5', 'g1f3']);
  assert.equal(state.item.result, null);
  assert.equal(state.item.kind, undefined);
  state = await action(api, 'move', state, { uci: 'b8c6' });
  assert.equal(state.item.result, true);
  assert.deepEqual(state.item.review.san, ['e5', 'Nf3', 'Nc6']);
  const summary = await action(api, 'finish', state);
  assert.equal(summary.puzzles.success_ratio, 1);
  assert.equal(summary.non_puzzles.success_ratio, null);
  await assert.rejects(api('session'), { status: 404 });
});

test('wrong move followed by successful retries stays unsuccessful', async () => {
  const api = controller();
  let state = await start(api);
  state = await action(api, 'move', state, { uci: 'c7c5' });
  assert.equal(state.item.result, false);
  assert.deepEqual(state.item.history, []);
  state = await action(api, 'move', state, { uci: 'e7e5' });
  state = await action(api, 'move', state, { uci: 'b8c6' });
  assert.equal(state.item.complete, true);
  assert.equal(state.item.result, false);
  const summary = await action(api, 'finish', state);
  assert.equal(summary.overall.attempted, 1);
  assert.equal(summary.overall.successes, 0);
});

for (const [uci, score, expected] of [['e7e5', 20, true], ['c7c5', -30, true], ['b8c6', -31, false], ['f7f6', 'M-3', false]]) {
  test(`ordinary move ${uci}: 0.5-pawn boundary / mate`, async () => {
    const source = ordinary();
    source.scores[uci] = score;
    const api = controller(new FakeCatalog([puzzle], [source]));
    let state = await start(api, 0);
    state = await action(api, 'move', state, { uci });
    assert.equal(state.item.result, expected);
    if (!expected) state = await action(api, 'move', state, { uci: 'e7e5' });
    const summary = await action(api, 'finish', state);
    assert.equal(summary.non_puzzles.successes, Number(expected));
    assert.equal(summary.non_puzzles.attempted, 1);
  });
}

for (const uci of ['e2e4', 'e2e2', '0000', 'e7e6q', 'bogus']) {
  test(`illegal input ${uci} does not score or change revision`, async () => {
    const api = controller();
    const state = await start(api);
    await assert.rejects(action(api, 'move', state, { uci }), { status: 422 });
    const current = await api('session');
    assert.deepEqual(current, state);
    const summary = await action(api, 'finish', current);
    assert.equal(summary.overall.attempted, 0);
  });
}

test('untouched is excluded, partial correct puzzle counts as unsuccessful', async () => {
  const api = controller();
  let state = await start(api);
  let summary = await action(api, 'finish', state);
  assert.equal(summary.overall.presented, 1);
  assert.equal(summary.overall.untouched, 1);
  assert.equal(summary.overall.success_ratio, null);
  state = await start(api);
  state = await action(api, 'move', state, { uci: 'e7e5' });
  summary = await action(api, 'finish', state);
  assert.equal(summary.overall.attempted, 1);
  assert.equal(summary.overall.success_ratio, 0);
});

test('skips, repeated reveal, and untouched position count once each', async () => {
  const api = controller();
  let state = await action(api, 'next', await start(api));
  state = await action(api, 'reveal', state);
  state = await action(api, 'reveal', state);
  state = await action(api, 'next', state);
  const summary = await action(api, 'finish', state);
  assert.deepEqual(summary.puzzles, { presented: 3, attempted: 2, successes: 0, untouched: 1, success_ratio: 0 });
});

test('random fraction sampled once, concealed in views, revealed only on finish', async () => {
  const random = () => 0.374;
  const api = controller(new FakeCatalog(), random);
  let state = await api('session', { ...settings(), ratio_mode: 'random' });
  for (let i = 0; i < 6; i++) {
    assert.equal(state.settings.puzzle_fraction, undefined);
    assert.equal(state.item.kind, undefined);
    assert.equal(state.item.review, undefined);
    state = await action(api, 'next', state);
  }
  const summary = await action(api, 'finish', state);
  assert.equal(summary.puzzle_fraction, 0.374);
  assert.equal(summary.overall.presented, 7);
  assert.equal(summary.overall.attempted, 6);
});

test('both group ratios and weighted overall ratio', async () => {
  const values = [0.1, 0.9, 0.1, 0.9];
  const api = controller(new FakeCatalog(), () => values.shift() ?? 0.9);
  let state = await start(api, 0.5);
  state = await action(api, 'move', state, { uci: 'e7e5' });
  state = await action(api, 'move', state, { uci: 'b8c6' });
  state = await action(api, 'next', state);
  state = await action(api, 'move', state, { uci: 'e7e5' });
  state = await action(api, 'next', state);
  state = await action(api, 'reveal', state);
  const summary = await action(api, 'finish', state);
  assert.equal(summary.puzzles.success_ratio, 0.5);
  assert.equal(summary.non_puzzles.success_ratio, 1);
  assert.equal(summary.overall.success_ratio, 2 / 3);
});

test('stale or concurrent duplicate actions cannot double score', async () => {
  const api = controller();
  const state = await start(api);
  const results = await Promise.allSettled([
    action(api, 'move', state, { uci: 'e7e5' }), action(api, 'move', state, { uci: 'e7e5' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409);
  assert.equal((await api('session')).item.history.length, 2);
  await assert.rejects(start(api), { status: 409 });
});

test('no hidden storage: new controller represents a reload and has no session', async () => {
  const api = controller();
  await start(api);
  await assert.rejects(controller()('session'), { status: 404 });
  assert.equal((await api('session')).number, 1);
});

test('failed next fetch retains current item, score, revision, and reserved draw', async () => {
  const catalog = new FakeCatalog();
  let fail = false, draws = 0;
  const originalGet = catalog.get;
  catalog.get = async (ref) => {
    if (fail) throw new Error('offline');
    return originalGet.call(catalog, ref);
  };
  const session = new Session(catalog, settings(), () => { draws++; return 0.2; });
  await session.advance();
  const before = structuredClone(session.view());
  const pending = session.pending;
  const beforeDraws = draws;
  fail = true;
  await assert.rejects(session.advance(), /offline/);
  assert.deepEqual(session.view(), before);
  assert.equal(session.pending, pending);
  assert.equal(draws, beforeDraws);
  fail = false;
  await session.advance();
  assert.equal(session.view().number, 2);
  assert.equal(session.counts.puzzle.attempted, 1);
});

test('missing grade fails before marking an attempt', () => {
  const source = ordinary();
  delete source.scores.f7f6;
  const item = new Item('ordinary', source);
  assert.throws(() => item.move('f7f6'), { status: 503 });
  assert.equal(item.attempted, false);
});

for (const [fen, setup, best, square, piece] of [
  ['r3k2r/ppp2ppp/8/8/8/8/PPP2PPP/R3K2R b KQkq - 0 1', 'h7h6', ['e1g1', 'e1c1'], 'f1', 'r'],
  ['6k1/3p4/8/4P3/8/8/8/6K1 b - - 0 1', 'd7d5', ['e5d6', 'g1f1'], 'd6', 'p'],
  ['7k/P7/8/8/8/8/8/6K1 b - - 0 1', 'h8h7', ['a7a8n', 'a7a8q'], 'a8', 'n'],
]) {
  test(`special move: ${best[0]}`, () => {
    const item = new Item('ordinary', ordinary(fen, setup, best));
    if (best[0].length === 5) assert.deepEqual(new Set(item.view().promotions.a7a8), new Set('qrbn'));
    item.move(best[0]);
    assert.equal(item.result, true);
    assert.equal(new Chess(item.view().fen).get(square).type, piece);
  });
}

test('decks exhaust before repeats and avoid a boundary repeat', () => {
  const deck = new Deck(['a', 'b', 'c'], () => 0.4);
  const first = [deck.draw(), deck.draw(), deck.draw()];
  assert.equal(new Set(first).size, 3);
  assert.notEqual(deck.draw(), first.at(-1));
});

test('exact rating interval and zero-puzzle endpoint', async () => {
  const catalog = new FakeCatalog([{ ...puzzle, rating: 2400 }]);
  const api = controller(catalog);
  await assert.rejects(start(api), /No puzzles match/);
  const state = await start(api, 0);
  assert.equal(state.settings.puzzle_fraction, 0);
});

for (const input of [{ puzzle_fraction: -1 }, { puzzle_fraction: 1.1 }, { puzzle_fraction: NaN },
  { ratio_mode: 'maybe' }, { rating_margin: -1 }, { anchor_rating: 399 }, { anchor_rating: 1700.5 }]) {
  test(`invalid settings: ${JSON.stringify(input)}`, () => assert.throws(() => validateSettings(input), { status: 422 }));
}

test('cryptographic fraction stays in [0, 1)', () => {
  for (let i = 0; i < 100; i++) {
    const fraction = randomFraction();
    assert(fraction >= 0 && fraction < 1);
  }
});
