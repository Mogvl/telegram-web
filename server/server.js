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
 *   GET  /health              -> {"ok":true,"dir":...}
 *   GET  /files               -> {"ok":true,"files":[{name,size,mtime,status}]}
 *   GET  /status              -> {"ok":true,"active":[{name,received,parts,bytes}]}
 *   DELETE /files/<name>      -> remove the file (and its temp .part) from the NAS
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

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return sendJson(res, 200, {ok: true, dir: DOWNLOAD_DIR, sessions: sessions.size});
  }

  // list downloaded files (final files only; .part leftovers listed as active)
  if (req.method === 'GET' && url === '/files') {
    let files;
    try {
      files = fs.readdirSync(DOWNLOAD_DIR)
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
        })
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    } catch (err) {
      return sendJson(res, 500, {ok: false, error: String(err.message || err)});
    }
    return sendJson(res, 200, {ok: true, files});
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
        return sendJson(res, 500, {ok: false, error: String(err.message || err)});
      }
    }

    if (!deleted.length) {
      return sendJson(res, 404, {ok: false, error: 'not found'});
    }
    return sendJson(res, 200, {ok: true, deleted});
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
          let mtime;
          try {
            mtime = fs.statSync(target).mtime.toISOString();
          } catch (e) {
            /* ignore */
          }
          sendJson(res, 200, {
            ok: true,
            complete: true,
            filename: path.basename(target),
            path: target,
            parts: session.received,
            size: fs.existsSync(target) ? fs.statSync(target).size : undefined,
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