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
 * Old prebuilt bundles inside public/ (*.js / *.js.map) are skipped so
 * they don't pollute the image.
 */
import {cpSync, readdirSync, statSync, copyFileSync, mkdirSync, existsSync} from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const PUBLIC = 'public';

// 1. assets/ tree (fonts, images, audio, tgs, ...)
if (existsSync(path.join(PUBLIC, 'assets'))) {
  cpSync(path.join(PUBLIC, 'assets'), path.join(DIST, 'assets'), {recursive: true});
}

// 2. top-level static files (favicons, browserconfig, manifest, ...),
//    skipping the old prebuilt js bundles and their source maps
for (const entry of readdirSync(PUBLIC)) {
  const full = path.join(PUBLIC, entry);
  if (!statSync(full).isFile()) continue;
  if (entry.endsWith('.js') || entry.endsWith('.js.map')) continue;
  copyFileSync(full, path.join(DIST, entry));
}

console.log('Merged public/ static assets into dist/');