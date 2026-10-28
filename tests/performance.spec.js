import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

// Run against the production build, never a dev server. Historical measurements:
// PLAYWRIGHT_DIST=data/training/baseline/dist PLAYWRIGHT_PORT=8766 PERF_PROFILE=before \
//   npx playwright test tests/performance.spec.js
// Then compare the new build (both projects, five fresh contexts each):
// PERF_BASELINE_REPORT='data/training/measurements/before-{project}.json' \
//   npx playwright test tests/performance.spec.js
// "before" records budget failures without gating; "after" is gated by default.
const profile = process.env.PERF_PROFILE || 'after';
const directory = path.resolve(process.env.PLAYWRIGHT_DIST || 'dist');
const reportDirectory = path.resolve(process.env.PERF_REPORT_DIR || 'data/training/measurements');
const conditions = { latencyMs: 100, downloadBitsPerSecond: 1_600_000,
  uploadBitsPerSecond: 1_600_000, cpuSlowdown: 4, cacheDisabled: true,
  reducedMotion: 'reduce', freshContexts: 5, serviceWorkers: 'block',
  cacheScope: 'HTTP(S) resources; inline data URLs are not network cache hits' };
const limits = { setupReadyMs: 3000, firstPlayableMs: 1500, initialTrainingBodyBytes: 192 * 1024,
  manifestRawBytes: 64 * 1024, manifestGzipBytes: 24 * 1024,
  shardBytes: 64 * 1024, sourceZipBytes: 10 * 1024 * 1024, siteBytes: 900 * 1024 * 1024,
  bundleGrowthPercent: 10 };
const trainingPath = (pathname) => pathname.includes('/training/')
  ? pathname.slice(pathname.indexOf('/training/') + '/training/'.length) : null;
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function artifacts(root) {
  const manifestBytes = fs.readFileSync(path.join(root, 'training/manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const bundles = { javascript: { rawBytes: 0, gzipBytes: 0, files: [] },
    css: { rawBytes: 0, gzipBytes: 0, files: [] } };
  const output = { siteBytes: 0, siteFiles: 0, sourceZipBytes: fs.statSync(path.join(root, 'source.zip')).size,
    corpusBytes: 0, corpusFiles: 0, shardFiles: 0, maxShardBytes: 0, largestShard: null,
    manifestRawBytes: manifestBytes.length, manifestGzipBytes: gzipSync(manifestBytes).length, bundles };
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      const filename = path.join(root, file), size = fs.statSync(filename).size;
      output.siteBytes += size;
      output.siteFiles++;
      if (file.startsWith('training/')) {
        output.corpusBytes += size;
        output.corpusFiles++;
        if (file.endsWith('.json.gz')) {
          output.shardFiles++;
          if (size > output.maxShardBytes) { output.maxShardBytes = size; output.largestShard = file; }
        }
      }
      const group = file.startsWith('assets/') && (file.endsWith('.js') ? bundles.javascript : file.endsWith('.css') ? bundles.css : null);
      if (group) {
        const bytes = fs.readFileSync(filename), compressed = gzipSync(bytes).length;
        group.rawBytes += bytes.length;
        group.gzipBytes += compressed;
        group.files.push({ path: file, rawBytes: bytes.length, gzipBytes: compressed,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  visit('');
  return { ...output, dataset: { schema: manifest.schema, datasetId: manifest.dataset_id,
    puzzles: { count: manifest.puzzles.count, version: manifest.puzzles.version || null },
    ordinary: { count: manifest.ordinary.count, version: manifest.ordinary.version || null } } };
}

function compareBundles(current, project) {
  const template = process.env.PERF_BASELINE_REPORT;
  const filename = path.resolve(template ? template.replaceAll('{project}', project) : 'tests/performance-baseline.json');
  const baseline = JSON.parse(fs.readFileSync(filename));
  if (template && baseline.project !== project) throw new Error(`Baseline project mismatch in ${filename}`);
  const bundles = template ? baseline.artifacts.bundles : baseline.bundles;
  const groups = Object.fromEntries(['javascript', 'css'].map((kind) => {
    const before = bundles[kind], after = current.bundles[kind];
    return [kind, { beforeRawBytes: before.rawBytes, afterRawBytes: after.rawBytes,
      rawGrowthPercent: 100 * (after.rawBytes / before.rawBytes - 1),
      beforeGzipBytes: before.gzipBytes, afterGzipBytes: after.gzipBytes,
      gzipGrowthPercent: 100 * (after.gzipBytes / before.gzipBytes - 1),
      pass: after.rawBytes <= before.rawBytes * (1 + limits.bundleGrowthPercent / 100) }];
  }));
  return { baselineReport: filename, maxRawGrowthPercent: limits.bundleGrowthPercent, groups };
}

function sourceRevision() {
  // Corresponding-source ZIP recipients need not initialize a Git repository.
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function contextSettings(use) {
  return Object.fromEntries(['viewport', 'screen', 'deviceScaleFactor', 'isMobile', 'hasTouch',
    'userAgent', 'locale', 'timezoneId', 'colorScheme'].filter((key) => use[key] !== undefined)
    .map((key) => [key, use[key]]));
}

async function measure(browser, baseURL, settings, index) {
  // Do not reuse the runner's page/context: each individual sample is cold.
  const context = await browser.newContext({ ...settings, baseURL,
    reducedMotion: conditions.reducedMotion, serviceWorkers: conditions.serviceWorkers });
  const startedAt = new Date().toISOString();
  try {
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    await client.send('Network.setBypassServiceWorker', { bypass: true });
    await client.send('Network.emulateNetworkConditions', { offline: false,
      latency: conditions.latencyMs, downloadThroughput: conditions.downloadBitsPerSecond / 8,
      uploadThroughput: conditions.uploadBitsPerSecond / 8, connectionType: 'cellular3g' });
    await client.send('Emulation.setCPUThrottlingRate', { rate: conditions.cpuSlowdown });
    const wire = [], requestURLs = new Map(), cached = new Set();
    client.on('Network.requestWillBeSent', ({ requestId, request }) => requestURLs.set(requestId, request.url));
    client.on('Network.requestServedFromCache', ({ requestId }) => cached.add(requestId));
    client.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
      const url = requestURLs.get(requestId);
      // Chromium calls embedded SVG data URLs "cached" even in a brand-new
      // context with Network.setCacheDisabled. They are not HTTP transfers.
      if (/^https?:/.test(url || '')) wire.push({ url, encodedBytesIncludingHeaders: encodedDataLength,
        servedFromCache: cached.has(requestId) });
    });
    await page.addInitScript(() => {
      window.__controlledMeasurement = { setupReadyMs: null, startMs: null, playableMs: null };
      const times = window.__controlledMeasurement;
      const check = () => {
        const start = document.querySelector('#start');
        if (times.setupReadyMs === null && start && !start.disabled && !document.querySelector('#setup')?.hidden) {
          times.setupReadyMs = performance.now();
        }
        const next = document.querySelector('#next'), training = document.querySelector('#training');
        if (times.startMs !== null && times.playableMs === null && training && !training.hidden
            && next && !next.disabled && document.querySelector('#board')?.dataset.fen
            && !document.querySelector('#uci-move')?.disabled) times.playableMs = performance.now();
      };
      document.addEventListener('click', (event) => {
        if (event.target.closest('#start') && times.startMs === null) times.startMs = performance.now();
      }, true);
      new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['disabled', 'hidden', 'data-fen'] });
    });
    let phase = 'setup';
    const requests = [], bodies = [], bodyReads = [], errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    page.on('request', (request) => requests.push({ url: request.url(),
      path: new URL(request.url()).pathname, phase, type: request.resourceType() }));
    page.on('response', (response) => {
      bodyReads.push((async () => {
        const headers = await response.allHeaders();
        bodies.push({ path: new URL(response.url()).pathname, status: response.status(),
          bodyBytes: (await response.body()).length, contentEncoding: headers['content-encoding'] || null,
          declaredContentLength: Number(headers['content-length']) || null,
          fromServiceWorker: response.fromServiceWorker() });
      })().catch((error) => { errors.push(`Reading response: ${error.message}`); }));
    });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__controlledMeasurement.setupReadyMs !== null, null, { timeout: 60_000 });
    const beforeStart = requests.filter((request) => trainingPath(request.path) !== null).map((request) => trainingPath(request.path));
    phase = 'training';
    await page.locator('#start').click();
    await page.waitForFunction(() => window.__controlledMeasurement.playableMs !== null, null, { timeout: 60_000 });
    // Include the single bounded prefetch in bytes/counts, but not in the
    // Start->playable timer. The timestamps are captured in-page, not by polling.
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
    await Promise.all(bodyReads);
    const timing = await page.evaluate(() => ({ ...window.__controlledMeasurement,
      navigationTimeOrigin: performance.timeOrigin,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      resourceTimings: performance.getEntriesByType('resource').map((resource) => ({
        path: new URL(resource.name).pathname, type: resource.initiatorType,
        durationMs: resource.duration, transferBytes: resource.transferSize,
        encodedBodyBytes: resource.encodedBodySize, decodedBodyBytes: resource.decodedBodySize,
      })),
    }));
    const trainingBodies = bodies.filter((body) => trainingPath(body.path) !== null);
    const trainingRequests = requests.filter((request) => trainingPath(request.path) !== null);
    return { index, startedAt, setupReadyMs: timing.setupReadyMs,
      firstPlayableMs: timing.playableMs - timing.startMs, startMs: timing.startMs,
      playableMs: timing.playableMs, navigationTimeOrigin: timing.navigationTimeOrigin,
      reducedMotion: timing.reducedMotion, beforeStart,
      shardRequests: trainingRequests.filter((request) => request.path.endsWith('.json.gz')).map((request) => trainingPath(request.path)),
      inventoryRequests: trainingRequests.filter((request) => request.path.endsWith('/inventory.json')).map((request) => trainingPath(request.path)),
      initialTrainingBodyBytes: trainingBodies.reduce((sum, body) => sum + body.bodyBytes, 0),
      allResourceBodyBytes: bodies.reduce((sum, body) => sum + body.bodyBytes, 0),
      wireBytesIncludingHeaders: wire.reduce((sum, resource) => sum + resource.encodedBytesIncludingHeaders, 0),
      cachedResources: wire.filter((resource) => resource.servedFromCache).map((resource) => resource.url),
      requests, responses: bodies, resourceTimings: timing.resourceTimings,
      trainingHTTPFailures: trainingBodies.filter((body) => body.status !== 200), errors };
  } finally { await context.close(); }
}

test('controlled cold startup and first position: five fresh Chromium contexts', async ({ browser, browserName, baseURL }, testInfo) => {
  test.setTimeout(600_000);
  expect(browserName).toBe('chromium');
  const settings = contextSettings(testInfo.project.use);
  const sizes = artifacts(directory), samples = [];
  const comparison = compareBundles(sizes, testInfo.project.name);
  for (let index = 1; index <= conditions.freshContexts; index++) {
    try { samples.push(await measure(browser, baseURL, settings, index)); }
    catch (error) { samples.push({ index, error: error.stack || String(error) }); }
  }
  const completed = samples.filter((sample) => !sample.error);
  const summary = {
    setupReadyMs: { median: median(completed.map((sample) => sample.setupReadyMs)), max: completed.length ? Math.max(...completed.map((sample) => sample.setupReadyMs)) : null },
    firstPlayableMs: { median: median(completed.map((sample) => sample.firstPlayableMs)), max: completed.length ? Math.max(...completed.map((sample) => sample.firstPlayableMs)) : null },
    initialTrainingBodyBytes: { median: median(completed.map((sample) => sample.initialTrainingBodyBytes)), max: completed.length ? Math.max(...completed.map((sample) => sample.initialTrainingBodyBytes)) : null },
  };
  const checks = {};
  const budget = (key, actual, limit) => { checks[key] = { actual, limit, pass: actual !== null && actual <= limit }; };
  const every = (key, predicate) => { checks[key] = { pass: completed.length === 5 && completed.every(predicate) }; };
  checks.fiveSuccessfulSamples = { actual: completed.length, expected: 5, pass: completed.length === 5 };
  budget('medianSetupReadyMs', summary.setupReadyMs.median, limits.setupReadyMs);
  budget('medianFirstPlayableMs', summary.firstPlayableMs.median, limits.firstPlayableMs);
  budget('initialTrainingBodyBytes', summary.initialTrainingBodyBytes.max, limits.initialTrainingBodyBytes);
  budget('manifestRawBytes', sizes.manifestRawBytes, limits.manifestRawBytes);
  budget('manifestGzipBytes', sizes.manifestGzipBytes, limits.manifestGzipBytes);
  budget('allShardsBytes', sizes.maxShardBytes, limits.shardBytes);
  budget('sourceZipBytes', sizes.sourceZipBytes, limits.sourceZipBytes);
  budget('siteBytes', sizes.siteBytes, limits.siteBytes);
  every('onlyOneManifestBeforeStart', (sample) => sample.beforeStart.length === 1 && sample.beforeStart[0] === 'manifest.json');
  every('selectedShardAndAtMostOnePrefetch', (sample) => sample.shardRequests.length >= 1 && sample.shardRequests.length <= 2
    && new Set(sample.shardRequests).size === sample.shardRequests.length);
  every('noInventories', (sample) => sample.inventoryRequests.length === 0);
  every('noOtherTrainingResources', (sample) => sample.requests.every((request) => {
    const relative = trainingPath(request.path);
    return relative === null || relative === 'manifest.json' || relative.endsWith('.json.gz');
  }));
  every('noCachesOrServiceWorkers', (sample) => sample.cachedResources.length === 0 && sample.responses.every((body) => !body.fromServiceWorker));
  every('reducedMotion', (sample) => sample.reducedMotion);
  every('noHTTPOrPageErrors', (sample) => sample.trainingHTTPFailures.length === 0 && sample.errors.length === 0);
  every('noExtraManifestRequests', (sample) => sample.requests.filter((request) => trainingPath(request.path) === 'manifest.json').length === 1);
  const site = new URL(baseURL);
  every('onlyLocalSubpathRequests', (sample) => sample.requests.every((request) => {
    const url = new URL(request.url);
    return url.origin === site.origin && url.pathname.startsWith(site.pathname) && !/\/api\/|\.wasm|\.nnue/.test(url.pathname);
  }));
  if (comparison) for (const [kind, group] of Object.entries(comparison.groups)) checks[`${kind}BundleGrowth`] = {
    actual: group.rawGrowthPercent, limit: limits.bundleGrowthPercent, pass: group.pass,
  };
  const gated = profile !== 'before' && process.env.PERF_ENFORCE !== '0';
  const report = { format: 1, profile, project: testInfo.project.name, createdAt: new Date().toISOString(),
    gated, passedBudgets: Object.values(checks).every((check) => check.pass),
    sourceRevision: sourceRevision(),
    dist: directory, baseURL, corpusOrigin: process.env.PERF_CORPUS_ORIGIN || (profile === 'before'
      ? 'data/training/backups/20261028T101223Z/public/training' : 'data/training/site'),
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      browser: browserName, browserVersion: browser.version(), cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem(), loadAverage: os.loadavg(),
      settings, conditions, hosting: 'loopback static production build; not a deployed Pages smoke test' },
    limits, artifacts: sizes, comparison, summary, checks, samples };
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `${profile}-${testInfo.project.name}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await testInfo.attach('controlled-performance-report', { path: reportPath, contentType: 'application/json' });
  console.log(`${profile}/${testInfo.project.name}: setup median ${summary.setupReadyMs.median?.toFixed(1)} ms, first playable median ${summary.firstPlayableMs.median?.toFixed(1)} ms; report ${reportPath}`);
  expect(completed, `All five fresh-context samples must complete; see ${reportPath}`).toHaveLength(5);
  if (gated) for (const [name, check] of Object.entries(checks)) expect.soft(check.pass, `${name}: ${JSON.stringify(check)}; see ${reportPath}`).toBe(true);
});
