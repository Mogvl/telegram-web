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
const scanned = [];

// CSS url(...) — resolved relative to the css file's own directory, so the
// check stays correct even if vite's assetsDir ever changes from ''.
for (const file of walk(DIST).filter((f) => f.endsWith('.css'))) {
  scanned.push(file);
  const dir = path.dirname(file);
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/url\(\s*([^)]*?)\s*\)/g)) {
    let u = m[1].trim().replace(/^["']|["']$/g, '');
    if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('http')) continue;
    u = u.split('?')[0]; // strip cache-busting query (?em6boz)
    if (u.startsWith('/')) {
      refs.add(path.join(DIST, u));
    } else {
      refs.add(path.resolve(dir, u));
    }
  }
}

// index.html src/href references (entry chunk, favicons, manifests, fonts, ...)
for (const file of walk(DIST).filter((f) => f.endsWith('index.html') || f.endsWith('.webmanifest'))) {
  scanned.push(file);
  const dir = path.dirname(file);
  const text = readFileSync(file, 'utf8');
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    let u = m[1].trim();
    if (u.startsWith('data:') || u.startsWith('#') || u.startsWith('http')
        || u.startsWith('mailto:') || u.startsWith('tel:') || u.startsWith('blob:')) continue;
    u = u.split('?')[0];
    if (u.startsWith('/')) {
      refs.add(path.join(DIST, u));
    } else {
      refs.add(path.resolve(dir, u));
    }
  }
}

const relToDist = (abs) => path.relative(DIST, abs).split(path.sep).join('/');
const missing = [];
for (const abs of refs) {
  if (!existsSync(abs)) missing.push(relToDist(abs));
}
if (missing.length) {
  console.error(`Missing ${missing.length} build assets:`);
  for (const m of missing.sort()) console.error('  ' + m);
  process.exit(1);
}
console.log(`OK: ${refs.size} referenced assets present in ${DIST}/ (scanned ${scanned.length} css/html/manifest files)`);
