# Chompy Jet Pack

An endless jetpack arcade game with a global leaderboard, built to deploy on Vercel with
Upstash Redis connected through Vercel Storage. No Supabase, no SQL, no build step.

```
chompy-jet-pack/
├── index.html          the entire game
├── api/
│   └── leaderboard.js  the entire backend (Vercel Serverless Function)
└── README.md
```

No `package.json`, no `node_modules`, no framework. `api/leaderboard.js` talks to Redis over
its REST API using the runtime's built-in `fetch()`.

## Deploy

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New… → Project → Import** the repository. Framework preset: **Other**.
   Leave the build command and output directory empty. Deploy.
3. Open the project → **Storage** → **Create Database** (or **Connect Store**) →
   **Upstash → Redis**. Pick a region near your players and create it.
4. Connect the database to this project when prompted. Vercel adds the credentials to the
   project's environment variables automatically.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new environment variables are picked up.
6. Open the site. The global leaderboard is live.

Until step 3 is done the game runs perfectly and the leaderboard shows
`GLOBAL LEADERBOARD UNAVAILABLE`. Nothing crashes.

### Environment variables

You do not set these by hand — Vercel injects them when the store is connected. The function
accepts any of the names the integration currently uses:

| Names it looks for |
| --- |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` |
| `REDIS_REST_API_URL` + `REDIS_REST_API_TOKEN` |
| any custom prefix, e.g. `CHOMPY_KV_REST_API_URL` + `CHOMPY_KV_REST_API_TOKEN` |

If you set a **Custom Prefix** while connecting the store, it still works — the function scans
for a matching `*REST_API_URL`/`*REST_URL` and its paired token.

The credentials stay server-side. `index.html` contains no tokens and never talks to Redis;
it only calls its own `/api/leaderboard`.

## API

**`GET /api/leaderboard?playerId=…`** — top 25 by distance, plus your rank.

```json
{
  "leaders": [
    { "rank": 1, "name": "CHOMPYKING", "distance": 8421, "you": false },
    { "rank": 2, "name": "JUAN",       "distance": 7994, "you": true  }
  ],
  "total": 1832,
  "player": { "rank": 2, "best": 7994 }
}
```

Player IDs are never returned to the browser.

**`POST /api/leaderboard`** — submit a run.

```json
{ "playerId": "…", "playerName": "JUAN", "distance": 4812, "coins": 319, "score": 5260, "runDuration": 187.2 }
```

```json
{ "ok": true, "improved": true, "best": 4812, "rank": 38, "total": 1832, "name": "JUAN" }
```

Errors: `400` with an error code for invalid or implausible data, `429` when rate limited,
`503` when Redis is unreachable or not connected yet.

## How the leaderboard behaves

- **One row per player.** The sorted set is keyed by `playerId`, so a player never fills the
  board with repeat runs. Names are not the identity — two players can both be "JUAN".
- **Best score wins, checked on the server.** The function compares the incoming distance to
  the stored one and keeps the higher. A worse run can never overwrite a better one, even if
  the browser claims it is a new best.
- **Never trusts the browser.** Player ID format, name characters and length, and every number
  are validated. `NaN`, `Infinity`, negatives, absurd values, and HTML/script in names are
  rejected.
- **Anti-cheat.** Submissions are checked against run duration using the game's real top speed
  (`distance ≤ runDuration × 140 m/s`, coins and score similarly), plus hard ceilings. 500,000 m
  in 8 seconds is rejected. See **Tuning** — two client constants are coupled to these limits.
- **Rate limiting.** 20 submissions per player per minute and 60 per IP per minute, counted in
  Redis with auto-expiring keys. Normal play is nowhere near either.
- **Offline-safe.** Local best, player ID, name, and settings live in `localStorage`, so the
  game and your personal best keep working with no network at all.

### Redis keys

| Key | Type | Contents |
| --- | --- | --- |
| `chompy:leaderboard` | sorted set | member `playerId`, score `bestDistance` |
| `chompy:names` | hash | `playerId → name` (one `HMGET` renders the whole top 25) |
| `chompy:player:{playerId}` | hash | name, bestDistance, bestScore, bestCoins, lastDistance, runs, updatedAt |
| `chompy:rl:*` | counter | rate-limit buckets, expire after 2 minutes |

## The game

- **Controls.** Desktop: hold `Space` / `↑` / `W` / mouse. Mobile: hold anywhere on screen.
  `P` pause, `M` mute, `L` leaderboard, `Enter` restart. Vehicles in `tap` mode act on the
  press edge rather than the held state, so the same button does both.
- **Flight feel.** Tuned for Jetpack Joyride snap: thrust responds within a frame (`RESPONSE`
  is a frame-rate-independent exponential ramp, ~17 ms to catch up rather than the old ~60 ms),
  and gravity/thrust are strong and near-symmetric. A 300 px climb takes ~0.50 s, a 300 px
  drop ~0.55 s.
- **Obstacles.** Zappers (vertical, horizontal, diagonal, zigzag), spinning rotors, floating
  mines, sweeping lasers with a telegraphed warning, and homing missiles with an on-screen
  alert — introduced gradually by distance.
- **Spinning rotors.** One hub, 1–3 bars at even angles turning together — a sweeping bar, a
  cross, or a six-blade fan — with a faint swept disc and a motion-blur smear so the danger
  radius reads at a glance. They start at 300 m and grow with difficulty. The `gauntlet`
  pattern parks a row of spinning crosses *on* the corridor centreline: a timing test, never
  a wall.
- **Power-ups.** Shield (absorbs one hit), Magnet (pulls coins in), Turbo (speed boost that
  smashes through obstacles), and **vehicles**.
- **Eleven vehicles**, defined in `VEHICLES`. Each changes what the single input means, so
  the game re-teaches itself every time you pick one up. `mode` selects the movement model:

  | Vehicle | Mode | Does |
  | --- | --- | --- |
  | Stomper | hold | Heavy walker, crushes mines |
  | Bubble | hold | Ultra-floaty and forgiving, 3 armour |
  | Saucer | hold | Steady hover, 4 armour |
  | Dragon | hold | Fire cone burns mines and missiles ahead |
  | Turbo Ram | hold | 1.55x speed, shatters zappers |
  | The Ace | hold | Serves volleyballs that clear a path ahead |
  | Flapper | tap | One flap per press, 2x coins |
  | Hog | tap | Motorbike — jump plus one air-jump |
  | Grav Suit | tap | Flips which way gravity pulls |
  | Drill | tap | Tunnels along floor/ceiling, invulnerable |
  | Blink | tap | Teleports up, sinks slowly between |

  Pickups come from a shuffled bag so you cycle the whole roster instead of re-rolling the
  same two. `armor` is hits soaked before it breaks apart; bigger `radius` is a bigger target.
- **Difficulty never flatlines.** `difficulty()` ramps corridor width and the obstacle
  mix over the first 4200m; `deepDifficulty()` then takes over and keeps tightening the
  corridor, stacking a second hazard into chunks, closing the spacing and raising the
  speed cap — indefinitely. Before this the game was byte-for-byte identical past
  11000m, so anyone who could survive that could survive forever. Measured: corridor
  265px -> 117px, speed 18.8 -> 72.3 m/s, reaction window 2.26s -> 0.59s by 100km.
  The corridor can never go below `GAP_FLOOR`, derived from the largest vehicle.
- **Near-miss combo.** Skimming a hazard within `COMBO.window` px as it passes builds a
  multiplier (up to x8) that decays if you play safe, and pays bonus coins. A hazard
  scores once, on the frame it goes behind you — proximity alone would fire every frame
  a long zapper is alongside you. Anything that can't hurt you (invulnerable, turbo, a
  vehicle that eats that hazard) is skipped so the multiplier is never free.
- **Fair by construction.** Every generated chunk is built around a corridor with a guaranteed
  safe opening; obstacles are only placed outside it, and the corridor moves a bounded amount
  between chunks. Blade clearances (`BLADE_MARGIN`, `GAUNTLET_LANE`) are derived from
  `VEH_MAX_RADIUS`, so a corridor that is fair on foot stays fair in every vehicle — sizing
  those margins by eye is how you get an unavoidable wall. Modes that constrain position
  need care for the same reason: the Hog's jump reaches the ceiling and the Drill is
  invulnerable while attached, because neither can dodge freely. A scripted bot flying on
  on-screen information alone survives indefinitely at every distance band from 0m to
  100,000m, on the jetpack and in all eleven vehicles (`node bot-test.js`).
- **Everything drawn in code** — no image or audio files. Sound is synthesized with the Web
  Audio API (jetpack thrust, coin chimes that rise in pitch, explosions, a chiptune loop).

### Using your own Chompy artwork

Put a transparent PNG (facing right) next to `index.html`, then set the constant near the top
of the script:

```js
const CHOMPY_SPRITE_URL = 'chompy.png';
```

The drawn body is replaced by the image; the jetpack flame, shield bubble, and tilt still work.
Leave it as `''` to use the built-in Chompy.

### Tuning

Constants live together at the top of the script in `index.html`:
`FLIGHT` (gravity, thrust, velocity caps — thrust is 2x gravity so rising mirrors falling,
which is most of what makes it feel light rather than heavy), `RESPONSE` (how fast thrust
ramps in and out — raise `on` for an even twitchier stick), `VEHICLES` (the whole roster),
`SPEED`, `POWERUP` durations, `COMBO`, `COIN_VALUE`. Corridor width and the obstacle unlock
distances are in `gen.spawn`; the pressure curves are `difficulty()` and `deepDifficulty()`.

**Two client constants are coupled to the server's anti-cheat.** If you change either,
change `api/leaderboard.js` to match or genuine runs get rejected as cheating:

| Client (`index.html`) | Server (`api/leaderboard.js`) | Why |
| --- | --- | --- |
| `SPEED.ceiling` x `TURBO_MULT` | `PLAUSIBILITY.maxMetersPerSecond` | 1180 px/s x 1.8 / 16 = 132.75 m/s peak, ceiling set to 140 |
| `COMBO.maxBonusPerSec` + collection | `PLAUSIBILITY.maxCoinsPerSecond` | ~10/s collected + 12/s combo bonus, ceiling set to 30 |

Changing `PHYS` / `RESPONSE` / the `VEHICLES` handling values does **not** affect the
anti-cheat, since horizontal speed is unchanged.

## Local testing

### Fairness bot

`node bot-test.js` (needs `npm i playwright`) flies a scripted bot through every difficulty
band in headless Chromium, twice — once on foot, once forced into the mech — using only the
obstacle positions the `?debug=1` hooks expose. Any band where the bot dies, or any frame
where it can't find a clear lane, means the generator produced an unfair chunk. `gen-test.js`
prints the obstacle mix per distance band; `feel.js` measures control latency.

### Server

`vercel dev` runs the whole thing locally. Point it at a real Upstash database, or set
`KV_REST_API_URL` / `KV_REST_API_TOKEN` yourself. Without them the game still runs and the
leaderboard reports itself unavailable.
