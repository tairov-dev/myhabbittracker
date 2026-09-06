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
const VERSION  = '3.4.0';

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
  "var SW_CACHE = 'dt-shell-v6.5.0';",
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
const ICON_512_B64 = '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';

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

/* ============================================================
   v3.4.0: ЛЕНТА НОВОСТЕЙ (/api/news) — серверный RSS-прокси.
   Браузер не может забирать RSS напрямую (CORS), поэтому сервер
   скачивает ленту сам, парсит <item>/<entry> и отдаёт JSON.
   Результат кэшируется в памяти на 10 минут (экономия трафика).
   ============================================================ */
const NEWS_SOURCES = {
  lenta:      { name: 'Lenta.ru',    url: 'https://lenta.ru/rss/news' },
  ria:        { name: 'РИА Новости', url: 'https://ria.ru/export/rss2/archive/index.xml' },
  habr:       { name: 'Хабр',        url: 'https://habr.com/ru/rss/news/?fl=ru' },
  rbc:        { name: 'РБК',         url: 'https://rssexport.rbc.ru/rbcnews/news/30/full' },
  gazeta:     { name: 'Gazeta.ru',   url: 'https://www.gazeta.ru/export/rss/lenta.xml' },
  kommersant: { name: 'Коммерсантъ', url: 'https://www.kommersant.ru/RSS/news.xml' }
};
const NEWS_TTL_MS  = 10 * 60 * 1000;
const NEWS_TIMEOUT = 12000;
const newsCache = new Map(); /* src → { ts, items } */

function xmlUnescape(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}
function newsTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
  return m ? xmlUnescape(m[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
function newsLink(block) {
  const m = block.match(/<link[^>]*href="([^"]+)"[^>]*>/i);
  if (m) return xmlUnescape(m[1]);
  const m2 = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  return m2 ? xmlUnescape(m2[1]).trim() : '';
}
function parseRssItems(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const b of blocks) {
    const title = newsTag(b, 'title');
    const link  = newsLink(b);
    if (!title || !link) continue;
    const dateRaw = newsTag(b, 'pubDate') || newsTag(b, 'updated') || newsTag(b, 'published');
    let ts = Date.now();
    if (dateRaw) { const d = new Date(dateRaw); if (!isNaN(d.getTime())) ts = d.getTime(); }
    items.push({
      title: title.slice(0, 300),
      link: link.slice(0, 500),
      date: ts,
      desc: (newsTag(b, 'description') || newsTag(b, 'summary') || newsTag(b, 'content')).slice(0, 240)
    });
    if (items.length >= 30) break;
  }
  return items;
}
function fetchNewsSource(src) {
  return new Promise((resolve) => {
    httpsRequest(NEWS_SOURCES[src].url, {
      method: 'GET', timeoutMs: NEWS_TIMEOUT, maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DisciplineTracker/3.4; +https://render.com)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    }).then(r => {
      if (r.status !== 200 || !r.text) { resolve([]); return; }
      resolve(parseRssItems(r.text));
    }).catch(() => resolve([]));
  });
}
async function handleNewsApi(res, query) {
  const src = String(query.get('src') || 'lenta').toLowerCase();
  if (!NEWS_SOURCES[src]) { sendJson(res, 400, { error: 'Неизвестный источник: ' + src, sources: Object.keys(NEWS_SOURCES) }); return; }
  const cached = newsCache.get(src);
  if (cached && (Date.now() - cached.ts) < NEWS_TTL_MS && cached.items.length) {
    sendJson(res, 200, { ok: true, src: src, name: NEWS_SOURCES[src].name, cached: true, items: cached.items.slice(0, 14) });
    return;
  }
  const items = await fetchNewsSource(src);
  if (!items.length) {
    /* упали и сеть, и кэш — отдаём устаревший кэш, если есть */
    if (cached && cached.items.length) {
      sendJson(res, 200, { ok: true, src: src, name: NEWS_SOURCES[src].name, cached: true, stale: true, items: cached.items.slice(0, 14) });
      return;
    }
    sendJson(res, 502, { error: 'Источник недоступен. Попробуйте другой.' });
    return;
  }
  newsCache.set(src, { ts: Date.now(), items: items });
  console.log('[news] ' + src + ': ' + items.length + ' новостей');
  sendJson(res, 200, { ok: true, src: src, name: NEWS_SOURCES[src].name, cached: false, items: items.slice(0, 14) });
}

/* ============================================================
   v3.4.0: БЕСПЛАТНЫЙ AI-АССИСТЕНТ (/api/ai/chat).
   Прокси на открытый Pollinations Text API (без ключей и оплаты,
   модели OpenAI/Mistral). Трекер шлёт историю сообщений — сервер
   пересылает её на text.pollinations.ai и возвращает ответ-текст.
   ============================================================ */
const AI_MODELS   = ['openai', 'mistral', 'llama'];
const AI_TIMEOUT  = 60000;
const AI_MAX_BODY = 200000; /* ~200KB истории */
function handleAiApi(req, res) {
  readBody(req, AI_MAX_BODY).then(body => {
    let msgs = Array.isArray(body.messages) ? body.messages : [];
    msgs = msgs
      .filter(m => m && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: (m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'), content: String(m.content).slice(0, 12000) }))
      .slice(-16); /* последние 16 реплик — экономим квоту */
    if (!msgs.length) { sendJson(res, 400, { error: 'Нужен массив messages' }); return; }
    const model = AI_MODELS.includes(body.model) ? body.model : 'openai';
    const payload = JSON.stringify({
      model: model,
      messages: msgs,
      referrer: 'discipline-tracker'
      /* v3.4.1-note: поле private НЕ отправляем — с ним Pollinations
         требует авторизацию (402 Payment Required) */
    });
    const doChat = () => httpsRequest('https://text.pollinations.ai/openai', {
      method: 'POST', timeoutMs: AI_TIMEOUT, maxRedirects: 3,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload
    });
    doChat().then(r => {
      let text = '';
      try {
        const j = JSON.parse(r.text || '');
        text = (j.choices && j.choices[0] && ((j.choices[0].message && j.choices[0].message.content) || j.choices[0].text)) || j.text || '';
      } catch (e) { text = r.text || ''; }
      text = String(text || '').trim();
      if (r.status === 200 && text) {
        sendJson(res, 200, { ok: true, model: model, text: text.slice(0, 16000) });
        return;
      }
      /* v3.4.0-резерв: POST упал (429/402/5xx) → пробуем бесплатный GET-вариант
         text.pollinations.ai/{prompt} — тот же сервис, другой маршрут/лимит */
      const lastUser = [...msgs].reverse().find(m => m.role === 'user');
      const prompt = encodeURIComponent(String((lastUser && lastUser.content) || '').slice(0, 1500));
      httpsRequest('https://text.pollinations.ai/' + prompt + '?model=' + encodeURIComponent(model) + '&referrer=discipline-tracker', {
        method: 'GET', timeoutMs: AI_TIMEOUT, maxRedirects: 3
      }).then(r2 => {
        const t2 = String(r2.text || '').trim();
        if (r2.status === 200 && t2 && !/^\s*\{\s*"error"/.test(t2)) {
          sendJson(res, 200, { ok: true, model: model, text: t2.slice(0, 16000), fallback: true });
          return;
        }
        sendJson(res, 502, { error: 'AI-сервис временно недоступен (HTTP ' + r.status + '). Подождите минуту и повторите — сервис бесплатный с лимитами.' });
      }).catch(() => {
        sendJson(res, 502, { error: 'AI-сервис временно недоступен (HTTP ' + r.status + '). Подождите минуту и повторите — сервис бесплатный с лимитами.' });
      });
    }).catch(e => {
      sendJson(res, 502, { error: 'AI-сервис недоступен: ' + (e.message || 'timeout') });
    });
  });
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
     v3.4.0: ЛЕНТА НОВОСТЕЙ — GET /api/news?src=lenta|ria|habr|rbc|gazeta|kommersant
     ========================================================== */
  if (urlPath === '/api/news') {
    await handleNewsApi(res, query);
    return;
  }

  /* ==========================================================
     v3.4.0: БЕСПЛАТНЫЙ AI-АССИСТЕНТ — POST /api/ai/chat {messages:[...]}
     ========================================================== */
  if (urlPath === '/api/ai/chat') {
    handleAiApi(req, res);
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
