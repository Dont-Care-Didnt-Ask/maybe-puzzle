// A build consumes a frozen, validated allowlist. It never hydrates implicitly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  LIMITS, DEFAULT_LOCK, KINDS, invariant, parseJSON, canonicalBytes, sameJSON, readLock, lockedDescriptors, physicalPath,
  readManifestBytes, readInventory, readDataFile, inventoryFiles, withPublicationLock,
} from './data-integrity.mjs';
import { validateData } from './validate-data.mjs';
import { validateLockedData } from './training-data.mjs';
import { validateManifest } from '../web/format.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

function copyDataFiles(source, destination, files) {
  let bytes = 0;
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of new Set(files)) {
    const maximum = relative === 'manifest.json' ? LIMITS.manifest
      : relative.endsWith('/inventory.json') ? LIMITS.inventory : LIMITS.shard;
    const data = readDataFile(source, relative, maximum);
    bytes += data.length;
    invariant(bytes <= LIMITS.site, 'training snapshot exceeds site byte budget');
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { flag: 'wx' });
  }
  return bytes;
}

export async function snapshotTrainingData({ trainingDir = 'public/training', destination,
  local = false, explicitTrainingDir = false, lockFile = DEFAULT_LOCK, deep = false, lockOptions } = {}) {
  invariant(destination && (!local || explicitTrainingDir), '--local requires an explicit --training-dir; never infer a local corpus');
  // Fail before touching anything when an owner has not yet bootstrapped a lock.
  if (!local) readLock(lockFile);
  let lock, lockBytes;
  await withPublicationLock(trainingDir, () => {
    const manifest = validateManifest(parseJSON(readManifestBytes(trainingDir), 'manifest'));
    const files = ['manifest.json'];
    if (!local) {
      ({ lock, bytes: lockBytes } = readLock(lockFile));
      invariant(sameJSON(manifest, lock.manifest), 'live manifest does not match production lock; run npm run data:hydrate explicitly (builds never download)');
      for (const descriptor of lockedDescriptors(lock)) {
        const { inventory } = readInventory(trainingDir, descriptor.kind, descriptor.version,
          descriptor.version === manifest[descriptor.kind].version ? manifest[descriptor.kind] : undefined);
        files.push(...inventoryFiles(inventory, descriptor.version));
      }
    } else if (manifest.schema === 3) {
      for (const kind of KINDS) {
        const { inventory } = readInventory(trainingDir, kind, manifest[kind].version, manifest[kind]);
        files.push(...inventoryFiles(inventory, manifest[kind].version));
      }
    } else for (const kind of KINDS) files.push(...manifest[kind].shards.map((shard) => shard.file));
    // Holding the same lock as the Python/Node publishers closes the TOCTOU gap:
    // validation, Vite, and source packaging below all see these copied bytes.
    copyDataFiles(trainingDir, destination, files);
  }, lockOptions);
  const result = lock ? validateLockedData(destination, lock, { deep })
    : validateData(destination, { deep, enforceBudgets: true });
  return { ...result, lock: lock || null, lockBytes: lockBytes || null };
}

export function copyPublicAssets(source, destination, { trainingDir = path.join(source, 'training') } = {}) {
  if (!fs.existsSync(source)) return;
  const training = path.resolve(trainingDir), trainingParent = path.dirname(training), trainingName = path.basename(training);
  const publicRoot = path.resolve(source);
  if (publicRoot === training || publicRoot.startsWith(`${training}${path.sep}`)) return;
  const excluded = (filename) => {
    const resolved = path.resolve(filename), name = path.basename(resolved);
    return resolved === training || (path.dirname(resolved) === trainingParent
      && (name === `${trainingName}.publication-lock` || name.startsWith(`.${trainingName}-`) || name.startsWith(`${trainingName}.tmp-`)));
  };
  const visit = (directory, relative = '') => {
    invariant(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), `unsafe public directory: ${directory}`);
    for (const name of fs.readdirSync(directory).sort()) {
      // Both publishers reserve sibling work/lock paths beside public/training.
      // A concurrent hydration must never sneak an unpinned tree into the site.
      if ((!relative && (name === 'training' || name === 'training.publication-lock'
        || name.startsWith('.training-') || name.startsWith('training.tmp-'))) || name === '.DS_Store') continue;
      const from = path.join(directory, name), next = relative ? path.join(relative, name) : name;
      if (excluded(from)) continue;
      const stat = fs.lstatSync(from);
      invariant(!stat.isSymbolicLink(), `symlink in public assets: ${next}`);
      if (stat.isDirectory()) visit(from, next);
      else {
        invariant(stat.isFile() && stat.size <= LIMITS.site, `unsafe/oversized public file: ${next}`);
        const target = path.join(destination, next);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        invariant(!fs.existsSync(target), `public asset would overwrite a build file: ${next}`);
        fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL);
      }
    }
  };
  visit(source);
}

export function measureSite(directory) {
  let bytes = 0, files = 0;
  const visit = (current) => {
    for (const name of fs.readdirSync(current)) {
      const filename = path.join(current, name), stat = fs.lstatSync(filename);
      invariant(!stat.isSymbolicLink(), `symlink in built site: ${filename}`);
      if (stat.isDirectory()) visit(filename);
      else {
        invariant(stat.isFile(), `special file in built site: ${filename}`);
        files++;
        bytes += stat.size;
        invariant(bytes <= LIMITS.site, `site exceeds ${LIMITS.site}-byte (900 MiB) budget`);
      }
    }
  };
  visit(directory);
  const source = fs.lstatSync(path.join(directory, 'source.zip'));
  invariant(source.isFile() && !source.isSymbolicLink() && source.size <= LIMITS.source,
    `source.zip exceeds ${LIMITS.source}-byte (10 MiB) budget`);
  return { bytes, files, sourceBytes: source.size };
}

// Local data can be validated without being production-pinned. Keep that
// distinction visible in both the deployed HTML and a machine-readable marker.
function markLocalPreview(directory, manifest) {
  const warning = 'UNPINNED LOCAL PREVIEW — this dataset is not production-pinned.';
  fs.writeFileSync(path.join(directory, 'local-preview.json'), canonicalBytes({
    format: 1, production_pinned: false, warning, schema: manifest.schema, dataset_id: manifest.dataset_id,
  }), { flag: 'wx' });
  const html = readDataFile(directory, 'index.html').toString('utf8');
  // A normal-flow notice marks previews without overlaying or intercepting
  // bottom-rank board input on shorter desktop/mobile viewports.
  const banner = `<div id="local-preview-banner" role="status" style="background:#5c2600;color:#fff;padding:6px;text-align:center;font:14px sans-serif">${warning}</div>`;
  fs.writeFileSync(path.join(directory, 'index.html'), /<body(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<body(?:\s[^>]*)?>/i, (body) => body + banner) : `${banner}\n${html}`);
}

export async function buildSite({ trainingDir = 'public/training', outDir = 'dist', lockFile = DEFAULT_LOCK,
  local = false, explicitTrainingDir = false, deep = false, projectRoot = PROJECT_ROOT, lockOptions,
  // Dependency injection keeps Node tests small and independent of a real corpus.
  viteBuild, runSources,
} = {}) {
  projectRoot = fs.realpathSync(path.resolve(projectRoot));
  const requestedOutput = path.isAbsolute(outDir) ? outDir : `${projectRoot}${path.sep}${outDir}`;
  if (fs.existsSync(requestedOutput)) invariant(!fs.lstatSync(requestedOutput).isSymbolicLink(), 'unsafe build output symlink');
  const output = physicalPath(requestedOutput);
  const training = physicalPath(path.isAbsolute(trainingDir) ? trainingDir : `${projectRoot}${path.sep}${trainingDir}`);
  const overlaps = (left, right) => left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
  const reserved = ['public', 'web', 'scripts', 'tests', 'data', 'node_modules', '.git']
    .flatMap((name) => { const directory = path.join(projectRoot, name); return [directory, physicalPath(directory)]; });
  invariant(output !== projectRoot && !projectRoot.startsWith(`${output}${path.sep}`)
    && !overlaps(output, physicalPath(training)) && !reserved.some((directory) => overlaps(output, directory))
    && output !== path.parse(output).root, 'unsafe build output directory');
  invariant(!local || explicitTrainingDir, '--local requires an explicit --training-dir');
  const resolvedLock = physicalPath(path.isAbsolute(lockFile) ? lockFile : `${projectRoot}${path.sep}${lockFile}`);
  const physicalLock = resolvedLock;
  invariant(!physicalLock.startsWith(`${output}${path.sep}`) && physicalLock !== output, 'build output would overwrite the production lock');
  if (!local) readLock(resolvedLock);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cpnp-build-'));
  // Stage the deployable site next to its destination, so final rename is atomic
  // even when the training snapshot lives on a different filesystem.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const stagedSite = fs.mkdtempSync(path.join(path.dirname(output), `.${path.basename(output)}-build-`));
  try {
    const snapshot = path.join(workspace, 'training');
    const result = await snapshotTrainingData({ trainingDir: training, destination: snapshot, local,
      explicitTrainingDir, lockFile: resolvedLock, deep, lockOptions });
    const build = viteBuild || (await import('vite')).build;
    await build({ root: projectRoot, configFile: path.join(projectRoot, 'vite.config.js'), publicDir: false,
      build: { outDir: stagedSite, emptyOutDir: true, copyPublicDir: false } });
    copyPublicAssets(path.join(projectRoot, 'public'), stagedSite, { trainingDir: physicalPath(training) });
    copyDataFiles(snapshot, path.join(stagedSite, 'training'), result.files);
    if (local) markLocalPreview(stagedSite, result.manifest);
    const frozenLock = result.lockBytes ? path.join(workspace, 'training-data.lock.json') : null;
    if (frozenLock) fs.writeFileSync(frozenLock, result.lockBytes);
    if (runSources) await runSources({ outDir: stagedSite, projectRoot, lockFile: frozenLock, local });
    else {
      const sourceArgs = ['--out-dir', stagedSite, ...(local ? ['--local'] : ['--lock', frozenLock])];
      const child = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/source.mjs'), ...sourceArgs],
        { cwd: projectRoot, stdio: 'inherit' });
      if (child.error) throw child.error;
      invariant(child.status === 0, `source packaging failed (${child.signal || child.status})`);
    }
    const sizes = measureSite(stagedSite);
    const backup = `${output}.old-${randomUUID()}`;
    let backedUp = false;
    try {
      if (fs.existsSync(output)) {
        invariant(fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink(), 'unsafe existing build output');
        fs.renameSync(output, backup);
        backedUp = true;
      }
      fs.renameSync(stagedSite, output);
    } catch (error) {
      if (backedUp) fs.renameSync(backup, output);
      throw error;
    }
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
    return { ...sizes, manifest: result.manifest, outDir: output, local };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(stagedSite, { recursive: true, force: true });
  }
}

function optionsOf(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--local' || arg === '--deep') {
      const key = arg.slice(2);
      invariant(!options[key], `duplicate ${arg}`);
      options[key] = true;
    } else {
      const key = { '--training-dir': 'trainingDir', '--out-dir': 'outDir', '--lock': 'lockFile' }[arg];
      invariant(key && !Object.hasOwn(options, key) && args[index + 1] && !args[index + 1].startsWith('--'), `unknown/missing build option: ${arg}`);
      options[key] = args[++index];
      if (key === 'trainingDir') options.explicitTrainingDir = true;
    }
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildSite(optionsOf(process.argv.slice(2)));
    console.log(`${result.local ? 'UNPINNED LOCAL PREVIEW (local-preview.json; not production-pinned). ' : ''}Built ${result.files} files (${(result.bytes / 1024 / 1024).toFixed(2)} MiB; source.zip ${(result.sourceBytes / 1024 / 1024).toFixed(2)} MiB) to ${result.outDir}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
