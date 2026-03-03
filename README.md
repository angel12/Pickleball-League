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
npm start
```

3. Open http://127.0.0.1:3000 in your browser.

## Main API Endpoints

- `GET /api/players`
- `POST /api/players` with `{ "name": "Alex" }`
- `POST /api/players/clear` clears all players and matches
- `POST /api/players/clear-history` with `{ "password": "..." }` keeps player names but resets stats and clears matches
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
- Generating matches clears the current match list and creates a new one.
- At least 4 present players are required to generate doubles matches.
- Each generated match includes an assigned `courtNumber` based on the selected court count.
- Each generated match includes `sitOutPlayerIds` listing players not playing in that round.
- Scheduler retries to avoid any player sitting out consecutive rounds; if impossible, generation returns an error.
- Saving a score automatically sets the winner and updates wins/losses plus player `totalPoints`.
- Saving a score also updates each player's `pointsAllowed` by adding the opponent team's score.
- Saving a score updates `pickles` for the winning team when the losing team score is `0`.
- Active Session Stats only includes completed matches with `sessionId` matching the active session.
- Clear History requires password (default is `pickleball`, override with `CLEAR_HISTORY_PASSWORD` env var).
