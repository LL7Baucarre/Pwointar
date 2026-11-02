/* Pwointar — logique client */
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  S: null,               // bootstrap
  timer: null,           // session ouverte (gros chrono)
  chronos: [],           // chronos de tâches actifs
  chronoTaskId: null,    // tâche choisie dans le sélecteur de chrono
  chronoTaskOptions: [], // tâches proposées dans le sélecteur
  lastTick: 0,
};

const tzOffsetMs = new Date().getTimezoneOffset() * 60 * 1000 * -1; // MS local - UTC

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDuration(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
function fmtClock(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
function fmtMoney(v, currency = 'EUR') {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
}
function fmtDateHuman(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function todayLocal() { return new Date(Date.now() - tzOffsetMs).toISOString().slice(0, 10); }
function chronoElapsedMs(c) {
  // temps actif accumulé + temps écoulé depuis la dernière reprise
  return (c.active_ms || 0) + (c.running ? Math.max(0, Date.now() - c.running_since) : 0);
}
function sessionElapsedMs(t) {
  if (!t) return 0;
  if (t.active_ms == null) return Math.max(0, Date.now() - t.start_ms); // ancien modèle
  return (t.active_ms || 0) + (t.running ? Math.max(0, Date.now() - t.running_since) : 0);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Toasts / gamification fx
// ---------------------------------------------------------------------------
function toast(msg, cls = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 2900);
}
function confetti(n = 40) {
  const colors = ['#7c5cff', '#a78bfa', '#2dd4bf', '#fbbf24', '#fb7185'];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'conf';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.top = '-20px';
    c.style.background = colors[i % colors.length];
    c.style.animationDelay = Math.random() * .4 + 's';
    c.style.animationDuration = (1 + Math.random()) + 's';
    $('confetti-layer').appendChild(c);
    setTimeout(() => c.remove(), 2600);
  }
}
function floatXp(text, anchor) {
  const el = document.createElement('div');
  el.className = 'float-xp';
  el.textContent = text;
  const r = (anchor || $('btn-pause')).getBoundingClientRect();
  el.style.left = r.left + r.width / 2 + 'px';
  el.style.top = r.top + 'px';
  $('confetti-layer').parentElement.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

let lastLevel = null, lastBadges = [];
function gamifyDiff(g) {
  if (!g) return;
  if (lastLevel !== null && g.level > lastLevel) {
    toast(`🎉 NIVEAU ${g.level} ATTEINT !`, 'gold');
    confetti(60);
  }
  const newOnes = lastBadges.length ? g.badges.filter(b => !lastBadges.includes(b)) : [];
  newOnes.forEach(k => {
    const names = {
      first_session: '🐣 Premier pointage !', ten_hours: '🕐 Badge 10 h !', fifty_hours: '⏳ Badge 50 h !',
      hundred_hours: '💯 Centurion !', streak_3: '🔥 Streak x3 !', streak_7: '🌋 Streak x7 !',
      streak_30: '🏆 Streak 30 jours !', deep_work: '🧠 Deep work !', early_bird: '🐓 Lève-tôt !',
      night_owl: '🦉 Oiseau de nuit !', taskmaster_5: '✅ 5 tâches done !', taskmaster_25: '🗂️ 25 tâches done !',
      money_1k: '💰 1 000 € !', marathon: '🏃 Marathon (8h/jour) !',
    };
    toast(names[k] || '🏅 Nouveau badge !', 'gold');
  });
  if (newOnes.length) confetti(30);
  lastLevel = g.level;
  lastBadges = g.badges;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------
function renderAll(S) {
  renderHud(S);
  renderGoal(S);
  renderTimerUI();
  renderChronos(S);
  renderRecent(S.recent);
  renderTasks(S.tasks);
  renderStats(S);
  renderSettings(S.settings, S.gamification);
  renderReminders(S.reminders);
  fillManualTaskSelect(S.tasks);
  renderTaskPicker(S.tasks);
  renderEntries(S);
}

function renderHud(S) {
  const g = S.gamification;
  $('hud-level-num').textContent = g.level;
  $('hud-streak-num').textContent = g.streak;
  $('hud-money-num').textContent = fmtMoney(g.money ?? (S.gamification.money), S.settings.currency);
  const span = g.next_level_xp - g.current_level_xp;
  const pct = span > 0 ? Math.min(100, ((g.xp_total - g.current_level_xp) / span) * 100) : 100;
  $('xpbar-fill').style.width = pct + '%';
  $('xpbar-label').textContent = `${g.xp_total} / ${g.next_level_xp} XP`;
  $('hud-streak').style.opacity = g.streak > 0 ? 1 : .55;
}

function renderTimerUI() {
  const open = !!state.timer;
  const running = open && state.timer.running !== false;
  $('btn-start').classList.toggle('hidden', open);
  $('btn-pause').classList.toggle('hidden', !running);
  $('btn-resume').classList.toggle('hidden', !open || running);
  $('btn-close-day').classList.toggle('hidden', !open || running);
  $('timer-ring').classList.toggle('running', running);
  $('timer-ring').classList.toggle('paused', open && !running);
  $('timer-note').textContent = running ? 'EN COURS' : (open ? 'EN PAUSE' : 'PRÊT À POINTER');
  const t = state.timer;
  $('timer-task').classList.toggle('hidden', !open || !t?.task_id);
  if (open && t) {
    const task = state.S.tasks.find(x => x.id === t.task_id);
    $('timer-task').innerHTML = task ? `📌 <b>${esc(task.title)}</b>` : '';
  }
  tick();
}

// Total du jour « live » : entrées clôturées + session en cours + minuteurs ouverts
function todayLiveMinutes() {
  if (!state.S) return 0;
  let today = state.S.today;
  if (state.timer) today += sessionElapsedMs(state.timer) / 60000;
  for (const c of state.chronos) {
    if (c.mode === 'standalone') today += chronoElapsedMs(c) / 60000;
  }
  return today;
}

function tick() {
  if (state.timer) {
    $('timer-display').textContent = fmtClock(sessionElapsedMs(state.timer));
  }
  const today = todayLiveMinutes();
  // objectif du jour + tuile stats en direct
  if (state.S) {
    const goal = state.S.settings.daily_goal_minutes;
    $('goal-done').textContent = today >= 60 ? fmtDuration(today) : `${Math.round(today)} min`;
    $('goal-earned').textContent = fmtMoney(today / 60 * state.S.settings.hourly_rate, state.S.settings.currency);
    $('goal-fill').style.width = Math.min(100, goal > 0 ? (today / goal) * 100 : 0) + '%';
    $('stat-today').textContent = fmtDuration(today);
  }
  renderWeekGoal();
  // horloges des chronos actifs
  for (const c of state.chronos) {
    const t1 = $('chrono-time-' + c.id);
    if (t1) t1.textContent = fmtClock(chronoElapsedMs(c));
    const t2 = $('task-chrono-time-' + c.id);
    if (t2) t2.textContent = fmtClock(chronoElapsedMs(c));
  }
  updateMoneyCounter();
}

// Compteur défilant de l'argent gagné aujourd'hui (grille plus fine pour « défiler »)
function updateMoneyCounter() {
  if (!state.S) return;
  const v = todayLiveMinutes() / 60 * state.S.settings.hourly_rate;
  $('timer-today').textContent = fmtMoney(v, state.S.settings.currency);
}
setInterval(() => { if (state.S) updateMoneyCounter(); }, 250);

setInterval(tick, 1000);

function renderGoal(S) {
  const goal = S.settings.daily_goal_minutes;
  const done = S.today;
  $('goal-target').textContent = fmtDuration(goal);
  $('goal-done').textContent = done >= 60 ? fmtDuration(done) : `${Math.round(done)} min`;
  $('goal-earned').textContent = fmtMoney(S.today / 60 * S.settings.hourly_rate, S.settings.currency);
  const pct = Math.min(100, goal > 0 ? (done / goal) * 100 : 0);
  $('goal-fill').style.width = pct + '%';
}

// Minutes de la semaine calendaire (lundi → dimanche), session en cours incluse
function weekLiveMinutes() {
  if (!state.S) return 0;
  return Math.max(0, (state.S.week_minutes || 0) - (state.S.today || 0) + todayLiveMinutes());
}
// Barre « objectif de la semaine » : en direct, surplus → rattrapage 🏦
function renderWeekGoal() {
  if (!state.S) return;
  const wg = state.S.settings.weekly_goal_minutes || 0;
  $('week-goal-block').classList.toggle('hidden', wg <= 0);
  if (wg <= 0) return;
  const done = weekLiveMinutes();
  $('week-goal-target').textContent = fmtDuration(wg);
  $('week-goal-done').textContent = done >= 60 ? fmtDuration(done) : `${Math.round(done)} min`;
  $('week-goal-fill').style.width = Math.min(100, (done / wg) * 100) + '%';
  const surplus = done - wg;
  $('week-rattrapage').textContent = surplus >= 1
    ? `🏦 +${fmtDuration(surplus)} → rattrapage`
    : `reste ${fmtDuration(Math.max(0, wg - done))}`;
}

function renderRecent(list) {
  const el = $('recent-list');
  el.innerHTML = '';
  if (!list || !list.length) {
    el.innerHTML = '<li class="empty">Aucune session encore. Lance ta première ! 🚀</li>';
    return;
  }
  list.slice(0, 8).forEach(e => el.appendChild(entryEl(e)));
}

function entryEl(e, withDelete) {
  const li = document.createElement('li');
  const task = state.S?.tasks.find(t => t.id === e.task_id);
  li.innerHTML = `
    <div class="entry-main">
      <span class="entry-date">${fmtDateHuman(e.date)} · ${fmtTime(e.start_ms)} → ${e.end_ms ? fmtTime(e.end_ms) : '…'}</span>
      ${e.note ? `<span class="entry-note">${esc(e.note)}</span>` : ''}
      ${task ? `<span class="entry-note">📌 ${esc(task.title)}</span>` : ''}
    </div>
    <div style="text-align:right">
      <div class="entry-time">${fmtDuration(e.minutes)}</div>
      <div class="entry-money">${fmtMoney(e.money, state.S.settings.currency)}</div>
    </div>`;
  if (withDelete) {
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.textContent = '🗑️';
    btn.title = 'Supprimer';
    btn.onclick = async () => {
      if (!confirm('Supprimer cette session ?')) return;
      try { await api(`/entries/${e.id}`, { method: 'DELETE' }); await refresh(); toast('Session supprimée'); }
      catch (err) { toast('❌ ' + err.message); }
    };
    li.appendChild(btn);
  }
  return li;
}

function renderTasks(tasks) {
  const open = $('task-list-open'), done = $('task-list-done');
  open.innerHTML = ''; done.innerHTML = '';
  const openList = tasks.filter(t => !t.done), doneList = tasks.filter(t => t.done);
  $('tasks-open-count').textContent = openList.length || '';
  $('tasks-done-count').textContent = doneList.length || '';

  const row = (t) => {
    const li = document.createElement('li');
    li.id = 'task-' + t.id;
    const chrono = state.chronos.find(c => c.task_id === t.id);
    if (chrono) li.classList.add('has-chrono');
    const check = document.createElement('button');
    check.className = 'task-check' + (t.done ? ' on' : '');
    check.textContent = '✓';
    check.onclick = () => toggleTask(t);
    const main = document.createElement('div');
    main.className = 't-main';
    main.innerHTML = `<div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">${t.est_minutes ? '~' + fmtDuration(t.est_minutes) + ' · ' : ''}<span class="t-xp">+${t.xp_bonus} XP</span>${chrono ? ` · ⏱️ <span class="t-live" id="task-chrono-time-${chrono.id}">${fmtClock(chronoElapsedMs(chrono))}</span>` : ''}</div>`;
    const del = document.createElement('button');
    del.className = 'icon-btn'; del.textContent = '🗑️';
    del.onclick = async () => {
      if (!confirm(`Supprimer la tâche « ${t.title} » ?`)) return;
      try { await api(`/tasks/${t.id}`, { method: 'DELETE' }); await refresh(); }
      catch (err) { toast('❌ ' + err.message); }
    };
    li.append(check, main, del);
    if (!t.done) {
      const play = document.createElement('button');
      play.className = 'icon-btn play-btn';
      play.textContent = '▶️';
      play.title = 'Lancer un chrono (📌 rattaché si le gros chrono tourne, sinon ⏱️ minuteur)';
      play.onclick = () => launchFromTask(t);
      li.insertBefore(play, del);
    }
    return li;
  };

  if (!openList.length) open.innerHTML = '<li class="empty">Rien à faire. Ajoute une tâche ! ☝️</li>';
  if (!doneList.length) done.innerHTML = '<li class="empty">Pas encore de tâches terminées.</li>';
  openList.forEach(t => open.appendChild(row(t)));
  doneList.slice(0, 30).forEach(t => done.appendChild(row(t)));
}

async function toggleTask(t) {
  try {
    const r = await api(`/tasks/${t.id}`, { method: 'PUT', body: { done: !t.done } });
    const li = $('task-' + t.id);
    if (r.gained_xp > 0) {
      floatXp(`+${r.gained_xp} XP`, li);
      toast(`✅ Tâche terminée ! +${r.gained_xp} XP`, 'gold');
      confetti(25);
    } else {
      toast(`↩️ Tâche réouverte`);
    }
    gamifyDiff(r.gamification);
    await refresh();
  } catch (err) { toast('❌ ' + err.message); }
}

function renderStats(S) {
  $('stat-today').textContent = fmtDuration(S.today);
  $('stat-week').textContent = fmtDuration(S.week_minutes);
  $('stat-month').textContent = fmtDuration(S.month_minutes);
  // 🏦 banque de rattrapage (visible si un objectif hebdo est défini)
  const rat = S.rattrapage || {};
  const ratOn = (rat.goal_minutes || 0) > 0;
  $('rattrapage-grid').classList.toggle('hidden', !ratOn);
  if (ratOn) {
    $('rat-balance').textContent = fmtDuration(rat.balance_min || 0);
    $('rat-week').textContent = '+' + fmtDuration(rat.current_surplus_min || 0);
  }
  fetchStats().then(st => {
    if (!st) return;
    $('stat-total').textContent = fmtDuration(st.total.m);
    renderDayChart(st.day_stats);
    renderHourChart(st.by_hour);
    renderTaskTime(st.by_task);
  });
}

async function fetchStats() {
  try { return await api('/stats'); } catch { return null; }
}

function renderDayChart(days) {
  const el = $('chart-days');
  el.innerHTML = '';
  // reconstituer les 14 derniers jours
  const map = new Map(days.map(d => [d.date, d.m]));
  const arr = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - tzOffsetMs - i * 86400000);
    const s = d.toISOString().slice(0, 10);
    arr.push({ date: s, m: map.get(s) || 0 });
  }
  const max = Math.max(...arr.map(a => a.m), 1);
  arr.forEach(a => {
    const bar = document.createElement('div');
    bar.className = 'bar' + (a.m === 0 ? ' zero' : '');
    bar.style.height = Math.max(2, (a.m / max) * 100) + '%';
    bar.innerHTML = `<span class="tip">${fmtDateHuman(a.date)} : ${fmtDuration(a.m)}</span>`;
    el.appendChild(bar);
  });
}

function renderHourChart(byHour) {
  const el = $('chart-hours');
  el.innerHTML = '';
  const map = new Map(byHour.map(h => [h.h, h.m]));
  const max = Math.max(...byHour.map(h => h.m), 1);
  for (let h = 0; h < 24; h++) {
    const m = map.get(h) || 0;
    const bar = document.createElement('div');
    bar.className = 'bar' + (m === 0 ? ' zero' : '');
    bar.style.height = Math.max(2, (m / max) * 100) + '%';
    bar.innerHTML = `<span class="tip">${String(h).padStart(2, '0')}h : ${fmtDuration(m)}</span>`;
    el.appendChild(bar);
  }
}

function renderTaskTime(byTask) {
  const el = $('task-time-list');
  el.innerHTML = '';
  if (!byTask.length) { el.innerHTML = '<li class="empty">Aucune donnée</li>'; return; }
  byTask.forEach(t => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(t.label)}</span><b>${fmtDuration(t.m)}</b>`;
    el.appendChild(li);
  });
}

function renderSettings(settings, g) {
  $('set-rate').value = settings.hourly_rate;
  $('set-currency').value = settings.currency;
  $('set-goal').value = settings.daily_goal_minutes;
  $('set-weekgoal').value = settings.weekly_goal_minutes ?? 0;
  $('set-active').value = settings.active_day_minutes;
  $('set-notify-stop').value = settings.notify_stop_minutes;
  $('set-notify-enabled').checked = !!settings.notify_enabled;
  $('set-currency-label').textContent = currencySymbol(settings.currency);
  const xpToNext = g.next_level_xp - g.xp_total;
  $('profile-level-circle').textContent = g.level;
  $('profile-xp').textContent = `${g.xp_total} XP · encore ${xpToNext} XP pour le niveau ${g.level + 1}`;
  renderBadges(g);
  renderPushStatus();
}

function currencySymbol(c) {
  return ({ EUR: '€', USD: '$', CHF: 'CHF', GBP: '£', CAD: '$' }[c] || c);
}

async function renderBadges(g) {
  try {
    const r = await api('/badges');
    const el = $('badges');
    el.innerHTML = '';
    r.badges.forEach(b => {
      const d = document.createElement('div');
      d.className = 'badge' + (b.earned ? ' earned' : '');
      d.title = b.desc;
      d.innerHTML = `<span class="b-icon">${b.icon}</span><span class="b-name">${b.name}</span><div class="b-desc">${b.desc}</div>`;
      el.appendChild(d);
    });
  } catch { /* offline */ }
}

function fillManualTaskSelect(tasks) {
  const sel = $('manual-task');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— aucune —</option>';
  tasks.filter(t => !t.done).forEach(t => {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.title;
    sel.appendChild(o);
  });
  sel.value = cur;
}

function renderEntries(S) {
  const el = $('all-entries');
  el.innerHTML = '';
  if (!S.recent.length) { el.innerHTML = '<li class="empty">Aucune session enregistrée.</li>'; return; }
  S.recent.forEach(e => el.appendChild(entryEl(e, true)));
}

// ---------------------------------------------------------------------------
// Timer actions
// ---------------------------------------------------------------------------
async function startTimer(taskId = null) {
  try {
    const r = await api('/timer/start', { method: 'POST', body: { task_id: taskId, tzOffset: tzOffsetMs } });
    state.timer = r.timer;
    if (taskId) {
      const task = state.S.tasks.find(x => x.id === taskId);
      if (task) toast(`📌 Session lancée sur « ${task.title} »`);
    } else {
      toast('▶️ C\'est parti ! Empile l\'XP 💪');
    }
    if (r.resumed_chronos) toast(`⏱️ ${r.resumed_chronos} chrono(s) rattaché(s) repris`);
    lastLevel = state.S.gamification.level;
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
}

async function pauseTimer() {
  try {
    const r = await api('/timer/pause', { method: 'POST', body: { tzOffset: tzOffsetMs } });
    if (r.timer) state.timer = r.timer;
    toast(`⏸ Pause — ${fmtDuration(r.today ?? 0)} pointées aujourd'hui 💤`);
    if (r.paused_chronos) toast(`⏸ ${r.paused_chronos} chrono(s) rattaché(s) en pause aussi`);
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
}

async function resumeTimer() {
  try {
    const r = await api('/timer/resume', { method: 'POST' });
    if (r.timer) state.timer = r.timer;
    toast('▶️ C\'est reparti ! Empile l\'XP 💪');
    if (r.resumed_chronos) toast(`⏱️ ${r.resumed_chronos} chrono(s) rattaché(s) repris`);
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
}

// 🌙 Clôturer la journée (chrono en pause) : la session prend fin, les minutes du
// jour sont figées et la prochaine reprise repart de zéro.
async function closeDay() {
  const mins = todayLiveMinutes();
  if (!confirm(`Clôturer la journée ? ${fmtDuration(mins)} pointées aujourd'hui — le chrono s'arrêtera et repartira de zéro à la prochaine reprise.`)) return;
  try {
    const r = await api('/timer/close', { method: 'POST', body: { tzOffset: tzOffsetMs } });
    state.timer = null;
    toast(`🌙 Journée clôturée — ${fmtDuration(r.today ?? mins)} pointées aujourd'hui 👏`);
    if (r.paused_chronos) toast(`⏸ ${r.paused_chronos} chrono(s) rattaché(s) en pause aussi`);
    if ((r.today ?? 0) > 0) confetti(30);
    if (r.gamification) gamifyDiff(r.gamification);
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
}

$('btn-start').onclick = () => startTimer(null);
$('btn-pause').onclick = pauseTimer;
$('btn-resume').onclick = resumeTimer;
$('btn-close-day').onclick = closeDay;
$('qa-start-new').onclick = () => {
  if (state.timer) { toast('⚠️ Une session est déjà en cours'); return; }
  const sel = $('manual-task');
  startTimer(sel.value ? Number(sel.value) : null);
};
$('qa-manual').onclick = () => {
  switchTab('profile');
  setTimeout(() => $('manual-date').scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
};

// ---------------------------------------------------------------------------
// Chronos de tâches (max 3 en parallèle)
// mode 'attached'   : le temps vient du gros chrono (auto-pausé si la session s'arrête)
// mode 'standalone' : minuteur autonome — crée un pointage à l'arrêt
// ---------------------------------------------------------------------------
async function startChrono(taskId, mode) {
  try {
    const r = await api('/chronos', { method: 'POST', body: { task_id: taskId, mode, tzOffset: tzOffsetMs } });
    if (r.session_started) toast('▶️ Gros chrono lancé automatiquement');
    if (r.resumed_chronos) toast(`⏱️ ${r.resumed_chronos} chrono(s) rattaché(s) repris`);
    toast(r.chrono.mode === 'attached'
      ? `📌 « ${r.chrono.task_title} » rattaché au gros chrono`
      : `⏱️ « ${r.chrono.task_title} » lancée en minuteur`);
    state.chronoTaskId = null;
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
}

// Lancement rapide depuis la liste des tâches : rattaché si le gros chrono tourne, sinon minuteur
async function launchFromTask(t) {
  await startChrono(t.id, state.timer ? 'attached' : 'standalone');
}

async function chronoPause(c) {
  try { await api(`/chronos/${c.id}/pause`, { method: 'POST' }); await refresh(); }
  catch (err) { toast('⚠️ ' + err.message); }
}

async function chronoResume(c) {
  try {
    const r = await api(`/chronos/${c.id}/resume`, { method: 'POST', body: { tzOffset: tzOffsetMs } });
    if (r.session_started) toast('▶️ Gros chrono relancé automatiquement');
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
}

async function chronoStop(c) {
  try {
    const r = await api(`/chronos/${c.id}/stop`, { method: 'POST' });
    if (r.entry) {
      toast(`⏹️ « ${r.chrono.task_title} » : ${fmtDuration(r.entry.minutes)} — +${r.gained_xp} XP 💰`, 'gold');
      if (r.gamification) gamifyDiff(r.gamification);
      confetti(15);
    } else {
      toast(`⏹️ « ${r.chrono.task_title} » — ${fmtDuration(r.chrono.elapsed_ms / 60000)} rattachées ✅`);
    }
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
}

async function chronoDelete(c) {
  if (!confirm('Supprimer ce chrono terminé ?')) return;
  try { await api(`/chronos/${c.id}`, { method: 'DELETE' }); toast('Chrono supprimé'); await refresh(); }
  catch (err) { toast('⚠️ ' + err.message); }
}

function renderChronos(S) {
  state.chronos = S.chronos || [];
  const list = $('chrono-list');
  list.innerHTML = '';
  if (!state.chronos.length) {
    list.innerHTML = '<li class="empty">Aucun chrono actif — choisis une tâche ci-dessus ⏱️</li>';
  } else {
    for (const c of state.chronos) {
      const trulyRunning = c.running && (c.mode === 'standalone' || !!state.timer);
      const li = document.createElement('li');
      li.className = 'chrono-row ' + (trulyRunning ? 'running' : 'paused');
      const badge = c.mode === 'attached'
        ? '<span class="c-badge attached">📌 rattaché</span>'
        : '<span class="c-badge standalone">⏱️ minuteur</span>';
      li.innerHTML = `
        <div class="c-main">
          <div class="c-title">${esc(c.task_title)}</div>
          <div class="c-badges">${badge}${c.auto_paused ? '<span class="c-badge auto">⏸ auto</span>' : ''}</div>
        </div>
        <span class="c-time" id="chrono-time-${c.id}">${fmtClock(chronoElapsedMs(c))}</span>`;
      const pauseBtn = document.createElement('button');
      pauseBtn.className = 'icon-btn';
      pauseBtn.textContent = c.running ? '⏸' : '▶';
      pauseBtn.title = c.running ? 'Mettre en pause' : 'Reprendre';
      pauseBtn.onclick = () => (c.running ? chronoPause(c) : chronoResume(c));
      const stopBtn = document.createElement('button');
      stopBtn.className = 'icon-btn stop-chrono';
      stopBtn.textContent = '■';
      stopBtn.title = 'Stopper et valider';
      stopBtn.onclick = () => chronoStop(c);
      li.append(pauseBtn, stopBtn);
      list.appendChild(li);
    }
  }

  // chronos terminés aujourd'hui
  const doneArr = S.chronos_done_today || [];
  $('chrono-done-card').classList.toggle('hidden', !doneArr.length);
  const done = $('chrono-done-list');
  done.innerHTML = '';
  doneArr.forEach(c => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="c-main">
        <div class="c-title">${esc(c.task_title)}</div>
        <div class="c-badges">${c.mode === 'attached'
          ? '<span class="c-badge attached">📌 rattaché</span>'
          : '<span class="c-badge standalone">⏱️ minuteur</span>'}</div>
      </div>
      <span class="c-time">${fmtDuration(c.minutes)}</span>`;
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '🗑️';
    del.title = 'Supprimer';
    del.onclick = () => chronoDelete(c);
    li.append(del);
    done.appendChild(li);
  });

  updateChronoLaunchUI();
}

function updateChronoLaunchUI() {
  if (!state.S) return;
  const sessionRunning = !!state.timer;
  const full = state.chronos.length >= 3;
  const noTasks = !state.S.tasks.some(t => !t.done);
  $('btn-chrono-attach').disabled = full || noTasks;
  $('btn-chrono-minuteur').disabled = full || noTasks || sessionRunning;
  $('chrono-task-btn').disabled = noTasks;
  $('btn-chrono-fly').disabled = full;
  const hint = $('chrono-hint');
  if (full) hint.textContent = '⚠️ 3 chronos max en parallèle — stoppe-en un d\'abord.';
  else if (noTasks) hint.textContent = 'Ajoute une tâche (onglet 📋) ou crée-la à la volée ✨.';
  else if (sessionRunning) hint.textContent = 'Gros chrono en cours → les nouvelles tâches seront 📌 rattachées (le temps vient de la session).';
  else hint.textContent = '⏱️ Minuteur = autonome, son temps compte dans la journée. 📌 Rattacher = démarre le gros chrono et le temps vient de la session.';
  if (state.S.fly_origin_ms && !full && !noTasks) {
    hint.textContent += ` ✨ À la volée : comptera depuis ${fmtTime(state.S.fly_origin_ms)}.`;
  }
}

// --- Sélecteur de tâche (dropdown maison) ------------------------------------
function renderTaskPicker(tasks) {
  state.chronoTaskOptions = (tasks || []).filter(t => !t.done);
  const btn = $('chrono-task-btn');
  const label = $('chrono-task-label');
  const sel = state.chronoTaskOptions.find(t => t.id === state.chronoTaskId);
  if (!sel) state.chronoTaskId = null;
  label.textContent = sel ? sel.title : '— choisir une tâche —';
  label.classList.toggle('placeholder', !sel);
  btn.disabled = !state.chronoTaskOptions.length;
}

function closeTaskPicker() {
  $('chrono-task-panel').classList.add('hidden');
  $('chrono-task-picker').classList.remove('open');
  $('chrono-task-btn').setAttribute('aria-expanded', 'false');
}

function openTaskPicker() {
  const panel = $('chrono-task-panel');
  panel.innerHTML = '';
  const opts = state.chronoTaskOptions || [];
  if (!opts.length) {
    panel.innerHTML = '<div class="task-picker-empty">Aucune tâche ouverte — crée-la à la volée ✨</div>';
  } else {
    opts.forEach(t => {
      const item = document.createElement('div');
      item.className = 'task-picker-item' + (t.id === state.chronoTaskId ? ' sel' : '');
      item.setAttribute('role', 'option');
      item.innerHTML = `<span class="tp-title">${esc(t.title)}</span>
        <span class="tp-meta">${t.est_minutes ? '~' + fmtDuration(t.est_minutes) + ' · ' : ''}+${t.xp_bonus} XP</span>`;
      item.onclick = () => {
        state.chronoTaskId = t.id;
        renderTaskPicker(state.S ? state.S.tasks : []);
        closeTaskPicker();
      };
      panel.appendChild(item);
    });
  }
  panel.classList.remove('hidden');
  $('chrono-task-picker').classList.add('open');
  $('chrono-task-btn').setAttribute('aria-expanded', 'true');
}

$('chrono-task-btn').onclick = () => {
  if ($('chrono-task-panel').classList.contains('hidden')) openTaskPicker();
  else closeTaskPicker();
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#chrono-task-picker')) closeTaskPicker();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTaskPicker(); });

$('btn-chrono-attach').onclick = () => {
  if (!state.chronoTaskId) { toast('⚠️ Choisis (ou crée) une tâche'); return; }
  startChrono(state.chronoTaskId, 'attached');
};
$('btn-chrono-minuteur').onclick = () => {
  if (!state.chronoTaskId) { toast('⚠️ Choisis (ou crée) une tâche'); return; }
  startChrono(state.chronoTaskId, 'standalone');
};
$('btn-chrono-fly').onclick = () => {
  const box = $('chrono-fly-box');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) $('chrono-fly-title').focus();
};
$('chrono-fly-box').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('chrono-fly-title').value.trim();
  if (!title) { toast('⚠️ Donne un nom à la tâche'); return; }
  try {
    const r = await api('/chronos/fly', { method: 'POST', body: { title, tzOffset: tzOffsetMs } });
    $('chrono-fly-title').value = '';
    $('chrono-fly-box').classList.add('hidden');
    toast(r.backfilled
      ? `✨ « ${r.task.title} » créée — comptée dès ${fmtTime(r.origin_ms)}`
      : `✨ « ${r.task.title} » créée — chrono ${r.mode === 'attached' ? 'rattaché 📌' : 'lancé ⏱️'}`);
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.add('hidden'));
  $('tab-' + name).classList.remove('hidden');
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'stats') renderStats(state.S);
}
$('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) switchTab(btn.dataset.tab);
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
$('task-form').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('task-title').value.trim();
  if (!title) return;
  try {
    await api('/tasks', { method: 'POST', body: { title, est_minutes: +$('task-est').value, xp_bonus: +$('task-xp').value } });
    $('task-title').value = '';
    toast('📋 Tâche ajoutée !');
    await refresh();
  } catch (err) { toast('❌ ' + err.message); }
};

// steppers (tâches + réglages)
document.querySelectorAll('.stepper button').forEach(b => {
  b.onclick = () => {
    const input = $(b.dataset.target);
    input.value = Math.max(+(input.min || 0), (+input.value || 0) + +b.dataset.step);
  };
});

$('manual-form').onsubmit = async (e) => {
  e.preventDefault();
  const body = {
    date: $('manual-date').value,
    start: $('manual-start').value,
    end: $('manual-end').value,
    note: $('manual-note').value.trim(),
    task_id: $('manual-task').value ? Number($('manual-task').value) : null,
  };
  if (!body.date || !body.start || !body.end) { toast('⚠️ Remplis date + heures'); return; }
  try {
    const r = await api('/entries', { method: 'POST', body });
    toast(`✏️ Pointage ajouté : ${fmtDuration(r.entry.minutes)}`);
    $('manual-note').value = '';
    gamifyDiff(r.gamification);
    await refresh();
  } catch (err) { toast('❌ ' + err.message); }
};

$('settings-form').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api('/settings', {
      method: 'PUT',
      body: {
        hourly_rate: +$('set-rate').value,
        currency: $('set-currency').value,
        daily_goal_minutes: +$('set-goal').value,
        weekly_goal_minutes: Math.max(0, +$('set-weekgoal').value || 0),
        active_day_minutes: Math.max(1, +$('set-active').value),
        notify_stop_minutes: Math.max(15, +$('set-notify-stop').value || 240),
        notify_enabled: $('set-notify-enabled').checked,
      },
    });
    toast('⚙️ Réglages enregistrés');
    gamifyDiff(r.gamification);
    await refresh();
  } catch (err) { toast('❌ ' + err.message); }
};

$('set-currency').onchange = () => $('set-currency-label').textContent = currencySymbol($('set-currency').value);

// ---------------------------------------------------------------------------
// Rappels de pointage multiples
// ---------------------------------------------------------------------------
function renderReminders(reminders) {
  const el = $('reminders-list');
  if (!el) return;
  el.innerHTML = '';
  const list = reminders || [];
  list.forEach(r => {
    const row = document.createElement('div');
    row.className = 'reminder-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!r.enabled;
    cb.title = r.enabled ? 'Rappel activé' : 'Rappel désactivé';
    cb.onchange = async () => {
      try { await api(`/reminders/${r.id}`, { method: 'PUT', body: { enabled: cb.checked } }); await refresh(); }
      catch (err) { toast('⚠️ ' + err.message); }
    };
    const time = document.createElement('input');
    time.type = 'time';
    time.value = r.time;
    time.onchange = async () => {
      try { await api(`/reminders/${r.id}`, { method: 'PUT', body: { time: time.value } }); toast('⏰ Rappel mis à jour'); await refresh(); }
      catch (err) { toast('⚠️ ' + err.message); }
    };
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '🗑️';
    del.title = 'Supprimer le rappel';
    del.onclick = async () => {
      try { await api(`/reminders/${r.id}`, { method: 'DELETE' }); toast('⏰ Rappel supprimé'); await refresh(); }
      catch (err) { toast('⚠️ ' + err.message); }
    };
    row.append(cb, time, del);
    el.appendChild(row);
  });
  if (!list.length) el.innerHTML = '<div class="empty">Aucun rappel — ajoute-en un !</div>';
  $('btn-reminder-add').disabled = list.length >= 8;
}

$('btn-reminder-add').onclick = async () => {
  try {
    await api('/reminders', { method: 'POST', body: { time: '09:00' } });
    toast('⏰ Rappel ajouté');
    await refresh();
  } catch (err) { toast('⚠️ ' + err.message); }
};

// ---------------------------------------------------------------------------
// Notifications push
// ---------------------------------------------------------------------------
let vapidPublic = null;

function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function getPushSub() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch { return null; }
}

async function renderPushStatus() {
  const el = $('push-status');
  const secure = window.isSecureContext;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.textContent = '❌ Push non supporté par ce navigateur';
    el.className = 'push-status bad';
    $('btn-push-enable').disabled = true;
    return;
  }
  const perm = Notification.permission;
  const sub = await getPushSub();
  if (sub && perm === 'granted') {
    el.textContent = '✅ Notifications activées sur cet appareil';
    el.className = 'push-status ok';
    $('btn-push-enable').classList.add('hidden');
    $('btn-push-disable').classList.remove('hidden');
  } else {
    el.textContent = perm === 'denied'
      ? '❌ Notifications bloquées — réautorise-les dans les réglages du navigateur'
      : `⚪ Notifications désactivées${secure ? '' : ' (HTTPS requis pour les push)'}`;
    el.className = 'push-status ' + (perm === 'denied' ? 'bad' : 'warn');
    $('btn-push-enable').classList.remove('hidden');
    $('btn-push-disable').classList.add('hidden');
  }
}

$('btn-push-enable').onclick = async () => {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('⚠️ Permission refusée — notifications impossibles'); renderPushStatus(); return; }
    if (!vapidPublic) { toast('⚠️ Clé serveur indisponible'); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapidPublic) });
    }
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('🔔 Notifications activées !');
    if (state.S) state.S.push.subs = (state.S.push.subs || 0) + 1;
    renderPushStatus();
  } catch (err) { toast('❌ ' + err.message); renderPushStatus(); }
};

$('btn-push-disable').onclick = async () => {
  try {
    const sub = await getPushSub();
    if (sub) {
      await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    toast('🔕 Notifications désactivées');
    if (state.S) state.S.push.subs = 0;
    renderPushStatus();
  } catch (err) { toast('❌ ' + err.message); }
};

$('btn-push-test').onclick = async () => {
  try {
    const r = await api('/push/test', { method: 'POST' });
    toast(r.sent > 0 ? `📬 Envoyé sur ${r.sent} appareil(s)` : '⚠️ Aucun appareil enregistré — active les notifications d\'abord');
  } catch (err) { toast('❌ ' + err.message); }
};

// ---------------------------------------------------------------------------
// Init / refresh
// ---------------------------------------------------------------------------
let refreshing = false;
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const S = await api('/bootstrap?tzOffset=' + tzOffsetMs);
    state.timer = S.timer || null; // le serveur fait foi (gère pauses & scission par jour)
    state.S = S;
    if (S.push?.vapid_public) vapidPublic = S.push.vapid_public;
    renderAll(S);
  } catch (err) {
    if (!navigator.onLine) toast('📡 Hors ligne — reconnexion auto quand tu reviens');
  } finally { refreshing = false; }
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

window.addEventListener('online', refresh);
setInterval(refresh, 60000); // sync période

// init manuel form dates
(function initDates() {
  $('manual-date').value = todayLocal();
  const st = $('manual-start'); const en = $('manual-end');
  st.value = '09:00'; en.value = '17:00';
})();

refresh();