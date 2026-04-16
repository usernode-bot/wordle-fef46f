const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { ANSWERS, VALID_EXTRA } = require('./words');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;

app.use(express.json());

// JWT auth middleware
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {}
  }
  next();
});

const VALID_WORDS = new Set([...ANSWERS, ...VALID_EXTRA]);

// Deterministic daily word by UTC date
function getTodayIndex() {
  const EPOCH = new Date('2024-01-01').getTime();
  return Math.floor((Date.now() - EPOCH) / 86400000) % ANSWERS.length;
}

function getTodayDate() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD UTC
}

// Evaluate guess against answer — standard Wordle logic
function evaluateGuess(guess, answer) {
  const result = Array(5).fill('absent');
  const answerArr = answer.split('');
  const guessArr = guess.split('');

  // First pass: correct positions
  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === answerArr[i]) {
      result[i] = 'correct';
      answerArr[i] = null;
      guessArr[i] = null;
    }
  }

  // Second pass: present but wrong position
  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === null) continue;
    const idx = answerArr.indexOf(guessArr[i]);
    if (idx !== -1) {
      result[i] = 'present';
      answerArr[idx] = null;
    }
  }

  return result;
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Get today's word number and current user game state
app.get('/api/wordle/daily', async (req, res) => {
  const dayIndex = getTodayIndex();
  const gameDate = getTodayDate();
  const word = ANSWERS[dayIndex];

  let game = null;
  if (req.user) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM wordle_games WHERE user_id = $1 AND game_date = $2',
        [req.user.id, gameDate]
      );
      if (rows.length) {
        const g = rows[0];
        const completed = g.won !== null;
        game = {
          guesses: g.guesses,
          results: g.guesses.map(guess => evaluateGuess(guess, word)),
          won: g.won,
          completed,
          word: completed ? word : null,
        };
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.json({ dayIndex, game });
});

// Submit a guess
app.post('/api/wordle/guess', async (req, res) => {
  const { guess } = req.body;
  if (!guess || typeof guess !== 'string' || guess.length !== 5) {
    return res.status(400).json({ error: 'Invalid guess' });
  }

  const normalized = guess.toLowerCase().replace(/[^a-z]/g, '');
  if (normalized.length !== 5) {
    return res.status(400).json({ error: 'Guess must be 5 letters' });
  }

  const gameDate = getTodayDate();
  const word = ANSWERS[getTodayIndex()];
  const result = evaluateGuess(normalized, word);
  const didWin = result.every(r => r === 'correct');

  if (!req.user) {
    // Unauthenticated: just return result, no persistence
    return res.json({ result, won: didWin, gameOver: didWin });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM wordle_games WHERE user_id = $1 AND game_date = $2',
      [req.user.id, gameDate]
    );

    let newGuesses;
    if (rows.length) {
      const g = rows[0];
      if (g.won !== null) return res.status(400).json({ error: 'Game already completed' });
      if (g.guesses.length >= 6) return res.status(400).json({ error: 'No more guesses' });

      newGuesses = [...g.guesses, normalized];
      const gameOver = didWin || newGuesses.length >= 6;

      await pool.query(
        `UPDATE wordle_games SET guesses = $1, won = $2, completed_at = $3 WHERE id = $4`,
        [newGuesses, gameOver ? didWin : null, gameOver ? new Date() : null, g.id]
      );

      if (gameOver) await updateStats(req.user.id, req.user.username, didWin, newGuesses.length, gameDate);
    } else {
      newGuesses = [normalized];
      const gameOver = didWin || newGuesses.length >= 6;

      await pool.query(
        `INSERT INTO wordle_games (user_id, username, game_date, word, guesses, won, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.id, req.user.username, gameDate, word, newGuesses,
         gameOver ? didWin : null, gameOver ? new Date() : null]
      );

      if (gameOver) await updateStats(req.user.id, req.user.username, didWin, newGuesses.length, gameDate);
    }

    const gameOver = didWin || newGuesses.length >= 6;
    res.json({
      result,
      won: didWin,
      gameOver,
      guessCount: newGuesses.length,
      word: gameOver ? word : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function updateStats(userId, username, won, guessCount, gameDate) {
  const { rows } = await pool.query('SELECT * FROM wordle_stats WHERE user_id = $1', [userId]);

  if (rows.length) {
    const s = rows[0];
    const lastWin = s.last_win_date ? new Date(s.last_win_date).toISOString().split('T')[0] : null;
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    let newStreak = won
      ? (lastWin === yesterday || lastWin === gameDate ? s.current_streak + 1 : 1)
      : 0;

    const dist = { ...s.guess_distribution };
    if (won) dist[String(guessCount)] = (dist[String(guessCount)] || 0) + 1;

    await pool.query(
      `UPDATE wordle_stats SET
        username = $1,
        games_played = games_played + 1,
        games_won = games_won + $2,
        current_streak = $3,
        max_streak = GREATEST(max_streak, $3),
        last_win_date = $4,
        guess_distribution = $5
       WHERE user_id = $6`,
      [username, won ? 1 : 0, newStreak,
       won ? gameDate : s.last_win_date, dist, userId]
    );
  } else {
    const dist = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 };
    if (won) dist[String(guessCount)] = 1;

    await pool.query(
      `INSERT INTO wordle_stats (user_id, username, games_played, games_won, current_streak, max_streak, last_win_date, guess_distribution)
       VALUES ($1, $2, 1, $3, $4, $4, $5, $6)`,
      [userId, username, won ? 1 : 0, won ? 1 : 0, won ? gameDate : null, dist]
    );
  }
}

// User stats
app.get('/api/wordle/stats', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const { rows } = await pool.query('SELECT * FROM wordle_stats WHERE user_id = $1', [req.user.id]);
    if (!rows.length) {
      return res.json({
        games_played: 0, games_won: 0, win_pct: 0,
        current_streak: 0, max_streak: 0,
        guess_distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 },
      });
    }
    const s = rows[0];
    res.json({
      games_played: s.games_played,
      games_won: s.games_won,
      win_pct: s.games_played > 0 ? Math.round((s.games_won / s.games_played) * 100) : 0,
      current_streak: s.current_streak,
      max_streak: s.max_streak,
      guess_distribution: s.guess_distribution,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leaderboard — ranked by wins
app.get('/api/wordle/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT username, games_won, games_played,
             CASE WHEN games_played > 0
               THEN ROUND((games_won::numeric / games_played) * 100)
               ELSE 0 END AS win_pct,
             current_streak, max_streak
      FROM wordle_stats
      ORDER BY games_won DESC, win_pct DESC, max_streak DESC
      LIMIT 50
    `);
    res.json({ leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wordle_games (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      game_date DATE NOT NULL,
      word VARCHAR(5) NOT NULL,
      guesses TEXT[] NOT NULL DEFAULT '{}',
      won BOOLEAN,
      completed_at TIMESTAMPTZ,
      UNIQUE(user_id, game_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wordle_stats (
      user_id INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      games_played INTEGER DEFAULT 0,
      games_won INTEGER DEFAULT 0,
      current_streak INTEGER DEFAULT 0,
      max_streak INTEGER DEFAULT 0,
      last_win_date DATE,
      guess_distribution JSONB DEFAULT '{"1":0,"2":0,"3":0,"4":0,"5":0,"6":0}'::jsonb
    )
  `);

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
