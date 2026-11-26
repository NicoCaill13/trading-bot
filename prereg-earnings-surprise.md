# Pré-déclaration — surprise sur résultats (SUE, marche aléatoire saisonnière)

Écrit le 18 octobre 2026, avant tout calcul de rendement. Amendé le même jour après le contrôle des dates sur 20 tickers (aucun rendement vu). Statut : non exécuté.

## Prior (avant de regarder les données)

- Martineau (2022, Critical Finance Review) : depuis 2006, la surprise d'analystes ne prédit plus les rendements hors microcaps. Avec le SUE à marche aléatoire, hors microcaps, la dérive n'existe qu'avant 1990 ; pour les microcaps elle ne dépasse pas 5 jours.
- Étude de Columbia sur la persistance du SUE : le portefeuille long-short par décile de SUE est indistinguable de zéro après 2017.
- Conséquence : la probabilité d'un PASS est faible. L'étude sert à fermer la question à coût borné, pas à la confirmer.

## Hypothèse unique (seule comparaison qui décide)

H1 : parmi les événements de résultats de l'univers éligible (même pool que les autres études : bande de prix et volume en dollars de la veille de la config, produits dérivés exclus ; pas de float, non disponible à la date), ceux avec un SUE >= 2 ont un rendement net excédentaire positif à 5 séances, contre les événements de résultats éligibles de la même semaine ISO (séance de réaction) avec SUE < 2.

- SUE = variation du BPA dilué contre le même trimestre un an avant (à 20 jours près), divisée par l'écart-type des variations disponibles sur les 1 100 jours précédents (environ 12 trimestres), au moins 6 variations, écart-type non nul. Seuil fixe SUE >= 2, déclaré avant tout calcul (un décile utiliserait des événements futurs pour classer).
- Seuls les trimestres T1 à T3 (10-Q) comptent : le BPA du T4 se dérive du total annuel et ajoute du bruit. La série n'a donc pas de T4 : les variations viennent des T1 à T3.
- BPA : valeur XBRL du premier dépôt de la période, supposée identique à celle du communiqué. Un retraitement entre les deux est rare et non mesuré.
- Date de l'événement : horodatage d'acceptation du premier 8-K point 2.02 de la période (pas le 10-Q). Séance de réaction E : ce jour si accepté avant 16 h (New York) un jour de bourse, sinon la séance suivante. Entrée : ouverture de E+1. Sortie : clôture de E+5. Rendements ajustés des splits. Coût : 1 % aller-retour, hypothèse non mesurée.

## Critère PASS

- n >= 100 événements avec SUE >= 2.
- Borne basse de l'IC 95 % clusterisé par séance > 0 pour l'excès contre le baseline ET pour le rendement net absolu après 1 % de coût (compte cash, long seulement), sur les événements avant SEEN_FROM (2026-08-19), et même signe sur les événements vus. Le coût s'annule dans l'excès, comme dans l'étude multi-jours.
- Aucun autre critère. Les analyses suivantes sont rapportées, jamais décisives : H = 1, H = 3, et l'excès contre le pool entier de la séance (comme l'étude multi-jours). Essais comptés : 1 décisif et 3 exploratoires.

## Puissance

Effet minimal détectable calculé avant exécution (1,96 fois l'erreur standard des rendements à 5 jours du pool). S'il dépasse 1,5 point, l'étude est déclarée sous-puissante, donc non concluante.

## Limite connue du timing

Le BPA XBRL est publié avec le 10-Q, qui peut suivre le communiqué (8-K point 2.02). Contrôle sur 20 tickers (18 octobre 2026) : 99 événements avec 8-K, 31 % avec un écart de plus d'une séance, clause non déclenchée. 34 dépôts sur 133 (26 %) sans 8-K datable sont exclus de l'étude : biais de sélection reconnu. La clause est réappliquée sur l'univers complet : au-dessus de 50 %, l'étude est non concluante.

## Données et biais

EDGAR gratuit (BPA dilué, horodatage d'acceptation). Barres journalières ajustées via scripts/lib/barFetch.ts (Alpaca, clés du dépôt) : accord explicite demandé au lancement. Biais connus : univers actuel seulement (survivorship), coûts réels non mesurés, exclusion des dépôts sans 8-K datable.

## Plafond et suite

Plafond : 8 heures de travail. Au-delà sans résultat, arrêt.

PASS : suivi en avant 3 mois sans argent avant tout code live. Échec ou non concluant : piste fermée et notée dans spec.md section 9.
