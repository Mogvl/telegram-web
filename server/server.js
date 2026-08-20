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
 *   GET /health  -> {"ok":true,"dir":"..."}
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

/** Sessions in flight: fileName -> {tmpPath, stream, received} */
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

  if (req.method === 'POST' && url === '/upload') {
    const fileName = cleanFileName(req.headers['x-filename']);
    const part = Number(req.headers['x-part'] || 0);
    const parts = Number(req.headers['x-parts'] || 1);
    const isLast = part === parts - 1;

    let session = sessions.get(fileName);
    if (!session) {
      const tmpPath = path.join(DOWNLOAD_DIR, `.${fileName}.part`);
      const stream = fs.createWriteStream(tmpPath, {flags: 'a'});
      session = {tmpPath, stream, received: 0};
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
          sendJson(res, 200, {
            ok: true,
            complete: true,
            filename: path.basename(target),
            path: target,
            parts: session.received
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