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
