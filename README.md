# Swing Study Radar

Radar de lecture seule sur les actions US. Il applique, après la clôture, les filtres de Weinstein, Minervini, O'Neil, Kullamägi et Wyckoff, puis écrit une fiche par setup encore actionnable. Aucun ordre n'est envoyé à Alpaca.

Ce n'est pas une preuve d'edge. Les études déjà dans `scripts/study*.ts` n'ont pas validé le momentum, la dérive post-catalyseur ni la surprise de résultats sur cet univers. Le radar sert à préparer une liste d'étude, pas à trader à ta place.

## Ce qu'il retient

Deux pistes, sur le même univers (NYSE et NASDAQ, hors ETF, prix ≥ 10 $, dollar volume moyen 20 séances ≥ 20 M$, ADR 14 jours > 4 %).

**Piste chartiste.** Le Trend Template Daily de Minervini doit passer (prix et empilement SMA50 / SMA150 / SMA200, SMA200 haussière, à plus de 30 % du plus bas 52 semaines, à moins de 25 % du plus haut, force relative ≥ 70), **confirmé en Weekly par une vraie Phase 2 de Weinstein** (`Close > SMA30W` avec `SMA30W` haussière). Ensuite une seule figure, dans cet ordre : VCP, tasse avec anse, drapeau de Kullamägi, base plate, spring de Wyckoff, épaule-tête-épaule inversée. La figure n'est gardée que si elle est au pivot (`FORMING_AT_PIVOT`, à moins de 5 % sous le pivot) ou si la cassure est celle de la séance (`FRESH_BREAKOUT`, volume relatif ≥ 1,5 et extension ≤ 5 %). Une cassure plus ancienne est écartée.

**Piste episodic pivot.** Gap d'ouverture ≥ 10 %, volume relatif 50 séances ≥ 3, clôture dans le haut de la bougie (et au-dessus de la `SMA30W` Weekly pour éviter les rebonds en Phase 4), validé par un titre de presse haussier sans titre baissier dans la fenêtre de news Alpaca.

**Supports & Résistances Weekly ("Overhead Supply").** Les bougies hebdomadaires sont reconstruites depuis les barres daily ajustées des splits (`SMA10W`, `SMA30W`, `SMA40W`, *3-Weeks Tight*, zones de pivots S/R sur 52 semaines). Tout setup qui bute sur une résistance Weekly à moins de `2R` au-dessus de l'entrée est écarté (`rejectedOverheadSupply`) ; l'absence de plafond hebdomadaire est signalée en **Voie libre (Blue Sky)**. Un stop structurel plus large que 8 % écarte également la fiche. La taille affichée est indicative : capital de référence × risque / (entrée − stop), plafonnée en notionnel. Le régime de SPY et QQQ (moyennes 50 et 200, jours de distribution) est écrit en tête du rapport et ne bloque pas la liste : en correction les fiches restent là, marquées « observation ».

## Lancer

```bash
npm install
cp .env.example .env
npm run scan
```

`npm run scan -- --date 2026-11-24` refait le rapport d'une séance passée. `npm start` attend chaque jour de bourse US **14:00 Europe/Paris** (avant l'ouverture de Wall Street), puis scanne la dernière séance déjà clôturée. Le watchdog (`npm run watchdog`) vérifie que le processus écrit encore son heartbeat et qu'un scan du jour calendaire de Paris existe après 14:20.

Sorties :

- `data/reports/YYYY-MM-DD-swing-study.md`
- `data/reports/YYYY-MM-DD-swing-study.json`
- `data/watchlist.json` (même contenu, pour le watchdog)

Chaque fiche a un lien TradingView, le pivot, le stop, le risque, les objectifs 2R et 3R, la force relative et, pour un episodic pivot, le titre de presse.

## Vérifier

```bash
npm test
npm run typecheck
npm run typecheck:all
```

## Layout

| Fichier | Rôle |
|---|---|
| `src/index.ts` | CLI `--once` / `--date`, ou boucle 14:00 Europe/Paris |
| `src/screener.ts` | Univers, barres daily, entonnoir, écriture du rapport |
| `src/marketRegime.ts` | Régime SPY / QQQ |
| `src/relativeStrength.ts` | Centile de force relative |
| `src/trendTemplate.ts` | Huit critères Daily de Minervini |
| `src/weeklyStructure.ts` | Agrégation 1W, Phase Weinstein, SMA10W/30W/40W, zones S/R Weekly |
| `src/patterns/` | VCP, tasse, drapeau, base, spring, ETEI, episodic pivot |
| `src/swingScoring.ts` | Note /100 et taille indicative |
| `src/reportFormatter.ts` | Markdown et alerte |
| `scripts/study*.ts` | Études déjà menées, inchangées dans leur conclusion |
