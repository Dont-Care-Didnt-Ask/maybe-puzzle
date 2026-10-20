import { Chessground } from '@lichess-org/chessground';
import { Catalog } from './catalog.js';
import { createController } from './session.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, motion ? ms : 0));
let state = null;
let ground = null;
let busy = false;
let ready = false;
let flipped = false;
let reviewIndex = null;

const api = createController(() => Catalog.load());

function showScreen(name) {
  for (const screen of ['setup', 'training', 'summary']) $(screen).hidden = screen !== name;
}

function showError(error) {
  $('error').textContent = error?.message || String(error);
  $('error').hidden = false;
}

function clearError() { $('error').hidden = true; }
function percent(ratio, digits = 1) { return ratio === null ? '—' : `${(100 * ratio).toFixed(digits)}%`; }
function turn(fen) { return fen.split(' ')[1] === 'w' ? 'white' : 'black'; }
function squares(uci) { return uci ? [uci.slice(0, 2), uci.slice(2, 4)] : undefined; }

function setBusy(value) {
  busy = value;
  $('start').disabled = busy || !ready;
  if (!state) return;
  const complete = state.item.complete;
  for (const id of ['next', 'finish', 'flip']) $(id).disabled = busy;
  $('reveal').disabled = busy || complete;
  $('play-move').disabled = busy || complete;
  $('uci-move').disabled = busy || complete;
  for (const button of $('review').querySelectorAll('button')) button.disabled = busy;
  if (ground) ground.set({ movable: {
    color: !busy && !complete && reviewIndex === null ? state.item.orientation : undefined,
    dests: !busy && !complete && reviewIndex === null
      ? new Map(Object.entries(state.item.dests)) : new Map(),
  } });
}

function boardPosition(fen, lastMove, { check = false } = {}) {
  const orientation = flipped
    ? (state.item.orientation === 'white' ? 'black' : 'white') : state.item.orientation;
  ground.set({ fen, orientation, turnColor: turn(fen), lastMove: squares(lastMove), check });
  // Board-only metadata for accessibility tooling/debugging; never session secrets.
  $('board').dataset.fen = fen;
  $('board').dataset.orientation = orientation;
}

function makeBoard() {
  if (ground) return;
  ground = Chessground($('board'), {
    coordinates: true,
    animation: { enabled: motion, duration: 220 },
    movable: { free: false, rookCastle: false, events: {
      after: (origin, target) => submitMove(origin + target),
    } },
    premovable: { enabled: false },
    drawable: { enabled: true },
    disableContextMenu: true,
  });
}

function renderSidebar() {
  const item = state.item;
  $('position-number').textContent = `Position ${state.number}`;
  $('side-to-move').textContent = item.complete
    ? 'Position complete' : `${item.orientation === 'white' ? 'White' : 'Black'} to move`;
  const settings = state.settings;
  $('session-mixture').textContent = settings.ratio_mode === 'random'
    ? 'Puzzle probability: hidden until you finish'
    : `Puzzle probability: ${percent(settings.puzzle_fraction, 0)}`;
  $('session-difficulty').textContent = `Puzzle rating: ${settings.anchor_rating} ± ${settings.rating_margin}`;
  $('next').textContent = item.complete ? 'Next position →' : 'Skip position →';
  $('reveal').hidden = item.complete;
  $('played-moves').textContent = item.history.map((frame) => frame.san).join('  ');

  const status = item.feedback?.status;
  let heading = 'Your turn';
  let message = 'Click or drag a piece to move, or enter a move below the board.';
  if (status === 'continue') {
    heading = 'Keep calculating';
    message = 'Good move. Now find your next move.';
  } else if (status === 'wrong') {
    heading = 'Not quite. Try again.';
    message = 'This attempt is unsuccessful. You can retry or view the solution.';
    const evaluation = item.feedback.evaluation;
    if (evaluation?.loss_cp !== null && evaluation?.loss_cp !== undefined) {
      message = `That move loses ${(evaluation.loss_cp / 100).toFixed(2)} pawns relative to the best move. Retry for practice; the first-attempt score stands.`;
    } else if (evaluation?.mate < 0) {
      message = 'That move allows a forced mate. You can retry for practice; the first-attempt score stands.';
    }
  } else if (status === 'success') {
    heading = item.result ? 'Well played.' : 'Line completed.';
    message = item.result
      ? (item.kind === 'puzzle' ? 'You found the complete solution.' : 'A sound move — no more than 0.5 pawns below the best evaluation.')
      : 'Good recovery. The first-attempt result remains unsuccessful.';
  } else if (status === 'revealed') {
    heading = item.result ? 'Solution review' : 'Solution revealed';
    message = item.result ? 'Review the line below.' : 'This attempt is unsuccessful. Review the line, then continue.';
  }
  $('feedback').className = `feedback ${status || ''}`;
  $('feedback').replaceChildren();
  const title = document.createElement('strong');
  title.textContent = heading;
  const detail = document.createElement('p');
  detail.textContent = message;
  $('feedback').append(title, detail);

  $('item-info').hidden = !item.kind;
  $('item-info').replaceChildren();
  if (item.kind) {
    $('item-info').append(document.createTextNode(item.kind === 'puzzle'
      ? `Lichess puzzle · ${item.rating}` : 'Ordinary game position'));
    if (item.source_url?.startsWith('https://lichess.org/')) {
      const link = document.createElement('a');
      link.href = item.source_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Source ↗';
      $('item-info').append(document.createTextNode(' · '), link);
    }
  }

  $('review').hidden = !item.review;
  $('solution-moves').replaceChildren();
  if (item.review) {
    $('review-label').textContent = item.kind === 'puzzle' ? 'Published solution' : 'One good line';
    item.review.san.forEach((san, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = san;
      button.title = `Review through ${san}`;
      button.addEventListener('click', () => review(index + 1));
      $('solution-moves').append(button);
    });
  }
  $('review-start').textContent = 'Replay line';
}

async function displaySession(next, { newItem = false, animate = false } = {}) {
  state = next;
  reviewIndex = null;
  if (newItem) flipped = false;
  showScreen('training');
  makeBoard();
  setBusy(true);
  renderSidebar();
  if (newItem) {
    $('training').scrollIntoView({ block: 'start', behavior: 'instant' });
    boardPosition(state.item.setup.fen, null);
    await pause(350);
    boardPosition(state.item.initial_fen, state.item.setup.uci);
    await pause(260);
  } else if (animate) {
    for (const frame of state.animation) {
      boardPosition(frame.fen, frame.uci);
      await pause(frame.actor === 'you' ? 280 : 240);
    }
  }
  boardPosition(state.item.fen, state.item.last_move, { check: state.item.check });
}

async function recover(error) {
  // Never blindly retry an action: it may have succeeded before a network error.
  try {
    await displaySession(await api('session'));
  } catch (refreshError) {
    if (refreshError.status === 404) {
      state = null;
      showScreen('setup');
    }
  }
  showError(error);
}

async function act(action, extra = {}) {
  if (busy || !state) return;
  clearError();
  setBusy(true);
  try {
    const next = await api(`session/${action}`, { revision: state.revision, ...extra });
    if (action === 'finish') {
      state = null;
      showSummary(next);
    } else {
      await displaySession(next, { newItem: action === 'next', animate: action === 'move' });
      if (action === 'reveal') review(0);
    }
  } catch (error) {
    await recover(error);
  } finally {
    setBusy(false);
  }
}

function choosePromotion(options) {
  const dialog = $('promotion-dialog');
  const roles = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
  const glyphs = state.item.orientation === 'white'
    ? { q: '♕', r: '♖', b: '♗', n: '♘' } : { q: '♛', r: '♜', b: '♝', n: '♞' };
  $('promotion-options').replaceChildren();
  for (const symbol of ['q', 'r', 'b', 'n'].filter((role) => options.includes(role))) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyphs[symbol];
    button.setAttribute('aria-label', roles[symbol]);
    button.addEventListener('click', () => dialog.close(symbol));
    $('promotion-options').append(button);
  }
  return new Promise((resolve) => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue || null), { once: true });
    dialog.showModal();
  });
}

async function submitMove(uci) {
  if (busy || !state || state.item.complete) return;
  const promotions = state.item.promotions[uci.slice(0, 4)];
  if (promotions && uci.length === 4) {
    setBusy(true);
    const symbol = await choosePromotion(promotions);
    setBusy(false);
    if (!symbol) {
      boardPosition(state.item.fen, state.item.last_move, { check: state.item.check });
      return;
    }
    uci += symbol;
  }
  $('uci-move').value = '';
  await act('move', { uci });
}

function review(index) {
  if (!state?.item.review || (busy && index !== 0)) return;
  const line = state.item.review;
  reviewIndex = Math.max(0, Math.min(index, line.moves.length));
  boardPosition(reviewIndex ? line.frames[reviewIndex - 1] : line.initial_fen,
    reviewIndex ? line.moves[reviewIndex - 1] : state.item.setup.uci);
  $('side-to-move').textContent = 'Solution review';
  $('review-start').textContent = `${reviewIndex} / ${line.moves.length} · Restart`;
  [...$('solution-moves').children].forEach((button, i) => button.classList.toggle('current', i === reviewIndex - 1));
}

function showSummary(summary) {
  showScreen('summary');
  $('overall-rate').textContent = percent(summary.overall.success_ratio);
  $('revealed-fraction').textContent = summary.ratio_mode === 'random'
    ? 'Varies' : percent(summary.puzzle_fraction, 2);
  $('fraction-caption').textContent = summary.ratio_mode === 'random'
    ? 'Puzzle chance varies each item' : 'Configured puzzle probability';
  const seconds = summary.duration_seconds;
  $('session-duration').textContent = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  $('summary-rows').replaceChildren();
  for (const [label, counts] of [['Puzzles', summary.puzzles], ['Non-puzzles', summary.non_puzzles], ['Overall', summary.overall]]) {
    const row = document.createElement('tr');
    for (const value of [label, counts.presented, `${counts.successes} / ${counts.attempted}`, percent(counts.success_ratio)]) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    }
    $('summary-rows').append(row);
  }
  $('summary-note').textContent = `${summary.overall.untouched} untouched position(s) excluded from scoring. `
    + `Observed puzzle share: ${percent(summary.puzzles.presented / summary.overall.presented)}.`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function settingsChanged() {
  $('fixed-controls').hidden = document.querySelector('[name=ratio_mode]:checked').value !== 'fixed';
  $('fraction-output').value = `${$('fraction').value}%`;
  const anchor = Number($('anchor').value), margin = Number($('margin').value);
  $('rating-range').textContent = `Lichess puzzle ratings ${anchor - margin}–${anchor + margin}`;
}

$('settings-form').addEventListener('input', settingsChanged);
$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !ready) return;
  clearError();
  const settings = {
    ratio_mode: document.querySelector('[name=ratio_mode]:checked').value,
    puzzle_fraction: Number($('fraction').value) / 100,
    anchor_rating: Number($('anchor').value),
    rating_margin: Number($('margin').value),
  };
  setBusy(true);
  try {
    await displaySession(await api('session', settings), { newItem: true });
  } catch (error) {
    if (error.status === 409 || !error.status) await recover(error);
    else showError(error);
  } finally { setBusy(false); }
});
$('move-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const uci = $('uci-move').value.trim().toLowerCase();
  if (uci) submitMove(uci);
});
$('next').addEventListener('click', () => act('next'));
$('reveal').addEventListener('click', () => act('reveal'));
$('finish').addEventListener('click', () => act('finish'));
$('flip').addEventListener('click', () => {
  if (busy || !state) return;
  flipped = !flipped;
  ground.toggleOrientation();
  $('board').dataset.orientation = ground.state.orientation;
});
$('review-start').addEventListener('click', () => review(0));
$('review-back').addEventListener('click', () => review((reviewIndex ?? 0) - 1));
$('review-forward').addEventListener('click', () => review((reviewIndex ?? 0) + 1));
$('promotion-cancel').addEventListener('click', () => $('promotion-dialog').close(''));
$('again').addEventListener('click', () => { clearError(); showScreen('setup'); });
document.addEventListener('keydown', (event) => {
  if (busy || !state || ['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement.tagName)) return;
  if (event.key.toLowerCase() === 'f') $('flip').click();
  if (reviewIndex !== null && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    review(reviewIndex + (event.key === 'ArrowRight' ? 1 : -1));
  }
});
window.addEventListener('beforeunload', (event) => {
  if (state) { event.preventDefault(); event.returnValue = ''; }
});

async function init() {
  try {
    const info = await api('info');
    ready = info.ready;
    $('data-status').textContent = ready
      ? `${info.puzzles.toLocaleString()} puzzles · ${info.ordinary_positions.toLocaleString()} ordinary positions · ${info.sampled_games.toLocaleString()} sampled games`
      : info.error;
    // Sessions are deliberately tab-local and are not restored after a reload.
  } catch (error) {
    $('data-status').textContent = 'Training data unavailable. Check your connection and reload.';
    showError(error);
  } finally { setBusy(false); }
}

settingsChanged();
init();
