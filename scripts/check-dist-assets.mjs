#!/usr/bin/env node
/**
 * Verifies that every asset referenced by the production build (CSS
 * url(...) and index.html) actually exists in dist/.
 * tweb builds with copyPublicDir:false, so static assets from public/
 * must be merged into dist/ separately (see Dockerfile) — this check
 * catches that regressing.
 */
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';

const DIST = 'dist';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const refs = new Set();

for (const file of walk(DIST).filter((f) => f.endsWith('.css') || f.endsWith('index.html'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/url\(\s*([^)]*?)\s*\)/g)) {
    let u = m[1].trim().replace(/^["']|["']$/g, '');
    if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('http')) continue;
    if (u.startsWith('./')) u = u.slice(2);
    u = u.split('?')[0]; // strip cache-busting query (?em6boz)
    refs.add(u);
  }
}

const missing = [...refs].filter((u) => !existsSync(path.join(DIST, path.normalize(u))));
if (missing.length) {
  console.error(`Missing ${missing.length} build assets:`);
  for (const m of missing) console.error('  ' + m);
  process.exit(1);
}
console.log(`OK: ${refs.size} referenced assets present in ${DIST}/`);