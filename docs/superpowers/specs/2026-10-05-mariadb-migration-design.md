# Design: Migrate PickleLeague persistence from data.json to MariaDB

Date: 2026-10-05 (rev 5 — final amendments from rev-4 review on issue #3)
Status: Ready to implement
Approach: **B — fully relational, per-row updates** (over A: whole-state repository, and C: JSON document in a table).

**Revision history**

- rev 2: incorporated the first review round (six findings + A/B/C).
- rev 3: incorporated the rev-2 review (11 items). Retracted the finding-A claim — the mutation queue does serialize today; the async-handler requirement survives on the disconnect justification (§2).
- rev 4: incorporated the rev-3 review (six amendments + three notes): commit-before-response, `MEDIUMTEXT`, test-user grants, manual-import guard, expanded import pre-checks, fault-hook guarding.
- rev 5: incorporates the rev-4 review (four final amendments): scoped timeout guarantees, commit-outcome semantics (known rollback vs unknown outcome), `court_number` nullable for legacy singles, and housekeeping (non-empty definition, hostnet import note, spec committed before planning). Changes marked `[rev 5]`.

## 1. Goal and non-goals

**Goal:** Replace the `data.json` whole-file persistence (`server.mjs:10,32-86`) with a MariaDB database for durability and operational comfort: InnoDB crash safety, `mariadb-dump` backups, and SQL-queryable data. Spencer runs the app via docker-compose and wants a real database to trust and back up.

**Non-goals:**

- No frontend changes (`public/` keeps consuming the same JSON API shapes).
- No auth changes: login sessions remain the in-memory `sessions` Map with 12h TTL (`server.mjs:15-16`). The `sessions` array in `data.json` is league play sessions, unrelated to auth.
- No schema-level reporting queries in this iteration: `/api/stats/active-session` keeps computing stats in JS (`buildStatsFromMatches`, `server.mjs:389-445`) from reassembled rows. Moving that computation into SQL is a possible later improvement.
- No multi-instance support work beyond what InnoDB transactions give for free; the app still runs as a single container (see §7 for the two-instance footgun to avoid).

## 2. Current behavior being preserved (and where it must change)

These semantics are the contract the migration must not break:

- **Atomic writes.** Today `saveState` writes a temp file, fsyncs, and renames (`server.mjs:64-86`) — a crash never leaves partial state. In MariaDB this becomes: every mutation handler runs inside a single transaction; a failed handler rolls back completely.
- **Serialized mutations.** `[rev 3 — corrected]` Mutations are chained through `enqueueMutation` (`server.mjs:195-199,843`), and it works: `runApiHandler` (`server.mjs:201-220`) returns a promise that resolves only on the response's `finish` or `close` event, so the queue waits for each request to run to completion — including the async `parseBody().then(...)` continuation inside the handler.
  The requirement to restructure survives for a narrower reason: **`close` also fires on client disconnect.** Once handlers await database I/O, a client disconnecting mid-handler would release the queue while that request's transaction is still in flight, letting the next mutation interleave with it. **Requirement:** the queue waits on each handler's own work promise (the database transaction, not merely the response events), so a mutation's transaction always completes before the next mutation begins — even if its client disconnected. A disconnected client's work still commits.
- **Commit before responding.** `[rev 4 — amendment 2; outcome semantics rev 5 — amendment 2]` Success responses are sent only **after** `withTransaction()` has confirmed the commit. A 200/201 must never precede its own commit. When the commit does not confirm, two distinct cases are handled differently:
  - **Known rollback** — the failure happened before `COMMIT` reached the server, or the server rejected it: nothing was saved. Return the generic 500 (§8).
  - **Unknown outcome** — the connection was lost while awaiting the commit confirmation: the change may or may not be persisted. Still return a 500, never a success; log the outcome as **unknown**, destroy the connection, and **never retry the mutation automatically** (a retried score update would apply its stat deltas twice). Clients reloading afterward see whatever the database actually holds.
- **Derived player stats.** `wins`, `losses`, `total_points`, `points_allowed`, `pickles` are maintained by undo-then-replay when a match is re-scored (`server.mjs:758-816`, helpers at `server.mjs:338-387`), including the `Math.max(0, …)` floor on decrements. These become columns on `players`, updated in the same transaction as the match write, with the same arithmetic (deltas applied in SQL, floors via `GREATEST(0, …)`).
- **Whole-list replacement on generate.** `POST /api/matches/generate` replaces the entire match list (`state.matches = generated`, `server.mjs:731`). The relational equivalent is `DELETE FROM matches` (cascading to `match_players`/`match_sit_outs`) + batch `INSERT`, in one transaction.
- **Consistent reads.** `[rev 2 — finding 3]` Today each GET reads the in-memory `state` in one uninterrupted step. Several separate SQL queries can straddle a concurrent schedule replacement and return old matches with missing participants. **Requirement:** every response assembled from more than one query runs on a single pooled connection inside a read transaction with a consistent snapshot (`START TRANSACTION WITH CONSISTENT SNAPSHOT`; the default REPEATABLE READ isolation then gives a stable view), committed or rolled back before the response is sent. The mutation queue does not protect GETs — this applies to `GET /api/matches`, `GET /api/session`, and `GET /api/stats/active-session` alike.
- **Legacy singles fields.** `getTeamPlayerIds` falls back to `player1Id`/`player2Id` (`server.mjs:328-336`). The importer maps those to `match_players` rows; new matches are always doubles with team arrays.
- **Validation and error messages.** All request validation stays in handler code with identical messages. DB constraints are a backstop, not the primary validation surface (see §8 for how validation errors and database errors are separated).

## 3. Schema

`[rev 5 — court_number nullable per review amendment 3]` MariaDB 11 LTS, InnoDB, `utf8mb4`. Default table collation is left as the server default; string comparisons that must match JavaScript semantics use explicit collations as noted.

```sql
CREATE TABLE IF NOT EXISTS players (
  id             INT          PRIMARY KEY,
  name           VARCHAR(80)  NOT NULL,
  -- JS toLowerCase() semantics: value computed in Node, compared binary.
  -- (MariaDB's LOWER() does not match JS toLowerCase() for e.g. 'İ', 'ß'.)
  -- 160, not 80: lowercasing can lengthen a string ('İ' -> 'i̇', 1 -> 2 chars),
  -- so an 80-char name can produce a 160-char key.
  name_key       VARCHAR(160) NOT NULL COLLATE utf8mb4_bin,
  present        TINYINT(1)   NOT NULL DEFAULT 1,
  wins           INT          NOT NULL DEFAULT 0,
  losses         INT          NOT NULL DEFAULT 0,
  total_points   INT          NOT NULL DEFAULT 0,
  points_allowed INT          NOT NULL DEFAULT 0,
  pickles        INT          NOT NULL DEFAULT 0,
  UNIQUE KEY uq_players_name_key (name_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS league_sessions (
  id         INT          PRIMARY KEY,
  started_at DATETIME(3)  NOT NULL,   -- ms precision: today's toISOString() has ms
  ended_at   DATETIME(3)  NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS matches (
  id            INT          PRIMARY KEY,
  round         INT          NOT NULL,
  -- MEDIUMTEXT, not TEXT: date/startTime were unrestricted free text until
  -- rev 3's validation, and the request-body limit is 1e6 characters
  -- (server.mjs:128) — up to ~4 MB in utf8mb4, exceeding TEXT's 65,535 bytes.
  -- MEDIUMTEXT (16 MB) bounds it. Stored verbatim; new writes are
  -- format-validated (§5), so only legacy rows can be odd.
  scheduled_at  MEDIUMTEXT   NOT NULL,
  -- NULLable [rev 5]: legacy singles matches may have no court number, and
  -- fabricating 1 would display "Court 1" for a value never recorded.
  -- NULL renders as the existing "Court TBD" (public/app.js:162).
  court_number  INT          NULL,
  session_id    INT          NULL,
  team1_score   INT          NULL,
  team2_score   INT          NULL,
  winner_team   TINYINT      NULL,
  completed     TINYINT(1)   NOT NULL DEFAULT 0,
  completed_at  DATETIME(3)  NULL,
  CONSTRAINT fk_matches_session FOREIGN KEY (session_id) REFERENCES league_sessions(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS match_players (
  match_id  INT     NOT NULL,
  team      TINYINT NOT NULL,   -- 1 or 2
  position  TINYINT NOT NULL,   -- 0-based index within the team array; preserves shuffle() order
  player_id INT     NOT NULL,
  PRIMARY KEY (match_id, team, player_id),
  UNIQUE KEY uq_match_players_pos (match_id, team, position),
  CONSTRAINT fk_mp_match  FOREIGN KEY (match_id)  REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_player FOREIGN KEY (player_id) REFERENCES players(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS match_sit_outs (
  match_id  INT     NOT NULL,
  position  TINYINT NOT NULL,   -- preserves the sit-out array order
  player_id INT     NOT NULL,
  PRIMARY KEY (match_id, position),
  CONSTRAINT fk_mso_match  FOREIGN KEY (match_id)  REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_mso_player FOREIGN KEY (player_id) REFERENCES players(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meta (
  id                TINYINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_player_id    INT NOT NULL DEFAULT 1,
  next_match_id     INT NOT NULL DEFAULT 1,
  next_session_id   INT NOT NULL DEFAULT 1,
  active_session_id INT NULL,
  -- Import marker: see §6. Set on first startup whether or not a file existed,
  -- so a data.json appearing later is never auto-imported into a live DB.
  import_completed  TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB;
INSERT IGNORE INTO meta (id) VALUES (1);
```

Notes:

- `name_key` uniqueness `[rev 2 — finding 6; length rev 3 — item 2]`: the app compares names with JS `toLowerCase()` (`server.mjs:509`). The key is computed in JS and stored under a binary collation, so `Jose` and `José` remain distinct (JS `toLowerCase()` does not strip accents) and the DB never applies its own case/accent folding. `name_key` is `VARCHAR(160)` because lowercasing can double a string's length (`'İ'` → `'i̇'`). The duplicate check in the handler keeps using `name_key`; `UNIQUE (name_key)` is the race backstop.
- Array order `[rev 2 — finding 5]`: `match_players.position` and `match_sit_outs.position` preserve the order produced by `shuffle()`/round-robin generation. Reads `ORDER BY team, position` / `position` so `team1PlayerIds`, `team2PlayerIds`, and `sitOutPlayerIds` round-trip exactly.
- Timestamps `[rev 2 — finding 4; scheduled_at rev 3 — item 3, rev 4 — amendment 4]`: `started_at`, `ended_at`, `completed_at` are `DATETIME(3)` because today's ISO strings include milliseconds. `scheduled_at` is `MEDIUMTEXT` holding the exact string the scheduler produced — including hour-overflow (`"2026-10-05 24:00"`), arbitrary legacy junk, and values too long for `TEXT` — see §5 and §10.
- `court_number` `[rev 5 — amendment 3]` is `NULL`-able. New matches always set it (from the validated `courtCount` math, `server.mjs:717`); legacy singles matches lacking it import as `NULL`, and the read path emits `courtNumber: null`, which the frontend renders as "Court TBD" (`public/app.js:162`) — the honest value, never a fabricated court number. (`round: 0` and `scheduledAt: ''` defaults from rev 4 stand: both reviewers accepted them.)
- DDL is applied at startup as idempotent `CREATE TABLE IF NOT EXISTS` statements (no separate migration framework — this schema is small and owned by one app).

## 4. Data access layer

- New module `db.mjs`:
  - Creates a `mariadb` connection pool from env: `DB_HOST`, `DB_PORT` (default 3306), `DB_USER`, `DB_PASSWORD`, `DB_NAME` (default `pickleball`), and **`timezone: 'Z'`** `[rev 2]` — the connector defaults to local time, which would shift UTC-stored `DATETIME` values on read. All timestamp conversions are explicitly UTC.
  - `[rev 4 — review note; scoped rev 5 — amendment 1]` Pool configuration limits how long the queue can be blocked. Each setting covers a different failure class, and none is a blanket "never blocks" guarantee:
    - `acquireTimeout` — bounds waiting for a pooled connection;
    - `socketTimeout` `[rev 5]` — bounds waiting on a socket that stops responding (the realistic way the queue sticks: a query hung on a dead connection);
    - `innodb_lock_wait_timeout` (compose `command`/session variable) — bounds lock waits (rare here, since all writes serialize through one queue).
    A connection that hits any of these timeouts is **destroyed, not returned to the pool** `[rev 5]`. With these in place a stuck mutation fails with a 500 and the queue moves on; failures below what these settings cover are handled by the commit-outcome semantics in §2/§8.
  - Applies the DDL above at startup, then runs startup initialization (§6).
  - `withTransaction(fn)`: `BEGIN` → `fn(conn)` → `COMMIT`, `ROLLBACK` on throw. Used by all mutation handlers. **Handlers await the commit before sending a success response** (§2, `[rev 4]`).
  - `withReadSnapshot(fn)`: one pooled connection, `START TRANSACTION WITH CONSISTENT SNAPSHOT` → `fn(conn)` → `COMMIT`. Used by multi-query reads (§2).
- **First npm dependency** for this repo: `mariadb` (the official connector; note: *not* the abandoned `mariasql` package). `[rev 2]` `package-lock.json` does not exist in the repo and `npm ci` requires it — it will be generated and committed alongside `package.json`. The `Dockerfile` gains `COPY package*.json` + `npm ci --omit=dev` before `COPY`ing the app, and **drops the `COPY data.json ./data/data.json` line** (`Dockerfile:9`) — after the migration it is dead scaffolding that would confuse the import logic in a fresh container.
- **Error classification** `[rev 2 — finding B]`: `db.mjs` tags driver/connection errors (subclass or symbol flag) so handlers can distinguish them from validation errors. Validation errors keep today's 400 + message; database errors are handled per §8.

## 5. Handler-by-handler translation

Every mutation becomes one transaction. Reads assemble the same JSON shapes the API emits today (camelCase keys, teams as `team1PlayerIds`/`team2PlayerIds` arrays in stored order, `sitOutPlayerIds` array in stored order) so `public/` needs zero changes.

`[rev 2]` Handlers are async; `[rev 3 — item 1]` the queue waits on each handler's own work promise (the transaction), per §2 — including when the client has disconnected mid-handler; `[rev 4 — amendment 2]` the success response is sent only after the commit confirms.

`[rev 2]` Each handler classifies its failures:

- validation failures → today's 400 responses, unchanged messages;
- database/connector failures (including unconfirmed commits) → generic 500 via the shared error path (§8), never a 400 carrying SQL text and never a success response.

| Endpoint (server.mjs) | Translation |
|---|---|
| `GET /api/players` (490) | `SELECT * FROM players ORDER BY id` → camelCase JSON (single query; no snapshot needed). |
| `POST /api/players` (495) | Validate name in code (trim, ≤80, dup check via `name_key`). `INSERT` player + `UPDATE meta SET next_player_id` in one txn. Catch `ER_DUP_ENTRY` on `uq_players_name_key` → 400 `Player already exists`. |
| `POST /api/players/clear` (523) | One txn: `DELETE FROM matches` (cascades `match_players`/`match_sit_outs`, clearing the FK to players), `DELETE FROM league_sessions`, `DELETE FROM players`, reset `meta` counters and `active_session_id`. `import_completed` is **not** touched — see §6. |
| `POST /api/players/clear-history` (536) | One txn: `DELETE FROM matches`, `DELETE FROM league_sessions`, `UPDATE players SET wins=0, losses=0, total_points=0, points_allowed=0, pickles=0`, reset match/session counters, `active_session_id = NULL`. |
| `POST /api/players/presence/clear` (558) | `UPDATE players SET present = 0`. |
| `POST /api/players/:id/presence` (620) | `UPDATE players SET present = ? WHERE id = ?`; 404 if no row affected. |
| `GET /api/session` (567) | Read snapshot: active session by `meta.active_session_id`; last session = `MAX(id)`. |
| `POST /api/session/start` (574) | One txn: `INSERT` session, set `meta.active_session_id` + `next_session_id`, `UPDATE matches SET session_id = ? WHERE session_id IS NULL` (preserves the attach-orphans behavior at 588-594). |
| `POST /api/session/end` (601) | One txn: `UPDATE league_sessions SET ended_at = ? WHERE id = meta.active_session_id`; `meta.active_session_id = NULL`. Keeps the "active session not found → clear pointer" edge case (606-611). |
| `GET /api/matches` (641) | Read snapshot: `SELECT` matches + `match_players` (ORDER BY team, position) + `match_sit_outs` (ORDER BY position), group into the existing match JSON shape. |
| `GET /api/stats/active-session` (646) | Same reassembly inside one read snapshot, then reuse `buildStatsFromMatches` unchanged. |
| `POST /api/matches/generate` (664) | `[rev 3 — item 7: validation refined]` `body.date`, when provided, must be a **real calendar date** in `YYYY-MM-DD` form (month/day ranges and leap years checked, not just the pattern) — today any string is accepted and defaults apply when omitted (`server.mjs:700`); `body.startTime`, when provided, must be a valid `HH:MM` time (hours 00-23, minutes 00-59 — the bare pattern would admit `99:99`); empty values keep today's defaults (today's date, `18:00`). The frontend already sends well-formed values from its date/time inputs (`public/app.js:287-288`). Violations → 400 with a specific message. **(Approved behavior change in review, with these refinements.)** Round-robin generation otherwise unchanged. One txn: `DELETE FROM matches` (cascades), batch `INSERT` matches + `match_players` (with positions) + `match_sit_outs` (with positions), update `next_match_id`. |
| `POST /api/matches/:id/result` (740) | One txn: `SELECT … FOR UPDATE` the match; if re-scoring, undo prior win/loss (floor at 0 via `GREATEST`); apply new deltas to `players`; `UPDATE` match. |
| `POST /api/matches/:id/score` (771) | One txn: `SELECT … FOR UPDATE`; undo prior stats (scores, points allowed, pickles, win/loss) with `GREATEST(0, …)` floors; apply new deltas; `UPDATE` match. |

Implementation shape: the stat helpers (`updateWinsAndLosses` etc., `server.mjs:338-387`) are reworked to emit per-player `UPDATE … SET wins = GREATEST(0, wins + ?)`-style statements inside the caller's transaction, so the undo/replay logic stays in one place. `player_id` values in `match_players` are validated against `players` by the generate handler (677-681); the FK is the backstop.

`[rev 2]` Timestamp serialization: `DATETIME(3)` values are emitted with millisecond precision matching today's `toISOString()` output; the connector is pinned to UTC (`timezone: 'Z'`, §4). `scheduled_at` is emitted verbatim as stored, including legacy hour-overflow or malformed strings, so clients see byte-identical values. `[rev 5]` `courtNumber` is emitted as `null` when the column is `NULL` (frontend renders "Court TBD", `public/app.js:162`); new matches always carry a real number.

## 6. One-time import of existing data.json

`[rev 3 — items 4 and 10; rev 4 — amendments 3 and 5; rev 5 — amendments 3 and 4]`

Startup initialization (after DDL), in one transaction:

- If `meta.import_completed = 0` **and** `data.json` exists in `DATA_DIR`: run the import below.
- Otherwise (no file, or a fresh install): set `meta.import_completed = 1` and commit. **The marker is set on first startup regardless of whether a file existed** — so a `data.json` that appears later is never auto-imported into a database already in use.

Import procedure (when it runs):

1. Parse `data.json` (parse failure → abort startup with the same "refusing to overwrite" spirit as `loadState` at `server.mjs:42-43`).
2. `[rev 4 — amendment 5: full pre-validation]` **Check every value a database constraint or column type could reject, before inserting anything.** Each failure aborts startup with an error naming the offending record and field — no silent drops, no mid-import failure after partial inserts. The checks:
   - dangling player references (teams, sit-outs, legacy `player1Id`/`player2Id`) — would violate `fk_mp_player`;
   - `match.sessionId` pointing at a missing session — would violate `fk_matches_session`;
   - duplicate player IDs, or names that lowercase to the same `name_key` — would violate the PK / `uq_players_name_key`;
   - the same player listed twice in one team — would violate the `match_players` PK;
   - `startedAt`/`endedAt`/`completedAt` that are not valid ISO timestamps — would violate the `DATETIME(3)` columns;
   - missing `round` or `scheduledAt` on doubles matches — would violate the `NOT NULL` columns.
   (Operator fixes `data.json`; this is the honest failure mode for a homelab data file.)
3. **Legacy singles defaults** `[rev 4 — amendment 5; court_number rev 5 — amendment 3]`: old `player1Id`/`player2Id` matches predate this repo's history and may lack `round`, `courtNumber`, or `scheduledAt`. `round: 0` and `scheduledAt: ''` are filled as defaults. `courtNumber` is **not defaulted**: the column is `NULL`-able (§3) and a missing value imports as `NULL`, so the frontend shows "Court TBD" instead of a fabricated "Court 1" (`public/app.js:162`). Players in legacy files still get the `loadState` defaults (`present` → true, stat fields → 0, `server.mjs:52-59`).
4. Import players, sessions, matches, meta counters **and set `meta.import_completed = 1`, all in one transaction.** The rename in step 6 is bookkeeping, not the marker: if the process dies after commit but before the rename, the next restart sees the file but `import_completed = 1` and does not re-import — cleared data can never be resurrected by a stale file.
5. `[rev 3 — item 10]` Defensive hardening, applied during import:
   - Counters: `next_player_id`/`next_match_id`/`next_session_id` are set to the **larger** of the file's stored counter and (highest imported id + 1), so a stale or hand-edited counter can never cause a duplicate-key insert later.
   - Counter allocation takes `SELECT … FOR UPDATE` on the `meta` row. This is hardening only: with one process and the awaited queue (§2), IDs are allocated one at a time anyway, and this does **not** make running multiple instances safe (see §7).
6. On success, rename `data.json` → `data.json.imported-<unix-ts>` (never delete). A failed rename is logged, not fatal.

**Later-appearing files** `[rev 3 — item 4; guard rev 4 — amendment 3; definition rev 5 — item 4]`: if `data.json` exists on a startup where `import_completed = 1`, the server logs a warning (file left untouched) and does not import. A deliberate import of a later file is an explicit operation: `npm run import -- <path>`, which runs the same procedure (pre-checks, defaults, hardening, one transaction) against a **stopped app** and **refuses to run against a non-empty database** — **"non-empty" means any rows in `players`, `matches`, or `league_sessions`** `[rev 5]` — because merging into existing data would need extra rules for IDs, counters, and stats, and is out of scope for this iteration. Documented command:

```
docker compose stop app
docker compose run --rm app npm run import -- /app/data/data.json
```

`[rev 5 — item 4]` Hosts running the `app-hostnet` profile must stop **that** service before importing (`docker compose stop app-hostnet`), not `app` — stopping the wrong service leaves the other instance writing during the import.

Current `data.json` is the empty scaffold, so the first deployment import is a no-op that just renames the file.

## 7. Deployment changes

`[rev 2 — port publishing fixed per finding 2; rev 3 — items 6 and 11; rev 4 — review note]`

- `docker-compose.yml` adds:

  ```yaml
  db:
    image: mariadb:11
    environment:
      MARIADB_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD:?Set MARIADB_ROOT_PASSWORD}
      MARIADB_DATABASE: pickleball
      MARIADB_USER: pickleball
      MARIADB_PASSWORD: ${MARIADB_PASSWORD:?Set MARIADB_PASSWORD}
    ports:
      # loopback only: reachable by app-hostnet, not the LAN.
      # Host port configurable to avoid clashing with a DB already on the host.
      - "127.0.0.1:${DB_HOST_PORT:-3306}:3306"
    volumes:
      - mariadb-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 10s
      timeout: 5s
      retries: 10
  ```

  `app` (bridge profile) reaches the database as `DB_HOST=db` over the compose network. **`app-hostnet` uses `DB_HOST=127.0.0.1` (and `DB_PORT=${DB_HOST_PORT:-3306}`):** with `network_mode: host` the `db` hostname does not resolve, and the published loopback port is what makes the database reachable from the host at all — without it, pointing the host-network app at the LAN IP would connect to nothing.
- `[rev 3 — item 6]` **`app-hostnet` also gets `depends_on: db: condition: service_healthy`** — without it, `docker compose up app-hostnet` does not start `db` at all.
- `app` and `app-hostnet` gain `DB_*` env vars; a named volume `mariadb-data` is declared.
- `[rev 3 — item 11]` **Two-instance footgun documented in the README:** `docker compose --profile hostnet up` starts *both* `app` and `app-hostnet` — two processes with separate in-process mutation queues writing one database, which §2's guarantees do not cover. The documented way to run the host-network profile is `docker compose up db app-hostnet` (or `--profile hostnet` with `app` explicitly stopped).
- `[rev 4 — review note]` **README upgrade steps** tell the operator to confirm the first startup after upgrading actually imported: the startup log must show the import ran (or its no-op rename) **with `./league-data` mounted** — starting once without the mount sets the import marker, and the data would then only be recoverable via the manual import path (§6).
- README updated: new env vars, backup command (`docker compose exec db mariadb-dump -u pickleball -p pickleball > backup.sql`), the import behavior (§6, including `npm run import`, its non-empty-DB refusal, and the `app-hostnet` stop note), the `DB_HOST_PORT` knob, and the host-network notes above.

## 8. Failure modes

- **DB unreachable at startup:** fail fast and exit, like the missing-`ADMIN_PASSWORD` check (`server.mjs:19-21`). No half-started server.
- **Request-time validation errors:** 400 with today's exact messages (new generate-validation messages are the one addition, §5).
- **Request-time database errors** `[rev 2 — finding B; commit outcomes rev 5 — amendment 2]`: the shared handler wrapper returns a generic 500 `Internal server error` and logs server-side with context; no handler path can leak driver messages, SQL text, or connection details to the client. (Today every handler's `.catch(err => sendJson(res, 400, { error: err.message }))` would do exactly that once driver errors are in the mix. Note the try/catch in `runApiHandler` only catches synchronous throws, so it provides no protection here.) Commit outcomes are distinguished per §2: **known rollback** (failure before `COMMIT` reached the server, or rejected by it) → 500, rollback certain; **unknown outcome** (connection lost awaiting the commit confirmation) → 500 with the outcome logged as unknown, connection destroyed, and **no automatic retry** — a retried score update would double-apply its stat deltas.
- **Stuck mutation** `[rev 4 — review note; scoped rev 5 — amendment 1]`: `acquireTimeout` bounds pool waits, `socketTimeout` bounds hung sockets, and `innodb_lock_wait_timeout` bounds lock waits (§4) — a stuck mutation fails with a 500 and the queue moves on; timed-out connections are destroyed, not reused. These three settings do not cover every conceivable hang; the commit-outcome semantics above handle the rest. The claim is exactly: *the queue cannot be blocked indefinitely by any timeout class covered above.*
- **Client disconnect mid-handler** `[rev 3 — item 1]`: the response is gone, but the handler's transaction still runs to completion because the queue waits on the work promise, not the response events. The next mutation starts only after the transaction commits or rolls back.
- **Connection loss mid-transaction:** a failure before the commit rolls back; a lost commit confirmation follows §2's unknown-outcome path. The pool reconnects on next use; erroring connections are destroyed, not reused.
- **Concurrent unique-name inserts:** `UNIQUE (name_key)` + `ER_DUP_ENTRY` mapping closes the race the in-memory check can't.
- **Fault-injection hooks** `[rev 4 — amendment 6]`: hooks that can throw or abort mid-transaction are active **only when `NODE_ENV=test`**; the server **refuses to start** if a hook env var is set in any other mode. A deployed container cannot have them on.
- **Secrets:** `MARIADB_PASSWORD` / `DB_PASSWORD` come from `.env` (gitignored) via compose variable substitution; never logged, never in error payloads.

## 9. Testing

`[rev 3 — items 5, 8, 9; rev 4 — amendments 1, 2, 6; rev 5 — amendments 2 and 3]` `test/security.test.mjs` launches the server as a **separate process** (`spawn` at `test/security.test.mjs:50`) with a temp `DATA_DIR`, and asserts on the persisted `data.json` (`:148`). Changes:

- Tests require a reachable MariaDB and use a throwaway database, `pickleball_test`, dropped and recreated (DDL re-applied) at the start of each run — no shared state between runs. The server under test is launched the same way as today (separate process) with `DB_NAME=pickleball_test`.
- `[rev 3 — item 9; rev 4 — amendment 1]` **Test credentials:** creating/dropping `pickleball_test` needs `CREATE`/`DROP` privileges the compose `MARIADB_USER` deliberately lacks. Tests use **root** (`DB_TEST_USER`/`DB_TEST_PASSWORD`, defaulting to `root`/`$MARIADB_ROOT_PASSWORD`) to provision the throwaway database — and **must also `GRANT ALL ON pickleball_test.* TO 'pickleball'@'%'`** after creating it, because the image's automatic grants for `MARIADB_USER` cover only `pickleball`. Without this grant the server under test fails every query with access-denied. (Alternative: a dedicated test user with the same explicit grant.)
- `[rev 3 — item 5]` **No-DB behavior (review veto applied):** tests **fail by default** when the database is unreachable, with an actionable message. Skipping is an explicit local opt-in only: `SKIP_DB_TESTS=1 npm test` prints a loud `SKIPPED: DB tests disabled` summary and runs the non-DB tests. CI (when present) must provide a reachable database — a skipped DB suite can never look green there.
- `[rev 3 — item 8; rev 4 — amendment 6]` **Fault injection is env-gated and test-only** (§8): hooks read an env var the harness sets for the spawned server; the server refuses to start with hooks set when `NODE_ENV !== 'test'`. A deployment cannot run with injection enabled.
- Coverage:
  1. All existing API/security behavior tests re-run against the DB-backed server (same assertions, new persistence layer).
  2. **Serialization (finding A as corrected / rev 3 item 1):** overlapping mutations — the second request's transaction starts only after the first completes, **including when the first client disconnects mid-handler** (abort the socket, then send the second mutation). `[rev 4 — review note]` Ordering is observed through a **deterministic test-only barrier** (the first transaction waits on a gate the test controls), not response timing — timing-based assertions would be flaky.
  3. **Transaction atomicity and commit failure** `[rev 4 — amendments 2 and 6; refined rev 5 — amendment 2]`: the test-only fault hook injects failures into the score handler. The commit-failure injection **throws before `COMMIT` reaches the server** — the only case where a full rollback can be asserted. For each injected failure the test asserts: no response success was sent (500 instead of 200), the match row is unchanged, and all player stat deltas rolled back completely. (A real lost commit confirmation isn't practical to test; its handling — unknown outcome, 500, destroyed connection, no auto-retry — is specified in §2/§8 and enforced in the same shared wrapper.)
  4. **Consistent-snapshot reads (finding 3):** interleave a `matches/generate` replacement with `GET /api/matches` response assembly and assert no response mixes old matches with missing participants.
  5. **Import path:** legacy `data.json` (including `player1Id`-style matches, unsorted ID arrays, over-long/odd `scheduled_at` strings, and names that lengthen when lowercased) → rows imported, arrays round-trip in original order, file renamed. **Crash-window test:** simulate commit-without-rename (delete the renamed file, restore the original) → restart does not re-import; then clear players and restart → still no resurrection (finding 1). **Fresh-install marker test:** first startup with no `data.json` sets `import_completed = 1`; a file dropped in afterwards is not auto-imported (rev 3 item 4). **Counter test:** a stale/low counter in the file is corrected to max(counter, max(id)+1) (rev 3 item 10).
  6. **Import pre-checks** `[rev 4 — amendment 5]`: a `data.json` exercising each §6.2 check (dangling player ref, bad `sessionId`, duplicate player ID, duplicate `name_key`, player twice in one team, invalid ISO timestamp, doubles match missing `round`/`scheduledAt`) → startup aborts with a message naming the record and field; nothing is imported. **Legacy defaults:** a `player1Id` match missing `round`/`courtNumber`/`scheduledAt` imports with `round: 0`, `scheduledAt: ''`, and `courtNumber: null` (rev 5 amendment 3). **Manual import guard:** `npm run import` against a database with any rows in `players`, `matches`, or `league_sessions` refuses with a clear error (rev 4 amendment 3; "non-empty" defined rev 5 item 4).
  7. **Names:** `Jose` vs `José` are distinct on import and creation (finding 6); an 80-char name containing `İ` (key lengthens beyond 80) is accepted and round-trips (rev 3 item 2).
  8. **Timestamps:** ms-precision `startedAt`/`completedAt` round-trip; a legacy schedule with hour 24+ (`"2026-10-05 24:00"`) stores and emits verbatim (findings 4/C); an over-length legacy `scheduled_at` string (beyond `TEXT`'s 65,535 bytes) round-trips through `MEDIUMTEXT` (rev 4 amendment 4).
  9. **Round-trip shapes:** `GET /api/matches` and `/api/players` return byte-identical JSON shapes to today's contract, with arrays whose IDs are not sorted (finding 5) — including `courtNumber: null` on legacy rows (rev 5 amendment 3).
  10. **Input validation (rev 3 item 7):** `99:99`, `2026-02-30`, and other pattern-valid but impossible values → 400; omitted values keep the defaults (today's date, `18:00`).
  11. **Fault-hook guard (rev 4 amendment 6):** starting the server with a hook env var set and `NODE_ENV !== 'test'` refuses to start.

## 10. Risks

- **Largest diff is in `server.mjs`** (~869 lines, single file): the rewrite touches all ~10 mutation sites **and reworks the queue/handler plumbing** (§2). Mitigation: the test suite in §9 plus the unchanged-JSON-shape contract for the frontend.
- **`[rev 3]` Queue rework is subtle:** the serialization guarantee must move from "response events" to "the handler's own work promise," and disconnect-mid-handler is exactly the case easy to get wrong. Test 2 is the guard, including the disconnect variant.
- **`[rev 4; refined rev 5]` Commit-before-response** (§2) is an invariant across every handler — one handler that responds early reintroduces the false-success bug. Test 3's commit-failure case is the guard; the shared handler wrapper (§8) is where it's enforced, not per-handler code. The unknown-outcome case (lost commit confirmation) cannot be fully tested — its handling lives in the wrapper and is specified in §2/§8.
- **Docker image gains a dependency step** (`npm ci` + committed `package-lock.json`); image size grows by the connector only.
- **`[rev 2; MEDIUMTEXT rev 4]` Timestamps:** `toISOString()` values include milliseconds, so session/completion columns are `DATETIME(3)` with explicit UTC (`timezone: 'Z'`); a regression here shifts times silently — covered by test 8. `scheduled_at` is `MEDIUMTEXT` and preserved verbatim — exact compatibility at the cost of a non-queryable column; a normalized derived column can be added later if SQL date math on schedules is ever wanted.
- **`[rev 2, refined rev 3]` Behavior change:** generate validates `date`/`startTime` for real calendars and time ranges, 400 on violation (§5), keeping defaults when omitted. Approved in review.
- **`[rev 3 — item 11]` Two instances on one database** (e.g. `app` + `app-hostnet` running together) are unsupported: separate queues, no cross-process serialization. Documented in §7/README; the `SELECT … FOR UPDATE` hardening in §6 does not change this.
- **Clock/timezone:** container clocks are shared via Docker; all conversions explicit UTC.
