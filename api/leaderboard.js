/*
 * CHOMPY JET PACK — Global Leaderboard API
 * ----------------------------------------
 * Vercel Serverless Function:  GET /api/leaderboard   -> top scores (+ your rank)
 *                              POST /api/leaderboard  -> submit a run
 *
 * Storage: Upstash Redis, connected through Vercel's Storage / Marketplace.
 * Talks to Redis with its REST API using native fetch() — no npm packages,
 * no package.json, no node_modules.
 *
 * Credentials come ONLY from Vercel's server-side environment variables
 * (KV_REST_API_URL / KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL /
 * UPSTASH_REDIS_REST_TOKEN, with or without a custom prefix). Nothing here is
 * ever sent to the browser.
 *
 * Redis layout
 *   chompy:leaderboard          sorted set   member = playerId, score = best distance
 *   chompy:names                hash         playerId -> display name (fast top-25 lookups)
 *   chompy:player:{playerId}    hash         name, bestDistance, bestScore, bestCoins, runs, updatedAt
 *   chompy:rl:{ip|pid}:{x}:{m}  counters     per-minute rate limiting (auto-expire)
 */

'use strict';

/* ------------------------------------------------------------------ */
/*  Tunables — the anti-cheat limits mirror the physics in index.html  */
/* ------------------------------------------------------------------ */

const LEADERBOARD_SIZE = 25;           // rows returned to the game
/* How many raw rows to read before merging duplicate names down. Must comfortably
   exceed LEADERBOARD_SIZE or a burst of duplicates could leave a short page. */
const MERGE_DEPTH = 400;
const NAME_MAX_LENGTH = 16;            // display name limit
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const HARD_CAPS = {                    // reject anything above these, full stop
  distance: 250000,                    // meters
  coins: 50000,
  score: 600000,
  runDuration: 4 * 60 * 60,            // seconds
};

const PLAUSIBILITY = {                 // "could a human have done this in that time?"
  // The deep-distance ramp in index.html pushes scroll speed to SPEED.ceiling = 1180
  // px/s (73.75 m/s) far out, and Turbo multiplies by 1.8 on top => 132.75 m/s peak.
  // This MUST stay above that, or genuine long runs get rejected as implausible.
  // If you change SPEED.ceiling or TURBO_MULT in index.html, change this to match.
  maxMetersPerSecond: 140,
  // Collected coins peak near 10/s with a magnet on a dense pattern; the near-miss
  // combo in index.html adds bonus coins capped at COMBO.maxBonusPerSec = 12/s on top.
  // Keep this above the sum, or real runs get rejected. Change both together.
  maxCoinsPerSecond: 30,
  coinScoreValue: 5,                   // score = distance + coins * 5 (see index.html)
  slackMeters: 50,
  slackCoins: 30,
  slackScore: 10,
};

const RATE_LIMIT = {                   // normal play is ~1 submission per 10-60 s
  perIpPerMinute: 60,
  perPlayerPerMinute: 20,
};

const KEY = {
  board: 'chompy:leaderboard',
  names: 'chompy:names',
  player: (id) => `chompy:player:${id}`,
  rate: (kind, id, minute) => `chompy:rl:${kind}:${id}:${minute}`,
};

/* ------------------------------------------------------------------ */
/*  Entry point                                                        */
/* ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const method = String(req.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.statusCode = 204;
    return res.end();
  }

  const redis = createRedis();
  if (!redis) {
    // Store not connected yet (or env vars not exposed to this environment).
    return send(res, 503, { error: 'LEADERBOARD_NOT_CONFIGURED' });
  }

  try {
    if (method === 'GET' || method === 'HEAD') return await handleGet(req, res, redis);
    if (method === 'POST') return await handlePost(req, res, redis);
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  } catch (err) {
    console.error('[leaderboard] ' + (err && err.message ? err.message : err));
    return send(res, 503, { error: 'LEADERBOARD_UNAVAILABLE' });
  }
};

/* ------------------------------------------------------------------ */
/*  GET /api/leaderboard?playerId=...                                  */
/* ------------------------------------------------------------------ */

async function handleGet(req, res, redis) {
  const url = new URL(req.url || '/', 'http://localhost');
  const rawId = url.searchParams.get('playerId') || '';
  const playerId = PLAYER_ID_RE.test(rawId) ? rawId : null;

  // Read deeper than we display, because merging by name collapses rows and we still
  // want a full page of results afterwards.
  const commands = [
    ['ZREVRANGE', KEY.board, '0', String(MERGE_DEPTH - 1), 'WITHSCORES'],
    ['ZCARD', KEY.board],
  ];
  if (playerId) {
    commands.push(['ZSCORE', KEY.board, playerId]);
    commands.push(['HGET', KEY.names, playerId]);
  }

  const results = await redis.pipeline(commands);
  const flat = Array.isArray(results[0]) ? results[0] : [];
  const totalRows = toInt(results[1]) || 0;

  const ids = [];
  const distances = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    ids.push(String(flat[i]));
    distances.push(Math.floor(Number(flat[i + 1]) || 0));
  }

  // Names live in one hash so the whole board is a single HMGET.
  let names = [];
  if (ids.length) {
    const [got] = await redis.pipeline([['HMGET', KEY.names, ...ids]]);
    names = Array.isArray(got) ? got : [];
  }

  /* Merge rows that share a display name, keeping the best.
     The board is keyed by playerId, which is deliberate — it stops one player filling
     the board with repeat runs, and it means nobody can overwrite your score just by
     typing your name. But one PERSON legitimately has several ids: phone and laptop,
     a private window, cleared site data. Those showed up as duplicate names.
     Entries arrive in descending distance order, so the first time a name appears it
     is already that name's best run; later ones just fold into it. Matching is
     case-insensitive because the UI renders every name uppercase anyway. */
  const byName = new Map();
  const board = [];
  for (let i = 0; i < ids.length; i++) {
    const name = cleanName(names[i]);
    const key = name.toUpperCase();
    const existing = byName.get(key);
    if (existing) { existing.ids.push(ids[i]); continue; }
    const row = { name, distance: distances[i], ids: [ids[i]] };
    byName.set(key, row);
    board.push(row);
  }

  // NOTE: player IDs are never returned — they are each player's private identity.
  const leaders = board.slice(0, LEADERBOARD_SIZE).map((row, i) => ({
    rank: i + 1,
    name: row.name,
    distance: row.distance,
    you: playerId !== null && row.ids.indexOf(playerId) !== -1,
  }));

  let player = null;
  if (playerId && results[2] !== null && results[2] !== undefined) {
    const myBest = Math.floor(Number(results[2]) || 0);
    const myName = cleanName(results[3]).toUpperCase();
    // Your rank is the rank of your NAME's merged row, so a lower run on a second
    // device does not report a worse position than the board actually shows.
    let idx = -1;
    for (let i = 0; i < board.length; i++) {
      if (board[i].ids.indexOf(playerId) !== -1 || board[i].name.toUpperCase() === myName) { idx = i; break; }
    }
    if (idx >= 0) {
      player = { rank: idx + 1, best: Math.max(myBest, board[idx].distance) };
    } else {
      // Outside the window we read, so fall back to the raw rank. It counts unmerged
      // duplicates and is therefore an upper bound, not an exact position.
      const [rawRank] = await redis.pipeline([['ZREVRANK', KEY.board, playerId]]);
      const r = rawRank === null || rawRank === undefined ? null : toInt(rawRank) + 1;
      player = { rank: r, best: myBest, approx: true };
    }
  }

  // Unique names, exact while the whole board fits inside the window we read.
  const total = ids.length < MERGE_DEPTH ? board.length : totalRows;

  return send(res, 200, { leaders, total, player });
}

/* ------------------------------------------------------------------ */
/*  POST /api/leaderboard                                              */
/* ------------------------------------------------------------------ */

async function handlePost(req, res, redis) {
  const body = await readJsonBody(req);
  const checked = validateSubmission(body);
  if (checked.error) {
    return send(res, 400, { error: checked.error });
  }
  const run = checked.value;

  /* --- rate limiting + current stored values, one round trip --- */
  const minute = Math.floor(Date.now() / 60000);
  const ip = clientIp(req);
  const ipKey = KEY.rate('ip', ip, minute);
  const pidKey = KEY.rate('pid', run.playerId, minute);

  const first = await redis.pipeline([
    ['INCR', ipKey], ['EXPIRE', ipKey, '120'],
    ['INCR', pidKey], ['EXPIRE', pidKey, '120'],
    ['ZSCORE', KEY.board, run.playerId],
    ['HMGET', KEY.player(run.playerId), 'bestScore', 'bestCoins'],
  ]);

  const ipHits = toInt(first[0]) || 0;
  const pidHits = toInt(first[2]) || 0;
  if (ipHits > RATE_LIMIT.perIpPerMinute || pidHits > RATE_LIMIT.perPlayerPerMinute) {
    res.setHeader('Retry-After', '60');
    return send(res, 429, { error: 'TOO_MANY_REQUESTS' });
  }

  /* --- server-side best check: the browser can never lower a score --- */
  const storedBest = first[4] === null || first[4] === undefined ? null : Math.floor(Number(first[4]) || 0);
  const improved = storedBest === null || run.distance > storedBest;
  const bestDistance = improved ? run.distance : storedBest;

  const prev = Array.isArray(first[5]) ? first[5] : [];
  const bestScore = Math.max(run.score, toInt(prev[0]) || 0);
  const bestCoins = Math.max(run.coins, toInt(prev[1]) || 0);

  const commands = [];
  if (improved) {
    commands.push(['ZADD', KEY.board, String(run.distance), run.playerId]);
  }
  commands.push([
    'HSET', KEY.player(run.playerId),
    'name', run.name,
    'bestDistance', String(bestDistance),
    'bestScore', String(bestScore),
    'bestCoins', String(bestCoins),
    'lastDistance', String(run.distance),
    'updatedAt', new Date().toISOString(),
  ]);
  commands.push(['HINCRBY', KEY.player(run.playerId), 'runs', '1']);
  commands.push(['HSET', KEY.names, run.playerId, run.name]);
  commands.push(['ZREVRANK', KEY.board, run.playerId]);
  commands.push(['ZCARD', KEY.board]);

  const second = await redis.pipeline(commands);
  const rankIndex = second[second.length - 2];
  const total = toInt(second[second.length - 1]) || 0;

  return send(res, 200, {
    ok: true,
    improved,
    best: bestDistance,
    rank: rankIndex === null || rankIndex === undefined ? null : toInt(rankIndex) + 1,
    total,
    name: run.name,
  });
}

/* ------------------------------------------------------------------ */
/*  Validation — never trust the browser                               */
/* ------------------------------------------------------------------ */

function validateSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'INVALID_BODY' };
  }

  const playerId = typeof body.playerId === 'string' ? body.playerId : '';
  if (!PLAYER_ID_RE.test(playerId)) return { error: 'INVALID_PLAYER_ID' };

  const distance = toInt(body.distance);
  const coins = toInt(body.coins);
  const score = toInt(body.score);
  const runDuration = toNumber(body.runDuration);

  if (distance === null || coins === null || score === null || runDuration === null) {
    return { error: 'INVALID_NUMBERS' };           // NaN, Infinity, strings, objects...
  }
  if (distance < 1 || coins < 0 || score < 0 || runDuration < 0) {
    return { error: 'OUT_OF_RANGE' };
  }
  if (distance > HARD_CAPS.distance || coins > HARD_CAPS.coins ||
      score > HARD_CAPS.score || runDuration > HARD_CAPS.runDuration) {
    return { error: 'OUT_OF_RANGE' };              // hard sanity ceiling
  }

  // Plausibility versus time actually played.
  const p = PLAUSIBILITY;
  if (distance > runDuration * p.maxMetersPerSecond + p.slackMeters) {
    return { error: 'IMPLAUSIBLE_DISTANCE' };      // e.g. 500,000 m in 8 seconds
  }
  if (coins > runDuration * p.maxCoinsPerSecond + p.slackCoins) {
    return { error: 'IMPLAUSIBLE_COINS' };
  }
  if (score > distance + coins * p.coinScoreValue + p.slackScore) {
    return { error: 'IMPLAUSIBLE_SCORE' };
  }

  return {
    value: {
      playerId,
      name: cleanName(body.playerName),
      distance,
      coins,
      score,
      runDuration: Math.round(runDuration * 10) / 10,
    },
  };
}

/** Display names: plain ASCII letters/digits/space/_ - . ! ?, max 16 chars. Strips HTML/script/emoji. */
function cleanName(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/[^A-Za-z0-9 _.!?-]/g, '').replace(/\s+/g, ' ').trim();
  s = s.slice(0, NAME_MAX_LENGTH).trim();
  return s || 'CHOMPY';
}

function toNumber(v) {
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v;
}

function toInt(v) {
  const n = toNumber(v);
  return n === null ? null : Math.floor(n);
}

/* ------------------------------------------------------------------ */
/*  Redis over REST (Upstash)                                          */
/* ------------------------------------------------------------------ */

/**
 * Finds the credentials Vercel injected for the connected Upstash Redis store.
 * Supports the Marketplace names (KV_REST_API_URL / KV_REST_API_TOKEN), the classic
 * Upstash names (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) and any custom
 * prefix chosen when connecting the store (e.g. MYDB_KV_REST_API_URL).
 */
function createRedis() {
  const env = process.env;
  let url = null;
  let token = null;

  const known = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    ['REDIS_REST_API_URL', 'REDIS_REST_API_TOKEN'],
  ];
  for (const [u, t] of known) {
    if (env[u] && env[t]) { url = env[u]; token = env[t]; break; }
  }

  if (!url) {
    for (const key of Object.keys(env)) {
      const m = /^(.*)(REST_API_URL|REST_URL)$/.exec(key);
      if (!m || !env[key]) continue;
      const tokenKey = m[1] + (m[2] === 'REST_API_URL' ? 'REST_API_TOKEN' : 'REST_TOKEN');
      if (env[tokenKey]) { url = env[key]; token = env[tokenKey]; break; }
    }
  }

  if (!url || !token || !/^https?:\/\//.test(url)) return null;
  const base = url.replace(/\/+$/, '');

  return {
    /** Runs several commands in one HTTP request; returns an array of results. */
    async pipeline(commands) {
      const response = await fetch(base + '/pipeline', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error('Redis HTTP ' + response.status);
      }
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Unexpected Redis response');
      return data.map((entry) => {
        if (entry && typeof entry === 'object' && entry.error) {
          throw new Error('Redis: ' + entry.error);
        }
        return entry ? entry.result : null;
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Small HTTP helpers (work on Vercel and on plain Node for tests)     */
/* ------------------------------------------------------------------ */

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(payload));
}

function clientIp(req) {
  const h = req.headers || {};
  const forwarded = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
  const ip = forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
  return ip.replace(/[^0-9a-fA-F.:]/g, '').slice(0, 64) || 'unknown';
}

async function readJsonBody(req) {
  // Vercel already parses JSON bodies into req.body.
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return safeParse(req.body.toString('utf8'));
    if (typeof req.body === 'string') return safeParse(req.body);
    if (typeof req.body === 'object') return req.body;
    return null;
  }
  // Plain Node (local testing): read the stream, capped at 8 KB.
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8192) { data = ''; req.destroy(); resolve(null); }
    });
    req.on('end', () => resolve(safeParse(data)));
    req.on('error', () => resolve(null));
  });
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}
