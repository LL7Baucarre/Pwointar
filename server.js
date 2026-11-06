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

CREATE TABLE IF NOT EXISTS task_chronos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  mode TEXT NOT NULL DEFAULT 'attached', -- 'attached' = rattaché au gros chrono | 'standalone' = minuteur autonome
  start_ms INTEGER NOT NULL,
  active_ms INTEGER NOT NULL DEFAULT 0,  -- temps actif accumulé (hors pauses)
  running_since INTEGER,                 -- NULL => en pause ou stoppé
  auto_paused INTEGER NOT NULL DEFAULT 0,-- mis en pause auto quand le gros chrono s'arrête
  stopped_at INTEGER,
  date TEXT NOT NULL,
  entry_id INTEGER
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
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
addColumn('settings', 'weekly_goal_minutes', 'INTEGER NOT NULL DEFAULT 0');

// Pause du gros chrono : temps actif accumulé + moment de la reprise en cours.
// (NULL = mode hérité « tourne depuis start_ms »)
addColumn('entries', 'active_ms', 'INTEGER');
addColumn('entries', 'running_since', 'INTEGER');
addColumn('entries', 'tz_offset', 'INTEGER');

// Rendre les sessions déjà ouvertes pause-capables (héritage de l'ancien modèle)
db.prepare('SELECT * FROM entries WHERE end_ms IS NULL').all().forEach((e) => {
  if (e.active_ms == null) {
    db.prepare('UPDATE entries SET active_ms=?, running_since=? WHERE id=?')
      .run(Math.max(0, Date.now() - e.start_ms), e.start_ms, e.id);
  }
});

const row = db.prepare('SELECT hourly_rate FROM settings WHERE id=1').get();
if (row.hourly_rate === 0) db.prepare('UPDATE settings SET hourly_rate=25 WHERE id=1').run();

// --- KV helpers + clés VAPID -------------------------------------------------
const kvGet = (k) => db.prepare('SELECT value FROM kv WHERE key=?').get(k)?.value ?? null;
const kvSet = (k, v) => db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
const kvDel = (k) => db.prepare('DELETE FROM kv WHERE key=?').run(k);

// Migration : l'ancien rappel quotidien unique devient une liste de rappels
db.exec(`INSERT INTO reminders (time, enabled)
  SELECT s.daily_remind, 1 FROM settings s
  WHERE s.id = 1 AND s.daily_remind <> '' AND NOT EXISTS (SELECT 1 FROM reminders)`);

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

  const money = totalMoney();
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
    weekly_goal_minutes: s.weekly_goal_minutes ?? 0,
    notify_enabled: !!s.notify_enabled, notify_stop_minutes: s.notify_stop_minutes,
    daily_remind: s.daily_remind || '',
  };
}
function todayStr(tzOffsetMs) {
  if (typeof tzOffsetMs === 'number') {
    // local = UTC + offset → on ajoute l'offset pour « lire » l'heure locale en UTC
    const d = new Date(Date.now() + tzOffsetMs);
    return d.toISOString().slice(0, 10);
  }
  return ymd(new Date());
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function entryToJson(e) {
  const open = e.end_ms === null;
  const minutes = open
    ? sessionElapsedMin(e)
    : e.minutes;
  const s = getSettings();
  const j = {
    id: e.id, task_id: e.task_id, note: e.note,
    start_ms: e.start_ms, end_ms: e.end_ms, date: e.date,
    minutes, open, money: (paidMoneyMinutes(e, minutes) / 60) * s.hourly_rate,
  };
  if (open) {
    j.active_ms = e.active_ms ?? null;
    j.running = e.active_ms == null ? true : e.running_since != null;
    j.running_since = e.running_since ?? null;
  }
  return j;
}

function buildDayStats(limitDays = 14) {
  const rows = db.prepare(`
    SELECT date, SUM(minutes) AS m, COUNT(*) AS sessions
    FROM entries WHERE end_ms IS NOT NULL
    GROUP BY date ORDER BY date DESC LIMIT ?
  `).all(limitDays);
  return rows;
}

// --- Semaine calendaire (lundi → dimanche) ---------------------------------
function weekRangeOf(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = (d.getDay() + 6) % 7; // lundi = 0
  const from = new Date(d); from.setDate(d.getDate() - dow);
  const to = new Date(from); to.setDate(from.getDate() + 6);
  return [ymd(from), ymd(to)];
}
function calendarWeekMinutes(dateStr) {
  const [from, to] = weekRangeOf(dateStr);
  return db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM entries WHERE end_ms IS NOT NULL AND date >= ? AND date <= ?')
    .get(from, to).m;
}
// Minutes d'une plage [from..to] (entrées clôturées + session en cours + minuteurs) — pour les pushs
function rangeMinutesFull(fromStr, toStr, now = Date.now()) {
  let m = db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM entries WHERE end_ms IS NOT NULL AND date >= ? AND date <= ?')
    .get(fromStr, toStr).m;
  const s = sessionOpen();
  if (s && s.date >= fromStr && s.date <= toStr) m += sessionElapsedMin(s, now);
  for (const c of openChronos()) {
    if (c.mode === 'standalone' && c.date >= fromStr && c.date <= toStr) m += chronoActiveMs(c, now) / 60000;
  }
  return m;
}

// 🏦 Rattrapage : chaque semaine terminée (lundi→dimanche) où tu as pointé au moins
// une fois verse son surplus dans la banque — ou en retire son déficit (le solde
// ne descend jamais sous 0). Les semaines sans aucun pointage ne comptent pas,
// et la semaine en cours n'est pas encore versée.
function rattrapageInfo(effectiveToday) {
  const goal = getSettings().weekly_goal_minutes || 0;
  const info = {
    goal_minutes: goal, balance_min: 0, since_date: null,
    current_week_minutes: 0, current_surplus_min: 0,
  };
  if (goal <= 0) return info;
  info.current_week_minutes = calendarWeekMinutes(effectiveToday);
  info.current_surplus_min = Math.max(0, info.current_week_minutes - goal);
  const since = kvGet('weekly_goal_since');
  if (!since) return info;
  info.since_date = since;
  const [curFrom] = weekRangeOf(effectiveToday);
  const rows = db.prepare(`
    SELECT date, SUM(minutes) AS m FROM entries
    WHERE end_ms IS NOT NULL AND date >= ? AND date < ?
    GROUP BY date ORDER BY date`).all(since, curFrom);
  const byWeek = new Map();
  for (const r of rows) {
    const [from] = weekRangeOf(r.date);
    byWeek.set(from, (byWeek.get(from) || 0) + r.m);
  }
  let bal = 0;
  for (const from of [...byWeek.keys()].sort()) {
    bal = Math.max(0, bal + (byWeek.get(from) - goal));
  }
  info.balance_min = bal;
  return info;
}

// 💰 Argent : avec un objectif hebdomadaire actif, chaque semaine (lundi→dimanche)
// suivie depuis l'activation ne paie que jusqu'à l'objectif — une fois atteint, les
// minutes suivantes ne rapportent plus d'argent (elles continuent de compter pour le
// temps pointé, l'XP et la banque de rattrapage 🏦). Les semaines d'avant l'activation
// paient toujours à 100 %.
function moneyCapConfig() {
  const s = getSettings();
  const goal = s.weekly_goal_minutes || 0;
  const since = kvGet('weekly_goal_since');
  if (goal <= 0 || !since) return null;
  return { goal, from: weekRangeOf(since)[0] };
}
// null = cette semaine n'est pas plafonnée (objectif absent ou désactivé,
// ou semaine antérieure à l'activation de l'objectif)
function moneyCapFor(dateStr) {
  const cap = moneyCapConfig();
  if (!cap || weekRangeOf(dateStr)[0] < cap.from) return null;
  return cap;
}
// Budget de la semaine déjà consommé par les entrées clôturées précédant `e`
function weekPaidBefore(cap, e) {
  const [wkFrom, wkTo] = weekRangeOf(e.date);
  if (e.end_ms === null) {
    // session ouverte : traitée comme la dernière de sa journée
    return db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM entries WHERE end_ms IS NOT NULL AND date >= ? AND date <= ? AND date <= ?')
      .get(wkFrom, wkTo, e.date).m;
  }
  return db.prepare(`
    SELECT COALESCE(SUM(minutes),0) AS m FROM entries
    WHERE end_ms IS NOT NULL AND date >= ? AND date <= ?
      AND (date < ? OR (date = ? AND (start_ms < ? OR (start_ms = ? AND id < ?))))
  `).get(wkFrom, wkTo, e.date, e.date, e.start_ms, e.start_ms, e.id).m;
}
// Minutes d'une entrée qui « rapportent » : 0 au-delà de l'objectif de la semaine
function paidMoneyMinutes(e, minutes) {
  const cap = moneyCapFor(e.date);
  if (!cap) return minutes;
  return Math.max(0, Math.min(minutes, cap.goal - weekPaidBefore(cap, e)));
}
// Argent total cumulé (HUD + badge 💰) : chaque semaine plafonnée ne paie que l'objectif
function totalMoney() {
  const s = getSettings();
  const cap = moneyCapConfig();
  const rows = db.prepare('SELECT date, COALESCE(SUM(minutes),0) AS m FROM entries WHERE end_ms IS NOT NULL GROUP BY date').all();
  let minutes = 0;
  const byWeek = new Map();
  for (const r of rows) {
    const wk = weekRangeOf(r.date)[0];
    if (!cap || wk < cap.from) minutes += r.m;
    else byWeek.set(wk, (byWeek.get(wk) || 0) + r.m);
  }
  if (cap) for (const m of byWeek.values()) minutes += Math.min(m, cap.goal);
  return (minutes / 60) * s.hourly_rate;
}

// ---------------------------------------------------------------------------
// Chronos de tâches (rattachés au gros chrono ou minuteurs autonomes)
// ---------------------------------------------------------------------------
const MAX_PARALLEL_CHRONOS = 3;

const sessionOpen = () => db.prepare('SELECT * FROM entries WHERE end_ms IS NULL ORDER BY start_ms DESC LIMIT 1').get() || null;
const openChronos = () => db.prepare('SELECT * FROM task_chronos WHERE stopped_at IS NULL').all();
// la session ne « tourne » que si elle n'est pas en pause
const sessionRunning = () => { const s = sessionOpen(); return (s && s.running_since != null) ? s : null; };
// minutes actives d'une session (pauses exclues)
function sessionElapsedMin(s, now = Date.now()) {
  if (s.active_ms == null) return Math.max(0, now - s.start_ms) / 60000; // ancien modèle
  return (s.active_ms + (s.running_since != null ? Math.max(0, now - s.running_since) : 0)) / 60000;
}
// minuit local (heure du device qui a créé l'entrée) et minuit du jour suivant
function dayStartMs(dateStr, tzOffset) {
  const off = typeof tzOffset === 'number' ? tzOffset : (-new Date().getTimezoneOffset() * 60000);
  return Date.parse(dateStr + 'T00:00:00Z') - off;
}
function dayBoundaryNext(dateStr, tzOffset) { return dayStartMs(dateStr, tzOffset) + 86400000; }

// Rend les chronos rattachés en pause quand la session (stop ou pause) s'arrête
function freezeAttachedChronos(now) {
  const rows = db.prepare("SELECT * FROM task_chronos WHERE stopped_at IS NULL AND mode='attached' AND running_since IS NOT NULL").all();
  for (const c of rows) {
    db.prepare('UPDATE task_chronos SET active_ms=?, running_since=NULL, auto_paused=1 WHERE id=?')
      .run(c.active_ms + Math.max(0, now - c.running_since), c.id);
  }
  return rows;
}
// Sortir la session de pause (sans notifier) — utilisé par /timer/resume et quand
// on rattache une tâche alors que le gros chrono est en pause
function resumeSessionInternal(s, now) {
  const tz = typeof s.tz_offset === 'number' ? s.tz_offset : undefined;
  // si la session a « sauté » des jours entiers en pause, on repart de maintenant
  const startFix = s.start_ms < dayStartMs(s.date, tz) ? now : s.start_ms;
  db.prepare('UPDATE entries SET running_since=?, start_ms=? WHERE id=?').run(now, startFix, s.id);
  clearLastPause();
}
// Passé un changement de journée : on scinde la session ouverte en tronçons par jour.
// Le temps actif d'avant minuit est clôturé pour ce jour ; la session continue sur le nouveau jour.
// (Les jours entiers passés en pause ne créent pas de ligne à 0 min.)
function rollSessionDay() {
  let open = sessionOpen();
  if (!open) return 0;
  const tz = typeof open.tz_offset === 'number' ? open.tz_offset : undefined;
  const today = dateFromMs(Date.now(), tz);
  let cuts = 0;
  while (open && open.date < today) {
    const now = Date.now();
    const boundary = dayBoundaryNext(open.date, open.tz_offset);
    const activeBefore = (open.active_ms || 0)
      + (open.running_since != null && open.running_since < boundary ? (boundary - open.running_since) : 0);
    if (open.running_since == null && activeBefore < 5) {
      // session en pause et sans minutes actives pour ce jour → on saute simplement au nouveau jour
      db.prepare('UPDATE entries SET date=?, start_ms=?, active_ms=0 WHERE id=?')
        .run(dateFromMs(boundary, open.tz_offset), boundary, open.id);
    } else {
      db.prepare('UPDATE entries SET end_ms=?, minutes=?, active_ms=?, running_since=NULL WHERE id=?')
        .run(boundary, Math.max(0.1, activeBefore / 60000), activeBefore, open.id);
      const runningSince = open.running_since != null ? Math.max(boundary, open.running_since) : null;
      db.prepare('INSERT INTO entries (task_id, note, start_ms, end_ms, date, minutes, active_ms, running_since, tz_offset) VALUES (?,?,?,NULL,?,0,0,?,?)')
        .run(open.task_id, open.note, boundary, dateFromMs(boundary, open.tz_offset), runningSince, open.tz_offset);
    }
    cuts++;
    open = sessionOpen();
  }
  return cuts;
}

function chronoActiveMs(c, now = Date.now()) {
  return (c.active_ms || 0) + (c.running_since ? Math.max(0, now - c.running_since) : 0);
}
function chronoToJson(c) {
  const t = c.task_id ? db.prepare('SELECT title FROM tasks WHERE id=?').get(c.task_id) : null;
  return {
    id: c.id, task_id: c.task_id,
    task_title: t ? t.title : '(tâche supprimée)',
    mode: c.mode, start_ms: c.start_ms, date: c.date,
    active_ms: c.active_ms,
    running: !!c.running_since, running_since: c.running_since || null,
    auto_paused: !!c.auto_paused,
    elapsed_ms: chronoActiveMs(c),
  };
}
function dateFromMs(ms, tzOffset) {
  if (typeof tzOffset === 'number') return new Date(ms + tzOffset).toISOString().slice(0, 10);
  return ymd(new Date(ms));
}
function createSession(taskId, note, tzOffset) {
  const start_ms = Date.now();
  const info = db.prepare(`INSERT INTO entries (task_id, note, start_ms, end_ms, date, minutes, active_ms, running_since, tz_offset)
    VALUES (?,?,?,NULL,?,0,0,?,?)`)
    .run(taskId, note, start_ms, dateFromMs(start_ms, tzOffset), start_ms, typeof tzOffset === 'number' ? tzOffset : null);
  return db.prepare('SELECT * FROM entries WHERE id=?').get(info.lastInsertRowid);
}
// Quand une (nouvelle) session démarre, on reprend les chronos rattachés auto-pausés
function resumeAutoPaused() {
  const rows = db.prepare('SELECT * FROM task_chronos WHERE stopped_at IS NULL AND auto_paused=1 AND running_since IS NULL').all();
  const now = Date.now();
  for (const c of rows) db.prepare('UPDATE task_chronos SET running_since=?, auto_paused=0 WHERE id=?').run(now, c.id);
  return rows.length;
}
// Un « temps libre à récupérer » = écoulé depuis la dernière pause où plus rien ne tournait
function markPauseIfIdle(now) {
  if (!sessionOpen() && !openChronos().some(c => c.running_since)) kvSet('last_pause_ms', String(now));
}
function clearLastPause() { kvSet('last_pause_ms', '0'); }
function claimableGap(now = Date.now()) {
  const lp = Number(kvGet('last_pause_ms') || 0);
  if (!lp || lp >= now) return null;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  if (lp < midnight.getTime()) return null;
  if (sessionOpen() || openChronos().some(c => c.running_since)) return null;
  return lp;
}
// Minutes du jour (entrées clôturées + session en cours + minuteurs ouverts) — pour les rappels/pushs
function dayMinutesFull(dateStr, now = Date.now()) {
  let m = db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM entries WHERE date=? AND end_ms IS NOT NULL').get(dateStr).m;
  const s = sessionOpen();
  if (s && s.date === dateStr) m += sessionElapsedMin(s, now);
  for (const c of openChronos()) {
    if (c.mode === 'standalone' && c.date === dateStr) m += chronoActiveMs(c, now) / 60000;
  }
  return m;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/bootstrap', (req, res) => {
  // scission par jour du gros chrono si on a changé de journée
  rollSessionDay();
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
  const weekMinutes = calendarWeekMinutes(effectiveToday);
  const monthMinutes = lastDaysSum(30, effectiveToday);
  const rattrapage = rattrapageInfo(effectiveToday);
  const chronos = openChronos().map(chronoToJson);
  const chronosDone = db.prepare(`
    SELECT c.id, c.task_id, c.mode, c.active_ms, c.entry_id, c.stopped_at,
           COALESCE(t.title, '(tâche supprimée)') AS task_title
    FROM task_chronos c LEFT JOIN tasks t ON t.id = c.task_id
    WHERE c.stopped_at IS NOT NULL AND c.date = ?
    ORDER BY c.stopped_at DESC LIMIT 15`).all(effectiveToday)
    .map(c => ({ ...c, minutes: c.active_ms / 60000 }));
  const reminders = db.prepare('SELECT * FROM reminders ORDER BY time').all()
    .map(r => ({ id: r.id, time: r.time, enabled: !!r.enabled }));
  res.json({
    settings, gamification,
    push: { vapid_public: VAPID_PUBLIC, subs: pushSubs().length },
    timer: open ? entryToJson(open) : null,
    today: effTodayMinutes,
    week_minutes: weekMinutes,
    month_minutes: monthMinutes,
    rattrapage,
    chronos,
    chronos_done_today: chronosDone,
    reminders,
    fly_origin_ms: claimableGap(),
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
  if (sessionOpen()) return res.status(409).json({ error: 'Une session est déjà en cours' });
  const runningStandalone = openChronos().find(c => c.mode === 'standalone' && c.running_since);
  if (runningStandalone) {
    return res.status(409).json({ error: 'Des minuteurs de tâche tournent — stoppe-les d\'abord (leur temps compte déjà dans la journée)' });
  }
  const { task_id = null, note = '', tzOffset } = req.body || {};
  const entry = createSession(task_id, note, tzOffset);
  clearLastPause();
  const resumed = resumeAutoPaused();
  res.json({ timer: entryToJson(entry), resumed_chronos: resumed });
});

app.post('/api/timer/resume', (req, res) => {
  const s = sessionOpen();
  if (!s) return res.status(409).json({ error: 'Aucune session en cours' });
  if (s.running_since != null) return res.status(409).json({ error: 'La session tourne déjà' });
  const runningStandalone = openChronos().find(c => c.mode === 'standalone' && c.running_since);
  if (runningStandalone) {
    return res.status(409).json({ error: 'Des minuteurs de tâche tournent — stoppe-les d\'abord (leur temps compte déjà dans la journée)' });
  }
  const now = Date.now();
  resumeSessionInternal(s, now);
  const resumed = resumeAutoPaused();
  res.json({ timer: entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(s.id)), resumed_chronos: resumed });
});

// ⏸ Pause : le temps actif s'arrête (les pauses ne comptent pas), la session continue.
// À chaque changement de journée, rollSessionDay() clôture les minutes du jour écoulé.
app.post('/api/timer/pause', (req, res) => {
  const s = sessionOpen();
  if (!s) return res.status(409).json({ error: 'Aucune session en cours' });
  if (s.running_since == null) return res.status(409).json({ error: 'Session déjà en pause' });
  const now = Date.now();
  db.prepare('UPDATE entries SET active_ms=?, running_since=NULL WHERE id=?')
    .run((s.active_ms || 0) + Math.max(0, now - s.running_since), s.id);
  const pausedChronos = freezeAttachedChronos(now);
  markPauseIfIdle(now);
  const tzo = (req.body || {}).tzOffset;
  const doneToday = dayMinutesFull(todayStr(typeof tzo === 'number' ? tzo : undefined), now);
  const sj = getSettings();
  if (sj.notify_enabled) {
    sendPushAll('⏸ En pause', `${fmtMinutesFr(doneToday)} pointées aujourd'hui — le gros chrono attend 💤`, 'pause').catch(() => {});
  }
  res.json({
    timer: entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(s.id)),
    paused_chronos: pausedChronos.length,
    today: doneToday,
  });
});

// 🌙 Clôturer la journée : la session ouverte est terminée maintenant (les minutes
// du jour sont figées), les chronos rattachés passent en ⏸ auto. La prochaine
// reprise créera une nouvelle session (repart de zéro).
app.post('/api/timer/close', (req, res) => {
  rollSessionDay();
  const s = sessionOpen();
  if (!s) return res.status(409).json({ error: 'Aucune session en cours' });
  const now = Date.now();
  const activeTotal = (s.active_ms || 0)
    + (s.running_since != null ? Math.max(0, now - s.running_since) : 0);
  db.prepare('UPDATE entries SET end_ms=?, minutes=?, active_ms=?, running_since=NULL WHERE id=?')
    .run(now, Math.max(0.1, activeTotal / 60000), activeTotal, s.id);
  const pausedChronos = freezeAttachedChronos(now);
  clearLastPause(); // journée finie : un futur chrono à la volée ne remontera pas avant la clôture
  const tzo = (req.body || {}).tzOffset;
  const today = todayStr(typeof tzo === 'number' ? tzo : undefined);
  const doneToday = dayMinutesFull(today, now);
  if (getSettings().notify_enabled) {
    sendPushAll('🌙 Journée clôturée',
      `${fmtMinutesFr(doneToday)} pointées aujourd'hui — bien joué 👏`, 'close').catch(() => {});
  }
  res.json({
    timer: null, closed: true,
    minutes: activeTotal / 60000,
    today: doneToday,
    rattrapage: rattrapageInfo(today),
    gamification: computeGamification(),
    paused_chronos: pausedChronos.length,
  });
});

// --- Chronos de tâches -------------------------------------------------------
app.post('/api/chronos', (req, res) => {
  const { task_id, mode = 'standalone', tzOffset } = req.body || {};
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(task_id) || -1);
  if (!task) return res.status(400).json({ error: 'Tâche introuvable' });
  if (mode !== 'attached' && mode !== 'standalone') return res.status(400).json({ error: 'Mode de chrono invalide' });
  if (openChronos().length >= MAX_PARALLEL_CHRONOS) {
    return res.status(409).json({ error: `Max ${MAX_PARALLEL_CHRONOS} chronos en parallèle — stoppe-en un` });
  }
  let session_started = false;
  if (mode === 'attached') {
    // Rattaché au gros chrono : s'il ne tourne pas, on le lance (ou on sort la pause)
    if (!sessionOpen()) { createSession(null, '', tzOffset); session_started = true; }
    else if (sessionOpen().running_since == null) { resumeSessionInternal(sessionOpen(), Date.now()); session_started = true; }
  } else if (sessionRunning()) {
    return res.status(409).json({ error: 'Le gros chrono tourne : rattache la tâche (📌) au lieu d\'un minuteur' });
  }
  const now = Date.now();
  const cInfo = db.prepare(`INSERT INTO task_chronos (task_id, mode, start_ms, active_ms, running_since, auto_paused, date)
    VALUES (?,?,?,0,?,0,?)`).run(task.id, mode, now, now, dateFromMs(now, tzOffset));
  clearLastPause();
  const resumed = session_started ? resumeAutoPaused() : 0;
  res.json({
    chrono: chronoToJson(db.prepare('SELECT * FROM task_chronos WHERE id=?').get(cInfo.lastInsertRowid)),
    session_started, resumed_chronos: resumed,
  });
});

// Création de tâche à la volée : la tâche est créée et son chrono démarre aussitôt.
// Si du temps s'est écoulé depuis la dernière pause (plus rien ne tournait), le chrono
// le prend en compte : il démarre à la dernière pause au lieu de maintenant.
app.post('/api/chronos/fly', (req, res) => {
  const { title, tzOffset } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'titre requis' });
  if (openChronos().length >= MAX_PARALLEL_CHRONOS) {
    return res.status(409).json({ error: `Max ${MAX_PARALLEL_CHRONOS} chronos en parallèle — stoppe-en un` });
  }
  const mode = sessionRunning() ? 'attached' : 'standalone';
  const origin = claimableGap();
  const tInfo = db.prepare('INSERT INTO tasks (title, xp_bonus, created_at) VALUES (?,?,?)')
    .run(String(title).trim().slice(0, 120), 25, Date.now());
  const taskId = tInfo.lastInsertRowid;
  const start_at = origin ?? Date.now();
  const cInfo = db.prepare(`INSERT INTO task_chronos (task_id, mode, start_ms, active_ms, running_since, auto_paused, date)
    VALUES (?,?,?,0,?,0,?)`).run(taskId, mode, start_at, start_at, dateFromMs(start_at, tzOffset));
  clearLastPause();
  let session_started = !sessionRunning() && mode === 'attached';
  if (session_started) {
    // gros chrono en pause (sans créneau libre à récupérer) : on le sort de pause
    resumeSessionInternal(sessionOpen(), start_at);
    resumeAutoPaused();
  }
  res.json({
    task: taskToJson(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)),
    chrono: chronoToJson(db.prepare('SELECT * FROM task_chronos WHERE id=?').get(cInfo.lastInsertRowid)),
    mode, backfilled: !!origin, origin_ms: start_at, session_started,
  });
});

function getChronoOr404(id, res) {
  const c = db.prepare('SELECT * FROM task_chronos WHERE id=?').get(id);
  if (!c || c.stopped_at) { res.status(404).json({ error: 'Chrono introuvable (ou déjà stoppé)' }); return null; }
  return c;
}

app.post('/api/chronos/:id/pause', (req, res) => {
  const c = getChronoOr404(req.params.id, res); if (!c) return;
  if (!c.running_since) return res.status(409).json({ error: 'Chrono déjà en pause' });
  const now = Date.now();
  db.prepare('UPDATE task_chronos SET active_ms=?, running_since=NULL WHERE id=?')
    .run(c.active_ms + Math.max(0, now - c.running_since), c.id);
  markPauseIfIdle(now);
  res.json({ chrono: chronoToJson(db.prepare('SELECT * FROM task_chronos WHERE id=?').get(c.id)) });
});

app.post('/api/chronos/:id/resume', (req, res) => {
  const c = getChronoOr404(req.params.id, res); if (!c) return;
  if (c.running_since) return res.status(409).json({ error: 'Chrono déjà lancé' });
  let session_started = false;
  if (c.mode === 'attached') {
    if (!sessionOpen()) { createSession(null, '', (req.body || {}).tzOffset); session_started = true; }
    else if (sessionOpen().running_since == null) { resumeSessionInternal(sessionOpen(), Date.now()); session_started = true; }
  } else if (sessionRunning()) {
    return res.status(409).json({ error: 'Le gros chrono tourne : impossible de reprendre un minuteur (double comptage)' });
  }
  const now = Date.now();
  db.prepare('UPDATE task_chronos SET running_since=?, auto_paused=0 WHERE id=?').run(now, c.id);
  clearLastPause();
  res.json({ chrono: chronoToJson(db.prepare('SELECT * FROM task_chronos WHERE id=?').get(c.id)), session_started });
});

app.post('/api/chronos/:id/stop', (req, res) => {
  const c = getChronoOr404(req.params.id, res); if (!c) return;
  const now = Date.now();
  const finalActive = chronoActiveMs(c, now);
  let entry_id = null, entry = null, gained_xp = 0, gamification = null;
  if (c.mode === 'standalone') {
    // Un minuteur autonome crée un vrai pointage (compte dans le jour, l'XP et l'argent)
    const minutes = Math.max(0.1, finalActive / 60000);
    const info = db.prepare('INSERT INTO entries (task_id, note, start_ms, end_ms, date, minutes) VALUES (?,?,?,?,?,?)')
      .run(c.task_id, '', c.start_ms, now, c.date, minutes);
    entry_id = info.lastInsertRowid;
    entry = entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(entry_id));
    gained_xp = Math.round(minutes) * XP_PER_MINUTE;
    gamification = computeGamification();
  }
  db.prepare('UPDATE task_chronos SET active_ms=?, running_since=NULL, auto_paused=0, stopped_at=?, entry_id=? WHERE id=?')
    .run(finalActive, now, entry_id, c.id);
  res.json({
    chrono: chronoToJson(db.prepare('SELECT * FROM task_chronos WHERE id=?').get(c.id)),
    entry, gained_xp, gamification,
  });
});

app.delete('/api/chronos/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM task_chronos WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Chrono introuvable' });
  if (!c.stopped_at) return res.status(409).json({ error: 'Stoppe le chrono avant de le supprimer' });
  if (c.entry_id) db.prepare('DELETE FROM entries WHERE id=?').run(c.entry_id);
  db.prepare('DELETE FROM task_chronos WHERE id=?').run(c.id);
  res.json({ ok: true, gamification: computeGamification() });
});

// --- Entrées manuelles / édition -------------------------------------------
app.get('/api/entries', (req, res) => {
  const rows = db.prepare('SELECT * FROM entries ORDER BY start_ms DESC LIMIT 100').all();
  res.json({ entries: rows.map(entryToJson) });
});

// Normalise « 9:30 » / « 09:30 » / « 09:30:45 » → « 09:30:45 », sinon null
function normHHMM(t) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim());
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}
// Heure locale (date + HH:MM[:SS]) → ms.
// tzOffset = local − UTC en ms (celui que le navigateur envoie déjà ailleurs).
// Sans tzOffset : interprétation dans la TZ du serveur (ancien comportement).
function localWallToMs(date, time, tzOffset) {
  const t = normHHMM(time);
  if (!date || !t) return null;
  if (typeof tzOffset === 'number') return Date.parse(`${date}T${t}Z`) - tzOffset;
  const ms = new Date(`${date}T${t.slice(0, 5)}`).getTime();
  return isNaN(ms) ? null : ms;
}

app.post('/api/entries', (req, res) => {
  const { task_id = null, note = '', date, start, end } = req.body || {};
  if (!date || !start || !end) return res.status(400).json({ error: 'date, start, end requis' });
  const tzOffset = (req.body || {}).tzOffset;
  const start_ms = localWallToMs(date, start, tzOffset);
  let end_ms = localWallToMs(date, end, tzOffset);
  if (start_ms == null || end_ms == null) return res.status(400).json({ error: 'heure invalide' });
  if (end_ms <= start_ms) end_ms += 24 * 3600 * 1000; // traverse minuit
  const minutes = (end_ms - start_ms) / 60000;
  const info = db.prepare('INSERT INTO entries (task_id, note, start_ms, end_ms, date, minutes, tz_offset) VALUES (?,?,?,?,?,?,?)')
    .run(task_id, note, start_ms, end_ms, date, minutes, typeof tzOffset === 'number' ? tzOffset : null);
  const g = computeGamification();
  res.json({ entry: entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(info.lastInsertRowid)), gamification: g });
});

app.put('/api/entries/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Introuvable' });
  const { note = e.note, date = e.date, start, end } = req.body || {};
  const tzOffset = (req.body || {}).tzOffset;
  let start_ms = e.start_ms, end_ms = e.end_ms, minutes = e.minutes;
  if (start && end) {
    start_ms = localWallToMs(date, start, tzOffset);
    end_ms = localWallToMs(date, end, tzOffset);
    if (start_ms == null || end_ms == null) return res.status(400).json({ error: 'heure invalide' });
    if (end_ms <= start_ms) end_ms += 24 * 3600 * 1000;
    minutes = (end_ms - start_ms) / 60000;
    db.prepare('UPDATE entries SET note=?, start_ms=?, end_ms=?, date=?, minutes=?, tz_offset=? WHERE id=?')
      .run(note, start_ms, end_ms, date, minutes, typeof tzOffset === 'number' ? tzOffset : e.tz_offset, e.id);
  } else if (typeof req.body?.minutes === 'number') {
    minutes = req.body.minutes;
    db.prepare('UPDATE entries SET note=?, date=?, minutes=? WHERE id=?')
      .run(note, date, minutes, e.id);
  } else {
    db.prepare('UPDATE entries SET note=?, date=? WHERE id=?')
      .run(note, date, e.id);
  }
  const g = computeGamification();
  res.json({ entry: entryToJson(db.prepare('SELECT * FROM entries WHERE id=?').get(e.id)), gamification: g });
});

app.delete('/api/entries/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id);
  if (e && e.end_ms === null) freezeAttachedChronos(Date.now()); // on supprime la session ouverte
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

// --- Rappels de pointage (multiples) ----------------------------------------
const MAX_REMINDERS = 8;

app.post('/api/reminders', (req, res) => {
  const time = String((req.body || {}).time || '').trim();
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Heure invalide (HH:MM)' });
  if (db.prepare('SELECT COUNT(*) AS c FROM reminders').get().c >= MAX_REMINDERS) {
    return res.status(409).json({ error: `${MAX_REMINDERS} rappels maximum` });
  }
  const info = db.prepare('INSERT INTO reminders (time, enabled) VALUES (?,1)').run(time);
  res.json({ reminder: db.prepare('SELECT * FROM reminders WHERE id=?').get(info.lastInsertRowid) });
});

app.put('/api/reminders/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM reminders WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Rappel introuvable' });
  const time = req.body?.time !== undefined ? String(req.body.time).trim() : r.time;
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Heure invalide (HH:MM)' });
  const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : r.enabled;
  db.prepare('UPDATE reminders SET time=?, enabled=? WHERE id=?').run(time, enabled, r.id);
  res.json({ reminder: db.prepare('SELECT * FROM reminders WHERE id=?').get(r.id) });
});

app.delete('/api/reminders/:id', (req, res) => {
  db.prepare('DELETE FROM reminders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- Réglages ---------------------------------------------------------------
app.put('/api/settings', (req, res) => {
  const { hourly_rate, currency, daily_goal_minutes, active_day_minutes, weekly_goal_minutes, notify_enabled, notify_stop_minutes, daily_remind } = req.body || {};
  db.prepare(`UPDATE settings SET
    hourly_rate = COALESCE(?, hourly_rate),
    currency = COALESCE(?, currency),
    daily_goal_minutes = COALESCE(?, daily_goal_minutes),
    active_day_minutes = COALESCE(?, active_day_minutes),
    weekly_goal_minutes = COALESCE(?, weekly_goal_minutes),
    notify_enabled = COALESCE(?, notify_enabled),
    notify_stop_minutes = COALESCE(?, notify_stop_minutes),
    daily_remind = COALESCE(?, daily_remind),
    updated_at = ?
    WHERE id=1`).run(
    hourly_rate !== undefined ? Number(hourly_rate) : null,
    currency || null,
    daily_goal_minutes !== undefined ? Number(daily_goal_minutes) : null,
    active_day_minutes !== undefined ? Number(active_day_minutes) : null,
    weekly_goal_minutes !== undefined ? Math.max(0, Number(weekly_goal_minutes) || 0) : null,
    notify_enabled !== undefined ? (notify_enabled ? 1 : 0) : null,
    notify_stop_minutes !== undefined ? Number(notify_stop_minutes) : null,
    typeof daily_remind === 'string' ? daily_remind : null,
    Date.now());
  // La banque de rattrapage démarre la semaine où l'objectif hebdomadaire est activé
  if (Number(weekly_goal_minutes) > 0 && !kvGet('weekly_goal_since')) kvSet('weekly_goal_since', todayStr());
  res.json({ settings: getSettings(), gamification: computeGamification() });
});

// --- Stats ------------------------------------------------------------------
app.get('/api/stats', (req, res) => {
  const days = buildDayStats(30);
  // Répartition par heure en heure LOCALE du navigateur (tzOffset = local − UTC) ;
  // une entrée qui connaît son propre tz_offset l'emporte (créée à une autre heure d'été/hiver).
  const tzReq = req.query.tzOffset !== undefined ? Number(req.query.tzOffset) : undefined;
  const buckets = new Array(24).fill(0);
  for (const r of db.prepare('SELECT start_ms, tz_offset, minutes FROM entries WHERE end_ms IS NOT NULL').all()) {
    const off = typeof r.tz_offset === 'number' ? r.tz_offset : (typeof tzReq === 'number' && !isNaN(tzReq) ? tzReq : 0);
    const h = Math.floor(((r.start_ms + off) % 86400000) / 3600000);
    buckets[h < 0 ? h + 24 : h] += r.minutes;
  }
  const byHour = buckets.map((m, h) => ({ h, m })).filter(x => x.m > 0);
  const byTask = db.prepare(`
    SELECT label, SUM(m) AS m FROM (
      SELECT COALESCE(t.title, '(sans tâche)') AS label, e.minutes AS m
      FROM entries e LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.end_ms IS NOT NULL
      UNION ALL
      SELECT COALESCE(t2.title, '(tâche supprimée)') AS label, c.active_ms / 60000.0 AS m
      FROM task_chronos c LEFT JOIN tasks t2 ON t2.id = c.task_id
      WHERE c.mode = 'attached'
    ) GROUP BY label ORDER BY m DESC LIMIT 10`).all();
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
    const nowMs = Date.now();
    const open = sessionRunning();
    const doneToday = dayMinutesFull(today, nowMs);

    // 1) Sans pause depuis longtemps → rappel
    if (open) {
      const stretchMin = (nowMs - open.running_since) / 60000;
      if (stretchMin >= s.notify_stop_minutes && !kvGet(`stop_alert_${open.id}_${open.running_since}`)) {
        await notifyIfEnabled('⏰ Pense à mettre en pause !',
          `Ça fait déjà ${fmtMinutesFr(stretchMin)} d'affilée sur cette session. Une petite pause ? 💤`, 'stop-remind');
        kvSet(`stop_alert_${open.id}_${open.running_since}`, '1');
      }
    }
    // 2) Objectif du jour atteint
    if (s.daily_goal_minutes > 0 && doneToday >= s.daily_goal_minutes && !kvGet('goal_alert_' + today)) {
      await notifyIfEnabled('🎯 Objectif du jour atteint !',
        `Bravo, tu as pointé ${fmtMinutesFr(doneToday)} aujourd'hui. La suite est du bonus !`, 'goal');
      kvSet('goal_alert_' + today, '1');
    }

    // 2bis) Objectif de la semaine atteint → le surplus filera au 🏦 rattrapage
    const wGoal = s.weekly_goal_minutes || 0;
    if (wGoal > 0) {
      const [wkFrom, wkTo] = weekRangeOf(today);
      const doneWeek = rangeMinutesFull(wkFrom, wkTo, nowMs);
      if (doneWeek >= wGoal && !kvGet('week_goal_alert_' + wkFrom)) {
        await notifyIfEnabled('🎯 Objectif de la semaine atteint !',
          `${fmtMinutesFr(doneWeek)} cette semaine — chaque minute de plus ne rapporte plus d’argent 💰 et file au 🏦 rattrapage`, 'week-goal');
        kvSet('week_goal_alert_' + wkFrom, '1');
      }
    }

    // 3) Rappels de pointage multiples : pendant la fenêtre du rappel (±30 min),
    //    si rien ne tourne (ni gros chrono ni chrono de tâche), on envoie le push
    const pointing = !!open || openChronos().some(c => c.running_since);
    if (!pointing) {
      const cur = now.getHours() * 60 + now.getMinutes();
      for (const r of db.prepare('SELECT * FROM reminders WHERE enabled=1').all()) {
        if (!/^\d{2}:\d{2}$/.test(r.time || '')) continue;
        const [hh, mm] = r.time.split(':').map(Number);
        const target = hh * 60 + mm;
        if (cur >= target && cur < target + 30 && !kvGet(`remind_alert_${r.id}_${today}`)) {
          await notifyIfEnabled('⏰ N\'oublie pas de pointer !',
            `Rappel de ${r.time} — lance la pointeuse (ou un chrono de tâche) pour empiler l'XP 💪`, 'remind-' + r.id);
          kvSet(`remind_alert_${r.id}_${today}`, '1');
        }
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
const reminderTimer = setInterval(checkReminders, 30 * 1000);

// Fallback SPA
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Arrêt propre ------------------------------------------------------------
// Node tournant en PID 1 dans le conteneur ignore SIGTERM tant qu'aucun handler
// n'est posé → docker le finit au SIGKILL après son délai → corruption possible
// des pages WAL pendant une écriture (cf. crash-loop du 5 nov). On ferme donc le
// serveur, puis la base, et on s'en va proprement.
let shuttingDown = false;
function cleanShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reminderTimer);
  console.log(`👋 Arrêt (${reason}) — fermeture du serveur puis de la base…`);
  server.closeIdleConnections?.(); // coupe immédiatement les keep-alive (ex. cloudflared)
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch {} process.exit(0); }, 5000).unref(); // garde-fou
}
process.on('SIGTERM', () => cleanShutdown('SIGTERM'));
process.on('SIGINT', () => cleanShutdown('SIGINT'));

// Une promesse rejetée en dehors de tout catch ne doit plus tuer le process (Node ≥ 15)
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

// Erreurs de routes → JSON plutôt que la page HTML d'Express (l'app reste debout)
app.use((err, req, res, _next) => {
  console.error('Erreur route:', err.message);
  res.status(500).json({ error: 'Erreur serveur', detail: err.message });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`⏰ Pwointar écoute sur http://0.0.0.0:${PORT}`);
});