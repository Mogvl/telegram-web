#!/usr/bin/env node
/**
 * Merges tweb's public/ static assets into dist/.
 *
 * tweb's vite build uses copyPublicDir:false; the project ships static
 * assets (fonts, images, icons, pattern.svg, favicons…) through public/
 * and expects the deploy step to merge them next to the built bundle.
 * This mirrors what upstream's build.js does (copyFiles dist -> public),
 * inverted for our dist-first image layout.
 *
 * Safety rules:
 *  - Directories are copied wholesale from an explicit allowlist:
 *    assets/ (fonts/images/icons) and changelogs/ (generated during the
 *    build and fetched by the in-app changelog dialog).
 *  - Top-level files come from an explicit allowlist (config files and
 *    runtime-fetched workers). Anything vite emitted itself is never
 *    clobbered, and stale prebuilt bundles (old hashed css/js/svg/wasm)
 *    from upstream's public/ are never pulled into the image.
 */
import {cpSync, readdirSync, statSync, copyFileSync, existsSync} from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const PUBLIC = 'public';

// Directories copied wholesale (recursive).
const DIRS = new Set(['assets', 'changelogs']);

// Top-level files allowed into dist. Exact names plus a few glob-ish
// patterns for files whose hash is stable across upstream releases.
const TOP_LEVEL_ALLOW = [
  'browserconfig.xml',
  'site.webmanifest',
  'site_apple.webmanifest',
  'snapshot.html',
  'version',
  'decoderWorker.min.wasm',
  'encoderWorker.min.wasm',
  /^tlottie-.*\.wasm$/,
];

function allowed(filename) {
  return TOP_LEVEL_ALLOW.some((entry) =>
    typeof entry === 'string' ? entry === filename : entry.test(filename)
  );
}

// 1. allowed dirs
for (const dir of DIRS) {
  if (existsSync(path.join(PUBLIC, dir))) {
    cpSync(path.join(PUBLIC, dir), path.join(DIST, dir), {recursive: true});
  }
}

// 2. allowlisted top-level files (never clobber fresh build artifacts)
for (const entry of readdirSync(PUBLIC)) {
  const full = path.join(PUBLIC, entry);
  if (!statSync(full).isFile()) continue;
  if (!allowed(entry)) continue;
  const target = path.join(DIST, entry);
  if (existsSync(target)) continue;
  copyFileSync(full, target);
}

console.log('Merged public/ static assets into dist/ (allowlisted top-level files)');