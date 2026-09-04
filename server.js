/**
 * ============================================================
 *  DISCIPLINE.TRACKER v5.9 — сервер для хостинга Render
 * ============================================================
 *  Ноль зависимостей: только встроенные модули Node.js.
 *
 *  Что умеет:
 *   1. Раздаёт статические файлы (index.html на «/») + gzip;
 *   2. /healthz и /api/health — health-check для Render;
 *   3. /api/steam/live   — STEAM LIVE: профиль + вся библиотека
 *      (часы, последние запуски) в реальном времени, без CORS;
 *   4. /api/sync/steam   — синхронизация библиотеки в трекер
 *      (протокол вкладки «Настройки → Сервер синхронизации игр»);
 *   5. /api/xbox/library — Xbox Game Pass PC через OpenXBL (xbl.io):
 *      GET /api/xbox/library?key=OPENXBL_KEY&xuid=XUID → titleHub;
 *   6. /api/sync/gfn     — честный ответ: у GeForce NOW нет
 *      публичного API (сессии GFN считаются в самом трекере,
 *      новые игры GFN добавляются импортом списка).
 *
 *  Локальный запуск:  node server.js
 *  На Render:         Start Command: npm start (PORT задаётся сам)
 *
 *  Опционально: переменная окружения RENDER_API_KEY — если задана,
 *  все /api/* требуют заголовок X-API-Key с этим значением.
 * ============================================================
 */
'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');

const PORT     = process.env.PORT || 3000;
const ROOT     = __dirname;
const API_KEY  = process.env.RENDER_API_KEY || ''; // необязательная защита
const VERSION  = '2.1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico':  'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.otf':   'font/otf',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const GZIP_TYPES = new Set([
  'text/html', 'application/javascript', 'text/css',
  'application/json', 'image/svg+xml', 'text/plain'
]);

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body);
}

/* ---------- HTTPS GET для Steam Web API и OpenXBL (без зависимостей) ---------- */
function httpsGetJson(url, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs || 12000, headers: headers || {} }, (r) => {
      if (r.statusCode !== 200) {
        r.resume();
        reject(new Error('Upstream HTTP ' + r.statusCode));
        return;
      }
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', c => { raw += c; });
      r.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Ответ не JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Upstream timeout')); });
    req.on('error', reject);
  });
}

/* ---------- Xbox Game Pass PC: OpenXBL titleHub ---------- */
function xboxLibrary(openxblKey, xuid) {
  const url = 'https://xbl.io/app/v2/title/hub/' + encodeURIComponent(xuid) + '?hub=games';
  return httpsGetJson(url, 15000, { 'X-Authorization': openxblKey, 'Accept': 'application/json' })
    .then(data => {
      const titles = (data && Array.isArray(data.titles)) ? data.titles : [];
      return {
        titles: titles.map(t => ({
          name: t.name || t.title || '',
          titleId: t.titleId || 0,
          lastTimePlayed: t.lastTimePlayed || '',
          achievements: t.achievements || null
        })),
        via: 'openxbl'
      };
    });
}

function steamLive(key, steamId) {
  const profUrl = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=' + encodeURIComponent(key) + '&steamids=' + encodeURIComponent(steamId);
  const ownedUrl = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=' + encodeURIComponent(key) + '&steamid=' + encodeURIComponent(steamId) + '&include_appinfo=1&include_played_free_games=1&format=json';
  return Promise.all([
    httpsGetJson(profUrl).catch(() => null),
    httpsGetJson(ownedUrl)
  ]).then(([prof, owned]) => ({
    profile: (prof && prof.response && prof.response.players && prof.response.players[0]) || null,
    owned: (owned && owned.response) || {}
  }));
}

/* ---------- API-роуты ---------- */
function checkApiKey(req) {
  if (!API_KEY) return true; // защита не включена
  return (req.headers['x-api-key'] || '') === API_KEY;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); }
    });
  });
}

async function handleApi(req, res, urlPath, query) {
  if (!checkApiKey(req)) { sendJson(res, 401, { error: 'Неверный X-API-Key' }); return; }

  if (urlPath === '/api/health') {
    sendJson(res, 200, { ok: true, version: VERSION, note: 'DISCIPLINE.TRACKER sync server' });
    return;
  }

  if (urlPath === '/api/steam/live') {
    const key = query.get('key') || '';
    const steamId = query.get('steamid') || '';
    if (!key || !steamId) { sendJson(res, 400, { error: 'Нужны параметры key и steamid' }); return; }
    try {
      const data = await steamLive(key, steamId);
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 502, { error: e.message || 'Steam недоступен' });
    }
    return;
  }

  if (urlPath === '/api/sync/steam') {
    const body = await readBody(req);
    const key = body.steam_key || query.get('key') || '';
    const steamId = body.steam_id || query.get('steamid') || '';
    if (!key || !steamId) { sendJson(res, 400, { error: 'Нужны steam_key и steam_id' }); return; }
    try {
      const data = await steamLive(key, steamId);
      const games = ((data.owned && data.owned.games) || []).map(g => ({
        title: g.name,
        platform: 'Steam',
        appid: g.appid,
        playtime_forever: g.playtime_forever || 0,
        coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + g.appid + '/header.jpg'
      }));
      sendJson(res, 200, { games: games, profile: data.profile ? { name: data.profile.personaname } : null });
    } catch (e) {
      sendJson(res, 502, { error: e.message || 'Steam недоступен' });
    }
    return;
  }

  if (urlPath === '/api/xbox/library') {
    const key = query.get('key') || '';
    const xuid = query.get('xuid') || '';
    if (!key || !xuid) { sendJson(res, 400, { error: 'Нужны параметры key (OpenXBL) и xuid' }); return; }
    try {
      const data = await xboxLibrary(key, xuid);
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 502, { error: e.message || 'xbl.io недоступен' });
    }
    return;
  }

  // GeForce NOW: публичного API нет — трекер считает сессии GFN локально,
  // новые игры добавляются импортом списка во вкладке «Игры»
  if (urlPath === '/api/sync/gfn') {
    sendJson(res, 501, { note: 'У GeForce NOW нет публичного API. Используйте живые сессии GFN во вкладке «Игры».' });
    return;
  }

  // Остальные платформы серверного протокола — заглушка с понятным ответом
  const m = urlPath.match(/^\/api\/sync\/([a-z0-9]+)$/);
  if (m) {
    sendJson(res, 501, { note: 'Платформа «' + m[1] + '» пока не поддерживается этим сервером (доступен steam).' });
    return;
  }

  sendJson(res, 404, { error: 'Неизвестный API-маршрут' });
}

/* ---------- Статика ---------- */
const server = http.createServer((req, res) => {
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
    query = u.searchParams;
  } catch (e) {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request');
    return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, query).catch(e => {
      sendJson(res, 500, { error: e.message || 'internal error' });
    });
    return;
  }

  if (pathname === '/healthz') {
    send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' }, 'ok');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
    return;
  }

  fs.stat(filePath, (err, st) => {
    const finalPath = (!err && st.isFile()) ? filePath : path.join(ROOT, 'index.html');
    fs.readFile(finalPath, (err2, data) => {
      if (err2) {
        send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, '404 Not Found');
        return;
      }
      const ext = path.extname(finalPath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': mime,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      };
      const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip')
        && GZIP_TYPES.has(mime.split(';')[0]);
      if (acceptsGzip && data.length > 1024) {
        zlib.gzip(data, (e3, buf) => {
          if (e3) {
            headers['Content-Length'] = data.length;
            send(res, 200, headers, data);
            return;
          }
          headers['Content-Encoding'] = 'gzip';
          headers['Content-Length'] = buf.length;
          send(res, 200, headers, buf);
        });
      } else {
        headers['Content-Length'] = data.length;
        send(res, 200, headers, data);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log('DISCIPLINE.TRACKER v5.9 запущен: http://localhost:' + PORT);
  console.log('Health: /healthz и /api/health · Steam Live: /api/steam/live?key=..&steamid=.. · Xbox: /api/xbox/library?key=..&xuid=..');
});
