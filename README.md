# Trading Bot — Algorithmic Mid-Cap Momentum (TradFi)

Bot de trading algorithmique autonome pour actions US mid-cap, exécuté via l’**API Alpaca** (mode **Paper** par défaut, compte **cash** — fonds réglés uniquement).  
Stack : **TypeScript strict**, **Node.js ≥ 18** avec **tsx**, WebSocket temps réel, indicateurs **ATR** / **VWAP** (aucun RSI).

---

## Sommaire

- [Architecture](#architecture)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Configuration](#configuration)
- [Lancer le bot](#lancer-le-bot)
- [Règles de trading](#règles-de-trading)
- [Calendrier de session (EST)](#calendrier-de-session-est)
- [Fichiers de données](#fichiers-de-données)
- [Observabilité](#observabilité)
- [Structure du projet](#structure-du-projet)
- [Avertissements](#avertissements)

---

## Architecture

Le code est découpé en **5 modules métier** + utilitaires :

| Module | Fichier | Rôle |
|--------|---------|------|
| **Config** | `src/config.ts` | Variables d’environnement, constantes, validation au démarrage (IIFE) |
| **Screener** | `src/screener.ts` | Univers dynamique Alpaca, filtres liquidité / momentum, export watchlist |
| **Trader** | `src/trader.ts` | File d’ordres, bracket orders, liquidations, trailing stops |
| **Risk Manager** | `src/riskManager.ts` | Sizing ATR, scale-out, circuit breaker, sweeps EOD |
| **Orchestrateur** | `src/index.ts` | WebSocket, signaux VWAP, debounce 10 s, persistance session |

Utilitaires : `alpacaClient.ts`, `logger.ts`, `notifier.ts`, `types.ts`, `utils.ts`.

---

## Prérequis

- **Node.js** ≥ 18 (ou **Bun** avec `bun run src/index.ts`)
- Compte **Alpaca** (Paper recommandé pour les tests)
- Clés API : [Alpaca Dashboard](https://app.alpaca.markets/) → API Keys
- (Optionnel) **PM2** pour exécution 24/7 : `npm install -g pm2`
- (Optionnel) Webhook **Discord** et/ou bot **Telegram** pour les alertes

---

## Installation

```bash
git clone <votre-repo>
cd trading-bot
npm install
cp .env.example .env
# Éditer .env avec vos clés Alpaca (et webhooks si besoin)
```

Créer le dossier de données (créé automatiquement au premier run si absent) :

```bash
mkdir -p data logs
```

---

## Configuration

Copier `.env.example` vers `.env` et renseigner au minimum :

```env
ALPACA_KEY_ID=...
ALPACA_SECRET_KEY=...
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

Les paramètres de stratégie sont **optionnels** ; les valeurs par défaut sont définies dans `src/config.ts` et validées au démarrage.

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MAX_POSITIONS` | `5` | Nombre max de positions simultanées |
| `MAX_POSITION_PCT` | `0.20` | Plafond de taille nominale (20 % du capital) |
| `RISK_PER_TRADE_PCT` | `0.01` | Risque monétaire cible par trade (1 %) |
| `ATR_STOP_MULTIPLIER` | `1.5` | Multiplicateur ATR pour la distance de stop |
| `HARD_STOP_FLOOR_PCT` | `0.015` | Plancher stop-loss (-1,5 %) |
| `SCALE_OUT_TARGET_PCT` | `0.03` | Objectif scale-out (+3 %) |
| `TRAILING_STOP_PCT` | `0.015` | Trailing stop après scale-out (1,5 %) |
| `EOD_TIGHT_TRAIL_PCT` | `0.005` | Trailing serré en fin de séance (0,5 %) |
| `DAILY_PROFIT_TARGET_PCT` | `0.01` | Coupe-circuit journalier (+1 % PnL net) |
| `MIN_RELATIVE_VOLUME` | `2.0` | Volume relatif min (screener) |
| `MIN_GAP_UP_PCT` | `0.02` | Gap up min (+2 %) |
| `WATCHLIST_MAX_SIZE` | `50` | Taille max de la watchlist |
| `VOLUME_BREAKOUT_MULTIPLIER` | `1.5` | Conviction volume à l’entrée |
| `SIGNAL_BATCH_WINDOW_MS` | `10000` | Fenêtre debounce des signaux (10 s) |
| `TRADE_DURING_LUNCH` | `false` | Autoriser les entrées 12h–14h EST |

Filtres screener (dans `config.ts`, surcharge partielle via env si ajoutée) : prix min **10 $**, dollar volume min **50 M$**.

---

## Lancer le bot

### Démarrage manuel (développement / test)

```bash
npm start
```

Équivalent :

```bash
npx tsx src/index.ts
```

### Screener seul (watchlist post-séance)

Génère ou régénère `./data/watchlist.json` sans lancer le trading intraday :

```bash
npm run screener
```

### Production avec PM2

```bash
pm2 start ecosystem.config.js
pm2 logs trading-bot
pm2 status
```

Arrêt propre (sauvegarde de `session_state.json` avant exit) :

```bash
pm2 stop trading-bot
```

### Vérification TypeScript (sans exécuter)

```bash
npx tsc --noEmit
```

---

## Règles de trading

### 1. Screener — univers et watchlist (post-séance)

Exécuté automatiquement si `data/watchlist.json` est absent, ou manuellement via `npm run screener`.

1. **Univers dynamique** : tous les actifs US `active`, `tradable`, `marginable` (pas de liste codée en dur).
2. **Pré-filtre liquidité** (snapshots Alpaca) :
   - Prix de clôture ≥ **10 $** (exclut penny stocks)
   - Dollar volume (prix × volume) ≥ **50 M$**
3. **Analyse historique** (barres journalières) :
   - **Force relative** : surperformance vs **SPY** sur 20 jours
   - **Gap up** ≥ **+2 %** : `(Open − Close_veille) / Close_veille`
   - **Gap tenu** : clôture du jour > ouverture × (1 − tolérance 1 %)
   - **Volume relatif** ≥ **2,0×** la moyenne sur 10 jours
4. Tri par alpha décroissant, export des **50** meilleurs symboles dans `data/watchlist.json`.

---

### 2. Entrée intraday — signal VWAP + volume

Surveillance en **barres 5 minutes** (WebSocket IEX). **Aucun RSI.**

| Condition | Règle |
|-----------|--------|
| Blackout matinal | Aucune entrée avant **09h45 EST** (VWAP stabilisé) |
| Heures creuses | Par défaut, **aucune entrée 12h00–14h00 EST** (`TRADE_DURING_LUNCH=false`) |
| Cassure VWAP | Bougie précédente ≤ VWAP **et** bougie courante > VWAP |
| Conviction volume | Volume bougie > **1,5×** moyenne des **5** bougies précédentes |
| Re-entry | Un symbole déjà tradé dans la session n’est **pas** ré-entré |
| Debounce | Signaux mis en file **10 s**, classés par **Momentum Score** = `volume × écart % au VWAP` |
| Slots | Seuls les **meilleurs signaux** sont exécutés, jusqu’à **5** positions max |

Exécution : **bracket order** Alpaca (achat `stop_limit` + **stop-loss** attaché, distance calculée par le risk manager).

---

### 3. Gestion du risque — sizing et stops

**Position sizing (ATR)** :

```
stopDistance = max(1,5 × ATR, 1,5 % du prix d'entrée)
qty          = floor( (capital × 1 %) / stopDistance )
qty          = min(qty, floor(capital × 20 % / prix))   # plafond nominal
```

- Risque cible : **1 %** du capital par trade.
- Allocation max par position : **20 %** du capital.
- Stop-loss initial : prix d’entrée − `stopDistance`.

**Gestion active en position** :

| Événement | Action |
|-----------|--------|
| Profit **+3 %** | Vente **50 %** (scale-out), trailing stop **1,5 %** sur le reste |
| Circuit breaker **+1 %** PnL journalier net | Liquidation totale, annulation ordres, **trading stoppé** pour la journée |
| **15h45 EST** — EOD Tight Choke | Positions **sous VWAP** ou **en perte** → liquidation ; gagnantes au-dessus VWAP → trailing **0,5 %** |
| **15h58 EST** — Hard Close | Liquidation **inconditionnelle** de toutes les positions restantes |

À partir de **15h45**, plus de **nouvelles entrées** (`tradingHalted = true`).

---

### 4. Résilience et réconciliation

- Au boot : lecture de `data/session_state.json` (symboles déjà entrés aujourd’hui).
- Réconciliation broker : positions ouvertes + trailing stops actifs (évite double scale-out après crash).
- Arrêt propre (`SIGTERM` / `SIGINT`) : sauvegarde de l’état session.
- Reset journalier **16h05 EST** : rapport PnL, purge état, nouvelle baseline equity.

---

## Calendrier de session (EST)

| Heure | Événement |
|-------|-----------|
| 09h30 | Ouverture marché — blackout entrées |
| 09h45 | Fin blackout — signaux VWAP actifs |
| 12h00–14h00 | Lunch filter (entrées off par défaut) |
| 15h45 | EOD sweep + blocage nouvelles entrées |
| 15h58 | Hard close — liquidation totale |
| 16h05 | Rapport journalier + reset session |

Toutes les heures sont calculées en fuseau **America/New_York**.

---

## Fichiers de données

| Fichier | Description |
|---------|-------------|
| `data/watchlist.json` | Watchlist générée par le screener (symboles + métriques) |
| `data/session_state.json` | Symboles déjà entrés dans la session (recovery crash) |
| `logs/trading-YYYY-MM-DD.log` | Logs applicatifs rotatifs par jour |
| `logs/pm2-out.log` / `pm2-error.log` | Logs PM2 (si utilisé) |

---

## Observabilité

- **Console + fichier** : préfixes `[SYSTEM]`, `[SCREENER]`, `[TRADER]`, `[RISK_MANAGER]`, `[NOTIFIER]`.
- **Discord** : variable `DISCORD_WEBHOOK_URL`
- **Telegram** : `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`

Alertes : démarrage, positions au redémarrage, circuit breaker, WebSocket irrécupérable, bilan journalier 16h05.

---

## Structure du projet

```
trading-bot/
├── src/
│   ├── index.ts          # Orchestrateur & WebSocket
│   ├── config.ts         # Configuration & validation
│   ├── screener.ts       # Univers & watchlist
│   ├── trader.ts         # Ordres & file d'attente
│   ├── riskManager.ts    # Risque & EOD
│   ├── alpacaClient.ts   # Client Alpaca singleton
│   ├── logger.ts
│   ├── notifier.ts
│   ├── types.ts
│   ├── utils.ts
│   └── alpaca.d.ts       # Types SDK Alpaca
├── data/                 # Watchlist & état session
├── logs/                 # Logs applicatifs
├── .env.example
├── ecosystem.config.js   # PM2
├── tsconfig.json
└── package.json
```

---

## Avertissements

- Ce bot est conçu pour le **paper trading** ; vérifiez `ALPACA_BASE_URL` avant tout passage en live.
- Compte **cash** : seuls les fonds **réglés** (`cash`) sont utilisés pour le sizing — pas de marge ni d’effet de levier implicite.
- Le trading algorithmique comporte un **risque de perte en capital** ; les performances passées (backtest ou paper) ne garantissent rien.
- Respectez les **rate limits** Alpaca ; le bot intègre throttling et retry exponentiel sur les ordres.
- Ne commitez **jamais** le fichier `.env` (clés API et webhooks).

---

## Licence

Usage privé / interne — adapter selon la politique de votre organisation.
