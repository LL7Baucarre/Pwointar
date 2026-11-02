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
| ⏱️ **Pointeuse** | Gros bouton pointer/stop, timer géant, objectif du jour avec barre de progression, argent gagné en direct |
| 📋 **Tâches** | Ajouter des tâches avec estimation et bonus XP, les cocher pour gagner l'XP |
| 📊 **Stats** | Aujourd'hui / semaine / 30 jours / total, graphique des 14 derniers jours, répartition par heure, temps par tâche |
| 😀 **Profil** | Niveau, badges, réglages (taux horaire 💶, devise, objectif quotidien, seuil de streak), pointage manuel, historique |

### Gamification
- **XP** : 1 XP par minute pointée + bonus XP des tâches terminées (par défaut +25)
- **Niveaux** : palier de `100 × (niveau−1)²` XP cumulés
- **Streak 🔥** : jours consécutifs où tu as pointé au moins le « seuil journée active » (par défaut 30 min, réglable)
- **Badges** : 14 badges (deep work 🧠, lève-tôt 🐓, oiseau de nuit 🦉, marathon 🏃, centurion 💯, …)

### 🔔 Notifications push (onglet Profil)

Active-les une fois par appareil via le bouton **🔔 Activer**, puis clique **🧪 Tester** pour vérifier.

Quand elles sont actives, le serveur t'envoie automatiquement :
- **⏰ Rappel de stop** — si une session dépasse la durée configurée (par défaut 240 min, réglable) : anti-oubli de pointeuse
- **🎯 Objectif du jour atteint** — en pleine session, dès que tu passes ton quota
- **⏰ Rappel quotidien** — à l'heure configurée (par défaut 09:00) si tu n'as pas encore pointé
- **⏹️ Résumé à l'arrêt** — durée de la session + XP + argent gagnés à chaque stop

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