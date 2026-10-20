import { Chess, play, reviewLine, uciOf } from './chess.js';

export function randomFraction() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((words[0] >>> 5) * 67108864 + (words[1] >>> 6)) / 9007199254740992;
}

function fail(message, status = 422) {
  throw Object.assign(new Error(message), { status });
}

export function validateSettings(input) {
  const settings = { ratio_mode: 'random', puzzle_fraction: 0.5, anchor_rating: 1700, rating_margin: 300, ...input };
  if (!['fixed', 'random'].includes(settings.ratio_mode)
      || !Number.isFinite(settings.puzzle_fraction) || settings.puzzle_fraction < 0 || settings.puzzle_fraction > 1
      || !Number.isInteger(settings.anchor_rating) || settings.anchor_rating < 400 || settings.anchor_rating > 3500
      || !Number.isInteger(settings.rating_margin) || settings.rating_margin < 0 || settings.rating_margin > 1500) {
    fail('Check the puzzle probability, anchor rating, and margin.');
  }
  return settings;
}

export class Deck {
  constructor(pool, random = randomFraction) {
    this.pool = pool;
    this.random = random;
    this.remaining = [];
    this.last = null;
  }

  draw() {
    if (!this.pool.length) fail('No positions available in this group.');
    if (!this.remaining.length) {
      this.remaining = [...this.pool];
      for (let i = this.remaining.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.remaining[i], this.remaining[j]] = [this.remaining[j], this.remaining[i]];
      }
      if (this.remaining.length > 1 && this.remaining.at(-1) === this.last) {
        [this.remaining[0], this.remaining[this.remaining.length - 1]] = [this.remaining.at(-1), this.remaining[0]];
      }
    }
    this.last = this.remaining.pop();
    return this.last;
  }
}

export class Item {
  constructor(kind, source) {
    this.kind = kind;
    this.source = source;
    this.board = new Chess(source.fen);
    this.setupSan = play(this.board, source.moves[0]).san;
    this.initialFen = this.board.fen();
    this.orientation = this.board.turn() === 'w' ? 'white' : 'black';
    this.cursor = 1;
    this.attempted = false;
    this.result = null;
    this.complete = false;
    this.settled = false;
    this.history = [];
    this.feedback = null;
  }

  push(uci, actor) {
    const move = play(this.board, uci);
    const frame = { fen: this.board.fen(), uci, san: move.san, actor };
    this.history.push(frame);
    return frame;
  }

  move(uci) {
    if (this.complete) fail('This position is complete. Continue to the next one.', 409);
    const legal = this.board.moves({ verbose: true }).some((move) => uciOf(move) === uci);
    if (!legal) fail('Illegal move. The position has not been scored.');
    let correct, evaluation = null;
    if (this.kind === 'puzzle') correct = uci === this.source.moves[this.cursor];
    else {
      if (!Object.hasOwn(this.source.scores, uci)) fail('This position is missing a move grade; the attempt has not been scored.', 503);
      const score = this.source.scores[uci];
      const loss = typeof score === 'number' ? Math.max(0, this.source.best_cp - score) : null;
      correct = loss !== null && loss <= 50;
      evaluation = { loss_cp: loss, mate: typeof score === 'string' ? Number(score.slice(1)) : null };
    }
    this.attempted = true;
    if (!correct) {
      this.result = false;
      this.feedback = { status: 'wrong', evaluation };
      return [];
    }
    const animation = [this.push(uci, 'you')];
    if (this.kind === 'puzzle') {
      this.cursor++;
      if (this.cursor < this.source.moves.length) animation.push(this.push(this.source.moves[this.cursor++], 'opponent'));
      this.complete = this.cursor >= this.source.moves.length;
    } else this.complete = true;
    if (this.complete && this.result === null) this.result = true;
    this.feedback = { status: this.complete ? 'success' : 'continue', evaluation };
    return animation;
  }

  reveal() {
    if (this.result === null) this.result = false;
    this.attempted = true;
    this.complete = true;
    this.feedback = { status: 'revealed' };
  }

  view() {
    const dests = {}, promotions = {};
    if (!this.complete) {
      for (const move of this.board.moves({ verbose: true })) {
        const targets = dests[move.from] ||= [];
        if (!targets.includes(move.to)) targets.push(move.to);
        if (move.promotion) (promotions[move.from + move.to] ||= []).push(move.promotion);
      }
    }
    const state = {
      fen: this.board.fen(), initial_fen: this.initialFen,
      setup: { fen: this.source.fen, uci: this.source.moves[0], san: this.setupSan },
      orientation: this.orientation, turn: this.board.turn() === 'w' ? 'white' : 'black',
      check: this.board.isCheck(), last_move: uciOf(this.board.history({ verbose: true }).at(-1)),
      dests, promotions, history: this.history, complete: this.complete,
      attempted: this.attempted, result: this.result, feedback: this.feedback,
    };
    // UI concealment only: the complete client dataset is inspectable in DevTools.
    if (this.result !== null) {
      state.kind = this.kind;
      state.source_url = this.source.url || '';
      if (this.kind === 'puzzle') state.rating = this.source.rating;
    }
    if (this.complete) {
      const solution = this.kind === 'puzzle' ? this.source.moves.slice(1) : this.source.line;
      state.review = reviewLine(this.initialFen, solution);
    }
    return state;
  }
}

function countsView(counts) {
  return { ...counts, untouched: counts.presented - counts.attempted,
    success_ratio: counts.attempted ? counts.successes / counts.attempted : null };
}

export class Session {
  constructor(catalog, input, random = randomFraction, clock = () => performance.now()) {
    this.catalog = catalog;
    this.settings = validateSettings(input);
    this.random = random;
    this.clock = clock;
    this.started = clock();
    const puzzles = catalog.refs('puzzle', this.settings);
    if (!puzzles.length && (this.settings.ratio_mode === 'random' || this.settings.puzzle_fraction > 0)) {
      fail('No puzzles match anchor ± margin. Widen the margin.');
    }
    this.fraction = this.settings.ratio_mode === 'random' ? null : this.settings.puzzle_fraction;
    this.decks = { puzzle: new Deck(puzzles, random), ordinary: new Deck(catalog.refs('ordinary', this.settings), random) };
    this.counts = { puzzle: { presented: 0, attempted: 0, successes: 0 }, ordinary: { presented: 0, attempted: 0, successes: 0 } };
    this.revision = 0;
    this.current = null;
    this.pending = null;
  }

  reserveNext() {
    if (!this.pending) {
      // In random mode, redraw the hidden probability for every item. Marginally,
      // outcomes are independent Bernoulli(0.5), without a session-wide rate to infer.
      const fraction = this.fraction ?? this.random();
      const kind = this.random() < fraction ? 'puzzle' : 'ordinary';
      this.pending = { kind, ref: this.decks[kind].draw() };
    }
    return this.pending;
  }

  prefetch() {
    this.catalog.get(this.reserveNext().ref).catch(() => {});
  }

  async advance() {
    const pending = this.reserveNext();
    // Fetch/validate first: a network failure must not skip or score the current item,
    // choose another kind, increment the revision, or consume a new probability draw.
    const source = await this.catalog.get(pending.ref);
    const item = new Item(pending.kind, source);
    if (this.current) this.settle(true);
    this.current = item;
    this.counts[item.kind].presented++;
    this.pending = null;
    this.prefetch();
  }

  settle(skipping = false) {
    const item = this.current;
    if (item.settled) return;
    if (item.result === null && (item.attempted || skipping)) item.result = false;
    if (item.result !== null) {
      this.counts[item.kind].attempted++;
      this.counts[item.kind].successes += Number(item.result);
    }
    item.settled = true;
  }

  view(animation = []) {
    const { puzzle_fraction: _fraction, ...settings } = this.settings;
    if (this.settings.ratio_mode === 'fixed') settings.puzzle_fraction = this.fraction;
    return { revision: this.revision, settings, number: this.counts.puzzle.presented + this.counts.ordinary.presented,
      item: this.current.view(), animation };
  }

  summary() {
    this.settle();
    const overall = { presented: 0, attempted: 0, successes: 0 };
    for (const counts of Object.values(this.counts)) for (const key of Object.keys(overall)) overall[key] += counts[key];
    const { puzzle_fraction: _fraction, ...settings } = this.settings;
    return { ratio_mode: this.settings.ratio_mode, puzzle_fraction: this.fraction, settings,
      duration_seconds: Math.round((this.clock() - this.started) / 1000),
      puzzles: countsView(this.counts.puzzle), non_puzzles: countsView(this.counts.ordinary), overall: countsView(overall) };
  }
}

// One local controller per tab. The UI retains its async action interface, not a network API.
export function createController(loadCatalog, random = randomFraction) {
  let catalog, session = null, locked = false;
  const getCatalog = async () => catalog ||= await loadCatalog();
  return async function action(path, body) {
    if (locked) fail('An action is already in progress. Please wait.', 409);
    locked = true;
    try {
      if (path === 'info') {
        const { manifest } = await getCatalog();
        return { ready: true, puzzles: manifest.puzzles.count, ordinary_positions: manifest.ordinary.count,
          sampled_games: manifest.sampled_games, engine: manifest.engine, nodes: manifest.nodes };
      }
      if (path === 'session' && body !== undefined) {
        if (session) fail('Finish the active session before starting another.', 409);
        const next = new Session(await getCatalog(), body, random);
        await next.advance();
        session = next;
      } else if (!session) fail('No active session. Refreshing or closing the page clears it.', 404);
      else if (path !== 'session') {
        if (body?.revision !== session.revision) fail('This action is stale. The position has not changed.', 409);
        let animation = [];
        if (path === 'session/move') animation = session.current.move(body.uci);
        else if (path === 'session/reveal') session.current.reveal();
        else if (path === 'session/next') await session.advance();
        else if (path === 'session/finish') {
          const summary = session.summary();
          session = null;
          return summary;
        } else fail('Unknown action.', 404);
        session.revision++;
        return structuredClone(session.view(animation));
      }
      return structuredClone(session.view());
    } finally { locked = false; }
  };
}
