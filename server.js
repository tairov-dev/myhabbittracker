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
 *  11. /api/cloud/*      — ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ (v3.3.0): единая база
 *      трекера между телефоном, компьютером и APK/PWA-приложением.
 *      push/pull/status по коду синхронизации (на сервере хранится
 *      только sha256-хэш кода). Данные: data/cloud_db.json.
 *  12. /manifest.webmanifest, /sw.js, /icons/* — PWA (v3.3.0):
 *      трекер ставится как приложение на Android/iOS («Установить
 *      приложение» в Chrome) и работает офлайн; из PWA собирается
 *      настоящий APK через PWABuilder.
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
const VERSION  = '3.3.0';

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

/* v3.1.9: Steam Web API требует ПОЛНОЕ имя языка (l=russian), а не ISO-код (l=ru) —
   с l=ru API МОЛЧА возвращает английские строки (проверено на appid 1091500:
   l=ru → "The Fool", l=russian → "Шут"). Мапим коды в полные имена. */
const STEAM_LANG_NAMES = { ru: 'russian', en: 'english', uk: 'ukrainian', de: 'german', fr: 'french', es: 'spanish', pl: 'polish', pt: 'brazilian', zh: 'schinese', ko: 'koreana', ja: 'japanese', it: 'italian', tr: 'turkish', cs: 'czech' };
function steamLangName(l) {
  const s = String(l || 'ru').trim().toLowerCase();
  if (STEAM_LANG_NAMES[s]) return STEAM_LANG_NAMES[s];
  return (s.length <= 3 ? 'russian' : s); // неизвестный короткий код → русский по умолчанию
}

async function steamAchievements(appid, key, steamId, lang) {
  const langName = steamLangName(lang); // v3.1.9: ru → russian, иначе достижения приходят на английском
  const schema = await httpsGetJson('https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=' + encodeURIComponent(key) + '&appid=' + encodeURIComponent(appid) + '&l=' + encodeURIComponent(langName), 15000);
  const sa = (schema && schema.game && schema.game.availableGameStats && schema.game.availableGameStats.achievements) || [];
  let player = null;
  let playerErr = '';
  if (steamId) {
    try {
      player = await httpsGetJson('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key=' + encodeURIComponent(key) + '&steamid=' + encodeURIComponent(steamId) + '&appid=' + encodeURIComponent(appid) + '&l=' + encodeURIComponent(langName), 15000);
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

function readBody(req, maxBytes) {
  /* v3.3.0: лимит параметром (облачная синхронизация шлёт до ~26MB) */
  const limit = maxBytes || 1e6;
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, dead = false;
    req.on('data', c => {
      if (dead) return;
      size += c.length;
      if (size > limit) { dead = true; try { req.destroy(); } catch (e) {} resolve({}); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); }
    });
    req.on('error', () => { if (!dead) resolve({}); });
  });
}

/* ============================================================
   ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ (v3.3.0)
   Единая база трекера: ПК + телефон + APK. Устройство выгружает
   снимок всех ключей localStorage (dt.*) под кодом синхронизации;
   другие устройства с тем же кодом забирают этот снимок.
   На сервере код хранится ТОЛЬКО как sha256-хэш.
   ============================================================ */
const CLOUD_DB_FILE = path.join(DATA_DIR, 'cloud_db.json');
const CLOUD_MAX_CODES = 20;      // максимум разных кодов (устройств/семей)
const CLOUD_MAX_BODY  = 26e6;    // лимит тела push (снимок всех данных)

function cloudHash(code) {
  return crypto.createHash('sha256').update('dt:' + String(code)).digest('hex');
}
function cloudLoad() {
  try { return JSON.parse(fs.readFileSync(CLOUD_DB_FILE, 'utf8')); } catch (e) { return {}; }
}
function cloudSave(db) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CLOUD_DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, CLOUD_DB_FILE);
  } catch (e) { console.warn('cloud db save failed:', e.message); }
}
function cloudPrune(db) {
  const keys = Object.keys(db);
  if (keys.length <= CLOUD_MAX_CODES) return;
  keys.sort((a, b) => (db[a].ts || 0) - (db[b].ts || 0));
  keys.slice(0, keys.length - CLOUD_MAX_CODES).forEach(k => delete db[k]);
}

async function handleCloudApi(req, res, urlPath, query) {
  if (urlPath === '/api/cloud/push') {
    const body = await readBody(req, CLOUD_MAX_BODY);
    const code = String(body.code || '').trim();
    if (code.length < 4 || code.length > 64) { sendJson(res, 400, { error: 'Код синхронизации: от 4 до 64 символов' }); return; }
    const data = body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) { sendJson(res, 400, { error: 'Нужен объект data (снимок dt.* ключей)' }); return; }
    const db = cloudLoad();
    const k = cloudHash(code);
    const entry = db[k];
    const baseTs = Number(body.baseTs) || 0;
    /* конфликт: на сервере более свежий снимок, чем знал клиент */
    if (entry && entry.ts > baseTs + 2000 && !body.force) {
      sendJson(res, 409, { error: 'conflict', ts: entry.ts, device: entry.device || '' });
      return;
    }
    const ts = Date.now();
    db[k] = { data: data, ts: ts, device: String(body.device || '').slice(0, 60), size: JSON.stringify(data).length };
    cloudPrune(db);
    cloudSave(db);
    console.log('[cloud] push от "' + (db[k].device || '?') + '": ' + Object.keys(data).length + ' ключей, ' + Math.round(db[k].size / 1024) + ' KB, код …' + k.slice(-8));
    sendJson(res, 200, { ok: true, ts: ts });
    return;
  }
  if (urlPath === '/api/cloud/pull') {
    const code = (query.get('code') || '').trim();
    if (!code) { sendJson(res, 400, { error: 'Нужен параметр code' }); return; }
    const e = cloudLoad()[cloudHash(code)];
    if (!e) { sendJson(res, 404, { error: 'not_found' }); return; }
    sendJson(res, 200, { ok: true, data: e.data, ts: e.ts, device: e.device || '' });
    return;
  }
  if (urlPath === '/api/cloud/status') {
    const code = (query.get('code') || '').trim();
    if (!code) { sendJson(res, 400, { error: 'Нужен параметр code' }); return; }
    const e = cloudLoad()[cloudHash(code)];
    if (!e) { sendJson(res, 200, { ok: true, exists: false }); return; }
    sendJson(res, 200, { ok: true, exists: true, ts: e.ts, device: e.device || '', size: e.size || 0 });
    return;
  }
  sendJson(res, 404, { error: 'Неизвестный облачный маршрут' });
}

/* ---------- PWA (v3.3.0): манифест + service worker ---------- */
const PWA_MANIFEST = {
  name: 'DISCIPLINE.TRACKER',
  short_name: 'Трекер',
  description: 'Трекер привычек, дисциплины, финансов и игр — единая база на всех устройствах',
  lang: 'ru',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0F111A',
  theme_color: '#0F111A',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
};
const PWA_SW_JS = [
  "'use strict';",
  "var SW_CACHE = 'dt-shell-v6.3.0';",
  "var SHELL = ['/', '/icons/icon-192.png', '/icons/icon-512.png'];",
  "self.addEventListener('install', function (e) {",
  "  e.waitUntil(caches.open(SW_CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));",
  "});",
  "self.addEventListener('activate', function (e) {",
  "  e.waitUntil(caches.keys().then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== SW_CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));",
  "});",
  "self.addEventListener('fetch', function (e) {",
  "  var req = e.request;",
  "  if (req.method !== 'GET') return;              // POST /api/cloud/push — только сеть",
  "  var url = new URL(req.url);",
  "  if (url.pathname.indexOf('/api/') === 0) return; // API не кэшируем",
  "  if (url.origin !== location.origin) return;      // сторонние (шрифты, leaflet) — мимо",
  "  if (req.mode === 'navigate' || url.pathname === '/') {",
  "    e.respondWith(fetch(req).then(function (r) { try { var cp = r.clone(); caches.open(SW_CACHE).then(function (c) { c.put('/', cp); }); } catch (err) {} return r; }).catch(function () { return caches.match('/'); }));",
  "    return;",
  "  }",
  "  e.respondWith(caches.match(req).then(function (hit) {",
  "    var net = fetch(req).then(function (r) { if (r && r.status === 200) { try { var cp = r.clone(); caches.open(SW_CACHE).then(function (c) { c.put(req, cp); }); } catch (err) {} } return r; }).catch(function () { return hit; });",
  "    return hit || net;",
  "  }));",
  "});"
].join('\n');

/* v3.3.0: PNG-иконки PWA вшиты base64 — server.js остаётся единственным файлом деплоя.
   Значения подставляет scripts/embed_pwa_icons.py между маркерами ниже. */
const ICON_192_B64 = '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';
const ICON_512_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AABmjklEQVR42u3deXhd13ke+vdba+8zYSJAEhQ1UJIlmxYlajAtzzEkeUpTx850fF3H10lqO3GTXLdpkt42bssojtt0SOLeOG5cO4md0TESJ3FsJU40EPKgkZZESZBkSZaoiSRIEPOZ9l7ru3/sfYBzDgASIDEd8P3p4QMI48EZ9veub6+1NkBEREREREREREREREREREREREREbUl4F7TL41M0xeLc/42MjPCxI6INob+/Xxv/f3Bw0Df8r/IeYgCgUzwGxWLR1It6f3+/Dg7uUeBmz7uHiNrbflMsDkvz8W1Q02DAcMAAcE7d31IsFmVkZETSF4Jb/HWz3+y97f4eMzWtsQQvt8Z0OecU0NAYuR7QUERUVfk4EtHaH9BEVFVERR+ygnFVFVXEUWAeDbM53xGPVu6+++7yqcLBwMABAwBDQzd44GaGAgaAzXT/7peBgQNmsWJfLBbtk09O9TmpXiHA5RB7kcJfDJVLAL8DYs6HqopIrxgz+9IQY3jvEtGGoOqbyrZz8YSIeKhOQczTqjomIg/D67gJ8FAswVNdweSJBcNBsWgHRkZkaKhfgUHPQMAA0E5MsVgUAGgt+MVi0T7zzMT5kddXe/XXQHUvDK6A4nxjTI+IAUQAVSg0eauavsDS/5H6/wpfFES0USKAiMzVE5kdoQjECAQyd2xThfeuBGAUwGMi5l6BPG1U7zEmd/jgwa+WWo+bIyMjknYIeFqUAWCjSdpYrU/QgYGBYKJsX6HevFa9fp8Cr4XqJcYGBZl9MXiktd2rqgL1wl5/QYnwsSKidksEs82B+igmPbaJqAGMERGIMagfC52LHYAXATkIkTu912/lbP7RlkAgAwMDlt0BBoB1v++SJ+KQa3wS7n3NwIUSha8B9Ach+lpVebm1NgAArx7qFareJS+GpiIvS3tNzbYA+AgQ0cY4GMqyy4nOhYP6sVCsiIExBoDAewdV/xxE7jcqXzXA3Q88cOtjjT9kYGAgYGeAAWDN7q9isWhaZ+hfd91br3CCfw7o96vqa6wNupIi7eG9h6o6QDRJvqcq9grV5heTiMx+TET40BHRBh7wA6rJACUZ2Ouix7bThQIRWBEjJj2bkHYIvgMjQ975v97z8m33NJxmTY/N7AowAKw8UywWpfGc/t7XDFwocfheQH9YVV9rg9CqKtQ7eO+XUPA1HdDPFXpp+lKFV4V3MQCBczFcHKWBQFGtVvg8J6INIcxkYY2FqsIYiyDMAEjeN7MTlmU2CNTnOLUeBxfg66cQRMQaYyFi4NVBVYchuCXw+scPPHD7odnvKBYtBgHgFCusiAHgtIpFiz17FDcno/3du9/Qlekq3CixflAFN1obdCWjfAdVxGkbyyx0vyaJuF7szez79e+P4xhxXENUq8K5GFGtCq8ecVRDvR3mvU9eJ/UXEBHRBikl6al8GBEYGwBQWBvCWgsbhAiCEGGYRRCGCIIMjLUwYho6BOmkZ9X0CCoLjZpUVbwIrBgjxli4OHIico9CPo8g+vuH7x16gV0BBoAzvk9anzRX7Xv7K8W794rgg2LMhTJbkDUWqGDBoq9zLwxjklmwUDjnEEVVRLUqarUKarUK4qgG55IC3/R90ngKoOXHN065JSJaR61zkuZOAdQ/N3dcqweEIAgRZrLIZHLIZLJJF8GG6bEu6YBiNhAsdLRTn4aBIOkMCLx3Uwr8pff+c48+eMe358ZyRcsgwACwlMI/2za6dt9Nb/MqP6/Qd1gTZpOi7zySof78op8+UZN2vpkt+LVaBZXyDKrVMqJaFXEcJetmkzI/+z31wj77s4iINlmHoD7an3ubDHCsDRFmMshkcsjlO5DNFmCDAAJJuwO+qZPaNNpS9cmZBGOttelgCt+G6u+XpsI/feqpf6gC9UmDzRO3GQBY+GcL/549ezJBduf7IfJBCN5gxMC5GKrqllL0VT2iWhXVahnl0jSq6QhfvW/4uvRcv7DQE9E5XoLS4+DsKYB0tVO9Q5DPdyKXLyCTycGk8wxOFQZU1YuIMcaKiMCre1w9/kIj/d+PPHL7MQYBBoBEsWjRUvhV8AvW2KvSzSpmn0zN95Wmiba56JdKU0nRr5bhvWv4Gplt5TN4EhGdoiiJzIaBeiAQMQgzWRQKXcgXOpHN5tMw4JtCQ0sU8AqosdYaY+GdO6aqv9cYBM71UwPnaADYb4CbAcDPL/wezjknSfU2LdESIgJjLABFFNUwMz2BUmkatbToz7X/pSEsEBHRmZcpnR35ixhkMlnkC53o6OxBJpNPQ4NPJ0rPK2teFd4YCYwNThUE3Ll4z55Tf29ju3/vtTf9Mxj5702FPzkpP6/wG5NsUOGcQ7k0jenpcVTKJTgXQTC3oxU36CEiWrX2QMPpAg9jLDLZPDo7e1Do6EIQZNKugMcii7FcPQg4F4+I4Nfj8pHPDA8P1wDUj/vnzKZC50wASM/5xABw9b63vRaqHxeRt6UT9RYs/FCFpLNL46iGmZkJTE+No1otAxAYFn0ionXKAumpAu+hUARBBh2dPejs2oJsNg9F8rkFTg/MBQFjod4/ouo/ceiB27/Y0A04J04LnAsBwKQPpF599dv6NdD/CMFHjJjQuyhNejLv0nr1pXvVahlTkydRmplCHNfSNfxza1eJiGj9OwPqk1MA1lrk853o6ulDvtCJ+rLthYOAemuthRiod3+POP53hw4NPdIQBDb1aYFNHQCaRv3XveVfquDj1gTnOxfVZ/Xb5u9IRvxQoFqZwdTUOGamJ+C9gxEDMYajfSKiDd4V8N5BIMgX0iCQ74QxdpEgoB4KmCAw6n0NkP8eCv7nwYO3Tmz21QKbNADMTfK7+uq3vEIt/j8bBO/wLob33i00q79+EYpyeQbjJ0dQLk/PbmvJNj8RUbuVtvrpASCTzWHLlm3o7NoCAPV9AtDSDnAiYoMgROzcdwXxRw9958DXN3M3wG62P6hYLNrh4U97AHr1vrf8P7Dy59bYK+M4jpOA2FD8VSHGwBiLWq2Ck6PHMDZ6DLVaNT2/b/k6IiJq446AiIFzEWamJ1GtlGBsgDCTTXdnnZssmNYGdc47Y2S7iH1//86Xbb3o/Jd9+9Zbv1pOasswOwAb928pGmDQzY76bfAO52NoMuq3jSP+ZBKfRRxHmBg/jqnJsaTVb+xseiQios2jPvIvdHShr28HMtn8wssHk/WGsEFoXEs3IO0wb4qVAptiiJsmMw8M6959N31IrB00xlzp4jiWuVF/+rgqrE3+7MmJUZwYeQHl0nQyuc9wxE9EtHk7AsnKrVqtiunpcbg4RiabRxCEzad50+1avfNxvRuw47xLt7xy967bDh/+ghsYGAgOHz7c9iGg7TsA9Yl+u3e/oSvbmf8tI/ZDzrsFR/31Gfzl0jTGTh5DpTKTFn7DLXmJiM6dKAAgmSwYhBn09vajs6sX9XkDWLQbEH8r9tFPPfbgnU82TjJnAFjH4r93702vMqH5nFh7XRzV5k/yU4WxFs45jJ8cweTkaBrykh39iIjoXOwICLxPNg4qFLrQt20nMtkcvJs/308VsQ2CQL0f9XA/+8h37vhSejpA27WQtGvPW4rFor3lllvcVdfd+C9NYL8oIhe7OI5FJJgr/vXZ/Ral0jSOH3sepZnJ2Zn9RETEEJBMBK9iZnoCIoJcriNtAswtGRSB8d45EekwJihu37Fry8jRz/8DgOS6MsPDbRcC2rAKzk3AuOq6G3/b2uDfeO/ntfw1HfX7plG/sN1PREQLlsP6NsKz3YBMDt7HraVSAVUbZIyL469H5ckff/zx+0bb8ZRAWwWA+lrMvXvf1Isg++c2CN7h4lr9hE3T32KMRaU8gxPHX0StVkln9xMREZ2yJQDvHKy16Nt6Hrq6+xbcQEgVcRAEgVd90rnqjz/64J33tVsIaJsAUL9jr7j2zS8PTeZPjbXXx1EUiSBsDGb1WZ4T46M4OXoUgM5eQ5qIiGhppTGZJNjV3Yet23ZCxMxe8bUxBNjABur9mIvdv3j00IGvt1MIaIthcf0OvfLaN18fmPCAiLk8Od8/V/zry/u8dzgx8iImxo/PXqyHiIho+c0Ai2plBuXSNLK5AsIw27RnQDIvwHsRKdggfH//9l0v3XvPgfvbZdOgDR8AZov/1Te8w9rgbyDS551z6WS/huIfoFIp4djR51ApT8PagM9eIiI6K/UN46anxmFtgFyho6mjLCICqFdVNTZ4V//OSybuuO1rd+3fv98MDQ0xAJxt8d97zY0ftpnMX0A1n6atptsdBCGmJk/i+LEX4F0MawO2/ImIaIU6AcmF4GZmJuG9R6Gjq+X8ebpmQL0Pwuw/29a/64LBL37+Kxu9E7BhA0Bj8Tdh+H+8i11yjn9uV7/6Ps9jJ4+l5/u5tp+IiFYjBAhEBJXyNOJaDflCZzq5fPZ6AgKIcc5FQRhev23HxRccuO1rGzoEbMgAsHDxhwGaiz8AjB5/CeNjx7m2n4iIVp0xFpXKDKqVMgodXTA2aFpaLgLrnY/bIQRsuACwePFv3tzHe4+jR57FzMwkrA35rCQiojULAXFUw8z0OHKLTQ5sgxCwoQJAfXe/Uxd/C+89jh15FpVKKZ3sx5Y/ERGtnfqywNLMJHL5DmQypw8ByUZ2G2di4IYJAAMDA8Gpiz8gxsK5GCNHn5st/pzsR0RE6xUCVD1KMxPI5QrIZHItKwSSEBCmIWDk6Oe/kl5JcEMUrg0RAGbb/tcOvNWEmcGFRv7GBKhWSjj60jOIalXu7EdERBsgBAhUNVkmGATI5TrmhQDnfBRmMtdv779I7r37wO379u0Ljxw5su6XE173Klpv+1957ZuvNybzN1Cfg2oyvT8t/iIW1WoJx44cTnZiYvEnIqINFAJEBDPTk7BBiFyuANXZ1QGzFxIyJripv//ilx584Nv3pZ2AdQ0B61pJ9+/fbz796U/7q6/+vkuNzX5DBH3ee21e6mfhXISjLx2G9zGX+RER0YYNAqXpSWRzBWSz+cY5AQJAVFVtEL5re/+Fj957z9Aj6x0C1jMAyNDQDfLK64M+K/ZvxZjLXLLDn228M733GDn6HKKoyuJPREQbXrJ1cDIxsKETIJqcG1AR+/at/Zfccf89B55Pdwxcl8K2XgvnZWBgwA4NDcV7r7vpn2wQvjWOolgEQXPxdzh25DAqlRKM4Wx/IiLa+FQVxhjs2HkJcrl8ejVBqX/OW2uNVx2RuLT30KG7jqefXPNOgFmPO6de/K+69sbfTop/LWot/gBw7OjzXOpHRERtpd69PnbkWdRqtaZJ6yJinHPOGNOvJv83AFAsFmU9BuRrfgpgbq3/wE/aMPMb3sWxiITNd57B6PGXMDMzMW+XJSIioo0fApJ9AmrVEgod3TDGNIUA770Lwsyu7f27dt5x+9e+sh7zAdY0ANQn/e3d9+a9MJm/hnqLhuV+qoogCDF28hjGx44jCEIWfyIiatsQUKtVEdWq6OzubdkyWNKNgjLXb9u+67n77jnwnbUOAWsZAKS/v98EwQUFEbnFGHOhd87XZ/zXL+k7NXkSJ0ePcp0/ERG1PWMsarUKvHPo6Oxp3SNAVNWLNW/vP+/8r9539zeOrOWkwDWrsvWd/vp3XvIZG4bvcHEci8jseX9rLSqVMo4fe76ejvjMISKiTdEJqFRmYG2AXL6jdWUArLVZUfOmHf2X/9GXdMphja4ZsCaTAIvFYjLp77obf8oG4U8tNOPfOYcTI89D1bP4ExHRpusEjJ44gkp5Zv6kwNjFJgj3qnG/g8FBVywW16Q2r3oHID3vr1fuu/EyA/OV9Ly/RdMe/wYnRl5EuTyTzvgnIiLafKqVEjo6e1omBc5eOGjftvN2PXbgtq89kl49cFVPBax6yhgeHhYAKk4+Y4zt8N6jsfgbYzE5Porp6XEYY3lxHyIi2qRdAINarYLR40eAlk53EgJiLzC/c/XVb+sfHNyjq12jV/WHF4tFOzg46PZec8PPBWH4lvS8v228MyrlaYxx0h8REW1yyQZBFtPT45gcH22te8Z7r9YG/Wrdp4Cb/cDAwKrW6FWruvUlf1fuu/EyI8Ggqg/RsOSvcZtf52Oe9ycionOCSDL4zeU7EIaZ2c53fWmgDYK928/b9dh9dx94eDVPBaxi1S3a/dijf3XtN/7RBsFbXBy55tG/xejxlzAxcYLb/BIR0TnFe49croDzzr9k3qdEBAqccDa+Zvi+G0aAm4FV2Cp4VdoLxWLRAoPuy9cO/d+Ltf5LpSlMTtZbICz+RER07kiWvs9gYvxE6/w34716a4N+E5vfAG726VbBK38bVqOrMDxcxN69bgts+NdQX0g7DU2t/+PHnm+8VCIREdE5RcSgWikhl69fObB+KgBGvXPG2Gv6d15yxx23fe3Z1TgVsOIdgGT94s1ebfhxGwTnee+bZjKKGIyfHEGtVmHxJyKic5r3HidPHEW6Qm6WKkREjKp+cmBgIEhXBaxo0VzRALB//34zODjo977qxn1i7M+k5/1nf4cxBuXSdEPrn4iI6NxVPxUwOTHadCog2SAodkGQedXJKfsz6amAFa3ZKzwET879773upgPGBgOtE/8AwdGXnkGlUmraBIGIiOhcpQoYI9h5wcuaVgUAUBFRVUy4rL18+O5/HKt/fEN1AOoT/67Zd+PbjbED3s2f9T81eRKVygyLPxER0Wx9FDgXY3xspHVcLt57tUHQa6rRLwLQlewCrFQfXoaHi7j88nzGhv4rxpht6QS/2Yl/zsU4MfICVHmhHyIioqYiKskugdlcoWVCoIh6r0bM6/ovuGTwjlu/dmKlrhi4IkmiPvEv31l5bxCEu52Lm879ixhMjB1HHEcs/kRERIsYPznSOiFQVFWNDTLq9FcAaLrF/oboAMyO/oOM/1MRbE1G+XPL/mq1CkZPHEFDJiAiIqKWLkAUVRGGWeRyHbNL5Ru6AFesZBfgrCvy/NG/8yL1n6sQMZicGIX3jqN/IiKiRS1aM+tdgOxKdgHOtgMgw8OP6p49wxmxlT9rHf0bY1GplDA2eoyjfyIiotN2AQRxXIMNQuTznQvNBah3AY6fbRfgrKpyMvoXtbnR980f/SdXPlrgfAYREREtGgKSeXNRXDtVFwBn2wU4qwCQ7kwE7/XnFL4phRhjUKmUUS5z2R8REdGSC7MxiOMIM9MTEDEtVwuMFDA/etVVN+0YHBx0OIv9fM64Mifr/m/2V7/qxpusta/yLtbWTX9mpsagytE/ERHRUqkmcwFmpsbnzQXwXn1gww4J9V+ltfiM6/gZf+PgYP2Gyi+KGKM6tzORiKBaLWN6eoJb/hIRES1TvY7OpHW0vjmgiBivDgA+smfPQOfg4KA/0y7AGQWA/fthgEG399VveRkgN3ofa33dfz25TE2c5Mx/IiKiM48BmJytpXMf9M45a8MdNm9+EIAODAyc0Uj7jALA8HB6bWLnf8IGQV69ziYQYwyiuIZSaarp3AUREREto0Abg1qtvOAW+gpAPX4agBkauuGMzrWfSWqQ4eFh3b37DV02DL4ARUda/EVVZ/f8n5megLVs/xMREZ0pVYV6RWfXlqbJgKrOW2Mv3XH+rr8/duQLLxSLRTs8PLysEfeyOwDphAPNduQHjA12qLrZaxQne/47zEyNc/RPRES0Al2ASmUa1Wq5aT8dVfFiLNRLEQBGRkaWfb592QGgvvTPef8RQNA4+a/5hvLcPxER0dmoD6ynp8YhIg1dAFjvHFTlfbt3v6FraGgoxjInAy43AAhws9+37/t2GpE3azLJr2HjH2B6chxnsSyRiIiIZutqMrG+NDMJ56LGuQCi6rwNgp3ZjvwAsPwlgcv64vpMw0iDH7dB2OW9ziaO+vaFlUqJo38iIqIV7AIsVF/rHfikIz/XoV+VAJDONDTey48lG/yoNCaUmel5CYWIiIjOuhOQdNgbp9aJiFHvYETevOf6gfOAm5e1J8CSK3Wy9v9mf/XVb7ncGLnOOze7819yXsKjXJpCMi+Ak/+IiIhWsgtQqZQQt1wfwHvvrA26rA/eAcx16lc0ABw4MJBs9GP1h40NMqpwsz/ECGq1KqrVMkf/REREK8wYA+ciVMoz81bZJRfl0fcAkOXsCbDkal3/oar6/ckvnmv/Awbl0jR3/iMiIloFSa0VlGam0tPuUu8MGPUOAF5/zTUDPcs5DbDUACDAzf66695wvohc1zj7n+1/ojYk0vyPiNrgZbvwaQBV742xW9QGbwKWvhpgSV9U/2He5F5jbdCjSdxIt/6da/9z9E+0UY8cBrA2+ScGiGMgjpJ/UZS8nK0FbADwNB7RhrTYaYBkUyAjUP9WYOmbAgVL+aL6lf+8w7tsKFAVFam3JCyq1TK8d7A2YAeAaEMdMWwS1cslSKWSjPYzIXxff1roFRCBjI1CpsuAd0CYgRY6ks87D4CvaaKNpFIpoau7r6EzAOO9h1N5x549ezJDQ0PRigUAYNDv2bMno9A3eu8hgob2v6LC9j/RRhsqJAeG6UnAe7hX7oW7Zh/iV78B/oKL4Xa9AggCwAMwCvPiszBHXkDw4D2wD90Pe+h+SKUM7exOvs453qdE66y+5L5SnkmX3Nt63TXwTq2Rl2lhx6XA8BPAfpPOBzibAJD8EFvYcal4cwm8S2b9pQHAe4dqtcr2P9FGYQPIzCTggWjg7ai9918iet2NQG82Gcw7ALV0YC/JW7f9Wrh91yJ61zuBMmAfug/ZL/8Zwr/7EmRiDNq9JVmIzJBPtK6SrYEjRFENuVxhduDtVX1gg4x6fT2AJwYGDpihIZwyAJz2ZN/AwAEDAMbL642xGZ/sADR7Q2q1SuuEBCJanyMDIAYydgLxNa/F9Of/BjOf/RKid3w/EGSBMQeMO2DaAZECsc69nfHAhEu+pqZw+65H6b/9Nqb/8nbU3v0+yOQk4GLODyDaAAHAe49KuYTmzrsoROBUbwCAoaH+06b1076a6z/Eqd6QzBYWrbciAEGlPANVzwBAtK5HBQOoQkrTqH74FzH9p19D/H0DQCkt7KpzkwCNnb8KwDROEpQkEIw7uMt3o/Q7n0HpNz4NBFlItZp8DRGti7naO92yHDCZBwCV1+3ZsycDfOm0+wEsIc5/yV9++eVZKF6frPNvPv9fq5bB8/9E6zzyVw+ZmUbp459C+eO/BsQGmHRzhX25F+iqf1/ZA2Mxau//cUx//m+hHd2QcokhgGiduwC1Wg3OxY2Db6PeqTFyqclvf1kyWN9vziYAGEC0o2PXNhG5EEn3X+baEDGiiO1/onUt/gCkNI3SJ/43ah/4cWAkSs7vr0SRNiZZGng8htt3LaZ//8vQzh6gUuHpAKJ1DADeRwucfldvjM1YtVcAQLE4LGccAIrFogCAD/B6Y4OCqrrGABBFNZ7/J1rXI4GBTE2gdPPvovYT7wNOxEAQrvzmPmEAjMVwr7oa05/7MpDNJnsJ8LVPtE4BwKNaae7AqybzALzHjUvK96f65OxmAl6vSlr+zef/o1oVybJAHgSI1pwNIBMnUX3vT6P2k+9Pi3+wer8vCICTMdxrrkH5V34TUppJ5h4Q0bqIapWWj6ioKhR6FXD6ywOf8tU7O4tQZU/j/v91tXm/nIjWauSP8gzcK65C5T98HJhyyeS+1RYGwGiM2vvek64OGON8AKI1Vh+E11oG4SIiyUI9ednrXve6PHBzfbHv8gMA8CV/8cUDORW9Jp3pP9v+V/WoVSvgBECidWAMpFJG9cO/BO0tADVdu3a8GKCqqHzk/4V2dCfLA8EuINGajgFEEMcRnItaJgJ6NUZ2TlUzlwDQ/fv3n1EAEEC0p6fWLZCd6QYgDRMAHeI4YvufaB2KP0rTcFdfj9oPvAuY9EBg1/j3e/g9l6L2g++FTE2yC0C0DgHAuWiBOqwqYjKhsZcCwPDw8PIDQP0CQNYWLhMxHarezwUAII7jdAkCHwiitX3lG0i1gtq73wf0ZNL9+tf4hSgAYkXtRz8A5PLJNQSIaE0DgKoijmpomQjoxRg4L1cBp74w0Gln8Dj4K4wxRrXxiiBJ6yE918BHgmjtXvVAXINuOw/RW98FlLA+y/GMBUqAu3ov4quvTyYEclkg0ZqLolrLR+oTAf2VANDfv/iOgIu+YuupQYFdC+0AGNUqTbsQEdHaBACpVOAu2w2/sz89979Ohdc7IG/grnkNENW4IoBoDZ22FqvsAk69EmDRV2w9Naji4oVWADgX8xEgWvMAYIBaDe7q64GCWd/Wuwjggfi616YrEDgZmGitOeeaJuKLiEA9IOhPVgL86qIrARYNAA2p4ZLm13xyriGqVcEVAETrU3j9hZdshBsCOMCfdyE0X+A8AKI1PxQkp+O9b9oSWFQVUFwQjUSZevd+OQFAgF/V173udXkI+pG0F6Sx9dBwUUAiWivqgTCEu/yVyWV91/MUnAhQA/wFF0N7t3JnQKL1OCSowns/76MiJlPp6TgfABZbCniKk3ai4+OuIJCLdMFrAHAJING6cRtotO09wE4g0bp0ALyPW5cCiqqqMTYfmuBCYPGlgKectdNR8zGgtQUbBES0fjbSjHvO/ida9yCwQG8ATnHK7XoXfOXW2wWue8srRGyP1qcbzg4+Yp4CIFpPUW2DHHkAxFHSBSCidRG3HA9UoWko2AcsvhfAggFgtl0QoEdEgsb+Xn33Ie8dTwEQrXnBNUCtiuCJR4EA69t6Vw9kAPvc92BOHgfCkKcCiNZ45K+q6V4AjZPyk6sCCnTbsjsADT8+Wjz2E9F6hQB5/hnAr/drUQELmBcPAzXuA0C0nkFgkc/UzjwAqM8s/HGmfKJ14T2QzSJ46F5gOgbsOhZdFUCA4P5vJ90ADgyI1um1uFhN1syyA0D9fIHz+loxBqrik9+RTAWochdAonV6oXtoNgfz3NOwTz0NZLFO598VCAxkrAL70L3p9QA4D4Bobev+YjU52Q7YObwGAIaGbvDL7wAAITsARBuMDSATYwhv+RKQl3T0vQ6diA5BcPe3YB8/lGwExInBRBuqAyCySA1fYgBgpSfaaLyDdnYh89W/gDx/EsiY9QnlMZD54mcBIzxSEG3QaHA2AYCINmLaz+RgDj+N7Je+AHSbtd0YyDmgyyL49t0Ih/4B2tnNbYCJ2hADAFG7dgG6tyD7hd+Beew5oMOuzTl4VcAoUHXI/a9f5SZARAwARLTmXYAghIyfROFXfjZp9FkAfpV78S4GtgbI/Y+PI7jvG9COLk7+I2IAIKI17wJ09SC45wDy+385uTywWcV9+eMY2BYi8/k/Q+7z/wva05cEAiJiACCiNeZi6JatyP7x7yL/sV9OTgUYAG4FR+WqSaHfHiDzR3+Gwsf+VTLrnzP/iBgAiGidQ8C2fmT/6FPI/8ovAaFPugFxfPbdgDgGrAB9ATJ/8Eco/MefhXZ0Jrv+cTkwEQMAEa2zOIZu7Uf2z34Pne9/N8zh7wHbAiCQpIh7v/QRu2ryPQCwNYBEUyj88i+g8J9+Li3+wjX/RAwARLShOgFbtiK4/5voes/bkPvN/wEZP54EgbwBIMkSPhcny/Ya/7k4+ZwCyAiwNQBQQ+bP/xydP/Z2ZP78s9Du3rmAQERtL+BdQLTJQkBXN1ApIfc/9iPzpS+g9s4fQ/QDRbjLXwlsSecItM7ds0k+wAxgXnoB4a1fQeZvvwR76H5oLgfdspUT/ogYAIhoY4cAB1gL3bYdMnocuU//d2T/5LPwF1+K+JpXw190Cdzu64AgSEb8BrBPD8O8cBj20EHYp5+AnDgGZHPQ3r65SYBExABARBtc/Tx+GEL7tgMuhnnyMWQffTCZD5DJoOnqfVGU7jCYgWZz0N5tyXl+xx3+iBgAiKg9g0B99J4vQAsdSeFvncQnMvdxjviJGACIaBPhjn1E1ICrAIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIgYAIiIiIgBgIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIgYAIiIiIgBgIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIgYAIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIgYAIiIiIgBgIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIgYAIiIiIgBgIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIgYAIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIgYAIiIiIgBgIiIiBgAiIiIiAGAiIiIGACIiIiIAYCIiIjWQMC7oE2IbM6/S+e9Q3x+8umw1Lv9HPgblU8GBoBzXhy3+VFRWo5Ykr4vzQVEpOFzLYe42SKjzcGhNUQoDxhre4RWqI83brZsx5IpfFrVGbG8ExgAznFdPYC1a5oBZKHD6Jn+ftW0MKdv1QNeoeoB7wHvAO+h3s2+3/j1qn6usIsAIhARQEzyz1jAGIgYwKQfawwV2hgOlCFhBYu/CTKwYT59ciy1culZj/zXpEbqBrkdp7l9GyYv6MreFlWPiiuBLSEGgHOXd4g+8fvAlXuBUgQxpvmFr41vk09I/fMtb+fe17nPzfsZLQe/ho8JWn5u4+9t/Z1QwNffKkQVUAe4pOCLc1CXFHyJI2gcA3GU/Isq0GoFqFWglTJQLcGXZ4DKDHx5GlqehpYm4UvJ+748lXysWobWKtDqzFyYgM6GBLEWMAHEBklgaIw5DAfLC4jGolYex8XXvB973/lriEoTECPzn3uLPL9kSc8vnf+9ukDBUZ3/vS2/P/mYLn6bmm6bzivwC/9cnV+IT/HzFn89Nrwul3R/aXPhP9XxYEmPgy5yfy38Ol/0tjU8MEt7Hugixx5FaDI4WT6K//XAh1Bx5bQTwNcmA8C52gHY0gOEChiZdxDEAgfGU39OT/szRFteoKc4uC4cAFpf8AJI/cAg6QzUdDSfDh7rZwVaC4Kpf7xeo136vvNAVIVGVaBaSULAzCT89Dj85Cjc+HG48RG4saNwY8fgJk7ATZ6ALyWBwbs4OYgbCwlCiA0Ba5NOAgBlKFhSByBT6IPAQIxZ8oF/wQCgSw8AcpoAYBYsaH55AUBPHwBkNQKAX2IAOO19vcYBYIHH92wCQCUqgedDGAAojoFYk9FxQwdgfvHWFQsAZ/x1p/x6bTlV33B7tfFvaP55vvEgJfUAJMnHxEDCHCRTgHRvg4hNRqKm4cDjkHQbKjPwM1Pwk8cRjx5FfPw5RMeeRXT0GUTHn0c8dgR+ZgK+Vkl+TxDCBFnABhCRZEKSMhC0hgB1EdRFgJplPw8W/Dqc4usW/Lk672N+JToA6xUAltgBwCYOAEYNnMZ8fTEAUP289+y/zfOHNb+71ALReuBXBzg328rX+oHZa9rm16TTYAPYnm0I+s5D9mXXJiFBAcQKLU/BjY8gGnkOtRefQPW5YVSffxzRsWcQT41C4wgSBDBhDggyyU9tnJvA5+fKPTd5ly7r1XO6t8v52o3wPcn7MnuKjhgAiE59KJQF3pfWoOChzgNxDernqoxRAWyAcPsuZHZehs7rbkoySKWEePQIqi88gcpTB1F66n5Unx9GPDEC9R4mk0u6DyIMA0TEAEC08YOCAKZlEpV6aFSF1iqzhVyMRbjtQmR2Xoae1/wAfC1CfOIFlJ+6H9OPHEDp8btRHXkGGtdgsoWkOwAkExCJiBgAiNooHIg0naPVqAatVeAVEDEIt56PzI4itryxCDdxHKWnDmLqga9j6uE7UB15BgBgcx0QE7ArQEQMAETtmwsEEDsbCjSqwVfLSVbIFNB93TvQs+/7EZ08hpnhOzF2999gevhOxNMnZ7sCWt/7gIiIAYCofQOBGJvOXHbwpQkoAJvvQu8bitjy2h9B9flhjN39ZYzd82VUj34PJszCZAsMAkS0YfBiQERnlwaSPQSMBVyMeGYcvjyN3AW7cf5792P3f/oH7PqJ/4nc+buTz9VKydcKX3pExABAtKk6AzAGvlZGPD0Gm+/G9nf8DHZ/7Gu45EOfQv6CKxBPj0GjCsQE4CYnRMQAQLSpwoBJJgG6GPH0GGAstt3wAez+la/i4p/8bWS2XoR4ehRQn4QGIiIGAKJN2BVQj3h6DCIW/W/9EK742N/jgh/6D5AgRDwzztMCRMQAQLRJk0A60vfJ6oBcJy740Y/hin//NfRd/y7EpQloXE1PCxARMQAQbcIgECQTBqdPIrfz5bj8Z7+Ayz78GYQ9OxDPnEy7AZwbQEQMAESbMAckQcDXynClSWx/4/+FK//9Ldj2uvcgLo1DXcy5AUTEAEC0eXOAgRiLaPokgq4+XP7Tn8VlP/k7MGEOrjLFUwJExABAtKmDgAmgcQ1xaRw7Bn4CV/7yV9B5yXWIp0fTTgBPCRARAwDRZk0BSTdgahT581+JK37hy+h/8wcQz4zNfp6IiAGAaLPmABvAVaYhxuLyn/wULin+GnxU5rwAImIAINr8zQALeIe4NIELf+AXsPvDn4VYC18rMwQQEQMA0eZOAQIxBtHkKLZd/yPY8/N/jqCzD646w8mBRMQAQLTpc4ANEE2NoucVb8SVH/0Ssr0XcIUAETEAEJ0zIWB6DB0X7MGVH/0Scv2XIi5PMgQQEQMA0aZ/sdoAcWkC+f6X4aqf/yIKOy6HqzAEEBEDANE50QmIy5PIbd2FK3/uT5HbdsnsigEiIgYAok0fAqaQ234JrvzIHyPT0w9XKzEEEBEDANE5EQJKkyic/0pc8eE/gM12wMc1CDcLIiIGAKJzIATMjKPn8tfhlR/4FNQ7qHpeSZCIGABonaiu3D8o78/ThIBoahTbrvtBXPYjv4a4Mrk+XYCVfMxnH/eN8K+NXnab9D9aPZw+TCtckQwQmMajUvNb6AIfa/y6+ucV8OlBWBVQP/c5VTRfHEfO6VFvPQRceNPPoHzsSbxw4P8g7NgK9fEa3QCB2DD5ZwwkfSxn36YPZ9Nb6Ozn5z6GBb5X53/vgj9X5/0M0/J1yef84rep6XYk3+Cdb4sgIGJgxMze7tm/o+G2yynf6ryPL/y1esqfdaqft9jvXfjnKKwEsMISxQBAbVKJANTK0EplriAvNwBAkhAhAIyFBCFgQkiQB2zyY0UA+PRf7IA4BlwMeJ/+LGn4wnMldxnElSlc9iM3Y+alxzD+1F0I8j2rHwJE4OMaaqWTiEoTECNLDABYOABg6QEApwkAsmAA0GUFgDDsgIjd0CFAIIjiCmJXgRGBNv09ukhgar2vdZH7q/V79dSPZcMDs9QguNDPgypCk0EpnmQXkAGANjp1MUx3B6p/+/uo/uGvQ3q2JkX5DEYysHa2+EsmD8nkILkOmK5emK4+2C3bYfvOh916HmzvTgS9O2A6e2AyYfJDIkCjKhBHSbdABJv+croiycWCMgXsft9v44Hf/sHkdIAN047JKjzm3iHMdOLoo7fg+HfvSA/US72fdVkfXixvrrYfeOfnsH37HkRRGbLRzpgq4NWhkO3FvY9/AUOP/C4KmV6ounW9TSv5uKh61HwNRgyDAAMAtUUHYGI0KbpnEAA0Tf/1t7Otf+8B9ckkN9UkINgAku+A7d4Gu+0ChBe8HJlLr0Lmoj0IL3g5zJZtyRV0I4VWS1DnIEawWae+iLFw1RkUznsFXv5jn8Cjf/jTCGxmdc+jph0AF5U3XihdgdiQFFPZ4C+7pANQqpyEQODXMwCsAiNc3soAQO1ShYAgTP6dRQteGt+TuY9I/f36ZDHnEJ94EfHRZ1F56EDyNdkCgm0XIHPxHuSueD1yV74RmQt3w3Z3A5GHVkpQ9cmIbpOdJhAbIJoZw47rfxRj3/0GXrzzDxF2rvJ8ABGICdeiep/hc2j9f8qqP+5iYE0IKwFkk3W7OBGQAYDa6hXbOJt7BSqBnjpwSJgBMtm5A596xCdeRHTkacx8+29hCt0IL9qNwrVvRcer34HspVfDZDPwpQo0qqYb6Gyeg6aIQVydwct+8Fcw/uRdKI8ehg1zSfdkNR9zWvdCyZnztBxcBkhtf9ibPUXgXfJPFRJmYDq2wHT3ASKofe8Qxv7iv+LF//xOvPRrP4KJf/g8/MwEbHcPJMhAnds8RUwEGteQ6dqOy979n5P7hIiIHQA6d7oQc4VPsgWYfCfUxSgPfwvlh4cQnncpugfei+4b3ofMzkuglQq0VtkUF9cRYxHNjGP7Nf8c513/Y3jp7j9H2NG3dksDiYgdAKKNEQg8NJ2UaPKdsJ29iMeOYvSLn8Dzv/I2nPiTX4ebHoPt3DLXUWj7RoDARxVc8s9+Cdme8+DjKncJJCIGADqHeQ/1DhJkYLu3wZWnMDr4X/Hcx96Osa//PiSTheQKs4GhjdsA8LUSCv2XY9eN/wquOp2uaSciYgCgc7oroMnaeRvAdm9DPH4Mxz7zr/H8J34U1cOPIujeki4/bOO5AcYiLk/igjd+AF0X7oWrzvCCQUTEAEDUFASCDGznVpQeuROHf+2dGP27/w2T7wRs0LYT6UQE6mOEHb3YddPPwrsaTwMQEQMA0bwg4GOYQg/gHI7+wS/hxd/5MLRWhsl1tO0EOjEWUXkSO657N7Zcej3i6jS7AETEAEA0j3eAMQi6tmHizr/A4U/8EGrHnoUt9LTvvADvYDMFXPjmD0G9YxeAiBgAiE7VDQi6t6LyzCEc/vV3o/zUQQSdW9ozBBiLuDKF/qv+GbovupZzAYiIAYDolDnAxbAdPYjGj+Lwf38PZh6/G7ZNQ4B6B5vvwgWvfz98zLkARAwARHT6EJDtgC9P4bnffB/KT94P29F+pwPEGLjqNPqv/gEU+i+DiyoMAUQMAER0utGzyeThSxN47pM/idqRp9OJge20OkDg4wi5np3Yce274GslngYgYgAgoiWFgFwnotEX8NynPghfmYEJMm21T4CIwMUV7Lju3QgKW7g1MBEDABEtKQSkcwLKT38HL33+30HCbHtdfU0MXK2MrvOvRO/LXgdXLaVXQyQiBgAiOm0ICLq2YuzOP8Porb+PoLPN5gOoQmyI/qvfubqXCCYiBgCiTRcCvIMtdOPY4CdQfuZh2FwHtE0uICRi4GolbN39ZuS2nJ+sCAAnAxIxABDRkkfR8fQ4jnzxV6Ei7TOjXgQ+riLXeyG2vOx1cLUSxPBQQMQAQERL7gIEHT2YfPCfMP7NL8EWuttqVYCIwbYr3sIHkogBgIiW3whQmCCLkb/7JOKpURgbAm0wKVDEwEUV9F72GmS7d/A0ABEDABEtsw0Aky2g8sJjOHngj2HyHe1x5cD0NEC+9yJ0XbAXPqpADAMAEQMAES2jC+BgMgWM3v55RGMjkCDbFl0ApN2Lvstfn+4HwABAxABARMsrpJkcqkefxvg9X4bJFdpkLoDAuwg9F78aJpMHPJcEEjEAENEyM4BCggxOfuOLcOVpiAk2fBNAjMBHVXTueAXyWy6Ed7xAEBEDABEtMwEkcwHKhw9h5vFvweQ6AN3oXQCB9xEynVvRufOVcHGV1wYgYgAgomWXUxFoHGH8nr+GtMtIWhUmCNF94dXtMXmRiBgAiDZeLU26ANOPfRO1ky8lkwE3+oWCROCdQ9f5V0Jse13YiIgYAIg2zmg6zKJ24nlMP3EXTCa34ffaFwjU1dDRfxnCQg9XAxAxABDRGecA7zH1yFB7TKiTZCVApmsHcj074eOofU5fEBEDANHGaQIoTCaL0tP3IZ4ag9gAG305gHqHINeJ/NZL4F3ElQBEDABEdAbVFBJkUR15FtUj34UJc4Df4OfVVWFsiI7tl7bBygUiYgAg2qDEWPjKDMqHD0GCENoGuwKqKgpbLwW4DJCIAYCIziYFADPPPNges+ol2c4413dhcjEjrgQgYgAgojMbTYsNUX3pCfhqCWI2+stMoM4h29UPm+2AqgNXAhAxABDR8iMAxGZQG30R0eQJyAYfVYsI1MfIdPYhyHZCnWP9J2IAIKIzaAFAbIB4+iSiky+0xQY7qg4204Gwow/qHYQJgIgBgIjOYFRtDHxUQW30JYi1G3wioEC9h80UEBa2pKcAiIgBgIjOjHeojT7XJuvqk65FptCb7F7IvQCIGACI6MzVTh5pjxuqChGDsNALeM8HjogBgIjOmBi4qRPtU1DFIMj3tMW+BUTEAEC0UYfUEGMQTZ2EdxFkw2+woxAIglwnHzoiBgAiOuNyqgDEwlemoLVqG5xTFyg8bKaDFwMiYgAgorMqqcbA18pQF6Vb7G70awIANpMHNwEgYgAgorOppiLw1TI0rrXJqFphggxXABAxABDR2bUABBrXoN4lRXWjz61TwNhMsgkQrwdAxABARGecAAB4QNtlWZ1CjOXDRsQAQERnXVK9Qn2MtjmvLoZTAIgYAIiIiIgBgIjOYEBtICYA2mVzHfXgPkBEDABEdHbVFIAApl1eZpJMWEzeJSIGACI6s/qvkDCTdABUN35RFcC7WroVMBMAEQMAEZ1ZNVUPkylAghDaFsvqBD6qcQkgEQMAEZ1VA8ArTCYHsWG6FHCDj6oFcFEZnARAxABARGdaSwWAOth8FyTMtsGoWiEwcLWZNulWEBEDANEGHU6r97BdW2FsCN3wmwEJFIq4MsWHjogBgIjOblDtEXZta59VAOoRVyaTrYCJiAGAiM5c2Hd+e9xQEah61GbG22jZIhExABBtyFeXRWbrRW0yq16gLkZUGoOI4UoAIgYAIjoT6j1MmENm6wVQF2/wywErRAxcVEZcGoMILwhExABARGcwmBaoixB0bUXYdwHURdjoSwDFGLjqDGqlMYi16WZARMQAQETLDgCZrRcg7NqaBIAN3AFQVYgJEM2MIa5MA2K5FQARAwARLbv+IwkAufN3w2QLUL/RlwAqxFpUpkbgqtMwxoAJgIgBgIjOrKaicOl1G3rk33hbRQJUxl6AdxEgPCwQMQAQ0fLrqXcw+Q7kL94LjaP2WFcvgvLos22wYRERMQAQbchCaqBRFdn+S5Hd+XL4qLLx19ULoD7GzPFnkiWARMQAQETLHUgLfFRFx+XXI+jshbq4DTKLhatMozx6GMaG3AOAiAGAiM6soBp0XTnQHoVUFcaGqE4fR2X8JYgNeTEgIgYAIlrm8B8+qiKzbRc6XvF6+Fp5w7fUVT3EZlA6/gyi0ljSAeAKACIGACJaTv038NUSOq94EzJ9O6FRrS1WAYgJMH1kGC6utseqBSJiACDaWKNphQQhtrz2h5I2elvUUoH6GJPPP8QJgEQMAER0BsNo+GoJ+Yv3ouOVb4SvzCQ76m3syAKxAaLSOKaOPA4TZAEuAyRiACCiZdR/EWhcRd+b/gVsvhPq4w3fAVBV2CCL0sjTKI89BxNkOAGQiAGAiJZR/eGjCrLnXYYtr/th+EoJYtrginqqMEEGE899B64y0x63mYgYAIg2Tv238JUStt74Ewh7d0DjGtAmu/95F+Hk09/m9r9EDABEtLwiauBrJeQu2I2+Gz4AX57Z+Dv/1Uf/NkR14igmn38INpPjNsBEDABEtPRBtMDXKtj+zo8i6NmWXEynDUb/qh42k8fE4e+gMvYijM1yB0AiBgAiWtrg38KVJtB19U3offO/gJuZbLPz6IITj98O9a5NliwSEQMA0foP/aEuhsl3Yed79ydX/GubEbTC2AyqkyM4+eQ3YTJ5tv+JGACIaMmj/5kJ7PiR/xeFy18FV5mGmPZ4Oan3sNk8xr53N8onnoUN2f4nYgAgotMXfxsgnjqJntf/MLZ9/0fgpichNmivP0KBkYe+mo782f8nYgAgotOP/MtTyF20Bxd88Lfa4nK/rZXfhDmUjn8PJ5+8EzbbAfVs/xMxABDRKV4tFr5Wge3sw0U//1nYzj74qL0uoKPeI8gUMPLwLahOHOXV/4gYAIjodMVfoyokCLHro7+P3CVXw5en2m73PGMsovI4jh78MkyQ49a/RAwARLQYMRYaVSDG4qJ//Yfo2DsANz3Wduf91TvYXBdGH7sDUy88DJst8OI/RAwARLRg8bcBfLUEky3gon/7x+h61dvhpsbbb9IfABED7yK8eNcf1yMBH2Cic1jAu4Bo8eLvpscQ7rgEF/7rP0TH5fsQT43D2KD9ls15B5vvxsnHh3Dyu9+EzXVy8h8RAwARNTEGUCCeOI7Oa9+K8z/yKYTbLkLcpiP/NM4Aqnj+zs/B+whWClB1fKyJGACICBCItfCVGUAV2374F7H9Pb+SXO2vNNm2xV+9Q5jvxsnHD2B0+DYEua5k+18iYgAgOudLv7FQHyOeHEN215XY8YFfR9e+t8PNTAMuAoxty1PmmvxxUB/j2ds+BfUxRAxH/0TEAEDnOGMB9XDTYzCFbmz7kV9C37s/Ctu5FW5qIjkdYNp4rqx3CAtbcPS+v8TYE0MI8j0c/RMRAwCdq8N9SUb8LoafHodksuj6vveg790fRf6ya+DLJfiZibZb47/Q+F9siGhmDM/+4ychNuSe/0TEAEDnXtGHJCN5jarwlXGYQje63vSj2PKOD6Gw541Q7+CmJiBiNkHxT8/9d/bie3/3CUy/+AjCjq1QH/O5QEQMAHTuFH3EEXx1ClCPcMcl6HjNO9H15iLyl78K8ApfmpztDKSD5/Yu/uphc52YfPYgnr/j9xDku9n6JyIGANqkxR4yty+/d9CoCq1VAAjsln50XHsTOl7zz1G45kaE23dCaw5+ZhJAY+HfLC3yZNnfU3/7a4gr0wwARMQAQG1YyGSBQl9/XzXZztbF0KgGjSMACsl3IthxCbKXvwr5a25AbvdrkTnvUogV+HIFbmoSgs0z4m8a/fsYmc6teO7rn8TJx+5A2NHH1j8RMQDQGozE6zPn9Qxmz2tDNa4Xd5+8Ve8B75LRvffJ54yFZPMwnVsQbr8I4a5XInvp1chcdh0yF1wO29Wb5IRqDb48DYECSM/xb8L5cMl+/92Y+N69eObv/yfX/BMRAwCtzWAdUQ1amwZKOcCdwaizHiBEICYAgiCZvR5mYQtdMIVumO4+2K3nw27diaD/YgTnXYJg6/mwW/phcjkIAI0VqFXhZ6bSfoHMLefbrBPhNZn176vT+O4Xfxm+VobNdXDLXyJiAKBVrP3GQmciBDf9GDpf8SogCJPRtqYN+/rb9GP1vDD7/fWPiUlG9cZAbAaSzUHCHEyuIxnphzlIJgcx6fw+V/8XAVEEPz0F8UgDhCTr/OvdhM1Mk4l/YbYHT/zJRzF5+DsIO7dCHVv/RMQAQKuaAASIPczOS2F2vWx+4de5gj9b7HWBAKANX+sBUQW8b/qnlRmo1+RzACSd/CdIC76ce3e/+hhh5za8cMdn8OI3/yg578/iT0QMALQ2IQBAVIVWfdPItOltQwegqRXf9DGZ+zoBoNJQ09OlffXpBY0j+3N0jxt1McKOXowN34anv7wfQb4Tqmz7ExEDAK11J6BxE50zCgAtXwec80V+8ZG/Q5DvQunIE3j8Cz8HqIdIyABARKdleBcQtW/xN5k8oulRDP/+h1CdPAYT5lj8iYgBgGjzFn8PE2ShURXDn/sQZl54hJv9EBEDANGm5j1MEAJQPPYHP4PxJ76BoKOXk/6IiAGAaNOO/NUn+yKI4PE/+AhGD93CGf9ExABAtKmLv3cwNgMAePxzP40TB/+WV/gjojPGVQBEbVL8bSYPjcp4/LMfxslDX0fYxY1+iIgBgGjzFn8Xw+a7EE0ex3f/zwcx/t1vsfgTEQMA0WYv/mFnL0ovPoYnPvMvUXrpcZ7zJyIGAKLNW/k12du/eyvGHvxHPPX5n0c0dQJBxxYWfyJiACDalLXfO4jNIMgU8NLXP43Df3UzAIXNdbL4ExEDANGmLP4uRlDohitN4qk/+WWMfOtPYPPdgBhu8kNEDABEm3LULwZh91ZMPXEXnvmTX8T0c4eS8/3qAW7vS0QMAESbqfJrssQv1wm4GC9+5X/ixa/9FnxcRdjJmf5ExABAtDlH/TZE2NGDqafuw/ODv4qJ4QMICj2w2Q4WfyJiACDadIVfBEHHFsTTJ/H8X/42jv7T78FXZxB2boN6x/P9RMQAQLR5Cr8HoMmkPh9j9K5BvPR3v4nSC48iKHTD5ru5rS8RMQAQbaoRvwpsvhMCwdTwnTjytU9i8tEDkCBMzvVz1E9EDABEm6HqJxv5CARBoRvwwPR378LIP/4eJh74B6iPERR6oKoc9RMRAwDRJhjuQ71CghBBthtaq2Dy4dtx/LY/xOTDt8LXKrCFbhiu6yciBgCiTVD0VSEwMNkOiA0Qj49g/J6/wck7/xTTT94ze0GfIMwl7X5l8SciBgCiNi76AsnkYcMMtFpF6ZkHMHHvVzBx/9dQOfoUxFiYXCdEhIWfiBgAiNqy4HsFAIgJYLIdMGEAX62h+tKTmH7kACYP/j1K3zsIV56CyRSSC/dAAe+hyruQiBgAiDZ4sVfAa1K8AYjYZJQfhAAAPzOF8jMPYmb4G5h+eAjlZx5APDUKsSFMtoCgM9m+l+f4iYgBgGjjVXlA02IPhSogEEAEEmZgbAZiBeoBnZlC7aUnUXn2YZS+ew/KT96P2pEn4UpTkCBIRvudfXOjfRZ+ImIAIFqnEXy9yPv6WwWk/gUGMBYSBjA2AKwkn3KAlqcRjb6I6OizqD3/GCrPPozq88OIRg7DTY9B1cOEWUiYQ9BVL/rKok9EDABEZzQar7/RlhH67Ei98WOYG72rAlKv7AKIAayFiIFYC4iFMXO/STygtRq0PI148iTcySOIjz+P6MjTqB15GtGxZxCPvgQ3PQZfq0BEIEEGEmZhO7ak+ULTOQEs+kTEAECrXiM94NN/aCyUaC6KjcV0obdYoJiu9Nct9PVY6GNp4Za0QoukRbz+WQNJPyYigAGkod6LJD9LfJoDYoVGFWi1DF+ZgZ8eh58ag584ATd2BPHJo3AnXkI8dgRufARuchS+PAWNqslufcZCbAgJQkgmjyBbaCj4HOWfky879XP/FnpOq57m9bjI1y339bvQ12nD7QNnmRIDwOaVKwAdBtAsYFsODP50BwsssYgv/2OSvi+NH2v9nDa+Tdvxs4FGAe8Al46oXfJPXQTUqkBUhVarQK0CrZWBcgm+PA0tTUFLk/AzE9CZiaTYT0/A1z9WmoSvlqHVEjSOkt8BBcQmHQIbQEwACbOQTB4CSQ6i6ZyAZJkfn3bnujAsIJPpTOOoaXp+m7SwyyleD7O9qfTJJC2vkfkf01P8jLnXnswGAIds2InAZBZJ20QMAO1NDIL/+gtAZxfgfDL0XeS1LvNGMIsNwHXeB2UpN0XP4GvqrXr1DYU/KfrwcXLZ2zgGXJwU67g2V7RdDI1jwEXJx9TPbrM72w0Rk0zeMwYw6fl9YwExkEwOko7kRSQZzc8W+vptczx00oKG7viPyGQ60gs5nfq1tlDX66y+5pSvy7lOgTUBxqafRzboTF4XRAwAmykACOShu9Pif2Y/Qlf6a87odtTb+409/PTtbPs/bfc3/D9EABtCgszs90vj9zemHFU0zylICvxS/z6iRkeP3J8Uf1m519nKHhuSU1SBzcKaDE8FEAPAplToxBlX/5U93pwlPcWHFvtcw6idxzdaQ2HYkT7rN/ITT5JTVnxxEAPAJuXZ2iNaa2yp02ZmeBcQERExABAREREDABERETEAEBEREQMAERERMQAQERERAwARERExABAREREDABERETEAEBEREQMAERERMQAQERERAwARERExABAREREDABERETEAEBEREQMAERERMQAQERExABAREREDABERETEAEBEREQMAERERMQAQERERAwARERExABAREREDABERETEAEBEREQMAERERMQAQERERAwARERExABAREREDABERETEAEBEREQMAERERMQAQERExABAREREDABERETEAEBEREQMAERERMQAQERERAwARERExABAREREDABERETEAEBEREQMAERERMQAQERERAwARERExABAREREDABERETEAEBEREQMAERERMQAQERExABAREREDABERETEAEBEREQMAERERMQAQERERAwARERG1dwAQEeVdRERE1I5OXcNPGQA8EPAOJCIiaj+q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';

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
    sendJson(res, 200, { ok: true, version: VERSION, note: 'DISCIPLINE.TRACKER sync server', xbox_oauth: !!XBOX_CLIENT_ID, cloud_sync: true, pwa: true });
    return;
  }

  /* ==========================================================
     ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ (v3.3.0): единая база всех устройств
     ========================================================== */
  if (urlPath === '/api/cloud/push' || urlPath === '/api/cloud/pull' || urlPath === '/api/cloud/status') {
    await handleCloudApi(req, res, urlPath, query);
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

  /* ---------- метаданные страницы (v3.2.0: drag&drop закладок — заголовок/описание/картинка) ---------- */
  if (urlPath === '/api/bookmark-meta') {
    const target = query.get('url') || '';
    let u = null;
    try { u = new URL(target); } catch (e) { u = null; }
    if (!u || !/^https?:$/.test(u.protocol)) { sendJson(res, 400, { error: 'Нужен корректный http(s) URL' }); return; }
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(u.href, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DisciplineTracker/3.2; +bookmark-meta)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8'
        }
      });
      clearTimeout(to);
      const ctype = r.headers.get('content-type') || '';
      if (!r.ok || !/text\/html|application\/xhtml/i.test(ctype)) {
        sendJson(res, 200, { ok: false, title: '', description: '', image: '', note: 'not html or http ' + r.status });
        return;
      }
      const raw = (await r.text()).slice(0, 400000);
      const pick = (re) => { const m = re.exec(raw); return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 300) : ''; };
      const decode = (s) => String(s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
      const title = decode(pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i))
        || decode(pick(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i))
        || decode(pick(/<title[^>]*>([^<]*)<\/title>/i));
      const description = decode(pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i))
        || decode(pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i));
      let image = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      if (image && !/^https?:/i.test(image)) { try { image = new URL(image, u.href).href; } catch (e) { image = ''; } }
      sendJson(res, 200, { ok: true, title, description, image, url: u.href });
    } catch (e) {
      sendJson(res, 200, { ok: false, title: '', description: '', image: '', error: String((e && e.message) || e) });
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

  /* ---------- PWA: манифест, service worker, иконки (v3.3.0) ---------- */
  if (pathname === '/manifest.webmanifest') {
    send(res, 200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }, JSON.stringify(PWA_MANIFEST, null, 2));
    return;
  }
  if (pathname === '/sw.js') {
    send(res, 200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }, PWA_SW_JS);
    return;
  }
  if (pathname === '/icons/icon-192.png' || pathname === '/icons/icon-512.png') {
    try {
      const buf = Buffer.from(pathname.endsWith('192.png') ? ICON_192_B64 : ICON_512_B64, 'base64');
      send(res, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800', 'Content-Length': buf.length }, buf);
    } catch (e) {
      send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'icon not found');
    }
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const safe = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  /* v3.3.0: НЕ отдаём наружу служебные файлы — data/ содержит токены Xbox
     и базу синхронизации, server.js — исходник с секретами */
  if (safe === '/server.js' || safe === '/package.json' || safe === '/render.yaml' || safe.indexOf('/data/') === 0 || safe === '/data') {
    send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
    return;
  }
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
    return;
  }
  /* v3.3.0: надёжная защита служебных файлов ЛЮБЫМ способом обхода
     (../, //, %-кодирование): проверяем путь ПОСЛЕ нормализации */
  const rel = path.relative(ROOT, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)
    || rel === 'server.js' || rel === 'package.json' || rel === 'render.yaml'
    || rel === 'data' || rel.startsWith('data' + path.sep)) {
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
  console.log('Облако (единая база): POST /api/cloud/push · GET /api/cloud/pull?code=.. · GET /api/cloud/status?code=..');
  console.log('PWA: /manifest.webmanifest · /sw.js · /icons/icon-192.png · /icons/icon-512.png (ставится как APK через Chrome/PWABuilder)');
});
