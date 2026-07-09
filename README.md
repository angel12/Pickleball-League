# Pickleball League App

A lightweight web app to manage a pickleball league:

- Track player wins/losses
- Track total points per player from recorded match scores
- Track player pickles (wins where opponent scores 0)
- Show an Active Session Stats leaderboard from matches in the current active session
- Mark players present/absent for the current session
- Generate doubles round robin match schedules (2 players per team)

## Run

1. Make sure you have Node.js 18+ installed.
2. From this folder, run:

```bash
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

3. Open http://127.0.0.1:3131 in your browser.

## Docker

### Build and run with normal port mapping

```bash
APP_PORT=3131 ADMIN_PASSWORD='choose-a-strong-password' docker compose up --build
```

Then open `http://127.0.0.1:3131`.

When upgrading an existing Docker install, migrate its state before the first start:

```bash
mkdir -p league-data
cp data.json league-data/data.json
```

### Run with host network mode

```bash
COMPOSE_PROFILES=hostnet APP_PORT=3131 ADMIN_PASSWORD='choose-a-strong-password' docker compose up --build app-hostnet
```

Notes:

- `APP_PORT` sets the app listen port inside the container.
- `ADMIN_PASSWORD` is required and protects every API operation that changes league data.
- Docker persists state in the local `league-data` directory so state files can be replaced atomically.
- Set `COOKIE_SECURE=true` when the app is served through HTTPS.
- In host network mode, Docker port mappings are not used.
- Host network mode is typically supported on Linux hosts.

## Main API Endpoints

- `GET /api/players`
- `GET /api/auth/session`
- `POST /api/auth/login` with `{ "password": "..." }`
- `POST /api/auth/logout`
- `POST /api/players` with `{ "name": "Alex" }`
- `POST /api/players/clear` clears all players and matches
- `POST /api/players/clear-history` keeps player names but resets stats and clears matches
- `POST /api/players/presence/clear` unchecks `present` for all players
- `POST /api/players/:id/presence` with `{ "present": true }`
- `GET /api/session` returns active/last round robin session
- `POST /api/session/start` starts a round robin session
- `POST /api/session/end` ends the active round robin session
- `GET /api/matches`
- `POST /api/matches/generate` with `{ "date": "2026-03-10", "startTime": "18:00", "courtCount": 2 }`
- `POST /api/matches/:id/result` with `{ "winnerTeam": 1 }` (1 or 2)
- `POST /api/matches/:id/score` with `{ "team1Score": 11, "team2Score": 8 }`
- `GET /api/stats/active-session` returns player stats from matches in the active session

## Notes

- Data persists to `data.json` in this folder.
- Mutating API requests require an authenticated session and the CSRF token returned by the login/session endpoint.
- State changes are serialized and persisted with atomic file replacement to prevent lost or partial writes.
- Generating matches clears the current match list and creates a new one.
- At least 4 present players are required to generate doubles matches.
- Each generated match includes an assigned `courtNumber` based on the selected court count.
- Each generated match includes `sitOutPlayerIds` listing players not playing in that round.
- Scheduler retries to avoid any player sitting out consecutive rounds; if impossible, generation returns an error.
- Saving a score automatically sets the winner and updates wins/losses plus player `totalPoints`.
- Saving a score also updates each player's `pointsAllowed` by adding the opponent team's score.
- Saving a score updates `pickles` for the winning team when the losing team score is `0`.
- Active Session Stats only includes completed matches with `sessionId` matching the active session.
- The browser prompts for the required admin password and keeps authentication in an HTTP-only, same-site session cookie.
