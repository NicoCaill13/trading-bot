# Spécification Technique & Stratégie - Trading Bot V7 (Master Plan)

Ce document récapitule l'intégralité du cahier des charges stratégique, quantitatif, fonctionnel et probabiliste pour le bot de trading algorithmique V7.

## 1. Univers & Filtres Institutionnels de Liquidité (Screener)
* **Marchés :** Actions US (NASDAQ et NYSE).
* **Prix Unitaire :** Supérieur à $5.00 (exclusion des penny stocks).
* **Dollar Volume Quotidien :** Supérieur à $20,000,000 (Close * Volume).
* **Float (Actions en circulation) :** Compris entre 10,000,000 et 500,000,000 de titres.
* **Volume Pré-Market :** Supérieur à 300,000 actions échangées avant 09:30 EST.
* **Average Daily Range (ADR) :** Supérieur à 4.0% sur 14 jours.

## 2. Alignement Macro & Tendance de Fond (Phase 2 de Weinstein)
* **Moyennes Mobiles de Référence :** SMA 200 (tendance très long terme) et SMA 150 / 30-week (déclencheur officiel de la Phase 2 de Weinstein).
* **Pente (Slope) :** Pente de la SMA 150 passant de négative à neutre/positive sur une fenêtre de 8 semaines.
* **Condition de Prix :** Cours actuel supérieur à la SMA 150 et à la SMA 200.

## 3. Cartographie des Figures & Structures (Price Action)

### A. Patterns de Retournement (Sortie d'Accumulation / Phase 1)
* **Épaule-Tête-Épaule Inversé (ETEI) :** Séquence de 3 creux avec Tête plus basse et Épaule Droite formant un creux plus haut. Volume décroissant sur la tête et explosion (RVOL > 1.5) sur la cassure de la ligne de cou.
* **Double Bottom / Spring de Wyckoff :** Faux franchissement baissier d'un support suivi d'une réintégration violente à fort volume.

### B. Patterns de Continuation (Phase 2 Installée)
* **Drapeau Haussier (Bull Flag) :** Impulsion haussière forte suivie d'une consolidation descendante étroite avec assèchement net des volumes (Volume Dry-up).
* **Tasse avec Anse (Cup & Handle) :** Arrondissement en U suivi d'une anse ne retraçant pas plus de 10% à 15%.
* **Base Plate (Flat Base) :** Compression de volatilité (contraction ATR) sur 5 à 6 semaines en tendance haussière.

## 4. Moteur Tactique Intraday & Execution
* **Fenêtre Temporelle :** 10:00 EST à 11:30 EST.
* **Filtre de Régime Global :** Interdiction stricte d'acheter si le SPY est baissier sur l'unité de temps 5 minutes (`spy_trend_5m === 'bearish'`).
* **Setup VWAP Pullback :**
  * Test du VWAP avec une tolérance de 0.1%.
  * Assèchement obligatoire des volumes pendant le repli vers le VWAP.
  * Signal d'achat sur clôture d'une bougie verte 5m avec RVOL > 1.5.

## 5. Gestion du Risque, Sorties Dynamiques & Probabilités
* **Risque Unitaire :** Fixé strictement à 1% du capital total par trade.
* **Ratio Risque/Récompense Initial :** Minimum 1:2.
* **Trailing Stop ATR :** Activation si le PnL latent dépasse +1.5% (distance 2x ATR) pour capturer les extensions explosives.
* **Time-Stop & Hard Close :** Liquidation automatique si stagnation > 45m sans MFE positif, et liquidation totale forcée à 15:55 EST (aucun risque overnight).

La préservation du capital prime sur l'opportunité.
* **Risk per Trade :** Fixé à 1% de l'équité totale par défaut.
* **Calcul Algorithmique de la Taille de Position :**
$$ \text{Position Size} = \frac{\text{Total Equity} \times 0.01}{\text{Entry Price} - \text{Stop Loss Price}} $$
* **Objectif Initial :** Ratio Risque/Récompense (R/R) minimum de 1:2.
* **Trailing Stop ATR :** Dès qu'un trade atteint +1.5% de profitabilité (MFE), bascule sur un Stop Suiveur calculé à 2x l'ATR 5m courant pour chevaucher la tendance.
* **Time-Stop :** Fermeture automatique de la position si le prix stagne pendant 45 minutes consécutives sans afficher de PnL latent positif.
* **Hard Close :** Liquidation forcée de toutes les positions ouvertes à 15:55 EST. Aucun overnight.

## 6. Matrice d'Espérance Mathématique (E)
**Formule :** `E = (Win_Rate * Avg_Win) - (Loss_Rate * Avg_Loss)`

| Scénario | Taux de Réussite | Pertes / Trades | Espérance par Trade | Statut |
| :--- | :--- | :--- | :--- | :--- |
| **Seuil de Rentabilité** | 33.3% | 2 / 3 | 0.00R | Neutre |
| **Scénario Robustesse** | 60.0% | 2 / 5 | +0.80R | Rentabilité élevée |
| **Scénario Standard** | 71.4% | 2 / 7 | +1.14R | Croissance agressive |
| **Scénario Sniper** | 80.0% | 2 / 10 | +1.40R | Niveau Institutionnel |

## 7. Couche d'Intelligence Dynamique & Infrastructure (V8)
Cette section définit les briques de haute performance nécessaires à l'exécution institutionnelle en Swing Intraday.

### A. Analyse de la Profondeur (Level 2 & Order Book Imbalance)
* Le bot consomme un flux de données de Niveau 2 via WebSocket.
* Il calcule l'imbalance entre le Bid (ordres d'achat en attente) et le Ask (ordres de vente).
* Si le prix approche du VWAP et qu'un déséquilibre massif (mur d'achat) est détecté au Bid, le bot anticipe le rebond et utilise le flux Level 2 comme gâchette d'exécution ultra-rapide.

### B. Classification Machine Learning des Régimes de Marché
* Un modèle léger de Random Forest / XGBoost évalue chaque matin (09:15 EST) l'état du VIX, l'ADR du SPY et les volumes pré-market globaux.
* S'il prédit un régime "Choppy" (haché/volatile), le bot réduit de lui-même ses cibles de Take-Profit à un ratio de 1:1.5.
* **Volatility Scaling :** Si le VIX dépasse 25, le risque unitaire (Risk per Trade) est divisé par deux, passant de 1% à 0.5% d'équité.

### C. Architecture Microstructure & Latence
* Séparation totale de l'écoute des WebSockets et de la logique de décision.
* Implémentation d'une file d'attente (Message Queue) pour ingérer les ticks en asynchrone sans bloquer la logique du programme.
* Moteur de Replay Intégré (Backtest Tick-by-Tick) capable de lire ces mêmes messages asynchrones pour simuler le slippage au millième de seconde près en phase de test.

## 8. Playbook live — Gap Hold (Hyper-Growth Cash, sept. 2026)

Compte cash T+1, max 2 tickets, bande $5–$100. Opening Drive 2,5–5,5 % vs open est **éteint** (`GAP_HOLD_ENABLED=true`). VWAP Core off.

Objectif : chasser les noms qui **battent le marché le jour J**, pas un spray scanner d’extension d’open.

### A. Track `news_gap` (codé, live)
* Gap overnight `(open − prevClose) / prevClose` dans **[8 %, 55 %]**.
* Hold : last ≥ open après 09:35 EST, last > VWAP, low RTH n’a pas mangé l’open (−1 %).
* Headline bullish dans la lookback, **zéro** headline bearish (veto type TYRA : data + adverse events).
* Exemples de référence : CHPT +75 % (gap +33 % earnings), SIG +20 % (beat + raise), IRD +54 % (FDA / data).

### B. Track `continuation` (codé, live)
* Gap overnight dans **[0 %, 12 %]**.
* Veille verte ≥ +3 %, close dans le haut de la barre (loc ≥ 0,60), last > high veille.
* News optionnelle (thème / note, pas forcément un 8-K).
* Exemples : AEHR, SNDK — déjà en run, jour de continuation.

### C. Ce que le playbook A/B n’est pas
* Pas la bande Opening Drive 2,5–5,5 % vs open (IONQ / QBTS / RGTI).
* Pas les lottery < $5 ou gap > 55 % (MIMI).
* Pas SNOW à $369 (hors bande prix).

### D. Track `rth_runner` — à coder (leçon 10 sept. 2026)

**FUBO** et **STNE** ont battu le marché ce jour-là. Le bot ne les a pas tradés. Ce n’est pas un bug : ils sont hors A et hors B.

| Nom | Prev close | Open | Overnight | vs open (RTH) | vs veille | Print du matin |
|---|---|---|---|---|---|---|
| FUBO | $10,71 | $10,56 | **−1,4 %** | +7,5 % | +6,1 % | aucun |
| STNE | $9,82 | $9,72 | **−1,0 %** | +6,1 % | +5,0 % | aucun |

FUBO encore $10,64 à 09:45 ; le run part **10:15–10:40**. Open plat / rouge, puis grind RTH. Contrats A/B exigent un overnight ≥ 0 % (continuation) ou ≥ 8 % (news). Un gap down tue les deux.

**Contrat à figer (3ᵉ track) :**
* Overnight plat ou légèrement rouge (ex. **[−2 %, +8 %)** — sous le plancher news_gap).
* Après 09:40 EST : last vs open **ou** last vs prevClose ≥ **~5 %**, last > VWAP, hold au-dessus de l’open.
* Pas besoin d’un 8-K du matin (thème / flux de séance).
* Même moteur d’exécution / stop / 2 tickets que Gap Hold.

Tant que D n’est pas branché, un batteur de marché **sans gap overnight** (FUBO, STNE) restera invisible au ranker.

> **Statut D (oct. 2026) :** ne pas coder avant d’avoir un edge démontré (voir §9). Les études ci-dessous contredisent la sélection par gap / volatilité / news sur laquelle reposent A, B et D.

## 9. Résultats de recherche (oct. 2026) — thèses réfutées

Toutes les études sont reproductibles (`scripts/study*.ts`, libs dans `scripts/lib/`, tests dans `test/`). Méthode commune : règles déclarées avant calcul, split hors échantillon (`SEEN_FROM = 2026-08-19`), IC clusterisés par séance, comparaison à un pool de base, coût aller-retour 1 %. Critère PASS : n ≥ 30 et borne basse de l’IC clusterisé > 0 (et borne basse de l’excès vs pool > 0 en multi-jours).

| Famille | Étude | Verdict |
|---|---|---|
| Journal live (59 trades) | revue des trades | E_R −0,13R ; Gap Hold −0,065R ; $200 → $172 |
| Sélection pré-open intraday (cible +10 % / stop −3 %) | `studyEligibleMovers.ts` | 13 règles sur 13 échouent hors échantillon ; rendement brut ≈ 0 pour toute paire cible/stop |
| Direction par news (gate strict `assessStrictBullishCatalyst`) | `studyNewsDirection.ts` | 66 lignes sur 66 échouent ; l’effet change de signe entre moitiés |
| Dérive multi-jours après catalyseur (H = 1, 3, 5, 10 ; 750 séances) | `studyMultiDayDrift.ts` | 48 lignes sur 48 échouent ; événements ≤ pool |
| Momentum cross-section 12-1, rebalancement mensuel (59 mois, 1 330 à 1 944 noms liquides) | `studyMomentum.ts` | Aucun PASS. Décile net 0,3 % : +4,3 %/an contre +9,5 %/an pour SPY ; vs SPY −0,24 %/mois [−1,49 ; +1,01], vs pool +0,58 %/mois [−0,51 ; +1,67] |

### Enseignements à retenir
* Les features pré-open (gap, ATR, volume relatif, veille verte) sélectionnent la **volatilité**, pas la **direction** : taux de cible et taux de stop montent ensemble, l’espérance brute reste ≈ 0.
* Le coût de 1 % n’est pas la cause : brut ≈ 0 en intraday. Il suffit en revanche à rendre le pool négatif en multi-jours (brut +0,55 % à H10, net −0,45 %).
* Gap ≥ 8 % avec volume ≥ 3x : sous-performance vs pool à tous les horizons (H10 : −0,79 % si le gap tient, −1,57 % s’il faiblit). Pas exploitable en long seul sur compte cash.
* Seul candidat positif (gap 4–8 % & vol ≥ 3x, tenu, H3) : instable entre moitiés (−0,21 % puis +1,12 % d’excès), IC englobant 0, 16 comparaisons par segment. Non retenu.
* Limite de puissance : IC multi-jours de ±1 à 2 points ; un edge < ~1 % à H10 n’est pas exclu, un edge exploitable à H1 l’est.
* Biais connus : survivorship (favorise les positifs, donc renforce les négatifs), coûts réels non mesurés, univers actuel uniquement.

* Momentum : signature cohérente (décile haut > pool > décile bas dans les deux moitiés) mais non significative, et brut ≈ SPY (+0,91 %/mois contre +0,85 %) ; les coûts le font passer sous l’indice. Le pool équipondéré traîne SPY d’environ 6 points par an (indice porté par les méga-caps) : le stock picking dans cet univers part avec un handicap structurel.
* Puissance du test momentum : erreur standard ≈ 0,65 %/mois, donc un edge doit dépasser ≈ 1,8 %/mois pour être détecté. Sur 5 ans de données mensuelles, une surperformance de quelques points par an est invérifiable ; l’indice reste l’hypothèse par défaut qui domine.

### Règle de conduite
* Aucune nouvelle stratégie live (nouveau track, nouveau filtre de sélection) sans PASS préalable sur une étude pré-déclarée de ce type, et un PASS ne suffit pas : il faut ensuite un shadow en avant.
* Objectif réaliste du bot en l’état : suivre SPY au moindre coût, sans stock picking, tant qu’aucun edge n’est démontré. Toute ambition de surperformance se juge contre SPY (rendement et drawdown), pas contre zéro.
* Pistes non testées : information différente (surprise sur résultats, flux d’ordres, options). Les variantes du momentum testées après lecture des résultats comptent comme du data snooping.
