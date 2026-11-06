# ⏰ Pwointar — Pointeuse gamifiée

Une **PWA dockerisée** pour pointer tes heures de travail, avec de la gamification : XP, niveaux, streaks 🔥, badges 🏅, argent gagné 💰, tâches avec bonus XP, et **notifications push** 🔔.

## 🚀 Lancer

```bash
docker compose up -d --build
```

Puis ouvre **http://localhost:3000** (sur ton PC) ou **http://\<ip-de-ton-PC\>:3000** depuis ton téléphone (même réseau Wi-Fi).

### Installation en PWA (app comme une vraie appli)
- **iPhone** : Safari → bouton Partager → « Sur l'écran d'accueil »
- **Android** : Chrome → menu ⋮ → « Installer l'application » (ou la bannière)
- **PC** : Chrome/Edge → icône ⊕ dans la barre d'adresse → « Installer »

## 🎮 Fonctions

| Zone | Ce que tu peux faire |
|---|---|
| ⏱️ **Pointeuse** | Gros bouton pointer → **⏸ PAUSE / ▶ REPRENDRE**, timer géant, **compteur d'argent défilant** dans l'anneau, objectif du jour, objectif de la semaine 🏦, les pauses ne pointent pas |
| 🌙 **Clôturer la journée** | Quand le chrono est en pause, le bouton **🌙 Clôturer la journée** termine la session : les minutes du jour sont figées (streak 🔥 et XP validés tout de suite) et la prochaine reprise repart de zéro |
| 🗓️ **Journées auto** | Dès que tu changes de jour, la session est **scindée automatiquement** : les minutes passées sont clôturées pour ce jour-là, le gros chrono continue sur le nouveau (un week-end en pause = aucune ligne fantôme) |
| ⏳ **Chronos de tâches** | Lance jusqu'à **3 chronos en parallèle** sous le gros chrono : 📌 rattaché au gros chrono, ou ⏱️ minuteur autonome. Pause/reprise par chrono, création de tâche ✨ à la volée |
| 📋 **Tâches** | Ajouter des tâches avec estimation et bonus XP, les cocher pour gagner l'XP, bouton ▶ pour démarrer un chrono directement |
| 📊 **Stats** | Aujourd'hui / semaine (lundi → dimanche) / 30 jours / total, **banque de rattrapage 🏦**, graphique des 14 derniers jours, répartition par heure, temps par tâche |
| 😀 **Profil** | Niveau, badges, réglages (taux horaire 💶, devise, objectif quotidien, **objectif hebdomadaire**, seuil de streak), pointage manuel, historique |

### 🏦 Rattrapage — comment ça marche

Règle ton **objectif hebdomadaire** dans le Profil (0 = désactivé). La semaine va du **lundi au dimanche**.

- Chaque **semaine terminée** où tu as pointé au moins une fois : le **surplus** (au-delà de l'objectif) est **versé dans la banque de rattrapage** 🏦 ; un **déficit** est retiré de la banque (jamais négatif — les semaines sans aucun pointage ne comptent pas, vacances incluses).
- La **semaine en cours** n'est pas encore versée : elle s'affiche en direct sous l'objectif du jour (barre dorée + `🏦 +X h → rattrapage` dès que tu dépasses).
- 💰 **Une fois l'objectif atteint, les minutes suivantes ne rapportent plus d'argent** : le compteur défilant s'arrête, et le surplus n'enrichit plus le total 💰 (l'XP, la streak et le 🏦 continuent). Les semaines d'avant l'activation de l'objectif restent payées à 100 %.
- La banque s'affiche dans l'onglet **Stats** (« Rattrapage en banque » + surplus de la semaine), et un push 🎯 part la première fois que tu atteins l'objectif de la semaine.
- Activer l'objectif démarre la banque **cette semaine-là** (l'historique d'avant n'est jamais recompté rétroactivement) ; changer la valeur de l'objectif re-base le calcul sur les semaines suivies.

### 📌 Chronos de tâches — comment ça marche

- **📌 Rattacher** : le chrono de la tâche se « branche » sur le gros chrono. Son temps vient de la session en cours (si celle-ci est mise en pause ou s'arrête, le chrono passe en ⏸ pause automatique ; il reprend avec le gros chrono). Si le gros chrono ne tourne pas ou dort en pause, il est **(re)lancé automatiquement**. Ce temps ne se cumule pas deux fois : il fait partie de la session.
- **⏱️ Minuteur** : chronomètre autonome pour une tâche, utilisable quand le gros chrono ne tourne pas. À l'arrêt, il crée un **vrai pointage** (compte dans la journée, l'XP et l'argent).
- Jusqu'à **3 chronos actifs en même temps**, chacun mettables en pause (⏸) et reprenables (▶) individuellement.
- **✨ Tâche à la volée** : crée une tâche imprévue et démarre son chrono aussitôt — si tu avais mis ton travail **en pause** et que rien ne tournait depuis, le chrono remonte à la dernière pause pour ne rien perdre.
- Le bouton ▶️ sur une tâche (onglet 📋) lance le bon mode tout seul : rattaché si le gros chrono tourne, sinon minuteur.
- Le temps rattaché est reporté dans les stats **« Temps par tâche »**.

### Gamification
- **XP** : 1 XP par minute pointée + bonus XP des tâches terminées (par défaut +25)
- **Niveaux** : palier de `100 × (niveau−1)²` XP cumulés
- **Streak 🔥** : jours consécutifs où tu as pointé au moins le « seuil journée active » (par défaut 30 min, réglable)
- **Badges** : 14 badges (deep work 🧠, lève-tôt 🐓, oiseau de nuit 🦉, marathon 🏃, centurion 💯, …)

### 🔔 Notifications push (onglet Profil)

Active-les une fois par appareil via le bouton **🔔 Activer**, puis clique **🧪 Tester** pour vérifier.

Quand elles sont actives, le serveur t'envoie automatiquement :
- **⏰ Rappels de pointage multiples** — une liste d'heures (8 max) réglable dans l'onglet Profil ; à chaque rappel, un push part si tu ne pointes pas à ce moment-là
- **⏰ Rappel de longue session** — si le chrono tourne sans pause pendant la durée configurée (par défaut 240 min, réglable) : anti-oubli de pause
- **🎯 Objectif du jour atteint** — dès que tu passes ton quota
- **🎯 Objectif de la semaine atteint** — la première fois de la semaine ; chaque minute de plus ne rapporte plus d'argent et ira au 🏦 rattrapage
- **🌙 Journée clôturée** — récap des minutes pointées quand tu clôtures la journée
- **⏸ Résumé en pause** — minutes du jour + état du gros chrono quand tu mets en pause

> ⚠️ Les navigateurs n'autorisent le push que sur une **origine sécurisée** : `http://localhost` fonctionne directement. Depuis un téléphone en HTTP (IP local), le navigateur refusera la permission — passe par HTTPS (proxy type Caddy/Nginx avec certificat, ou exposition via ton serveur) pour que ça marche sur mobile. Sur **iOS**, il faut aussi que la PWA soit installée sur l'écran d'accueil (Safari ≥ 16.4).

## ⚙️ Configuration

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3000` | Port exposé |
| `DATA_DIR` | `/data` | Dossier de la base SQLite (persistée via le volume `./data`) |

Les données vivent dans `./data/pwointar.db` sur ta machine (montage bind). Sauvegarde = copier ce dossier.

## 🛠️ Stack

- **Backend** : Node.js 20 + Express + SQLite (better-sqlite3)
- **Frontend** : HTML/CSS/JS vanilla, zéro build — chargé instantanément, fonctionnel hors-ligne via service worker (l'interface est cachée ; les données nécessitent le serveur)
- **Docker** : image `node:20-slim`, données persistées dans `./data`

Pour arrêter : `docker compose down`. Pour mettre à jour : modifie le code puis `docker compose up -d --build`.

## 📁 Structure

```
Pwointar/
├── docker-compose.yml
├── Dockerfile
├── server.js          # API + logique gamification
├── public/
│   ├── index.html     # SPA mobile-first
│   ├── styles.css
│   ├── app.js
│   ├── manifest.webmanifest
│   ├── sw.js          # service worker (offline)
│   └── icon*.svg      # icônes PWA
└── data/              # base SQLite (auto-créée)
```