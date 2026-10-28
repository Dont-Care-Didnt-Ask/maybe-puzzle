// The schema-3 browser contract. Paths are derived from counts and immutable
// group versions; manifests and item references never supply a path template.
export const PUZZLE_SHARD_SIZE = 256;
export const ORDINARY_SHARD_SIZE = 64;
const version = (value) => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);

function require(condition, message) {
  if (!condition) throw new Error(`Invalid training data: ${message}`);
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value);
const positive = (value) => integer(value) && value > 0;
const nonnegative = (value) => integer(value) && value >= 0;

function fields(value, expected, description) {
  require(object(value) && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key)), `invalid ${description} fields`);
}

export function validateCompactGroup(group, kind) {
  require(kind === 'puzzles' || kind === 'ordinary', 'invalid group kind');
  fields(group, ['version', 'count', 'shard_size', ...(kind === 'puzzles' ? ['rating_counts'] : [])], `${kind} group`);
  require(version(group.version), `invalid ${kind} version`);
  require(positive(group.count), `empty/invalid ${kind} count`);
  require(Number.isSafeInteger(group.shard_size) && (kind === 'puzzles'
    ? group.shard_size >= 128 && group.shard_size <= PUZZLE_SHARD_SIZE
    : group.shard_size === ORDINARY_SHARD_SIZE), `invalid ${kind} shard size`);
  if (kind === 'puzzles') {
    require(Array.isArray(group.rating_counts) && group.rating_counts.length > 0, 'missing puzzle rating counts');
    let total = 0, previous;
    for (const pair of group.rating_counts) {
      require(Array.isArray(pair) && pair.length === 2 && integer(pair[0]) && positive(pair[1]), 'invalid puzzle rating count');
      const [rating, count] = pair;
      require(previous === undefined || rating > previous, 'puzzle ratings must be sorted and unique');
      require(total <= Number.MAX_SAFE_INTEGER - count, 'puzzle count overflow');
      total += count;
      previous = rating;
    }
    require(total === group.count, 'puzzle rating count mismatch');
  }
  return group;
}

export function shardCount(count, size) {
  require(positive(count) && positive(size), 'invalid shard count or size');
  // Divide an exact multiple, avoiding both overflowing additions and rounding
  // a quotient across an integer boundary near MAX_SAFE_INTEGER.
  const remainder = count % size;
  return (count - remainder) / size + (remainder === 0 ? 0 : 1);
}

export function shardLength(count, size, part) {
  require(nonnegative(part) && part < shardCount(count, size), 'invalid shard part');
  return Math.min(size, count - part * size);
}

export function puzzleShardPath(groupVersion, rating, part) {
  require(version(groupVersion), 'invalid puzzle version');
  require(integer(rating) && nonnegative(part), 'invalid puzzle rating or part');
  // Numeric interpolation is canonical for every safe integer, including -0 → 0.
  return `puzzles/${groupVersion}/${rating}/${part}.json.gz`;
}

export function ordinaryShardPath(groupVersion, part) {
  require(version(groupVersion), 'invalid ordinary version');
  require(nonnegative(part), 'invalid ordinary part');
  return `ordinary/${groupVersion}/${part}.json.gz`;
}

// The manifest is validated once by Catalog. Recheck identity and the selected
// count here without scanning every rating on each get(), or expanding shards.
export function resolveSchema3Reference(manifest, ref) {
  require(manifest?.schema === 3 && object(ref) && (ref.kind === 'puzzle' || ref.kind === 'ordinary'), 'invalid item reference');
  const puzzle = ref.kind === 'puzzle';
  fields(ref, ['kind', 'version', 'part', 'row', ...(puzzle ? ['rating'] : [])], 'item reference');
  const group = manifest[puzzle ? 'puzzles' : 'ordinary'];
  require(object(group) && typeof ref.version === 'string' && ref.version === group.version, 'item reference version mismatch');
  let count = group.count;
  if (puzzle) {
    require(integer(ref.rating) && Array.isArray(group.rating_counts), 'invalid item reference rating');
    let low = 0, high = group.rating_counts.length - 1;
    count = undefined;
    while (low <= high) {
      const middle = low + Math.floor((high - low) / 2);
      const [rating, ratingCount] = group.rating_counts[middle];
      if (rating < ref.rating) low = middle + 1;
      else if (rating > ref.rating) high = middle - 1;
      else { count = ratingCount; break; }
    }
    require(positive(count), 'invalid item reference rating');
  }
  const length = shardLength(count, group.shard_size, ref.part);
  require(nonnegative(ref.row) && ref.row < length, 'invalid item reference row');
  return { file: puzzle ? puzzleShardPath(ref.version, ref.rating, ref.part) : ordinaryShardPath(ref.version, ref.part),
    count: length, ...(puzzle ? { rating: ref.rating } : {}) };
}

// A lazy tooling convenience, not a stored shard list. Browser loading only calls
// resolveSchema3Reference for the selected item and never requests inventories.
export function* schema3Shards(manifest, kind) {
  require(manifest?.schema === 3 && (kind === 'puzzle' || kind === 'ordinary'), 'invalid schema or item kind');
  const group = validateCompactGroup(manifest[kind === 'puzzle' ? 'puzzles' : 'ordinary'], kind === 'puzzle' ? 'puzzles' : 'ordinary');
  if (kind === 'puzzle') {
    for (const [rating, count] of group.rating_counts) {
      for (let part = 0; part < shardCount(count, group.shard_size); part++) {
        yield { file: puzzleShardPath(group.version, rating, part), count: shardLength(count, group.shard_size, part), rating };
      }
    }
  } else {
    for (let part = 0; part < shardCount(group.count, group.shard_size); part++) {
      yield { file: ordinaryShardPath(group.version, part), count: shardLength(group.count, group.shard_size, part) };
    }
  }
}
