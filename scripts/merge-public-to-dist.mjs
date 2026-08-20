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
 *  - Old prebuilt bundles inside public/ (*.js / *.js.map / index.html)
 *    are SKIPPED — vite's freshly built index.html is authoritative and
 *    must never be overwritten (a stale index.html references old chunk
 *    hashes that 404 after the upgrade).
 *  - Top-level files are copied only when MISSING from dist/, so nothing
 *    vite emitted is ever clobbered.
 */
import {cpSync, readdirSync, statSync, copyFileSync, existsSync} from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const PUBLIC = 'public';
const SKIP = new Set(['index.html', 'sw.js']);

// 1. assets/ tree (fonts, images, audio, tgs, ...)
if (existsSync(path.join(PUBLIC, 'assets'))) {
  cpSync(path.join(PUBLIC, 'assets'), path.join(DIST, 'assets'), {recursive: true});
}

// 2. top-level static files (favicons, browserconfig, manifest, ...),
//    skipping prebuilt js bundles and anything vite already emitted
for (const entry of readdirSync(PUBLIC)) {
  const full = path.join(PUBLIC, entry);
  if (!statSync(full).isFile()) continue;
  if (entry.endsWith('.js') || entry.endsWith('.js.map')) continue;
  if (SKIP.has(entry)) continue;
  const target = path.join(DIST, entry);
  if (existsSync(target)) continue; // never clobber a fresh build artifact
  copyFileSync(full, target);
}

console.log('Merged public/ static assets into dist/ (skipped stale prebuilt files)');