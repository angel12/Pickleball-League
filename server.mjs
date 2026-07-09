import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const dataFile = path.join(dataDir, 'data.json');

const PORT = process.env.PORT || 3131;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
let mutationQueue = Promise.resolve();

if (!ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set');
}

function createEmptyState() {
  return {
    players: [],
    matches: [],
    sessions: [],
    meta: { nextPlayerId: 1, nextMatchId: 1, nextSessionId: 1, activeSessionId: null }
  };
}

function loadState() {
  if (!fs.existsSync(dataFile)) {
    const initial = createEmptyState();
    saveState(initial);
    return initial;
  }
  let state;
  try {
    const raw = fs.readFileSync(dataFile, 'utf-8').trim();
    state = raw ? JSON.parse(raw) : createEmptyState();
  } catch (error) {
    throw new Error(`Unable to parse ${dataFile}; refusing to overwrite it`, { cause: error });
  }
  state.players = Array.isArray(state.players) ? state.players : [];
  state.matches = Array.isArray(state.matches) ? state.matches : [];
  state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
  state.meta = state.meta || { nextPlayerId: 1, nextMatchId: 1, nextSessionId: 1, activeSessionId: null };
  if (!Number.isFinite(state.meta.nextSessionId)) state.meta.nextSessionId = 1;
  if (!('activeSessionId' in state.meta)) state.meta.activeSessionId = null;

  state.players.forEach(player => {
    if (!Number.isFinite(player.wins)) player.wins = 0;
    if (!Number.isFinite(player.losses)) player.losses = 0;
    if (typeof player.present !== 'boolean') player.present = true;
    if (!Number.isFinite(player.totalPoints)) player.totalPoints = 0;
    if (!Number.isFinite(player.pointsAllowed)) player.pointsAllowed = 0;
    if (!Number.isFinite(player.pickles)) player.pickles = 0;
  });

  return state;
}

function saveState(state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tempFile = path.join(dataDir, `.data.${process.pid}.${crypto.randomUUID()}.tmp`);
  const contents = JSON.stringify(state, null, 2);
  let fd;

  try {
    fd = fs.openSync(tempFile, 'wx', 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempFile, dataFile);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript'
    };

    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'text/plain',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(content);
  });
}

function parseBody(req) {
  if (req.parsedBody !== undefined) return Promise.resolve(req.parsedBody);

  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
  });
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .map(item => item.trim().split('='))
    .reduce((cookies, [name, ...valueParts]) => {
      if (name) cookies[name] = valueParts.join('=');
      return cookies;
    }, {});
}

function getSession(req) {
  const token = parseCookies(req).pickleball_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function secretsMatch(candidate, expected) {
  const candidateBuffer = Buffer.from(String(candidate));
  const expectedBuffer = Buffer.from(String(expected));
  return candidateBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function setSessionCookie(res, token, maxAge) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `pickleball_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function authorizeMutation(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'Authentication required' });
    return false;
  }

  if (!secretsMatch(req.headers['x-csrf-token'] || '', session.csrfToken)) {
    sendJson(res, 403, { error: 'Invalid CSRF token' });
    return false;
  }

  req.authSession = session;
  return true;
}

function enqueueMutation(task) {
  const operation = mutationQueue.then(task, task);
  mutationQueue = operation.catch(() => {});
  return operation;
}

function runApiHandler(req, res, pathname) {
  return new Promise(resolve => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };

    res.once('finish', finish);
    res.once('close', finish);
    try {
      apiHandler(req, res, pathname);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      else res.destroy();
      finish();
    }
  });
}

function buildRoundRobinPairs(playerIds) {
  const ids = [...playerIds];
  if (ids.length < 2) return [];
  if (ids.length % 2 === 1) ids.push(null);

  const rounds = [];
  for (let i = 0; i < ids.length - 1; i += 1) {
    const round = [];
    for (let j = 0; j < ids.length / 2; j += 1) {
      const p1 = ids[j];
      const p2 = ids[ids.length - 1 - j];
      if (p1 !== null && p2 !== null) {
        round.push([p1, p2]);
      }
    }
    rounds.push(round);
    const fixed = ids[0];
    const rotating = ids.slice(1);
    rotating.unshift(rotating.pop());
    ids.splice(0, ids.length, fixed, ...rotating);
  }
  return rounds;
}

function shuffle(array) {
  const list = [...array];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function buildDoublesRoundRobin(playerIds) {
  const pairRounds = buildRoundRobinPairs(playerIds);
  const rounds = [];
  const sitOutCountByPlayer = new Map();
  const lastSitOutRoundByPlayer = new Map();

  for (let roundIndex = 0; roundIndex < pairRounds.length; roundIndex += 1) {
    const roundPairs = pairRounds[roundIndex];
    const validPairs = roundPairs.filter(pair => pair[0] !== null && pair[1] !== null);
    const roundActivePlayers = new Set(validPairs.flat());
    const sitOutPlayerIds = playerIds.filter(playerId => !roundActivePlayers.has(playerId));

    if (validPairs.length % 2 === 1) {
      let bestIndex = 0;
      let bestScore = Number.POSITIVE_INFINITY;

      for (let i = 0; i < validPairs.length; i += 1) {
        const candidate = validPairs[i];
        const candidateScore = candidate.reduce((score, playerId) => {
          const satLastRound = lastSitOutRoundByPlayer.get(playerId) === roundIndex - 1 ? 1 : 0;
          const sitOutCount = sitOutCountByPlayer.get(playerId) || 0;
          return score + satLastRound * 1000 + sitOutCount * 10;
        }, 0) + Math.random();

        if (candidateScore < bestScore) {
          bestScore = candidateScore;
          bestIndex = i;
        }
      }

      const [droppedPair] = validPairs.splice(bestIndex, 1);
      sitOutPlayerIds.push(...droppedPair);
    }

    sitOutPlayerIds.forEach(playerId => {
      sitOutCountByPlayer.set(playerId, (sitOutCountByPlayer.get(playerId) || 0) + 1);
      lastSitOutRoundByPlayer.set(playerId, roundIndex);
    });

    const shuffledPairs = shuffle(validPairs);
    const matches = [];
    for (let i = 0; i + 1 < shuffledPairs.length; i += 2) {
      matches.push({
        team1PlayerIds: shuffledPairs[i],
        team2PlayerIds: shuffledPairs[i + 1]
      });
    }
    if (matches.length) {
      rounds.push({
        matches,
        sitOutPlayerIds
      });
    }
  }

  return rounds;
}

function hasConsecutiveSitOuts(rounds) {
  const lastSitOutRoundByPlayer = new Map();
  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const sitOutPlayerIds = rounds[roundIndex].sitOutPlayerIds || [];
    for (const playerId of sitOutPlayerIds) {
      if (lastSitOutRoundByPlayer.get(playerId) === roundIndex - 1) {
        return true;
      }
      lastSitOutRoundByPlayer.set(playerId, roundIndex);
    }
  }
  return false;
}

function getTeamPlayerIds(match, teamNumber) {
  if (teamNumber === 1) {
    if (Array.isArray(match.team1PlayerIds)) return match.team1PlayerIds;
    return Number.isFinite(match.player1Id) ? [match.player1Id] : [];
  }

  if (Array.isArray(match.team2PlayerIds)) return match.team2PlayerIds;
  return Number.isFinite(match.player2Id) ? [match.player2Id] : [];
}

function updateWinsAndLosses(state, match, winnerTeam, direction) {
  const winners = getTeamPlayerIds(match, winnerTeam);
  const losers = getTeamPlayerIds(match, winnerTeam === 1 ? 2 : 1);

  winners.forEach(playerId => {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return;
    if (direction > 0) player.wins += 1;
    else player.wins = Math.max(0, player.wins - 1);
  });

  losers.forEach(playerId => {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return;
    if (direction > 0) player.losses += 1;
    else player.losses = Math.max(0, player.losses - 1);
  });
}

function updateTeamPoints(state, playerIds, points, direction) {
  playerIds.forEach(playerId => {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return;
    if (direction > 0) player.totalPoints += points;
    else player.totalPoints = Math.max(0, player.totalPoints - points);
  });
}

function updateTeamPointsAllowed(state, playerIds, pointsAllowed, direction) {
  playerIds.forEach(playerId => {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return;
    if (direction > 0) player.pointsAllowed += pointsAllowed;
    else player.pointsAllowed = Math.max(0, player.pointsAllowed - pointsAllowed);
  });
}

function updatePicklesFromScore(state, match, team1Score, team2Score, direction) {
  if (!Number.isInteger(team1Score) || !Number.isInteger(team2Score) || team1Score === team2Score) return;
  const winnerTeam = team1Score > team2Score ? 1 : 2;
  const loserScore = winnerTeam === 1 ? team2Score : team1Score;
  if (loserScore !== 0) return;

  getTeamPlayerIds(match, winnerTeam).forEach(playerId => {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return;
    if (direction > 0) player.pickles += 1;
    else player.pickles = Math.max(0, player.pickles - 1);
  });
}

function buildStatsFromMatches(players, matches) {
  const stats = players.map(player => ({
    playerId: player.id,
    name: player.name,
    wins: 0,
    losses: 0,
    totalPoints: 0,
    pointsAllowed: 0,
    pickles: 0,
    pointDiff: 0
  }));
  const byId = new Map(stats.map(item => [item.playerId, item]));

  matches.forEach(match => {
    if ([1, 2].includes(match.winnerTeam)) {
      getTeamPlayerIds(match, match.winnerTeam).forEach(playerId => {
        const stat = byId.get(playerId);
        if (stat) stat.wins += 1;
      });
      getTeamPlayerIds(match, match.winnerTeam === 1 ? 2 : 1).forEach(playerId => {
        const stat = byId.get(playerId);
        if (stat) stat.losses += 1;
      });
    }

    if (Number.isInteger(match.team1Score) && Number.isInteger(match.team2Score)) {
      if (match.team1Score !== match.team2Score) {
        const winnerTeam = match.team1Score > match.team2Score ? 1 : 2;
        const loserScore = winnerTeam === 1 ? match.team2Score : match.team1Score;
        if (loserScore === 0) {
          getTeamPlayerIds(match, winnerTeam).forEach(playerId => {
            const stat = byId.get(playerId);
            if (stat) stat.pickles += 1;
          });
        }
      }

      getTeamPlayerIds(match, 1).forEach(playerId => {
        const stat = byId.get(playerId);
        if (!stat) return;
        stat.totalPoints += match.team1Score;
        stat.pointsAllowed += match.team2Score;
      });
      getTeamPlayerIds(match, 2).forEach(playerId => {
        const stat = byId.get(playerId);
        if (!stat) return;
        stat.totalPoints += match.team2Score;
        stat.pointsAllowed += match.team1Score;
      });
    }
  });

  stats.forEach(stat => {
    stat.pointDiff = stat.totalPoints - stat.pointsAllowed;
  });
  return stats;
}

function getMatchParticipantIds(match) {
  const ids = new Set();
  getTeamPlayerIds(match, 1).forEach(id => ids.add(id));
  getTeamPlayerIds(match, 2).forEach(id => ids.add(id));
  return ids;
}

function apiHandler(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/auth/session') {
    const session = getSession(req);
    sendJson(res, 200, session
      ? { authenticated: true, csrfToken: session.csrfToken }
      : { authenticated: false, csrfToken: null });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    parseBody(req)
      .then(body => {
        if (!secretsMatch(body.password || '', ADMIN_PASSWORD)) {
          sendJson(res, 401, { error: 'Invalid password' });
          return;
        }

        const token = crypto.randomBytes(32).toString('base64url');
        const csrfToken = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
        setSessionCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
        sendJson(res, 200, { authenticated: true, csrfToken });
      })
      .catch(err => sendJson(res, 400, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    if (req.authSession) sessions.delete(req.authSession.token);
    setSessionCookie(res, '', 0);
    sendJson(res, 200, { success: true });
    return;
  }

  const state = loadState();

  if (req.method === 'GET' && pathname === '/api/players') {
    sendJson(res, 200, state.players);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/players') {
    parseBody(req)
      .then(body => {
        const name = String(body.name || '').trim();
        if (!name) {
          sendJson(res, 400, { error: 'Player name is required' });
          return;
        }

        if (name.length > 80) {
          sendJson(res, 400, { error: 'Player name must be 80 characters or fewer' });
          return;
        }

        if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
          sendJson(res, 400, { error: 'Player already exists' });
          return;
        }

        const player = { id: state.meta.nextPlayerId++, name, wins: 0, losses: 0, totalPoints: 0, pointsAllowed: 0, pickles: 0, present: true };
        state.players.push(player);
        saveState(state);
        sendJson(res, 201, player);
      })
      .catch(err => sendJson(res, 400, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/players/clear') {
    state.players = [];
    state.matches = [];
    state.sessions = [];
    state.meta.nextPlayerId = 1;
    state.meta.nextMatchId = 1;
    state.meta.nextSessionId = 1;
    state.meta.activeSessionId = null;
    saveState(state);
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/players/clear-history') {
    parseBody(req)
      .then(() => {
        state.players.forEach(player => {
          player.wins = 0;
          player.losses = 0;
          player.totalPoints = 0;
          player.pointsAllowed = 0;
          player.pickles = 0;
        });
        state.matches = [];
        state.meta.nextMatchId = 1;
        state.sessions = [];
        state.meta.nextSessionId = 1;
        state.meta.activeSessionId = null;
        saveState(state);
        sendJson(res, 200, { success: true });
      })
      .catch(err => sendJson(res, 400, { error: err.message }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/players/presence/clear') {
    state.players.forEach(player => {
      player.present = false;
    });
    saveState(state);
    sendJson(res, 200, { success: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/session') {
    const activeSession = state.sessions.find(session => session.id === state.meta.activeSessionId) || null;
    const lastSession = state.sessions.length ? state.sessions[state.sessions.length - 1] : null;
    sendJson(res, 200, { activeSession, lastSession });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/session/start') {
    if (state.meta.activeSessionId !== null) {
      sendJson(res, 400, { error: 'A round robin session is already active' });
      return;
    }

    const session = {
      id: state.meta.nextSessionId++,
      startedAt: new Date().toISOString(),
      endedAt: null
    };
    state.sessions.push(session);
    state.meta.activeSessionId = session.id;

    // If matches were generated before starting the session, attach them now
    // so active-session stats include score updates for those matches.
    state.matches.forEach(match => {
      if (match.sessionId === null || match.sessionId === undefined) {
        match.sessionId = session.id;
      }
    });

    saveState(state);
    sendJson(res, 201, session);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/session/end') {
    if (state.meta.activeSessionId === null) {
      sendJson(res, 400, { error: 'No active round robin session to end' });
      return;
    }
    const session = state.sessions.find(item => item.id === state.meta.activeSessionId);
    if (!session) {
      state.meta.activeSessionId = null;
      saveState(state);
      sendJson(res, 400, { error: 'Active session was not found and has been cleared' });
      return;
    }
    session.endedAt = new Date().toISOString();
    state.meta.activeSessionId = null;
    saveState(state);
    sendJson(res, 200, session);
    return;
  }

  const presenceMatch = pathname.match(/^\/api\/players\/(\d+)\/presence$/);
  if (req.method === 'POST' && presenceMatch) {
    parseBody(req)
      .then(body => {
        const playerId = Number(presenceMatch[1]);
        const present = Boolean(body.present);

        const player = state.players.find(p => p.id === playerId);
        if (!player) {
          sendJson(res, 404, { error: 'Player not found' });
          return;
        }

        player.present = present;
        saveState(state);
        sendJson(res, 200, player);
      })
      .catch(err => sendJson(res, 400, { error: err.message }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/matches') {
    sendJson(res, 200, state.matches);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/stats/active-session') {
    const activeSessionId = state.meta.activeSessionId;
    if (activeSessionId === null) {
      sendJson(res, 200, { activeSessionId: null, matchesFinished: 0, stats: [] });
      return;
    }

    const todaysMatches = state.matches.filter(match => match.completed && match.sessionId === activeSessionId);
    const participatingIds = new Set();
    todaysMatches.forEach(match => {
      getMatchParticipantIds(match).forEach(playerId => participatingIds.add(playerId));
    });
    const participatingPlayers = state.players.filter(player => participatingIds.has(player.id));
    const stats = buildStatsFromMatches(participatingPlayers, todaysMatches);
    sendJson(res, 200, { activeSessionId, matchesFinished: todaysMatches.length, stats });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/matches/generate') {
    parseBody(req)
      .then(body => {
        const selected = Array.isArray(body.playerIds)
          ? body.playerIds.map(n => Number(n)).filter(Number.isFinite)
          : state.players.filter(p => p.present !== false).map(p => p.id);

        const uniqueIds = [...new Set(selected)];
        if (uniqueIds.length < 4) {
          sendJson(res, 400, { error: 'At least four present players are required for doubles' });
          return;
        }

        const playersExist = uniqueIds.every(id => state.players.some(p => p.id === id));
        if (!playersExist) {
          sendJson(res, 400, { error: 'One or more players do not exist' });
          return;
        }

        let rounds = [];
        const maxAttempts = 100;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const candidate = buildDoublesRoundRobin(shuffle(uniqueIds));
          if (!candidate.length) continue;
          rounds = candidate;
          if (!hasConsecutiveSitOuts(candidate)) break;
        }

        if (!rounds.length) {
          sendJson(res, 400, { error: 'Unable to generate doubles matches for this player set' });
          return;
        }
        if (hasConsecutiveSitOuts(rounds)) {
          sendJson(res, 400, { error: 'Unable to generate schedule without consecutive sit-outs. Try changing player count.' });
          return;
        }
        const date = String(body.date || '').trim() || new Date().toISOString().slice(0, 10);
        const startTime = String(body.startTime || '').trim() || '18:00';
        const courtCount = Math.max(1, Number(body.courtCount) || 1);

        const generated = [];
        rounds.forEach((round, roundIndex) => {
          round.matches.forEach((roundMatch, matchIndex) => {
            const slot = Math.floor(matchIndex / courtCount);
            const [h, m] = startTime.split(':').map(Number);
            const minutes = (h * 60 + m) + slot * 25 + roundIndex * 40;
            const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
            const minute = String(minutes % 60).padStart(2, '0');

            generated.push({
              id: state.meta.nextMatchId++,
              round: roundIndex + 1,
              scheduledAt: `${date} ${hour}:${minute}`,
              courtNumber: (matchIndex % courtCount) + 1,
              team1PlayerIds: roundMatch.team1PlayerIds,
              team2PlayerIds: roundMatch.team2PlayerIds,
              sitOutPlayerIds: round.sitOutPlayerIds,
              sessionId: state.meta.activeSessionId,
              team1Score: null,
              team2Score: null,
              winnerTeam: null,
              completed: false,
              completedAt: null
            });
          });
        });

        state.matches = generated;
        state.meta.nextMatchId = generated.length ? generated.at(-1).id + 1 : 1;
        saveState(state);
        sendJson(res, 201, { generatedCount: generated.length, matches: generated });
      })
      .catch(err => sendJson(res, 400, { error: err.message }));
    return;
  }

  const resultMatch = pathname.match(/^\/api\/matches\/(\d+)\/result$/);
  if (req.method === 'POST' && resultMatch) {
    parseBody(req)
      .then(body => {
        const matchId = Number(resultMatch[1]);
        const winnerTeam = Number(body.winnerTeam);

        const match = state.matches.find(m => m.id === matchId);
        if (!match) {
          sendJson(res, 404, { error: 'Match not found' });
          return;
        }

        if (![1, 2].includes(winnerTeam)) {
          sendJson(res, 400, { error: 'winnerTeam must be 1 or 2' });
          return;
        }

        if (match.completed && [1, 2].includes(match.winnerTeam)) updateWinsAndLosses(state, match, match.winnerTeam, -1);
        match.winnerTeam = winnerTeam;
        match.completed = true;
        match.completedAt = new Date().toISOString();
        updateWinsAndLosses(state, match, winnerTeam, 1);

        saveState(state);
        sendJson(res, 200, match);
      })
      .catch(err => sendJson(res, 400, { error: err.message }));
    return;
  }

  const scoreMatch = pathname.match(/^\/api\/matches\/(\d+)\/score$/);
  if (req.method === 'POST' && scoreMatch) {
    parseBody(req)
      .then(body => {
        const matchId = Number(scoreMatch[1]);
        const team1Score = Number(body.team1Score);
        const team2Score = Number(body.team2Score);

        if (!Number.isInteger(team1Score) || !Number.isInteger(team2Score) || team1Score < 0 || team2Score < 0) {
          sendJson(res, 400, { error: 'Scores must be non-negative whole numbers' });
          return;
        }
        if (team1Score === team2Score) {
          sendJson(res, 400, { error: 'Tie scores are not allowed' });
          return;
        }

        const match = state.matches.find(m => m.id === matchId);
        if (!match) {
          sendJson(res, 404, { error: 'Match not found' });
          return;
        }

        if (match.completed && [1, 2].includes(match.winnerTeam)) updateWinsAndLosses(state, match, match.winnerTeam, -1);

        if (Number.isInteger(match.team1Score) && Number.isInteger(match.team2Score)) {
          updateTeamPoints(state, getTeamPlayerIds(match, 1), match.team1Score, -1);
          updateTeamPoints(state, getTeamPlayerIds(match, 2), match.team2Score, -1);
          updateTeamPointsAllowed(state, getTeamPlayerIds(match, 1), match.team2Score, -1);
          updateTeamPointsAllowed(state, getTeamPlayerIds(match, 2), match.team1Score, -1);
          updatePicklesFromScore(state, match, match.team1Score, match.team2Score, -1);
        }

        const winnerTeam = team1Score > team2Score ? 1 : 2;
        match.team1Score = team1Score;
        match.team2Score = team2Score;
        match.winnerTeam = winnerTeam;
        match.completed = true;
        match.completedAt = new Date().toISOString();

        updateTeamPoints(state, getTeamPlayerIds(match, 1), team1Score, 1);
        updateTeamPoints(state, getTeamPlayerIds(match, 2), team2Score, 1);
        updateTeamPointsAllowed(state, getTeamPlayerIds(match, 1), team2Score, 1);
        updateTeamPointsAllowed(state, getTeamPlayerIds(match, 2), team1Score, 1);
        updatePicklesFromScore(state, match, team1Score, team2Score, 1);
        updateWinsAndLosses(state, match, winnerTeam, 1);

        saveState(state);
        sendJson(res, 200, match);
      })
      .catch(err => sendJson(res, 400, { error: err.message }));
    return;
  }

  sendJson(res, 404, { error: 'API route not found' });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    sendJson(res, 400, { error: 'Invalid request URL' });
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (req.method === 'POST' && pathname !== '/api/auth/login') {
      if (!authorizeMutation(req, res)) return;
      parseBody(req)
        .then(body => {
          req.parsedBody = body;
          enqueueMutation(() => runApiHandler(req, res, pathname));
        })
        .catch(err => sendJson(res, 400, { error: err.message }));
      return;
    }

    runApiHandler(req, res, pathname);
    return;
  }

  if (pathname === '/') {
    sendFile(res, path.join(publicDir, 'index.html'));
    return;
  }

  const filePath = path.join(publicDir, pathname);
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  sendFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`Pickleball League app running at http://${HOST}:${PORT}`);
});
