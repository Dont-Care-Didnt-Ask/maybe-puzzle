import { Chess, play, reviewLine, uciOf } from './chess.js';

export function assert(condition, message) {
  if (!condition) throw new Error(`Invalid training data: ${message}`);
}

export function validateManifest(manifest) {
  assert([1, 2].includes(manifest.schema) && manifest.tolerance_cp === 50, 'unsupported schema or threshold');
  assert(typeof manifest.dataset_id === 'string' && manifest.dataset_id.length > 0, 'missing dataset ID');
  assert(typeof manifest.engine === 'string' && manifest.engine.length > 0, 'missing engine name');
  assert(Number.isInteger(manifest.nodes) && manifest.nodes > 0, 'invalid search budget');
  assert(Number.isInteger(manifest.sampled_games) && manifest.sampled_games > 0, 'invalid source-game count');
  for (const [kind, prefix] of [['puzzles', 'p'], ['ordinary', 'n']]) {
    const group = manifest[kind];
    assert(group && Number.isInteger(group.count) && group.count > 0, `empty ${kind}`);
    assert(Array.isArray(group.shards) && group.shards.length > 0, `missing ${kind} shards`);
    let total = 0;
    const files = new Set();
    for (const shard of group.shards) {
      assert(new RegExp(`^${prefix}-[a-f0-9]{20}\\.json\\.gz$`).test(shard.file), 'unsafe shard filename');
      assert(!files.has(shard.file), 'duplicate shard');
      files.add(shard.file);
      assert(Number.isInteger(shard.count) && shard.count > 0, 'invalid shard size');
      if (kind === 'puzzles') {
        if (manifest.schema === 2) assert(Number.isInteger(shard.rating), 'missing exact shard rating');
        else {
          assert(Array.isArray(shard.ratings) && shard.ratings.length === shard.count, 'missing rating index');
          assert(shard.ratings.every(Number.isInteger), 'invalid rating');
        }
      }
      total += shard.count;
    }
    assert(total === group.count, `${kind} count mismatch`);
  }
  assert(manifest.sampled_games >= manifest.ordinary.count, 'more ordinary positions than source games');
  return manifest;
}

export function validatePuzzleShape(record, requireKey = false) {
  assert(record && typeof record.id === 'string' && record.id.length > 0, 'missing ID');
  assert(typeof record.fen === 'string' && /^[prnbqkPRNBQK1-8/]+ [wb] (?:-|[KQkq]+) (?:-|[a-h][36]) \d+ [1-9]\d*$/.test(record.fen), 'invalid puzzle FEN');
  assert(Number.isInteger(record.rating) && Array.isArray(record.moves) && record.moves.length >= 2
    && record.moves.every((move) => typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)), 'invalid puzzle');
  assert(record.url === undefined || typeof record.url === 'string', 'invalid source URL');
  if (requireKey || record.position_key !== undefined) {
    assert(typeof record.position_key === 'string' && /^[prnbqkPRNBQK1-8/]+ [wb] (?:-|[KQkq]+) (?:-|[a-h][36])$/.test(record.position_key), 'missing/invalid puzzle position key');
  }
}

export function validateRecord(record, kind) {
  assert(record && typeof record.id === 'string' && record.id.length > 0, 'missing ID');
  assert(typeof record.fen === 'string', 'missing FEN');
  assert(record.url === undefined || typeof record.url === 'string', 'invalid source URL');
  assert(Array.isArray(record.moves) && record.moves.length > 0, 'missing setup move');
  const board = new Chess(record.fen);
  play(board, record.moves[0]);
  if (kind === 'puzzle') {
    validatePuzzleShape(record);
    if (record.position_key !== undefined) assert(record.position_key === board.fen().split(' ').slice(0, 4).join(' '), 'puzzle position key mismatch');
    for (const uci of record.moves.slice(1)) play(board, uci);
    return;
  }
  const legal = board.moves({ verbose: true }).map(uciOf).sort();
  assert(!board.isGameOver() && legal.length >= 2, 'terminal ordinary position');
  assert(record.moves.length === 1 && record.scores && typeof record.scores === 'object', 'missing scores');
  const scored = Object.keys(record.scores).sort();
  assert(JSON.stringify(legal) === JSON.stringify(scored), 'scores must cover every legal move exactly');
  const finite = [];
  for (const score of Object.values(record.scores)) {
    if (Number.isInteger(score)) finite.push(score);
    else assert(typeof score === 'string' && /^M-?\d+$/.test(score) && Number(score.slice(1)) <= 0, 'invalid/mating best score');
  }
  finite.sort((a, b) => b - a);
  assert(finite.length >= 2 && finite[0] === record.best_cp && Math.abs(finite[0]) <= 500
    && finite[0] - finite[1] <= 50, 'not two reasonable moves');
  assert(Array.isArray(record.line) && record.line.length > 0
    && record.scores[record.line[0]] === record.best_cp, 'invalid best review line');
  reviewLine(board.fen(), record.line);
}
