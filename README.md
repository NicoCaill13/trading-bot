# Trading Bot — Algorithmic Mid-Cap Momentum (TradFi)

Bot de trading algorithmique autonome pour actions US mid-cap, exécuté via l’**API Alpaca** (mode **Paper** par défaut, compte **cash** — fonds réglés uniquement).  
Stack : **TypeScript strict**, **Node.js ≥ 18** avec **tsx**, WebSocket temps réel, indicateurs **ATR** / **VWAP** (aucun RSI).

**V2 — Portefeuille Core / Satellite** : stratégie de continuation (V1) + catalyseurs pré-market « Play-Maker » (V2), avec budgets de risque et slots de positions séparés (80 % / 20 %).

---

## Sommaire

- [Architecture](#architecture)
- [Portefeuille Core / Satellite](#portefeuille-core--satellite)
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

Le code est découpé en **6 modules métier** + utilitaires :

| Module | Fichier | Rôle |
|--------|---------|------|
| **Config** | `src/config.ts` | Variables d’environnement, constantes, validation au démarrage (IIFE) |
| **Screener Core** | `src/screener.ts` | Univers dynamique Alpaca, filtres liquidité / momentum (V1), export watchlist Core |
| **Screener Satellite** | `src/premarket_screener.ts` | Scan pré-market (V2), Catalyst Score, export watchlist Satellite |
| **Trader** | `src/trader.ts` | File d’ordres, bracket orders, liquidations, trailing stops |
| **Risk Manager** | `src/riskManager.ts` | Sizing ATR par tier, scale-out, circuit breaker, sweeps EOD |
| **Orchestrateur** | `src/index.ts` | WebSocket, signaux VWAP / ORB, flush dual-bucket, persistance session |
| **File prioritaire** | `src/signalQueue.ts` | Files Satellite (haute priorité) / Core, enregistrement Play-Maker 09h15 |

Utilitaires : `alpacaClient.ts`, `logger.ts`, `notifier.ts`, `types.ts`, `utils.ts`.

---

## Portefeuille Core / Satellite

Deux buckets coexistent sur la même session (même WebSocket, même risk manager), avec **quotas et sizing indépendants**.

| Bucket | Source | Rôle | Risque par trade | Slots (défaut, `MAX_POSITIONS=5`) |
|--------|--------|------|------------------|-----------------------------------|
| **Core (80 %)** | `screener.ts` (V1) | Continuation momentum, force relative, gap tenu (UT1D) | `RISK_PER_TRADE_PCT × 0,80` → **0,8 %** equity | **4** |
| **Satellite (20 %)** | `premarket_screener.ts` (V2) | News plays, gap pré-market, catalyseurs du jour | `RISK_PER_TRADE_PCT × 0,20` → **0,2 %** equity | **1** |

- Les signaux sont classés et exécutés **par bucket** (pas de classement global Core vs Satellite).
- Un symbole présent dans les deux watchlists est traité en **Satellite** (priorité V2).
- Plafond nominal par position : `MAX_POSITION_PCT` réparti selon le tier (ex. 16 % Core / 4 % Satellite si base 20 %).
- **Plafond agrégé** : `getPortfolioAllocation(origin)` dans `riskManager.ts` — le capital **déployé** Satellite ne peut pas dépasser **20 %** de l’équité (idem 80 % pour Core).

---

## Prérequis

- **Node.js** ≥ 18 (ou **Bun** avec `bun run src/index.ts`)
- Compte **Alpaca** (Paper recommandé pour les tests)
- Clés API : [Alpaca Dashboard](https://app.alpaca.markets/) → API Keys
- Accès **SIP** recommandé pour le screener pré-market (bougies étendues 04h00–09h15) ; le flux intraday WebSocket reste sur **IEX**
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

### Risque et positions

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MAX_POSITIONS` | `5` | Nombre max de positions simultanées (tous buckets) |
| `MAX_POSITION_PCT` | `0.20` | Plafond nominal global (réparti par tier) |
| `RISK_PER_TRADE_PCT` | `0.01` | Risque de base par trade (1 %), avant part Core/Satellite |
| `CORE_RISK_SHARE` | `0.80` | Part du risque allouée au bucket Core |
| `SATELLITE_RISK_SHARE` | `0.20` | Part du risque allouée au bucket Satellite |
| `CORE_MAX_POSITIONS` | `0` | Slots Core (0 = auto : `floor(MAX_POSITIONS × 0,80)`) |
| `SATELLITE_MAX_POSITIONS` | `0` | Slots Satellite (0 = auto : reste) |
| `ATR_STOP_MULTIPLIER` | `1.5` | Multiplicateur ATR pour la distance de stop |
| `HARD_STOP_FLOOR_PCT` | `0.015` | Plancher stop-loss (-1,5 %) |
| `SCALE_OUT_TARGET_PCT` | `0.03` | Objectif scale-out (+3 %) |
| `TRAILING_STOP_PCT` | `0.015` | Trailing stop après scale-out (1,5 %) |
| `EOD_TIGHT_TRAIL_PCT` | `0.005` | Trailing serré en fin de séance (0,5 %) |
| `DAILY_PROFIT_TARGET_PCT` | `0.01` | Coupe-circuit journalier (+1 % PnL net) |

### Screener Core (V1)

| Variable | Défaut | Description |
|----------|--------|-------------|
| `MIN_RELATIVE_VOLUME` | `2.0` | Volume relatif min |
| `MIN_GAP_UP_PCT` | `0.02` | Gap up min (+2 %) |
| `WATCHLIST_MAX_SIZE` | `50` | Taille max watchlist Core |

Filtres fixes dans `config.ts` : prix min **10 $**, dollar volume min **50 M$**.

### Screener Satellite (V2)

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PREMARKET_MIN_GAP_UP_PCT` | `0.04` | Gap pré-market min (+4 %) |
| `PREMARKET_MIN_DOLLAR_VOLUME` | `2000000` | Dollar volume pré-market min (2 M$) |
| `PREMARKET_WATCHLIST_MAX_SIZE` | `10` | Top-N symboles Satellite |

### Entrée intraday

| Variable | Défaut | Description |
|----------|--------|-------------|
| `VOLUME_BREAKOUT_MULTIPLIER` | `1.5` | Conviction volume (VWAP et ORB) |
| `SIGNAL_BATCH_WINDOW_MS` | `10000` | Fenêtre debounce des signaux (10 s) |
| `ORB_WINDOW_BARS` | `1` | Bougies 5 min pour définir l’Opening Range (Satellite) |
| `ENTRY_LIMIT_OFFSET_PCT` | `0` | Prix limite d’achat = close × (1 + offset). `0` = au close ; négatif = en dessous |
| `TRADE_DURING_LUNCH` | `false` | Autoriser les entrées 12h–14h EST |

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

Au boot : charge `data/watchlist.json` (Core) + `data/watchlist_v2.json` (Satellite si présent), merge des symboles, connexion WebSocket.

### Screener Core seul (watchlist post-séance)

Génère ou régénère `./data/watchlist.json` sans lancer le trading intraday :

```bash
npm run screener
```

### Screener Satellite seul (pré-market)

Génère `./data/watchlist_v2.json` (gap + Catalyst Score). À lancer avant l’ouverture, ou laisser le cron **09h15** du bot s’en charger :

```bash
npm run premarket-screener
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

### 1. Screener Core — univers et watchlist (post-séance, ~20h00 EST)

Exécuté automatiquement si `data/watchlist.json` est absent, manuellement via `npm run screener`, ou au reset journalier **20h00**.

1. **Univers dynamique** : actifs US `active`, `tradable`, `marginable`.
2. **Pré-filtre liquidité** (snapshots) : clôture ≥ **10 $**, dollar volume ≥ **50 M$**.
3. **Analyse journalière** : force relative vs **SPY** (20 j), gap up ≥ **+2 %**, gap tenu, RVOL ≥ **2×**.
4. Tri par alpha, export des **50** meilleurs → `data/watchlist.json` (`source: core`).

---

### 2. Screener Satellite — catalyseurs pré-market (09h15 EST)

Exécuté automatiquement à **09h15** (après réconciliation broker) ou via `npm run premarket-screener`.

1. Même univers / pré-filtre liquidité que le Core.
2. **Snapshots** : gap instantané `(prix pré-market − clôture veille) / clôture veille` ≥ **+4 %**.
3. **Catalyst Score** : `gap × (DV pré-market / DV moyen 14j)`.
4. Filtre DV pré-market ≥ **2 M$** (bougies SIP 04h00–09h15).
5. Top **10** → `data/watchlist_v2.json` (`source: satellite`).

---

### 3. Entrée intraday — Core (VWAP) et Satellite (ORB + VWAP)

Surveillance en **barres 5 minutes** (WebSocket IEX). **Aucun RSI.**

#### Core — signal VWAP

| Condition | Règle |
|-----------|--------|
| Blackout matinal | Aucune entrée Core avant **09h45 EST** |
| Heures creuses | Par défaut, aucune entrée **12h00–14h00 EST** |
| Cassure VWAP | Bougie précédente ≤ VWAP **et** bougie courante > VWAP |
| Conviction volume | Volume > **1,5×** moyenne des **5** bougies précédentes |
| Debounce | File **10 s**, classement par Momentum Score dans le bucket Core |
| Slots | Jusqu’à **4** positions Core (défaut) |

#### Satellite — Opening Range Breakout (ORB)

| Condition | Règle |
|-----------|--------|
| Fenêtre ORB | **09h30–09h45 EST** : collecte du range sur `ORB_WINDOW_BARS` bougies |
| Breakout | `close > ORB high` + conviction volume → entrée **pendant le blackout** |
| Fallback | Après **09h45**, même logique **VWAP** que le Core si ORB non déclenché |
| Slots | **1** position Satellite max (défaut) |

#### Exécution commune

- **File prioritaire** (`signalQueue.ts`) : signaux Satellite dans une file haute priorité, Core dans une file séparée ; flush **Satellite d’abord**.
- **Flush dual-bucket** : quotas de slots indépendants par tier.
- **Entrée limit** : bracket **limit** (pas market) — plafond d’achat au prix signal (+ offset configurable).
- **Re-entry** : un symbole déjà entré dans la session n’est pas ré-entré (tier persisté).
- **Capital bucket** : `getPortfolioAllocation('satellite')` bloque une entrée si le Satellite a déjà 20 % d’équité engagés.

---

### 4. Gestion du risque — sizing et stops

**Position sizing (ATR, par tier)** :

```
stopDistance   = max(1,5 × ATR, 1,5 % du prix d'entrée)
riskBudget     = capital × RISK_PER_TRADE_PCT × (CORE_RISK_SHARE | SATELLITE_RISK_SHARE)
qty            = floor(riskBudget / stopDistance)
qty            = min(qty, floor(min(perTradeCap, bucketAvailable) / prix))
bucketAvailable = maxCapital(tier) - deployed(tier)   // 20 % ou 80 % equity
```

Exemple (défauts) : Core **0,8 %** equity à risque, Satellite **0,2 %**.

**Gestion active en position** :

| Événement | Action |
|-----------|--------|
| Profit **+3 %** | Vente **50 %** (scale-out), trailing **1,5 %** sur le reste |
| Circuit breaker **+1 %** PnL journalier net | Liquidation totale, **trading stoppé** (global, tous buckets) |
| **15h45 EST** — EOD Tight Choke | Perdantes / sous VWAP → liquidation ; gagnantes → trailing **0,5 %** |
| **15h58 EST** — Hard Close | Liquidation inconditionnelle |

À partir de **15h45**, plus de nouvelles entrées.

---

### 5. Résilience et réconciliation

- Au boot : `data/session_state.json` → symboles entrés avec **tier** (`core` | `satellite`).
- Format legacy (`string[]`) toujours accepté → tier `core` par défaut.
- Réconciliation broker : positions ouvertes + trailing stops (évite double scale-out).
- **09h15** : réconciliation + screener Satellite + abonnement WebSocket aux nouveaux symboles.
- Reset **20h00** : purge état, screener Core, reconnexion WebSocket.
- Rapport **16h05** : bilan PnL journalier.

---

## Calendrier de session (EST)

| Heure | Événement |
|-------|-----------|
| **09h15** | Réconciliation broker + screener Satellite + subscribe WS |
| **09h30** | Ouverture — blackout entrées **Core** ; fenêtre **ORB Satellite** |
| **09h45** | Fin blackout — signaux VWAP Core + fallback VWAP Satellite |
| **12h00–14h00** | Lunch filter (entrées off par défaut) |
| **15h45** | EOD sweep + blocage nouvelles entrées |
| **15h58** | Hard close — liquidation totale |
| **16h05** | Rapport journalier |
| **20h00** | Reset session + screener Core pour le lendemain |

Toutes les heures sont calculées en fuseau **America/New_York**.

---

## Fichiers de données

| Fichier | Description |
|---------|-------------|
| `data/watchlist.json` | Watchlist **Core** (V1) — symboles + métriques momentum |
| `data/watchlist_v2.json` | Watchlist **Satellite** (V2) — gap, Catalyst Score |
| `data/session_state.json` | Symboles entrés + tier (`core` / `satellite`) pour recovery crash |
| `logs/trading-YYYY-MM-DD.log` | Logs applicatifs rotatifs par jour |
| `logs/pm2-out.log` / `pm2-error.log` | Logs PM2 (si utilisé) |

---

## Observabilité

- **Console + fichier** : préfixes `[SYSTEM]`, `[SCREENER]`, `[PREMARKET_SCREENER]`, `[TRADER]`, `[RISK_MANAGER]`, `[NOTIFIER]`.
- **Discord** : variable `DISCORD_WEBHOOK_URL`
- **Telegram** : `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`

Alertes : démarrage (Core/Satellite counts), positions au redémarrage, circuit breaker, WebSocket irrécupérable, bilan journalier 16h05.

---

## Structure du projet

```
trading-bot/
├── src/
│   ├── index.ts              # Orchestrateur, WebSocket, VWAP / ORB, flush dual-bucket
│   ├── config.ts             # Configuration, portfolio Core/Satellite, validation
│   ├── screener.ts           # Screener Core (V1)
│   ├── premarket_screener.ts # Screener Satellite (V2) → signalQueue
│   ├── signalQueue.ts        # Files prioritaires Core / Satellite
│   ├── trader.ts             # Ordres & file d'attente
│   ├── riskManager.ts        # Risque par tier & EOD
│   ├── alpacaClient.ts       # Client Alpaca singleton
│   ├── logger.ts
│   ├── notifier.ts
│   ├── types.ts
│   ├── utils.ts
│   └── alpaca.d.ts           # Types SDK Alpaca
├── data/                     # Watchlists & état session
├── logs/                     # Logs applicatifs
├── .env.example
├── ecosystem.config.js       # PM2
├── tsconfig.json
└── package.json
```

---

## Avertissements

- Ce bot est conçu pour le **paper trading** ; vérifiez `ALPACA_BASE_URL` avant tout passage en live.
- Compte **cash** : seuls les fonds **réglés** (`cash`) sont utilisés pour le sizing — pas de marge ni d’effet de levier implicite.
- Le screener Satellite utilise le feed **SIP** pour les bougies pré-market ; sans abonnement données adapté, la watchlist V2 peut être vide.
- Le trading algorithmique comporte un **risque de perte en capital** ; les performances passées (backtest ou paper) ne garantissent rien.
- Respectez les **rate limits** Alpaca ; le bot intègre throttling et retry exponentiel sur les ordres.
- Ne commitez **jamais** le fichier `.env` (clés API et webhooks).

---

## Licence

Usage privé / interne — adapter selon la politique de votre organisation.
