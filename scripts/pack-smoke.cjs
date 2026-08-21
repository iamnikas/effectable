#!/usr/bin/env node
'use strict';

/**
 * Packs the package and smoke-tests the tarball as a consumer would:
 * CommonJS require of the root and every documented subpath, generated .d.ts
 * for those entry points, Node engines/.nvmrc, and no src/ at runtime.
 *
 * Expects `npm run build` to have already produced ./build.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOCUMENTED_SUBPATHS = [
  '.',
  './bootstrap',
  './store',
  './component',
  './connect',
  './runtime',
];

const ENTRY_DTS = [
  'build/index.d.ts',
  'build/bootstrap/index.d.ts',
  'build/store/index.d.ts',
  'build/component/index.d.ts',
  'build/connect/index.d.ts',
  'build/runtime/index.d.ts',
];

/**
 * @param {string} message
 * @returns {never}
 */
function fail (message) {
  console.error(`pack-smoke: ${message}`);
  process.exit(1);
}

/**
 * @param {string[]} args
 * @param {{ cwd?: string, stdio?: 'pipe' | 'inherit' }} [options]
 * @returns {string}
 */
function runNpm (args, options) {
  const cwd = options && options.cwd ? options.cwd : ROOT;
  const stdio = options && options.stdio ? options.stdio : 'pipe';
  try {
    const result = execFileSync('npm', args, {
      cwd,
      encoding: 'utf8',
      stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    return typeof result === 'string' ? result : '';
  } catch (error) {
    const err = error && typeof error === 'object' ? error : {};
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const stderr = typeof err.stderr === 'string' ? err.stderr : '';
    fail(
      `npm ${args.join(' ')} failed` +
      (stdout !== '' ? `\n${stdout}` : '') +
      (stderr !== '' ? `\n${stderr}` : '')
    );
  }
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseNpmJson (raw) {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('[');
  const alt = trimmed.indexOf('{');
  const jsonStart = start === -1
    ? alt
    : alt === -1
      ? start
      : Math.min(start, alt);
  if (jsonStart === -1) {
    fail(`npm did not print JSON\n${trimmed}`);
  }
  return JSON.parse(trimmed.slice(jsonStart));
}

/**
 * @param {unknown} value
 * @returns {object}
 */
function firstPackListing (value) {
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  if (value !== null && typeof value === 'object') {
    return value;
  }
  fail('unexpected npm pack --json shape');
}

function assertNodeVersion () {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const enginesNode = pkg.engines && typeof pkg.engines.node === 'string'
    ? pkg.engines.node
    : '';
  const nvmrc = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  const minMajorMatch = /^>=(\d+)/.exec(enginesNode);
  const minMajor = minMajorMatch ? Number.parseInt(minMajorMatch[1], 10) : NaN;

  if (!Number.isFinite(minMajor) || minMajor < 22) {
    fail(`expected package.json engines.node to be ">=22" (or higher), got ${JSON.stringify(enginesNode)}`);
  }
  if (!Number.isFinite(major) || major < minMajor) {
    fail(
      `engines.node is ${enginesNode}; running Node ${process.version}. ` +
      `CI uses .nvmrc=${nvmrc} (no version matrix).`
    );
  }

  console.log(
    `pack-smoke: Node ${process.version} (engines.node=${enginesNode}, .nvmrc=${nvmrc})`
  );
}

function assertBuildPresent () {
  const marker = path.join(ROOT, 'build', 'index.js');
  if (!fs.existsSync(marker)) {
    fail('build/index.js is missing; run `npm run build` before test:pack-smoke');
  }
}

/**
 * @param {object} listing
 * @returns {string[]}
 */
function listingPaths (listing) {
  const files = listing.files;
  if (!Array.isArray(files)) {
    fail('npm pack listing has no files[]');
  }
  return files.map((entry) => {
    if (entry !== null && typeof entry === 'object' && typeof entry.path === 'string') {
      return entry.path.replace(/\\/g, '/');
    }
    fail('npm pack listing file entry is missing path');
  });
}

/**
 * @param {string[]} packedPaths
 */
function assertPackedContents (packedPaths) {
  const srcHits = packedPaths.filter((rel) => rel === 'src' || rel.startsWith('src/'));
  if (srcHits.length > 0) {
    fail(`tarball contains src/ (must not be required at runtime): ${srcHits.join(', ')}`);
  }

  for (const dts of ENTRY_DTS) {
    if (!packedPaths.includes(dts)) {
      fail(`tarball is missing generated types ${dts}`);
    }
  }

  const required = ['package.json', 'LICENSE', 'README.md', 'build/index.js'];
  for (const rel of required) {
    if (!packedPaths.includes(rel)) {
      fail(`tarball is missing ${rel}`);
    }
  }
}

/**
 * @param {string} consumerDir
 * @param {string} tarballPath
 */
function installTarball (consumerDir, tarballPath) {
  runNpm(['init', '--yes'], { cwd: consumerDir, stdio: 'inherit' });
  runNpm(['install', '--ignore-scripts', tarballPath], { cwd: consumerDir, stdio: 'inherit' });
}

/**
 * @param {string} consumerDir
 */
function writeConsumerSmoke (consumerDir) {
  const body = `'use strict';

const fs = require('node:fs');
const path = require('node:path');

const subpaths = ${JSON.stringify(DOCUMENTED_SUBPATHS)};
const dtsFiles = ${JSON.stringify(ENTRY_DTS)};
const consumerRoot = ${JSON.stringify(consumerDir)};

function fail (message) {
  console.error('pack-smoke consumer: ' + message);
  process.exit(1);
}

const pkgJsonPath = require.resolve('effectable/package.json');
const pkgRoot = path.dirname(pkgJsonPath);
const expectedRoot = path.join(consumerRoot, 'node_modules', 'effectable');

if (path.resolve(pkgRoot) !== path.resolve(expectedRoot)) {
  fail('effectable resolved outside consumer node_modules: ' + pkgRoot);
}

if (fs.existsSync(path.join(pkgRoot, 'src'))) {
  fail('installed package contains src/; consumers must not need source at runtime');
}

for (const subpath of subpaths) {
  const spec = subpath === '.' ? 'effectable' : 'effectable/' + subpath.slice(2);
  let resolved;
  try {
    resolved = require.resolve(spec);
    require(spec);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    fail('require(' + JSON.stringify(spec) + ') failed: ' + text);
  }
  if (!resolved.startsWith(expectedRoot + path.sep) && resolved !== expectedRoot) {
    fail(spec + ' resolved outside the installed package: ' + resolved);
  }
  if (resolved.includes(path.sep + 'src' + path.sep)) {
    fail(spec + ' resolved into src/: ' + resolved);
  }
  console.log('pack-smoke: require(' + JSON.stringify(spec) + ') -> ' + resolved);
}

for (const rel of dtsFiles) {
  const dtsPath = path.join(pkgRoot, rel);
  if (!fs.existsSync(dtsPath)) {
    fail('missing generated types: ' + rel);
  }
  console.log('pack-smoke: dts ok ' + rel);
}

console.log('pack-smoke: consumer import smoke passed');
`;

  fs.writeFileSync(path.join(consumerDir, 'smoke-consumer.cjs'), body);
}

function main () {
  assertNodeVersion();
  assertBuildPresent();

  console.log('pack-smoke: npm pack --dry-run (file list only)');
  const dryRaw = runNpm(['pack', '--dry-run', '--json', '--ignore-scripts']);
  const dryListing = firstPackListing(parseNpmJson(dryRaw));
  const packedPaths = listingPaths(dryListing);
  for (const rel of packedPaths) {
    console.log(`  ${rel}`);
  }
  assertPackedContents(packedPaths);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'effectable-pack-smoke-'));
  const packDir = path.join(workDir, 'pack');
  const consumerDir = path.join(workDir, 'consumer');
  fs.mkdirSync(packDir);
  fs.mkdirSync(consumerDir);

  try {
    console.log('pack-smoke: npm pack (actual tarball)');
    const packRaw = runNpm(['pack', '--json', '--ignore-scripts', `--pack-destination=${packDir}`]);
    const packListing = firstPackListing(parseNpmJson(packRaw));
    const filename = typeof packListing.filename === 'string' ? packListing.filename : '';
    if (filename === '') {
      fail('npm pack --json did not include filename');
    }
    const tarballPath = path.join(packDir, path.basename(filename));
    if (!fs.existsSync(tarballPath)) {
      fail(`packed tarball not found at ${tarballPath}`);
    }
    console.log(`pack-smoke: tarball ${tarballPath}`);

    installTarball(consumerDir, tarballPath);
    writeConsumerSmoke(consumerDir);

    execFileSync(process.execPath, [path.join(consumerDir, 'smoke-consumer.cjs')], {
      cwd: consumerDir,
      stdio: 'inherit',
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log('pack-smoke: ok');
}

main();
