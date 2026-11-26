# Swing Study Radar

Lecture seule. Alpaca fournit les barres daily et les news. Le processus n'appelle pas `createOrder`.

## Univers

Actions US tradables, NYSE ou NASDAQ, hors ETF et hors symboles avec `.` ou `/`.

- Clôture ≥ `SWING_MIN_PRICE` (10 $).
- Dollar volume moyen sur 20 séances ≥ 20 M$.
- ADR 14 jours strictement supérieur à 4 %.
- La dernière barre daily doit être celle de la séance demandée.

## Force relative

Score pondéré `0,40 × rendement 63 séances + 0,20 × 126 + 0,20 × 189 + 0,20 × 252`. En dessous de 252 séances mais avec au moins 150, les jambes manquantes sont retirées et les poids restants sont renormalisés. Le centile cross-sectionnel va de 1 à 99 sur les noms liquides qui ont un score.

## Trend Template

Les huit conditions sont exigées ensemble, sur au moins 252 séances :

1. Clôture > SMA150 et clôture > SMA200.
2. SMA150 > SMA200.
3. SMA200 supérieure à sa valeur d'il y a 20 séances.
4. SMA50 > SMA150 et SMA50 > SMA200.
5. Clôture > SMA50.
6. Clôture ≥ 1,30 × plus bas 52 semaines.
7. Clôture ≥ 0,75 × plus haut 52 semaines.
8. Force relative ≥ 70.

## Figures

Priorité : VCP, tasse avec anse, drapeau Kullamägi, base plate, spring, ETEI. La première qui est encore au pivot gagne.

Une figure est `FORMING_AT_PIVOT` quand la clôture est à 5 % ou moins sous le pivot. Elle est `FRESH_BREAKOUT` quand la dernière barre franchit le pivot avec un volume relatif ≥ 1,5 et une extension ≤ 5 %. Toute clôture au-dessus du pivot sur une barre plus ancienne élimine la figure.

- **VCP.** Deux à cinq contractions, chacune ≤ 80 % de la précédente, la dernière ≤ 10 %, volume de la dernière contraction ≤ 70 % du volume des 50 séances d'avant.
- **Tasse avec anse.** 35 à 325 séances, profondeur 12 à 35 %, lèvres à moins de 8 %, anse dans la moitié haute, repli de l'anse ≤ 12 %, volume de l'anse ≤ 80 % du volume de la tasse.
- **Drapeau.** Impulsion ≥ 30 % en 40 séances ou moins, pause de 5 à 25 séances au-dessus de l'EMA20, creux non descendant, volume de pause ≤ 60 % du volume d'impulsion.
- **Episodic pivot.** Piste séparée, sans Trend Template. Gap d'ouverture ≥ 10 %, RVOL 50 séances ≥ 3, clôture dans les 35 % hauts de la barre, et `assessStrictBullishCatalyst` (au moins un titre haussier, aucun titre baissier).

Le risque `(entrée − stop) / entrée` doit rester ≤ 8 %. L'entrée est le pivot si la base n'a pas cassé, la clôture si la cassure est du jour.

## Régime

SPY et QQQ. Un jour de distribution est une baisse d'au moins 0,2 % sur un volume supérieur à la veille. Il sort du compte après 25 séances, ou dès que le cours a repris 5 % au-dessus de la clôture de ce jour-là.

- `CONFIRMED_UPTREND` : clôture > SMA50 > SMA200, SMA50 haussière, au plus 4 jours de distribution. Exposition indicative 100 %.
- `UPTREND_UNDER_PRESSURE` : le reste tant que le cours est au-dessus de la SMA200 et qu'il y a moins de 7 jours de distribution. Exposition 50 %.
- `CORRECTION` : clôture sous la SMA200, ou 7 jours de distribution ou plus. Exposition 0 %.

Le plus défensif des deux indices l'emporte. Le régime est affiché. Il ne retire pas les fiches.

## Score

Sur 100 : force relative 20, contraction et assèchement du volume Daily 20, structure Weekly (alignement MM + voie libre / S/R + semaines serrées) 20, position au pivot ou volume de cassure 15, proximité du plus haut 52 semaines 15, risque comparé à l'ADR 10. 80 et plus : A+. 65 à 79 : A. En dessous : B.

## Structure Weekly (1W)

Les séances daily ajustées des splits sont regroupées par semaine ISO (lundi–vendredi NY) sur ~300 séances (~75 semaines calendaires) :

- **Moyennes mobiles Weekly** : `SMA10W`, `SMA30W` (pente sur 4 semaines) et `SMA40W`.
- **Phases de Weinstein** : `STAGE_2` exigée sur la piste chartiste (`close > SMA30W` et `SMA30W` haussière) ; `close > SMA30W` exigée sur la piste episodic pivot.
- **Supports & Résistances Weekly** : pivots hebdomadaires sur 52 semaines fusionnés par zones (tolérance 2 %) avec principe de polarité. Si une résistance Weekly se situe au-dessus de l'entrée à moins de `2R` (`SWING_MIN_ROOM_TO_RESISTANCE_R`), la fiche est rejetée (`rejectedOverheadSupply`). Sans résistance au-dessus, la fiche est marquée `Blue Sky`.
- **Accumulation institutionnelle** : détection des clôtures hebdomadaires serrées (*3-Weeks Tight*, tolérance 1,5 %).

## Études déjà faites

Les scripts `scripts/study*.ts` restent la référence quantitative. Leurs conclusions négatives (momentum 12-1, dérive multi-jours, surprise de résultats, sélection pré-open) ne sont pas annulées par ce radar. Une fiche est une hypothèse à regarder, pas un signal validé hors échantillon.
