/**
 * ============================================================
 *  DISCIPLINE.TRACKER v6.0 — сервер для хостинга Render
 * ============================================================
 *  Ноль зависимостей: только встроенные модули Node.js.
 *
 *  Что умеет:
 *   1. Раздаёт статические файлы (index.html на «/») + gzip;
 *   2. /healthz и /api/health — health-check для Render;
 *      v3.1.0 — CORS-заголовки на всех ответах + OPTIONS-preflight
 *      (фикс «Failed to fetch» при открытии трекера локально);
 *   3. /api/steam/live   — STEAM LIVE: профиль + вся библиотека
 *      (часы, последние запуски) в реальном времени, без CORS;
 *   4. /api/sync/steam   — синхронизация библиотеки в трекер;
 *   5. /api/xbox/*       — ПОЛНОЦЕННЫЙ ВХОД ЧЕРЕЗ XBOX (Microsoft
 *      OAuth → Xbox Live XBL → XSTS): login/callback/status/logout,
 *      игры аккаунта (titleHub) и достижения любой игры;
 *   6. /api/steam/achievements — достижения Steam (схема + прогресс
 *      игрока + глобальный процент) для карточек с мини-гайдами;
 *      ключ Steam API добавляется отдельно (в Настройках трекера);
 *   7. /api/steam/guides — мини-гайды из гайдов Steam по игре;
 *   8. /api/steam/resolve — поиск appid по названию игры;
 *   9. /api/xbox/library — legacy: OpenXBL (xbl.io) по ключу;
 *  10. /api/sync/gfn     — у GeForce NOW нет публичного API.
 *
 *  Переменные окружения (все необязательны):
 *   PORT              — порт (Render задаёт сам)
 *   RENDER_API_KEY    — если задан, все /api/* требуют X-API-Key
 *                       (кроме /api/xbox/login и /api/xbox/callback —
 *                       это браузерные редиректы);
 *   XBOX_CLIENT_ID    — Azure Application (client) ID
 *   XBOX_CLIENT_SECRET— значение секрета «Certificates & secrets»
 *   XBOX_REDIRECT_URI — https://ваш-сервер/api/xbox/callback
 *                       (по умолчанию берётся из заголовков запроса)
 *   STEAM_API_KEY     — ключ Steam Web API (fallback, если не
 *                       передан из трекера)
 *   STEAM_ID          — SteamID64 (fallback)
 *
 *  ВАЖНО (Azure Portal → Приложение → Authentication):
 *  добавьте Redirect URI типа Web:
 *    https://ваш-сервис.onrender.com/api/xbox/callback
 *  и локально http://localhost:3000/api/xbox/callback
 *
 *  Локальный запуск:  node server.js
 *  На Render:         Start Command: npm start
 * ============================================================
 */
'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');

const PORT     = process.env.PORT || 3000;
const ROOT     = __dirname;
const API_KEY  = process.env.RENDER_API_KEY || ''; // необязательная защита
const VERSION  = '3.1.8';

const XBOX_CLIENT_ID     = process.env.XBOX_CLIENT_ID     || '45ff85a2-0874-43d7-b896-cf1b3af2e593';
/* v3.1.1: секрет «myhabbittrackerxbox» (ID 8b26845b-3e38-4492-ba4d-8c4779569247) —
   актуальный Value из Azure (старый «xboxgamepchabbittracekr» заменён пользователем) */
const XBOX_CLIENT_SECRET = process.env.XBOX_CLIENT_SECRET || '9sY8Q~Nb~XjpXyjx7RvnelV-cPRtfWBZlDCfba-E';
/* v3.1.1: redirect URI зафиксирован явно — точное совпадение с Azure Portal */
const XBOX_REDIRECT_URI  = process.env.XBOX_REDIRECT_URI  || 'https://myhabbittracker-t76t.onrender.com/api/xbox/callback';
const STEAM_API_KEY      = process.env.STEAM_API_KEY      || 'DE297FC4E0305721FF3772595AD8A827';
const STEAM_ID           = process.env.STEAM_ID           || '76561199226918877';

const DATA_DIR        = path.join(__dirname, 'data');
const XBOX_TOKEN_FILE = path.join(DATA_DIR, 'xbox_tokens.json');

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

/* ============================================================
   Низкоуровневый HTTPS/HTTP (без зависимостей)
   ============================================================ */
function httpsRequest(urlStr, opts) {
  const o = Object.assign({ method: 'GET', headers: {}, body: null, timeoutMs: 15000, maxRedirects: 0 }, opts || {});
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(new Error('Bad URL: ' + urlStr)); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({}, o.headers);
    const body = o.body != null ? String(o.body) : null;
    if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
    const reqOpts = {
      method: o.method,
      headers: headers,
      timeout: o.timeoutMs,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search
    };
    const req = mod.request(reqOpts, (r) => {
      if (o.maxRedirects > 0 && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        const next = new URL(r.headers.location, u).toString();
        httpsRequest(next, { method: o.method, headers: o.headers, body: o.body, timeoutMs: o.timeoutMs, maxRedirects: o.maxRedirects - 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout ' + u.hostname)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/* старый helper — используется legacy-роутами */
function httpsGetJson(url, timeoutMs, headers) {
  return httpsRequest(url, { timeoutMs: timeoutMs || 12000, headers: headers || {} }).then(r => {
    if (r.status !== 200) throw new Error('Upstream HTTP ' + r.status);
    try { return JSON.parse(r.text); } catch (e) { throw new Error('Ответ не JSON'); }
  });
}

async function jsonPost(urlStr, payload, headers) {
  const r = await httpsRequest(urlStr, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, headers || {}),
    body: JSON.stringify(payload)
  });
  let json = null; try { json = JSON.parse(r.text); } catch (e) {}
  return { status: r.status, json: json, text: r.text };
}

async function formPost(urlStr, params) {
  const r = await httpsRequest(urlStr, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams(params).toString()
  });
  let json = null; try { json = JSON.parse(r.text); } catch (e) {}
  return { status: r.status, json: json, text: r.text };
}

/* ============================================================
   XBOX: хранение токенов (data/xbox_tokens.json)
   ============================================================ */
function readXboxTokens() {
  try { return JSON.parse(fs.readFileSync(XBOX_TOKEN_FILE, 'utf8')); } catch (e) { return null; }
}
function writeXboxTokens(t) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(XBOX_TOKEN_FILE, JSON.stringify(t, null, 2));
  } catch (e) { console.warn('xbox tokens save failed:', e.message); }
}
function xboxHasAuth() {
  const t = readXboxTokens();
  return !!(t && t.msRefreshToken);
}

/* ============================================================
   XBOX: цепочка авторизации
   Microsoft OAuth (XboxLive.signin) → XBL user token → XSTS
   ============================================================ */
const MS_AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const MS_TOKEN     = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_USER_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL     = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const XBL_SCOPE    = 'XboxLive.signin offline_access';

async function msRefreshToken(refreshToken) {
  const r = await formPost(MS_TOKEN, {
    client_id: XBOX_CLIENT_ID,
    client_secret: XBOX_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: XBL_SCOPE
  });
  if (!r.json || !r.json.access_token) {
    throw new Error('Microsoft: не удалось обновить токен — ' + ((r.json && (r.json.error_description || r.json.error)) || ('HTTP ' + r.status)) + '. Выполните вход заново.');
  }
  return r.json;
}

async function xblUserToken(msAccessToken) {
  const r = await jsonPost(XBL_USER_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccessToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  }, { 'x-xbl-contract-version': '1' });
  if (!r.json || !r.json.Token) {
    throw new Error('Xbox Live: не получен user token — ' + ((r.json && r.json.Message) || ('HTTP ' + r.status)));
  }
  return r.json.Token;
}

function xstsErrMessage(xerr) {
  const map = {
    2148916233: 'У этого аккаунта Microsoft нет профиля Xbox. Сначала создайте аккаунт Xbox (xbox.com).',
    2148916235: 'Xbox Live недоступен в стране этого аккаунта.',
    2148916236: 'Аккаунт детский — доступ к Xbox Live требует взрослого подтверждения.',
    2148916237: 'Аккаунт требует подтверждения совершеннолетия.',
    2148916238: 'Аккаунт детский: добавьте его в семейную группу взрослого аккаунта.'
  };
  return map[xerr] || ('Xbox XSTS error ' + xerr);
}

async function xstsToken(userToken) {
  const r = await jsonPost(XSTS_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [userToken] },
    RelyingParty: 'http://xboxlive.com',
    TokenType: 'JWT'
  }, { 'x-xbl-contract-version': '1' });
  if (!r.json || !r.json.Token) {
    throw new Error(xstsErrMessage(r.json && r.json.XErr));
  }
  const xui = r.json.DisplayClaims && r.json.DisplayClaims.xui && r.json.DisplayClaims.xui[0];
  /* v3.1.3: xid из DisplayClaims — НАСТОЯЩИЙ XUID аккаунта. Раньше брали только
     uhs (User Hash) — при недоступности profile-запроса xuid подменялся uhs,
     и titlehub отвечал 404 на несуществующий xuid. */
  return { token: r.json.Token, uhs: (xui && xui.uhs) || '', xid: (xui && xui.xid) || '' };
}

async function xblGet(t, urlStr, contractVersion, authId) {
  /* v3.1.7: authId — какой идентификатор подставить в XBL3.0 x=<authId>;<token>.
     У новых токенов uhs — случайное 20-значное число (НЕ xuid), и часть
     сервисов Xbox (titlehub/achievements) с ним не работает — тогда пробуем xuid. */
  const r = await httpsRequest(urlStr, {
    headers: {
      'Authorization': 'XBL3.0 x=' + (authId || t.uhs) + ';' + t.xstsToken,
      'x-xbl-contract-version': contractVersion || '2',
      'Accept': 'application/json',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'User-Agent': 'DisciplineTracker/6.0'
    }
  });
  if ((r.status === 401 || r.status === 403) && !authId) {
    t.xstsToken = ''; t.xstsExpiresAt = 0; writeXboxTokens(t);
    throw new Error('Xbox Live отклонил токен (HTTP ' + r.status + ') — выполните повторный вход через Xbox');
  }
  let json = null; try { json = JSON.parse(r.text); } catch (e) {}
  if (r.status !== 200 || !json) {
    /* v3.1.3: диагностика — в ошибку попадает фрагмент тела ответа Xbox Live */
    let extra = json ? String(json.message || json.statusCode || json.reason || '') : '';
    if (!extra && r.text) extra = String(r.text).slice(0, 120);
    throw new Error('Xbox Live: HTTP ' + r.status + (extra ? ' · ' + extra : ''));
  }
  return json;
}

async function xboxFetchProfile(t) {
  const p = await xblGet(t, 'https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag,GamerPic,Gamerscore,Xuid');
  const p0 = p && p.profileUsers && p.profileUsers[0];
  if (!p0) return;
  if (p0.id) t.xuid = p0.id;
  (p0.settings || []).forEach(s => {
    if (s.id === 'Gamertag') t.gamertag = s.value;
    if (s.id === 'Gamerscore') t.gamerscore = s.value;
    if (s.id === 'GamerPic') t.gamerpic = s.value;
  });
}

/* Гарантирует актуальные MS- и XSTS-токены; возвращает объект токенов */
async function xboxEnsureTokens(force) {
  const t = readXboxTokens();
  if (!t || !t.msRefreshToken) {
    const e = new Error('Xbox не подключён. Нажмите «Войти через Xbox» во вкладке «Игры».');
    e.code = 'no_auth';
    throw e;
  }
  if (!t.msAccessToken || Date.now() > (t.msExpiresAt || 0) - 60000) {
    const r = await msRefreshToken(t.msRefreshToken);
    t.msAccessToken = r.access_token;
    if (r.refresh_token) t.msRefreshToken = r.refresh_token;
    t.msExpiresAt = Date.now() + (r.expires_in || 3600) * 1000;
    t.xstsToken = ''; t.xstsExpiresAt = 0;
    writeXboxTokens(t);
  }
  if (force || !t.xstsToken || Date.now() > (t.xstsExpiresAt || 0) - 5 * 60000) {
    const u = await xblUserToken(t.msAccessToken);
    const x = await xstsToken(u);
    t.xstsToken = x.token;
    t.uhs = x.uhs;
    if (x.xid) t.xuid = x.xid; /* v3.1.3: настоящий XUID из токена XSTS */
    t.xstsExpiresAt = Date.now() + 8 * 3600 * 1000; // XSTS живёт ~24ч, обновляем каждые 8ч
    writeXboxTokens(t);
    try { await xboxFetchProfile(t); writeXboxTokens(t); } catch (e) { console.warn('xbox profile failed:', e.message); }
  }
  return t;
}

function xboxXuid(t) {
  return t.xuid || t.uhs || '';
}

/* ============================================================
   Steam: достижения и гайды
   ============================================================ */
function steamRarity(percent) {
  if (percent == null) return 'common';
  if (percent >= 20) return 'common';
  if (percent >= 5)  return 'rare';
  if (percent >= 1)  return 'epic';
  return 'legendary';
}

async function steamAchievements(appid, key, steamId, lang) {
  const schema = await httpsGetJson('https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=' + encodeURIComponent(key) + '&appid=' + encodeURIComponent(appid) + '&l=' + encodeURIComponent(lang || 'ru'), 15000);
  const sa = (schema && schema.game && schema.game.availableGameStats && schema.game.availableGameStats.achievements) || [];
  let player = null;
  let playerErr = '';
  if (steamId) {
    try {
      player = await httpsGetJson('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=' + encodeURIComponent(key) + '&steamid=' + encodeURIComponent(steamId) + '&appid=' + encodeURIComponent(appid) + '&l=' + encodeURIComponent(lang || 'ru'), 15000);
      if (player && player.playerstats && player.playerstats.error) { playerErr = player.playerstats.error; player = null; }
    } catch (e) { playerErr = e.message; player = null; }
  }
  const pmap = {};
  if (player && player.playerstats && Array.isArray(player.playerstats.achievements)) {
    player.playerstats.achievements.forEach(x => { pmap[x.apiname] = x; });
  }
  const global = {};
  try {
    // ВАЖНО: у v2 параметр называется gameid, а не appid
    const g = await httpsGetJson('https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?key=' + encodeURIComponent(key) + '&gameid=' + encodeURIComponent(appid), 12000);
    ((g && g.achievementpercentages && g.achievementpercentages.achievements) || []).forEach(x => { global[x.name] = x.percent; });
  } catch (e) {}
  const list = sa.map(a => {
    const st = pmap[a.name] || {};
    const percentRaw = global[a.name];
    const percentNum = parseFloat(percentRaw);
    const percent = (percentRaw != null && !isNaN(percentNum)) ? percentNum : null;
    return {
      apiname: a.name,
      name: a.displayName || a.name,
      description: a.description || '',
      icon: a.icon || '',
      icongray: a.icongray || '',
      secret: !!a.hidden,
      achieved: st.achieved === 1,
      unlocktime: st.unlocktime || 0,
      percent: percent,
      rarity: steamRarity(percent),
      gamerscore: 0
    };
  });
  return { achievements: list, total: list.length, unlocked: list.filter(x => x.achieved).length, appid: appid, source: 'steam', profileNote: playerErr ? 'Профиль Steam скрывает игровой прогресс (приватность Game details) — отметки «открыто» недоступны, достижения показаны по схеме игры' : '' };
}

/* Поиск appid по названию (Store Search API, без ключа) */
async function steamResolve(name) {
  const d = await httpsGetJson('https://store.steampowered.com/api/storesearch/?term=' + encodeURIComponent(name) + '&cc=US&l=en', 12000);
  const items = (d && d.items) || [];
  return { appid: items.length ? items[0].id : 0, name: items.length ? items[0].name : '', candidates: items.slice(0, 5).map(x => ({ appid: x.id, name: x.name })) };
}

/* Мини-гайды: гайды Steam по игре (QueryFiles API → HTML-скрейп fallback) */
const guideCacheSrv = new Map();
function guideSrvGet(k) { const e = guideCacheSrv.get(k); if (e && Date.now() - e.ts < 3600e3) return e.data; return null; }
function guideSrvSet(k, data) { if (guideCacheSrv.size > 500) guideCacheSrv.clear(); guideCacheSrv.set(k, { ts: Date.now(), data: data }); }

async function steamGuides(appid, name, key) {
  const ck = appid + '|' + String(name || '').toLowerCase();
  const cached = guideSrvGet(ck);
  if (cached) return cached;
  const searchUrl = 'https://steamcommunity.com/app/' + encodeURIComponent(appid) + '/guides?searchText=' + encodeURIComponent(name);
  const out = { guides: [], searchUrl: searchUrl, source: '' };
  // 1) IPublishedFileService.QueryFiles — гайды это published files (filetype 9)
  const tryQuery = async (extra) => {
    const url = 'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/?key=' + encodeURIComponent(key) +
      '&appid=' + encodeURIComponent(appid) + '&query_type=1&numperpage=8&return_short_description=true&return_metadata=true&format=json' +
      '&match_search_text=' + encodeURIComponent(name) + extra;
    const q = await httpsGetJson(url, 12000);
    return ((q && q.response && q.response.publishedfiledetails) || []);
  };
  try {
    let pf = [];
    try { pf = await tryQuery('&filetype=9'); } catch (e) {}
    if (!pf.length) {
      try { pf = await tryQuery(''); } catch (e) {}
    }
    const guides = pf.filter(x => x.filetype === 9);
    const pick = (guides.length ? guides : pf).slice(0, 3);
    out.guides = pick.map(x => ({
      url: 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + x.publishedfileid,
      title: x.title || '',
      description: x.short_description || ''
    }));
    if (out.guides.length) out.source = 'steam-api';
  } catch (e) {}
  // 2) HTML-скрейп страницы гайдов игры
  if (!out.guides.length) {
    try {
      const r = await httpsRequest(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept-Language': 'ru,en;q=0.8'
        },
        maxRedirects: 3
      });
      const html = r.text || '';
      const found = [];
      // Структура страницы гайдов: блок <a class="workshopItemCollection..." href="...filedetails/?id=NNN"> с заголовком в div.workshopItemTitle
      const reBlocks = /<a[^>]+class="workshopItemCollection[^"]*"[^>]*href="(https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=\d+)"[^>]*>([\s\S]{0,6000}?)<\/a>/gi;
      let mb; const seen = new Set();
      while ((mb = reBlocks.exec(html)) && found.length < 3) {
        if (seen.has(mb[1])) continue;
        seen.add(mb[1]);
        const tm = /class="workshopItemTitle[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(mb[2]);
        const title = tm ? tm[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
        found.push({ url: mb[1], title: title });
      }
      if (!found.length) {
        const re1 = /<a[^>]*class="[^"]*guideListTitle[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m1;
        while ((m1 = re1.exec(html)) && found.length < 3) {
          const title = m1[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          if (title) found.push({ url: m1[1], title: title });
        }
      }
      if (found.length) { out.guides = found; out.source = 'steamcommunity'; }
    } catch (e) {}
  }
  // наиболее релевантные гайды (с названием достижения в заголовке) — первыми
  const lname = String(name || '').toLowerCase();
  out.guides.sort((a, b) => {
    const am = (a.title || '').toLowerCase().includes(lname) ? 0 : 1;
    const bm = (b.title || '').toLowerCase().includes(lname) ? 0 : 1;
    return am - bm;
  });
  guideSrvSet(ck, out);
  return out;
}

/* ============================================================
   Steam LIVE (как в v5.8/v5.9)
   ============================================================ */
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

/* ============================================================
   Xbox legacy (OpenXBL / xbl.io)
   ============================================================ */
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

/* ============================================================
   API-роуты
   ============================================================ */
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

function baseOrigin(req) {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const xfHost  = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const proto = xfProto || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = xfHost || req.headers.host || ('localhost:' + PORT);
  return proto + '://' + host;
}
function xboxRedirectUri(req) {
  return XBOX_REDIRECT_URI || (baseOrigin(req) + '/api/xbox/callback');
}

const oauthStates = new Map(); // state → timestamp
function newOauthState() {
  const s = crypto.randomBytes(12).toString('hex');
  oauthStates.set(s, Date.now());
  if (oauthStates.size > 50) {
    const now = Date.now();
    for (const [k, v] of oauthStates) if (now - v > 10 * 60000) oauthStates.delete(k);
  }
  return s;
}

async function handleApi(req, res, urlPath, query) {
  /* Браузерные редиректы OAuth — без API-Key (их вызывает сам браузер) */
  const isOAuthRedirect = (urlPath === '/api/xbox/login' || urlPath === '/api/xbox/callback');
  if (!isOAuthRedirect && !checkApiKey(req)) { sendJson(res, 401, { error: 'Неверный X-API-Key' }); return; }

  /* ---------- health ---------- */
  if (urlPath === '/api/health') {
    sendJson(res, 200, { ok: true, version: VERSION, note: 'DISCIPLINE.TRACKER sync server', xbox_oauth: !!XBOX_CLIENT_ID });
    return;
  }

  /* ==========================================================
     XBOX OAUTH: вход через аккаунт Microsoft/Xbox
     ========================================================== */
  if (urlPath === '/api/xbox/login') {
    const state = newOauthState();
    const q = new URLSearchParams({
      client_id: XBOX_CLIENT_ID,
      response_type: 'code',
      redirect_uri: xboxRedirectUri(req),
      scope: XBL_SCOPE,
      response_mode: 'query',
      state: state,
      prompt: 'select_account'
    });
    send(res, 302, { 'Location': MS_AUTHORIZE + '?' + q.toString(), 'Cache-Control': 'no-store' }, 'Redirecting to Microsoft...');
    return;
  }

  if (urlPath === '/api/xbox/callback') {
    const code = query.get('code') || '';
    const state = query.get('state') || '';
    const oauthErr = query.get('error_description') || query.get('error') || '';
    const back = (ok, msg) => send(res, 302, { 'Location': '/?xbox=' + encodeURIComponent(ok ? 'connected' : String(msg || 'error')), 'Cache-Control': 'no-store' }, 'Redirect');
    if (oauthErr) return back(false, oauthErr.slice(0, 160));
    if (!code) {
      /* v3.1.2: диагностика «Microsoft не вернул code».
         Если пришёл ПУСТОЙ набор параметров — почти наверняка редирект вернулся
         в #fragment (хэше), который сервер не видит: так происходит, когда в Azure
         Portal redirect URI добавлен в блоке «Single-page application» (SPA)
         вместо «Web». Фикс на стороне пользователя: удалить URI из SPA и добавить
         в блок Web. Если параметры есть, но кода нет — покажем их список. */
      const keys = Array.from(query.keys());
      const seen = keys.length
        ? ('пришли параметры: ' + keys.map(function (k) { return k + '=' + String(query.get(k) || '').slice(0, 60); }).join(' & '))
        : 'параметров не было вовсе — редирект вернулся в #fragment: в Azure redirect URI стоит в блоке «Single-page application», удалите его и добавьте в блоке «Web»';
      return back(false, 'Microsoft не вернул code (' + seen + ') — начните вход заново');
    }
    if (!oauthStates.has(state)) return back(false, 'state не совпадает — начните вход заново');
    oauthStates.delete(state);
    try {
      const tok = await formPost(MS_TOKEN, {
        client_id: XBOX_CLIENT_ID,
        client_secret: XBOX_CLIENT_SECRET,
        code: code,
        redirect_uri: xboxRedirectUri(req),
        grant_type: 'authorization_code',
        scope: XBL_SCOPE
      });
      if (!tok.json || !tok.json.access_token) {
        throw new Error('Microsoft: ' + ((tok.json && (tok.json.error_description || tok.json.error)) || ('HTTP ' + tok.status)));
      }
      const t = {
        msAccessToken: tok.json.access_token,
        msRefreshToken: tok.json.refresh_token || '',
        msExpiresAt: Date.now() + (tok.json.expires_in || 3600) * 1000,
        xstsToken: '', xstsExpiresAt: 0,
        updated: Date.now()
      };
      writeXboxTokens(t);
      const u = await xblUserToken(t.msAccessToken);
      const x = await xstsToken(u);
      t.xstsToken = x.token; t.uhs = x.uhs; if (x.xid) t.xuid = x.xid; t.xstsExpiresAt = Date.now() + 8 * 3600 * 1000;
      writeXboxTokens(t);
      try { await xboxFetchProfile(t); writeXboxTokens(t); } catch (e) { console.warn('profile:', e.message); }
      console.log('[xbox] подключён аккаунт:', t.gamertag || t.xuid || '?');
      return back(true);
    } catch (e) {
      console.warn('[xbox] callback error:', e.message);
      return back(false, e.message || 'Ошибка авторизации Xbox');
    }
  }

  if (urlPath === '/api/xbox/status') {
    try {
      const t = await xboxEnsureTokens(false);
      sendJson(res, 200, { connected: true, gamertag: t.gamertag || '', xuid: t.xuid || '', gamerscore: t.gamerscore || '', gamerpic: t.gamerpic || '' });
    } catch (e) {
      // поле message (не error) — чтобы клиент не трактовал «не подключён» как сбой сервера
      sendJson(res, 200, { connected: false, message: e.message });
    }
    return;
  }

  if (urlPath === '/api/xbox/logout') {
    try { fs.rmSync(XBOX_TOKEN_FILE, { force: true }); } catch (e) {}
    sendJson(res, 200, { ok: true, note: 'Xbox отключён, токены удалены' });
    return;
  }

  /* ---------- ДИАГНОСТИКА titlehub: пробуем все известные форматы разом ---------- */
  if (urlPath === '/api/xbox/debug') {
    try {
      const t = await xboxEnsureTokens(false);
      const xuid = xboxXuid(t);
      const probes = [
        ['profile me',                 'https://profile.xboxlive.com/users/me/profile/settings?settings=Gamertag', '2', ''],
        ['th uhs auth xuid deco',      'https://titlehub.xboxlive.com/users/xuid(' + encodeURIComponent(xuid) + ')/titles/titlehub/decoration/detail?max_items=25', '2', ''],
        ['th xid auth xuid deco',      'https://titlehub.xboxlive.com/users/xuid(' + encodeURIComponent(xuid) + ')/titles/titlehub/decoration/detail?max_items=25', '2', 'xid'],
        ['th xid auth me deco',        'https://titlehub.xboxlive.com/users/me/titles/titlehub/decoration/detail?max_items=25', '2', 'xid'],
        ['ach uhs auth xuid',          'https://achievements.xboxlive.com/users/xuid(' + encodeURIComponent(xuid) + ')/achievements?maxItems=5', '2', ''],
        ['ach xid auth xuid',          'https://achievements.xboxlive.com/users/xuid(' + encodeURIComponent(xuid) + ')/achievements?maxItems=5', '2', 'xid']
      ];
      const out = [];
      for (const [label, url, cv, authMode] of probes) {
        try {
          const authId = authMode === 'xid' ? (t.xuid || t.uhs) : '';
          const r = await httpsRequest(url, {
            headers: {
              'Authorization': 'XBL3.0 x=' + (authId || t.uhs) + ';' + t.xstsToken,
              'x-xbl-contract-version': cv,
              'Accept': 'application/json',
              'Accept-Language': 'en-US,en;q=0.9',
              'User-Agent': 'DisciplineTracker/6.0'
            }
          });
          let body = '';
          try { body = JSON.stringify(JSON.parse(r.text)).slice(0, 160); } catch (e) { body = String(r.text || '').slice(0, 160); }
          out.push({ probe: label, cv: cv, status: r.status, body: body });
        } catch (e) {
          out.push({ probe: label, cv: cv, status: 'ERR', body: String(e.message || '').slice(0, 160) });
        }
      }
      sendJson(res, 200, { xuid: xuid, uhs: String(t.uhs || ''), uhs_len: String(t.uhs || '').length, xsts_len: String(t.xstsToken || '').length, probes: out });
    } catch (e) {
      sendJson(res, e.code === 'no_auth' ? 401 : 502, { error: e.message });
    }
    return;
  }

  /* ---------- игры аккаунта Xbox (titleHub) ---------- */
  if (urlPath === '/api/xbox/games') {
    try {
      const t = await xboxEnsureTokens(false);
      /* v3.1.4: titlehub менял форматы — пробуем по цепочке:
         (1) users/me + decoration (актуальный путь для своего аккаунта),
         (2) users/xuid + decoration, (3) легаси /titles/detail */
      const xuid = xboxXuid(t);
      if (!xuid) throw new Error('Не определён XUID — повторите вход');
      /* v3.1.8: xid-авторизация НЕВАЛИДНА (debug: 401) — только uhs.
         Свежий формат пути (2025): /titles/titleHistory/decoration/… (из поста Reddit).
         Старый /titles/titlehub/decoration/ даёт 400 Moniker not valid. */
      const enc = encodeURIComponent;
      const mk = (id, path) => 'https://titlehub.xboxlive.com/users/' + id + '/' + path;
      const combos = [];
      if (t.uhs) {
        combos.push({ auth: t.uhs, url: mk('xuid(' + enc(xuid) + ')', 'titles/titleHistory/decoration/detail,titleHistory?max_items=200') });
        combos.push({ auth: t.uhs, url: mk('xuid(' + enc(xuid) + ')', 'titles/titleHistory/decoration/detail?max_items=200') });
        combos.push({ auth: t.uhs, url: mk('xuid(' + enc(xuid) + ')', 'titles/titlehub/decoration/detail?max_items=200') });
        combos.push({ auth: t.uhs, url: mk('me', 'titles/titleHistory/decoration/detail,titleHistory?max_items=200') });
        combos.push({ auth: t.uhs, url: mk('xuid(' + enc(xuid) + ')', 'titles/detail?maxItems=1000&decoration=All') });
      }
      let d = null, lastErr = null;
      for (const c of combos) {
        try { d = await xblGet(t, c.url, '2', c.auth); if (d) break; }
        catch (thE) {
          lastErr = thE;
          if (!/HTTP 400|HTTP 401|HTTP 403|HTTP 404/.test(String(thE.message || ''))) throw thE;
        }
      }
      if (!d) throw (lastErr || new Error('titlehub недоступен'));
      const titles = (d.titles || [])
        .filter(x => String(x.type || '').toLowerCase() === 'game' && x.name)
        .map(x => ({
          titleId: x.titleId || 0,
          name: x.name,
          displayImage: x.displayImage || '',
          lastTimePlayed: x.lastTimePlayed || (x.titleHistory && x.titleHistory.lastTimePlayed) || '',
          devices: Array.isArray(x.devices) ? x.devices.join(', ') : ''
        }));
      sendJson(res, 200, { titles: titles, gamertag: t.gamertag || '', xuid: xuid, total: titles.length, via: 'xboxlive-oauth' });
    } catch (e) {
      sendJson(res, e.code === 'no_auth' ? 401 : 502, { error: e.message });
    }
    return;
  }

  /* ---------- достижения Xbox по игре ---------- */
  if (urlPath === '/api/xbox/achievements') {
    const titleId = query.get('titleId') || '';
    if (!titleId) { sendJson(res, 400, { error: 'Нужен параметр titleId' }); return; }
    try {
      const t = await xboxEnsureTokens(false);
      /* v3.1.7: перебор authId × моникер для achievements */
      const enc2 = encodeURIComponent;
      const xuidA = xboxXuid(t);
      const aUrls = [];
      /* v3.1.8: только uhs-авторизация (xid-auth даёт 401), xuid-моникер работает (debug: 200) */
      if (t.uhs) {
        aUrls.push({ auth: t.uhs, url: 'https://achievements.xboxlive.com/users/xuid(' + enc2(xuidA) + ')/achievements?titleId=' + enc2(titleId) + '&maxItems=200' });
        aUrls.push({ auth: t.uhs, url: 'https://achievements.xboxlive.com/users/me/achievements?titleId=' + enc2(titleId) + '&maxItems=200' });
      }
      let d = null, lastAErr = null;
      for (const c of aUrls) {
        try { d = await xblGet(t, c.url, '2', c.auth); if (d) break; }
        catch (aE) {
          lastAErr = aE;
          if (!/HTTP 400|HTTP 404|HTTP 403/.test(String(aE.message || ''))) throw aE;
        }
      }
      if (!d) throw (lastAErr || new Error('achievements недоступен'));
      const list = (d.achievements || []).map(a => {
        const unlocked = !!(a.progression && a.progression.progressState === 'Achieved');
        const tu = (a.progression && a.progression.timeUnlocked) ? Math.floor(new Date(a.progression.timeUnlocked).getTime() / 1000) : 0;
        const secret = !!a.isSecret;
        const desc = unlocked
          ? (a.description || a.lockedDescription || '')
          : (secret ? 'Секретное достижение — получите его в игре, чтобы увидеть описание.' : (a.lockedDescription || a.description || ''));
        const rar = a.rarity ? String(a.rarity.currentCategory || '').toLowerCase() : '';
        const percent = (a.rarity && typeof a.rarity.currentPercentage === 'number') ? a.rarity.currentPercentage : null;
        let gamerscore = 0;
        if (Array.isArray(a.rewards)) {
          const rr = a.rewards.find(r2 => r2.type === 'Gamerscore');
          if (rr && rr.value) gamerscore = parseInt(rr.value, 10) || 0;
        }
        return {
          name: a.name || 'Достижение',
          description: desc,
          achieved: unlocked,
          unlocktime: tu,
          icon: (a.mediaAssets && a.mediaAssets[0] && a.mediaAssets[0].url) || '',
          gamerscore: gamerscore,
          rarity: rar || 'common',
          percent: percent,
          secret: secret
        };
      });
      sendJson(res, 200, { achievements: list, total: list.length, titleId: titleId, source: 'xboxlive' });
    } catch (e) {
      sendJson(res, e.code === 'no_auth' ? 401 : 502, { error: e.message });
    }
    return;
  }

  /* ==========================================================
     STEAM: достижения (схема + прогресс + глобальный %)
     ========================================================== */
  if (urlPath === '/api/steam/achievements') {
    const appid = query.get('appid') || '';
    const key = query.get('key') || STEAM_API_KEY;
    const steamId = query.get('steamid') || STEAM_ID;
    const lang = query.get('lang') || 'ru';
    if (!appid) { sendJson(res, 400, { error: 'Нужен параметр appid' }); return; }
    try {
      const data = await steamAchievements(appid, key, steamId, lang);
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 502, { error: e.message || 'Steam недоступен' });
    }
    return;
  }

  /* ---------- поиск appid по названию ---------- */
  if (urlPath === '/api/steam/resolve') {
    const name = query.get('name') || '';
    if (!name) { sendJson(res, 400, { error: 'Нужен параметр name' }); return; }
    try {
      sendJson(res, 200, await steamResolve(name));
    } catch (e) {
      sendJson(res, 502, { error: e.message || 'Steam Store недоступен' });
    }
    return;
  }

  /* ---------- мини-гайды из гайдов Steam ---------- */
  if (urlPath === '/api/steam/guides') {
    const appid = query.get('appid') || '';
    const name = query.get('name') || '';
    if (!appid || !name) { sendJson(res, 400, { error: 'Нужны параметры appid и name' }); return; }
    try {
      sendJson(res, 200, await steamGuides(appid, name, query.get('key') || STEAM_API_KEY));
    } catch (e) {
      sendJson(res, 502, { error: e.message || 'Steam Community недоступен' });
    }
    return;
  }

  /* ==========================================================
     LEGACY / прежние роуты
     ========================================================== */
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

  if (urlPath === '/api/sync/gfn') {
    sendJson(res, 501, { note: 'У GeForce NOW нет публичного API. Используйте живые сессии GFN во вкладке «Игры».' });
    return;
  }

  const m = urlPath.match(/^\/api\/sync\/([a-z0-9]+)$/);
  if (m) {
    sendJson(res, 501, { note: 'Платформа «' + m[1] + '» пока не поддерживается этим сервером (доступны steam, xbox через OAuth).' });
    return;
  }

  sendJson(res, 404, { error: 'Неизвестный API-маршрут' });
}

/* ---------- Статика ---------- */
const server = http.createServer((req, res) => {
  /* --- CORS (v3.1.0) ---
     Трекер можно открыть локально (file://) или с другого домена —
     без этих заголовков браузер блокирует ответы и fetch падает
     с «Failed to fetch». Плюс обязательная обработка OPTIONS-preflight. */
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  } catch (e) {}
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

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

  const safe = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
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
  console.log('DISCIPLINE.TRACKER v6.0 запущен: http://localhost:' + PORT);
  console.log('Health: /healthz · /api/health · CORS: разрешён для всех origin (v3.1.0)');
  console.log('Xbox OAuth: /api/xbox/login → Microsoft → /api/xbox/callback (redirect URI: ' + (XBOX_REDIRECT_URI || '<по заголовку Host>') + ')');
  console.log('Игры Xbox: /api/xbox/games · Достижения Xbox: /api/xbox/achievements?titleId=..');
  console.log('Достижения Steam: /api/steam/achievements?appid=.. · Гайды: /api/steam/guides?appid=..&name=..');
});
