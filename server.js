const express = require('express');
const webpush = require('web-push');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'pwointar.db'));
db.pragma('journal_mode = WAL');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  hourly_rate REAL NOT NULL DEFAULT 25,
  currency TEXT NOT NULL DEFAULT 'EUR',
  daily_goal_minutes INTEGER NOT NULL DEFAULT 480,
  active_day_minutes INTEGER NOT NULL DEFAULT 30,
  updated_at INTEGER
);
INSERT OR IGNORE INTO settings (id, updated_at) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  est_minutes INTEGER DEFAULT 0,
  xp_bonus INTEGER DEFAULT 25,
  note TEXT DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  note TEXT DEFAULT '',
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,             -- NULL => session en cours
  date TEXT NOT NULL,         -- date locale (YYYY-MM-DD) du démarrage
  minutes REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);

CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// --- Migrations douces (colonnes ajoutées sur une base existante) ----------
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('settings', 'notify_enabled', 'INTEGER NOT NULL DEFAULT 1');
addColumn('settings', 'notify_stop_minutes', 'INTEGER NOT NULL DEFAULT 240');
addColumn('settings', 'daily_remind', "TEXT NOT NULL DEFAULT '09:00'");

const row = db.prepare('SELECT hourly_rate FROM settings WHERE id=1').get();
if (row.hourly_rate === 0) db.prepare('UPDATE settings SET hourly_rate=25 WHERE id=1').run();

// --- KV helpers + clés VAPID -------------------------------------------------
const kvGet = (k) => db.prepare('SELECT value FROM kv WHERE key=?').get(k)?.value ?? null;
const kvSet = (k, v) => db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const kvDel = (k) => db.prepare('DELETE FROM kv WHERE key=?').run(k);

function initVapid() {
  let pub = kvGet('vapid_pub'), priv = kvGet('vapid_priv');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey; priv = keys.privateKey;
    kvSet('vapid_pub', pub); kvSet('vapid_priv', priv);
  }
  webpush.setVapidDetails('mailto:pwointar@example.com', pub, priv);
  return pub;
}
const VAPID_PUBLIC = initVapid();
void VAPID_PUBLIC;

// ---------------------------------------------------------------------------
// Gamification
// ---------------------------------------------------------------------------
const XP_PER_MINUTE = 1;

function levelFromXp(xp) {
  let level = 1;
  while (xp >= levelXpThreshold(level + 1)) level++;
  return level;
}
function levelXpThreshold(level) {
  // Cumul requis pour atteindre un niveau : 100*(n-1)^2
  return 100 * Math.pow(level - 1, 2);
}

const BADGES = [
  { key: 'first_session',   icon: '🐣', name: 'Premier pointage',     desc: 'Enregistrer une 1ère session' },
  { key: 'ten_hours',       icon: '🕐', name: '10 heures',            desc: 'Total de 10 h pointées' },
  { key: 'fifty_hours',     icon: '⏳', name: '50 heures',            desc: 'Total de 50 h pointées' },
  { key: 'hundred_hours',   icon: '💯', name: 'Centurion',            desc: 'Total de 100 h pointées' },
  { key: 'streak_3',        icon: '🔥', name: 'En feu x3',            desc: 'Série de 3 jours' },
  { key: 'streak_7',        icon: '🌋', name: 'Semaine de feu',       desc: 'Série de 7 jours' },
  { key: 'streak_30',       icon: '🏆', name: 'Machine',              desc: 'Série de 30 jours' },
  { key: 'deep_work',       icon: '🧠', name: 'Deep work',            desc: 'Une session de 4 h+' },
  { key: 'early_bird',      icon: '🐓', name: 'Lève-tôt',             desc: 'Pointer avant 7 h' },
  { key: 'night_owl',       icon: '🦉', name: 'Oiseau de nuit',       desc: 'Pointer après 22 h' },
  { key: 'taskmaster_5',    icon: '✅', name: 'Faiseur de tâches',    desc: 'Terminer 5 tâches' },
  { key: 'taskmaster_25',   icon: '🗂️', name: 'Grand chef',          desc: 'Terminer 25 tâches' },
  { key: 'money_1k',        icon: '💰', name: 'Premier millier',      desc: '1 000 € cumulés' },
  { key: 'marathon',        icon: '🏃', name: 'Marathon',             desc: '8 h pointées en un jour' },
];

function computeGamification() {
  const { active_day_minutes } = getSettings();

  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(minutes), 0) AS total_minutes,
      COALESCE(MIN(start_ms), 0) AS first_start,
      COALESCE(MAX(minutes), 0) AS longest_session,
      SUM(CASE WHEN CAST(strftime('%H', start_ms / 1000, 'unixepoch') AS INTEGER) < 7 THEN 1 ELSE 0 END) AS early_sessions,
      SUM(CASE WHEN CAST(strftime('%H', start_ms / 1000, 'unixepoch') AS INTEGER) >= 22 THEN 1 ELSE 0 END) AS night_sessions
    FROM entries WHERE end_ms IS NOT NULL
  `).get();

  const days = db.prepare(`
    SELECT date, SUM(minutes) AS m FROM entries
    WHERE end_ms IS NOT NULL GROUP BY date ORDER BY date DESC
  `).all();

  const total_tasks_done = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE done=1').get().c;

  // Streak : jours consécutifs "actifs" (>= active_day_minutes) finissant aujourd'hui ou hier
  const today = todayStr();
  const activeSet = new Set(days.filter(d => d.m >= active_day_minutes).map(d => d.date));
  let streak = 0;
  {
    const d = new Date();
    // si aujourd'hui pas actif, on regarde à partir d'hier
    if (!activeSet.has(today)) d.setDate(d.getDate() - 1);
    for (;;) {
      const s = ymd(d);
      if (activeSet.has(s)) { streak++; d.setDate(d.getDate() - 1); }
      else break;
    }
  }

  const money = totalMinutesToMoney(stats.total_minutes);
  const xp = Math.round(stats.total_minutes) * XP_PER_MINUTE
    + db.prepare('SELECT COALESCE(SUM(xp_bonus),0) AS s FROM tasks WHERE done=1').get().s;
  const level = levelFromXp(xp || 0);

  const checkers = {
    first_session:  () => (stats.total_minutes > 0),
    ten_hours:      () => stats.total_minutes >= 600,
    fifty_hours:    () => stats.total_minutes >= 3000,
    hundred_hours:  () => stats.total_minutes >= 6000,
    streak_3:       () => streak >= 3,
    streak_7:       () => streak >= 7,
    streak_30:      () => streak >= 30,
    deep_work:      () => stats.longest_session >= 240,
    early_bird:     () => stats.early_sessions > 0,
    night_owl:      () => stats.night_sessions > 0,
    taskmaster_5:   () => total_tasks_done >= 5,
    taskmaster_25:  () => total_tasks_done >= 25,
    money_1k:       () => money >= 1000,
    marathon:       () => days.some(d => d.m >= 480),
  };
  const earned = BADGES.filter(b => { try { return checkers[b.key](); } catch { return false; } });

  return { xp, level, xp_total: xp, next_level_xp: levelXpThreshold(level + 1), current_level_xp: levelXpThreshold(level), streak, total_tasks_done, money, badges: earned.map(b => b.key) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getSettings() {
  const s = db.prepare('SELECT * FROM settings WHERE id=1').get();
  return {
    hourly_rate: s.hourly_rate, currency: s.currency,
    daily_goal_minutes: s.daily_goal_minutes, active_day_minutes: s.active_day_minutes,
    notify_enabled: !!s.notify_enabled, notify_stop_minutes: s.notify_stop_minutes,
    daily_remind: s.daily_remind || '',
  };
}
function todayStr(tzOffsetMs) {
  if (tzOffsetMs !== undefined) {
    const d = new Date(Date.now() - tzOffsetMs);
    return d.toISOString().slice(0, 10);
  }
  return ymd(new Date());
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function totalMinutesToMoney(m) {
  const s = getSettings();
  return (m / 60) * s.hourly_rate;
}

function entryToJson(e) {
  const open = e.end_ms === null;
  const minutes = open
    ? (Date.now() - e.start_ms) / 60000
    : e.minutes;
  const s = getSettings();
  return {
    id: e.id, task_id: e.task_id, note: e.note,
    start_ms: e.start_ms, end_ms: e.end_ms, date: e.date,
    minutes, open, money: (minutes / 60) * s.hourly_rate,
  };
}

function buildDayStats(limitDays = 14) {
  const rows = db.prepare(`
    SELECT date, SUM(minutes) AS m, COUNT(*) AS sessions
    FROM entries WHERE end_ms IS NOT NULL
    GROUP BY date ORDER BY date DESC LIMIT ?
  `).all(limitDays);
  return rows;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/bootstrap', (req, res) => {
  const settings = getSettings();
  const gamification = computeGamification();
  const open = db.prepare('SELECT * FROM entries WHERE end_ms IS NULL ORDER BY start_ms DESC LIMIT 1').get() || null;
  const today = todayStr();
  const todayMinutes = db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM entries WHERE date=? AND end_ms IS NOT NULL').get(today).m;
  const tz = typeof req.query.tzOffset === 'string' ? Number(req.query.tzOffset) : undefined;
  const effectiveToday = todayStr(tz);
  const effTodayMinutes = effectiveToday === today ? todayMinutes
    : db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM entries WHERE date=? AND end_ms IS NOT NULL').get(effectiveToday).m;
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY done ASC, created_at DESC').all();
  const recent = db.prepare('SELECT * FROM entries WHERE end_ms IS NOT NULL ORDER BY start_ms DESC LIMIT 20').all().map(entryToJson);
  const dayStats = buildDayStats(14);
  const weekMinutes = lastDaysSum(7, effectiveToday);
  const monthMinutes = lastDaysSum(30, effectiveToday);
  res.json({
    settings, gamification,
    push: { vapid_public: VAPID_PUBLIC, subs: pushSubs().length },
    timer: open ? entryToJson(open) : null,
    today: effTodayMinutes,
    week_minutes: weekMinutes,
    month_minutes: monthMinutes,
    tasks, recent, day_stats: dayStats,
  });
});

function lastDaysSum(nDays, endDay) {
  const d = new Date(endDay + 'T00:00:00');
  const from = new Date(d); from.setDate(from.getDate() - (nDays - 1));
  const rows = db.prepare(`
    SELECT date, SUM(minutes) AS m FROM entries
    WHERE end_ms IS NOT NULL AND date >= ? AND date <= ?
    GROUP BY date`).all(ymd(from), endDay);
  return rows.reduce((a, r) => a + r.m, 0);
}

// --- Pointeuse -------------------------------------------------------------
app.post('/api/timer/start', (req, res) => {
  const existing = db.prepare('SELECT * FROM entries WHERE end_ms IS NULL').get();
  if (existing) return res.status(409).json({ error: 'Une session est déjà en cours' });
  const { task_id = null, note = '', tzOffset } = req.body || {};
  const start_ms = Date.now();
  const date = typeof tzOffset === 'number' ? new Date(start_ms - tzOffset).toISOString().slice(0, 10) : todayStr();
  const info = db.prepare('INSERT INTO entries (task_id, note, start_ms, end_ms, date, minutes) VALUES (?,?,?,NULL,?,0)').run(task_id, note, start_ms, date);
  const entry = db.prepare('SELECT * FROM entries WHERE id=?').get(info.lastInsertRowid);
  res.json({ timer: entryToJson(entry) });
});

app.post('/api/timer/stop', (req, res) => {
  const entry = db.prepare('SELECT * FROM entries WHERE end_ms IS NULL ORDER BY start_ms DESC LIMIT 1').get();
  if (!entry) return res.status(409).json({ error: 'Aucune session en cours' });
  const end_ms = Date.now();
  const minutes = Math.max(0.1, (end_ms - entry.start_ms) / 60000);
  db.prepare('UPDATE entries SET end_ms=?, minutes=? WHERE id=?').run(end_ms, minutes, entry.id);
  const g = computeGamification();
  kvDel('stop_alert_' + entry.id);
  const s = getSettings();
  if (s.notify_enabled) {
    sendPushAll('⏹️ Session validée !',
      `${fmtMinutesFr(minutes)} pointées → +${Math.round(minutes)} XP, ${(minutes / 60 * s.hourly_rate).toFixed(2)} 💪`, 'stop-ok')
      .catch(() => {});
  }

  // XP gagné pour cette session (les minutes viennent d'être créditées)
  const taskBonus = entry.task_id ? 0 : 0; // le bonus tâche est versé à la complétion
  res.json({
    entry: entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(entry.id)),
    gained_xp: Math.round(minutes) * XP_PER_MINUTE,
    gamification: g,
  });
});

// --- Entrées manuelles / édition -------------------------------------------
app.get('/api/entries', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries ORDER BY start_ms DESC LIMIT 100').all();
  res.json({ entries: rows.map(entryToJson) });
});

app.post('/api/entries', (req, res) => {
  const { task_id = null, note = '', date, start, end } = req.body || {};
  if (!date || !start || !end) return res.status(400).json({ error: 'date, start, end requis' });
  const start_ms = new Date(`${date}T${start}`).getTime();
  let end_ms = new Date(`${date}T${end}`).getTime();
  if (isNaN(start_ms) || isNaN(end_ms)) return res.status(400).json({ error: 'heure invalide' });
  if (end_ms <= start_ms) end_ms += 24 * 3600 * 1000; // traverse minuit
  const minutes = (end_ms - start_ms) / 60000;
  const info = db.prepare('INSERT INTO entries (task_id, note, start_ms, end_ms, date, minutes) VALUES (?,?,?,?,?,?)')
    .run(task_id, note, start_ms, end_ms, date, minutes);
  const g = computeGamification();
  res.json({ entry: entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(info.lastInsertRowid)), gamification: g });
});

app.put('/api/entries/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Introuvable' });
  const { note = e.note, date = e.date, start, end } = req.body || {};
  let start_ms = e.start_ms, end_ms = e.end_ms, minutes = e.minutes;
  if (start && end) {
    start_ms = new Date(`${date}T${start}`).getTime();
    end_ms = new Date(`${date}T${end}`).getTime();
    if (isNaN(start_ms) || isNaN(end_ms)) return res.status(400).json({ error: 'heure invalide' });
    if (end_ms <= start_ms) end_ms += 24 * 3600 * 1000;
    minutes = (end_ms - start_ms) / 60000;
  } else if (typeof req.body?.minutes === 'number') {
    minutes = req.body.minutes;
  }
  db.prepare('UPDATE entries SET note=?, start_ms=?, end_ms=?, date=?, minutes=? WHERE id=?')
    .run(note, start_ms, end_ms, date, minutes, e.id);
  const g = computeGamification();
  res.json({ entry: entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(e.id)), gamification: g });
});

app.delete('/api/entries/:id', (req, res) => {
  db.prepare('DELETE FROM entries WHERE id=?').run(req.params.id);
  res.json({ ok: true, gamification: computeGamification() });
});

// --- Tâches ----------------------------------------------------------------
function taskToJson(t) {
  return { ...t };
}

app.post('/api/tasks', (req, res) => {
  const { title, est_minutes = 0, xp_bonus = 25, note = '' } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'titre requis' });
  const info = db.prepare('INSERT INTO tasks (title, est_minutes, xp_bonus, note, created_at) VALUES (?,?,?,?,?)')
    .run(title.trim(), Number(est_minutes) || 0, Number(xp_bonus) >= 0 ? Number(xp_bonus) : 25, note, Date.now());
  res.json({ task: taskToJson(db.prepare('SELECT * FROM tasks WHERE id=?').get(info.lastInsertRowid)) });
});

app.put('/api/tasks/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Introuvable' });
  const { title = t.title, est_minutes = t.est_minutes, xp_bonus = t.xp_bonus, done = t.done, note = t.note } = req.body || {};
  const wasDone = !!t.done;
  const nowDone = !!done;
  const done_at = nowDone && !wasDone ? Date.now() : (!nowDone && wasDone ? null : t.done_at);
  db.prepare('UPDATE tasks SET title=?, est_minutes=?, xp_bonus=?, done=?, note=?, done_at=? WHERE id=?')
    .run(String(title), Number(est_minutes) || 0, Number(xp_bonus) || 0, nowDone ? 1 : 0, note, done_at, t.id);
  res.json({
    task: taskToJson(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)),
    gamification: computeGamification(),
    gained_xp: nowDone && !wasDone ? (Number(xp_bonus) || 0) : 0,
  });
});

app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- Réglages ---------------------------------------------------------------
app.put('/api/settings', (req, res) => {
  const { hourly_rate, currency, daily_goal_minutes, active_day_minutes, notify_enabled, notify_stop_minutes, daily_remind } = req.body || {};
  db.prepare(`UPDATE settings SET
    hourly_rate = COALESCE(?, hourly_rate),
    currency = COALESCE(?, currency),
    daily_goal_minutes = COALESCE(?, daily_goal_minutes),
    active_day_minutes = COALESCE(?, active_day_minutes),
    notify_enabled = COALESCE(?, notify_enabled),
    notify_stop_minutes = COALESCE(?, notify_stop_minutes),
    daily_remind = COALESCE(?, daily_remind),
    updated_at = ?
    WHERE id=1`).run(
    hourly_rate !== undefined ? Number(hourly_rate) : null,
    currency || null,
    daily_goal_minutes !== undefined ? Number(daily_goal_minutes) : null,
    active_day_minutes !== undefined ? Number(active_day_minutes) : null,
    notify_enabled !== undefined ? (notify_enabled ? 1 : 0) : null,
    notify_stop_minutes !== undefined ? Number(notify_stop_minutes) : null,
    typeof daily_remind === 'string' ? daily_remind : null,
    Date.now());
  res.json({ settings: getSettings(), gamification: computeGamification() });
});

// --- Stats ------------------------------------------------------------------
app.get('/api/stats', (req, res) => {
  const days = buildDayStats(30);
  const byHour = db.prepare(`
    SELECT CAST(strftime('%H', start_ms/1000, 'unixepoch') AS INTEGER) AS h, SUM(minutes) AS m
    FROM entries WHERE end_ms IS NOT NULL GROUP BY h ORDER BY h`).all();
  const byTask = db.prepare(`
    SELECT COALESCE(t.title, '(sans tâche)') AS label, SUM(e.minutes) AS m
    FROM entries e LEFT JOIN tasks t ON t.id = e.task_id
    WHERE e.end_ms IS NOT NULL GROUP BY e.task_id ORDER BY m DESC LIMIT 10`).all();
  const total = db.prepare('SELECT COALESCE(SUM(minutes),0) AS m, COUNT(*) AS c FROM entries WHERE end_ms IS NOT NULL').get();
  res.json({ day_stats: days, by_hour: byHour, by_task: byTask, total });
});

// --- Badges -----------------------------------------------------------------
app.get('/api/badges', (req, res) => {
  const g = computeGamification();
  const earnedSet = new Set(g.badges);
  res.json({
    badges: BADGES.map(b => ({ ...b, earned: earnedSet.has(b.key) })),
    gamification: g,
  });
});

// --- Push -------------------------------------------------------------------
const pushSubs = () => db.prepare('SELECT * FROM push_subs').all();

async function sendPushAll(title, body, tag) {
  const payload = JSON.stringify({ title, body, tag });
  let sent = 0;
  for (const sub of pushSubs()) {
    const target = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(target, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subs WHERE id=?').run(sub.id);
      }
    }
  }
  return sent;
}

app.get('/api/push/public-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return res.status(400).json({ error: 'subscription invalid' });
  }
  db.prepare(`INSERT INTO push_subs (endpoint, p256dh, auth, created_at) VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`)
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
  res.json({ ok: true, subs: pushSubs().length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(req.body?.endpoint || '');
  res.json({ ok: true });
});

app.post('/api/push/test', async (req, res) => {
  const sent = await sendPushAll('⏰ Pwointar', 'Les notifications push fonctionnent ! 🎉', 'test');
  res.json({ ok: true, sent, subs: pushSubs().length });
});

app.get('/api/push/status', (req, res) => res.json({ subs: pushSubs().length }));

// --- Rappels automatiques ----------------------------------------------------
function notifyIfEnabled(title, body, tag) {
  if (!getSettings().notify_enabled) return;
  return sendPushAll(title, body, tag);
}

async function checkReminders() {
  try {
    const s = getSettings();
    const now = new Date();
    const today = todayStr();
    const open = db.prepare('SELECT * FROM entries WHERE end_ms IS NULL ORDER BY start_ms DESC LIMIT 1').get();

    // 1) Session ouverte depuis longtemps → rappel de stop
    if (open) {
      const alreadyDone = db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM entries WHERE date=? AND end_ms IS NOT NULL').get(today).m;
      const running = (Date.now() - open.start_ms) / 60000;
      if (running >= s.notify_stop_minutes && !kvGet('stop_alert_' + open.id)) {
        await notifyIfEnabled('⏰ Pense à stopper !',
          `Ça fait déjà ${fmtMinutesFr(running)} sur cette session. Stoppez pour valider ton XP !`, 'stop-remind');
        kvSet('stop_alert_' + open.id, '1');
      }
      // 2) Objectif du jour atteint pendant la session
      if (alreadyDone + running >= s.daily_goal_minutes && !kvGet('goal_alert_' + today)) {
        await notifyIfEnabled('🎯 Objectif du jour atteint !',
          `Bravo, tu as pointé ${fmtMinutesFr(alreadyDone + running)} aujourd'hui. La suite est du bonus !`, 'goal');
        kvSet('goal_alert_' + today, '1');
      }
    }

    // 3) Rappel quotidien de pointer (fenêtre : heure configurée + 30 min)
    if (s.daily_remind && /^\d{2}:\d{2}$/.test(s.daily_remind)) {
      const [hh, mm] = s.daily_remind.split(':').map(Number);
      const cur = now.getHours() * 60 + now.getMinutes();
      const target = hh * 60 + mm;
      const noSessionYet = db.prepare('SELECT COUNT(*) AS c FROM entries WHERE date=?').get(today).c === 0;
      if (cur >= target && cur < target + 30 && noSessionYet && !kvGet('daily_alert_' + today)) {
        await notifyIfEnabled('⏰ N\'oublie pas de pointer !', 'Ta journée commence — lance la pointeuse pour empiler l\'XP 💪', 'daily');
        kvSet('daily_alert_' + today, '1');
      }
    }
  } catch (err) {
    console.error('checkReminders:', err.message);
  }
}
function fmtMinutesFr(min) {
  min = Math.round(min);
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : `${min} min`;
}
setInterval(checkReminders, 30 * 1000);

// Fallback SPA
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`⏰ Pwointar écoute sur http://0.0.0.0:${PORT}`);
});