const playerForm = document.querySelector('#player-form');
const playerNameInput = document.querySelector('#player-name');
const clearPresentButton = document.querySelector('#clear-present-btn');
const clearHistoryButton = document.querySelector('#clear-history-btn');
const clearPlayersButton = document.querySelector('#clear-players-btn');
const playersTableBody = document.querySelector('#players-table tbody');
const scheduleForm = document.querySelector('#schedule-form');
const scheduleDateInput = document.querySelector('#schedule-date');
const scheduleTimeInput = document.querySelector('#schedule-time');
const courtCountInput = document.querySelector('#court-count');
const startSessionButton = document.querySelector('#start-session-btn');
const endSessionButton = document.querySelector('#end-session-btn');
const sessionStatus = document.querySelector('#session-status');
const matchesContainer = document.querySelector('#matches');
const todaysStatsTableBody = document.querySelector('#todays-stats-table tbody');
const message = document.querySelector('#message');

scheduleDateInput.value = new Date().toISOString().slice(0, 10);

let players = [];
let matches = [];
let activeSessionStats = [];
let activeSessionMatchesFinished = 0;
let sessionInfo = { activeSession: null, lastSession: null };

function setMessage(text, isError = false) {
  message.textContent = text;
  message.style.color = isError ? '#b00020' : '#006d77';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function playerNameById(id) {
  const p = players.find(player => player.id === id);
  return p ? p.name : `Player ${id}`;
}

function renderPlayers() {
  playersTableBody.innerHTML = players
    .sort((a, b) => {
      const aDiff = (Number.isFinite(a.totalPoints) ? a.totalPoints : 0) - (Number.isFinite(a.pointsAllowed) ? a.pointsAllowed : 0);
      const bDiff = (Number.isFinite(b.totalPoints) ? b.totalPoints : 0) - (Number.isFinite(b.pointsAllowed) ? b.pointsAllowed : 0);
      return b.wins - a.wins || bDiff - aDiff || b.totalPoints - a.totalPoints || a.losses - b.losses || a.name.localeCompare(b.name);
    })
    .map(
      p => {
        const totalPoints = Number.isFinite(p.totalPoints) ? p.totalPoints : 0;
        const pointsAllowed = Number.isFinite(p.pointsAllowed) ? p.pointsAllowed : 0;
        const pointDiff = totalPoints - pointsAllowed;
        return `<tr>
        <td>${p.name}</td>
        <td>${p.wins}</td>
        <td>${p.losses}</td>
        <td>${totalPoints}</td>
        <td>${pointsAllowed}</td>
        <td>${pointDiff}</td>
        <td>${Number.isFinite(p.pickles) ? p.pickles : 0}</td>
        <td><input type="checkbox" data-player-id="${p.id}" data-type="presence" ${p.present !== false ? 'checked' : ''} /></td>
      </tr>`;
      }
    )
    .join('');
}

function renderSessionStatus() {
  if (sessionInfo.activeSession) {
    sessionStatus.textContent = `Session active since ${new Date(sessionInfo.activeSession.startedAt).toLocaleTimeString()}`;
    return;
  }
  if (sessionInfo.lastSession?.endedAt) {
    sessionStatus.textContent = `Last session ended ${new Date(sessionInfo.lastSession.endedAt).toLocaleTimeString()}`;
    return;
  }
  sessionStatus.textContent = 'No active session';
}

function renderActiveSessionStats() {
  if (!activeSessionStats.length) {
    todaysStatsTableBody.innerHTML = '<tr><td colspan="7">No completed matches in the active session.</td></tr>';
    return;
  }

  todaysStatsTableBody.innerHTML = activeSessionStats
    .sort((a, b) => b.wins - a.wins || b.pointDiff - a.pointDiff || b.totalPoints - a.totalPoints || a.losses - b.losses || a.name.localeCompare(b.name))
    .map(
      stat => `<tr>
        <td>${stat.name}</td>
        <td>${stat.wins}</td>
        <td>${stat.losses}</td>
        <td>${stat.totalPoints}</td>
        <td>${stat.pointsAllowed}</td>
        <td>${stat.pointDiff}</td>
        <td>${Number.isFinite(stat.pickles) ? stat.pickles : 0}</td>
      </tr>`
    )
    .join('');
}

function renderMatches() {
  if (!matches.length) {
    matchesContainer.innerHTML = '<p>No matches scheduled.</p>';
    return;
  }

  matchesContainer.innerHTML = matches
    .sort((a, b) => {
      const aHasWinner = (a.winnerTeam !== null && a.winnerTeam !== undefined) || (a.winnerId !== null && a.winnerId !== undefined);
      const bHasWinner = (b.winnerTeam !== null && b.winnerTeam !== undefined) || (b.winnerId !== null && b.winnerId !== undefined);
      if (aHasWinner !== bHasWinner) return aHasWinner ? 1 : -1;
      return a.round - b.round || a.id - b.id;
    })
    .map(match => {
      const team1 = Array.isArray(match.team1PlayerIds)
        ? match.team1PlayerIds.map(playerNameById).join(' & ')
        : playerNameById(match.player1Id);
      const team2 = Array.isArray(match.team2PlayerIds)
        ? match.team2PlayerIds.map(playerNameById).join(' & ')
        : playerNameById(match.player2Id);
      const winner =
        match.winnerTeam === 1
          ? `Team 1 (${team1})`
          : match.winnerTeam === 2
            ? `Team 2 (${team2})`
            : 'Not reported';
      const courtLabel = Number.isFinite(match.courtNumber) ? `Court ${match.courtNumber}` : 'Court TBD';
      const sitOutLabel = Array.isArray(match.sitOutPlayerIds) && match.sitOutPlayerIds.length
        ? match.sitOutPlayerIds.map(playerNameById).join(', ')
        : 'None';
      const scoreLabel =
        Number.isInteger(match.team1Score) && Number.isInteger(match.team2Score)
          ? `${match.team1Score} - ${match.team2Score}`
          : 'Not recorded';

      return `
        <article class="match">
          <strong>Round ${match.round}</strong> - ${match.scheduledAt} - ${courtLabel}<br />
          Team 1: ${team1}<br />
          Team 2: ${team2}<br />
          Score: ${scoreLabel}<br />
          Sitting out this round: ${sitOutLabel}<br />
          Winner: ${winner}<br />
          <div class="row">
            <input data-match-id="${match.id}" data-type="team1-score" type="number" min="0" step="1" placeholder="Team 1 score" value="${Number.isInteger(match.team1Score) ? match.team1Score : ''}" />
            <input data-match-id="${match.id}" data-type="team2-score" type="number" min="0" step="1" placeholder="Team 2 score" value="${Number.isInteger(match.team2Score) ? match.team2Score : ''}" />
            <button data-match-id="${match.id}" data-action="save-score">Save Score</button>
          </div>
        </article>
      `;
    })
    .join('');
}

async function refresh() {
  const [nextPlayers, nextMatches, nextActiveSessionStats, nextSessionInfo] = await Promise.all([
    api('/api/players'),
    api('/api/matches'),
    api('/api/stats/active-session'),
    api('/api/session')
  ]);
  players = nextPlayers;
  matches = nextMatches;
  activeSessionStats = nextActiveSessionStats.stats;
  activeSessionMatchesFinished = nextActiveSessionStats.matchesFinished;
  sessionInfo = nextSessionInfo;
  renderPlayers();
  renderMatches();
  renderActiveSessionStats();
  renderSessionStatus();
}

playerForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await api('/api/players', {
      method: 'POST',
      body: JSON.stringify({ name: playerNameInput.value.trim() })
    });
    playerNameInput.value = '';
    await refresh();
    setMessage('Player added.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

clearPlayersButton.addEventListener('click', async () => {
  const confirmed = window.confirm('Clear all players and matches?');
  if (!confirmed) return;

  try {
    await api('/api/players/clear', { method: 'POST' });
    await refresh();
    setMessage('Players and matches cleared.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

clearPresentButton.addEventListener('click', async () => {
  try {
    await api('/api/players/presence/clear', { method: 'POST' });
    await refresh();
    setMessage('All player presence checkboxes cleared.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

clearHistoryButton.addEventListener('click', async () => {
  const confirmed = window.confirm('Clear all player stats and current matches, but keep player names?');
  if (!confirmed) return;
  const password = window.prompt('Enter password to clear history:');
  if (password === null) return;

  try {
    await api('/api/players/clear-history', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    await refresh();
    setMessage('Player history cleared. Names kept.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

startSessionButton.addEventListener('click', async () => {
  try {
    await api('/api/session/start', { method: 'POST' });
    await refresh();
    setMessage('Round robin session started.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

endSessionButton.addEventListener('click', async () => {
  const finishedCount = activeSessionMatchesFinished;
  try {
    await api('/api/session/end', { method: 'POST' });
    await refresh();
    setMessage(`Round robin session ended. ${finishedCount} matches were finished in that session.`);
  } catch (error) {
    setMessage(error.message, true);
  }
});

scheduleForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const result = await api('/api/matches/generate', {
      method: 'POST',
      body: JSON.stringify({
        date: scheduleDateInput.value,
        startTime: scheduleTimeInput.value,
        courtCount: Number(courtCountInput.value)
      })
    });
    await refresh();
    setMessage(`Generated ${result.generatedCount} matches.`);
  } catch (error) {
    setMessage(error.message, true);
  }
});

playersTableBody.addEventListener('change', async event => {
  const input = event.target;
  if (input.dataset.type !== 'presence') return;

  try {
    await api(`/api/players/${input.dataset.playerId}/presence`, {
      method: 'POST',
      body: JSON.stringify({ present: input.checked })
    });
    await refresh();
    setMessage('Player presence updated.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

matchesContainer.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action="save-score"]');
  if (!button) return;

  const matchId = button.dataset.matchId;
  const team1Input = matchesContainer.querySelector(`input[data-match-id="${matchId}"][data-type="team1-score"]`);
  const team2Input = matchesContainer.querySelector(`input[data-match-id="${matchId}"][data-type="team2-score"]`);
  const team1Score = Number(team1Input?.value);
  const team2Score = Number(team2Input?.value);

  if (!Number.isInteger(team1Score) || !Number.isInteger(team2Score) || team1Score < 0 || team2Score < 0) {
    setMessage('Enter non-negative whole-number scores for both teams.', true);
    return;
  }

  try {
    await api(`/api/matches/${matchId}/score`, {
      method: 'POST',
      body: JSON.stringify({ team1Score, team2Score })
    });
    await refresh();
    setMessage('Score saved.');
  } catch (error) {
    setMessage(error.message, true);
  }
});

refresh().catch(error => setMessage(error.message, true));
