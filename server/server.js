/**
 * telegram-web-dl — minimal download sink for the self-hosted Telegram Web.
 *
 * The browser-side media downloader (public/telegram-media-downloader.js)
 * POSTs media blobs to /dl/upload (proxied by the web app's nginx to this
 * service). This service streams them into DOWNLOAD_DIR, which is a volume
 * mounted from the NAS filesystem (see docker-compose.yaml).
 *
 * Protocol:
 *   POST /upload
 *     X-Filename: URI-encoded base file name
 *     X-Part:     0-based part index
 *     X-Parts:    total number of parts; the last part finalizes the file
 *     body:       raw bytes of this part
 *   Parts for the same file name are appended in order; on the final part
 *   the temp file is renamed to its final name (with a numeric suffix if
 *   the name is already taken).
 *
 *   GET    /health                        -> {"ok":true,"dir":...}
 *   GET    /files[?page=&pageSize=&q=&sort=] -> {"ok":true,"files":[...],"total":N,"page":P,"pageSize":S}
 *   GET    /files/<name>                  -> stream the file (inline, UTF-8 filename)
 *   GET    /status                        -> {"ok":true,"active":[{name,received,parts,bytes}]}
 *   DELETE /files/<name>                  -> remove the file (and its temp .part) from the NAS
 *   POST   /batch-delete {"names":[...]}  -> remove several files at once
 *
 * No external dependencies — plain node:http.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/data/downloads';
const PORT = Number(process.env.PORT || 9090);

// Clean up leftover temp files from interrupted runs.
fs.mkdirSync(DOWNLOAD_DIR, {recursive: true});
for (const f of fs.readdirSync(DOWNLOAD_DIR)) {
  if (f.endsWith('.part')) {
    fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
  }
}

/** Sessions in flight: fileName -> {tmpPath, stream, received, parts} */
const sessions = new Map();

function cleanFileName(raw) {
  let name = String(raw || 'download');
  try {
    name = decodeURIComponent(name);
  } catch (e) {
    /* keep as-is */
  }
  name = path.basename(name).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').trim();
  return name || 'download';
}

function finalName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

function sendJson(res, status, obj) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}

function parseQuery(search) {
  const out = {};
  for (const [k, v] of new URLSearchParams(search || '')) out[k] = v;
  return out;
}

function readFiles() {
  return fs.readdirSync(DOWNLOAD_DIR)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const full = path.join(DOWNLOAD_DIR, f);
      const st = fs.statSync(full);
      return {
        name: f,
        size: st.size,
        mtime: st.mtime.toISOString(),
        status: (sessions.has(f) || fs.existsSync(path.join(DOWNLOAD_DIR, `.${f}.part`)))
          ? 'active'
          : 'done'
      };
    });
}

function deleteFileFromDisk(name) {
  const target = path.join(DOWNLOAD_DIR, name);
  const partPath = path.join(DOWNLOAD_DIR, `.${name}.part`);

  const session = sessions.get(name);
  if (session) {
    sessions.delete(name);
    session.stream.destroy();
  }

  const deleted = [];
  for (const p of [target, partPath]) {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        deleted.push(path.basename(p));
      }
    } catch (err) {
      return {error: String(err.message || err)};
    }
  }
  return {deleted};
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return sendJson(res, 200, {ok: true, dir: DOWNLOAD_DIR, sessions: sessions.size});
  }

  // batch delete: {"names":["a.mp4","b.jpg"]}
  if (req.method === 'POST' && url === '/batch-delete') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let names = [];
      try {
        names = JSON.parse(body || '{}').names || [];
      } catch (e) {
        return sendJson(res, 400, {ok: false, error: 'bad json'});
      }
      const deleted = [];
      const notFound = [];
      for (const raw of names) {
        const name = cleanFileName(raw);
        const result = deleteFileFromDisk(name);
        if (result.error) return sendJson(res, 500, {ok: false, error: result.error});
        if (result.deleted.length) deleted.push(name);
        else notFound.push(name);
      }
      return sendJson(res, 200, {ok: true, deleted, notFound});
    });
    return;
  }

  // list downloaded files, with paging/search/sort:
  //   GET /files?page=1&pageSize=20&q=query&sort=time|name|size
  if (req.method === 'GET' && url === '/files') {
    const q = parseQuery(req.url.split('?')[1] || '');
    const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize || '20', 10) || 20));
    const query = (q.q || '').toLowerCase();
    const sort = q.sort || 'time';

    let files;
    try {
      files = readFiles();
    } catch (err) {
      return sendJson(res, 500, {ok: false, error: String(err.message || err)});
    }

    if (query) files = files.filter((f) => f.name.toLowerCase().includes(query));
    if (sort === 'name') files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    else if (sort === 'size') files.sort((a, b) => a.size - b.size);
    else files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

    const total = files.length;
    const start = (page - 1) * pageSize;
    const pageFiles = files.slice(start, start + pageSize);
    return sendJson(res, 200, {ok: true, files: pageFiles, total, page, pageSize});
  }

  // stream a file back to the browser (inline preview / re-download):
  //   GET /files/<name>
  if (req.method === 'GET' && url.startsWith('/files/')) {
    const name = cleanFileName(url.slice('/files/'.length));
    const target = path.join(DOWNLOAD_DIR, name);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return sendJson(res, 404, {ok: false, error: 'not found'});
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': fs.statSync(target).size,
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store'
    });
    fs.createReadStream(target).pipe(res);
    return;
  }

  // in-flight upload sessions (live progress)
  if (req.method === 'GET' && url === '/status') {
    const active = [...sessions.entries()].map(([name, s]) => {
      let bytes = 0;
      try {
        bytes = fs.statSync(s.tmpPath).size;
      } catch (e) {
        /* temp file not flushed yet */
      }
      return {name, received: s.received, parts: s.parts, bytes};
    });
    return sendJson(res, 200, {ok: true, active});
  }

  // delete a downloaded file from the NAS (also aborts an in-flight upload)
  if (req.method === 'DELETE' && url.startsWith('/files/')) {
    const name = cleanFileName(url.slice('/files/'.length));
    const result = deleteFileFromDisk(name);
    if (result.error) return sendJson(res, 500, {ok: false, error: result.error});
    if (!result.deleted.length) return sendJson(res, 404, {ok: false, error: 'not found'});
    return sendJson(res, 200, {ok: true, deleted: result.deleted});
  }

  if (req.method === 'POST' && url === '/upload') {
    const fileName = cleanFileName(req.headers['x-filename']);
    const part = Number(req.headers['x-part'] || 0);
    const parts = Number(req.headers['x-parts'] || 1);
    const isLast = part === parts - 1;

    let session = sessions.get(fileName);
    if (!session) {
      const tmpPath = path.join(DOWNLOAD_DIR, `.${fileName}.part`);
      const stream = fs.createWriteStream(tmpPath, {flags: 'a'});
      session = {tmpPath, stream, received: 0, parts};
      sessions.set(fileName, session);
    }

    session.stream.on('error', (err) => {
      sessions.delete(fileName);
      sendJson(res, 500, {ok: false, error: String(err.message || err)});
    });

    req.pipe(session.stream, {end: false});
    req.on('end', () => {
      session.received++;
      if (!isLast) {
        return sendJson(res, 200, {ok: true, received: session.received, complete: false});
      }

      const stream = session.stream;
      sessions.delete(fileName);
      stream.end(() => {
        const target = finalName(DOWNLOAD_DIR, fileName);
        fs.rename(session.tmpPath, target, (err) => {
          if (err) {
            return sendJson(res, 500, {ok: false, error: String(err.message || err)});
          }
          let mtime, size;
          try {
            const st = fs.statSync(target);
            mtime = st.mtime.toISOString();
            size = st.size;
          } catch (e) {
            /* ignore */
          }
          sendJson(res, 200, {
            ok: true,
            complete: true,
            filename: path.basename(target),
            path: target,
            parts: session.received,
            size,
            mtime
          });
        });
      });
    });
    req.on('error', (err) => {
      sessions.delete(fileName);
      session.stream.destroy();
      sendJson(res, 500, {ok: false, error: String(err.message || err)});
    });
    return;
  }

  sendJson(res, 404, {ok: false, error: 'not found'});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`telegram-web-dl listening on :${PORT}, dir=${DOWNLOAD_DIR}`);
});