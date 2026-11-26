import type { MarketRegimeStatus, SwingStudyReport, WeinsteinStage } from './types';

const STATUS_LABEL: Record<MarketRegimeStatus, string> = {
  CONFIRMED_UPTREND: 'tendance confirmée',
  UPTREND_UNDER_PRESSURE: 'tendance sous pression',
  CORRECTION: 'correction',
};

const STAGE_LABEL: Record<WeinsteinStage, string> = {
  STAGE_1: 'Phase 1 (base)',
  STAGE_2: 'Phase 2 (avancée)',
  STAGE_3: 'Phase 3 (sommet)',
  STAGE_4: 'Phase 4 (déclin)',
};

function money(value: number): string {
  return value.toFixed(2);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

/** French study sheet. No orders are implied; levels are a checklist. */
export function formatSwingReport(report: SwingStudyReport): string {
  const lines: string[] = [];
  lines.push(`# Radar swing — ${report.tradingDay}`);
  lines.push('');
  lines.push(`Généré le ${report.generatedAt}. Lecture seule : aucun ordre n'est transmis.`);
  lines.push('');
  lines.push('## Régime');
  lines.push('');
  lines.push(
    `Lecture combinée : **${STATUS_LABEL[report.combinedStatus]}**. ` +
    `Exposition indicative : **${report.recommendedExposurePct} %**. ` +
    'En correction le radar continue de lister les bases, à titre d\'observation.',
  );
  lines.push('');
  for (const regime of report.regimes) {
    const weeklyInfo = regime.weeklyStage
      ? `, Weekly ${STAGE_LABEL[regime.weeklyStage]} (SMA10W ${regime.sma10w ? money(regime.sma10w) : 'n/a'} / SMA30W ${regime.sma30w ? money(regime.sma30w) : 'n/a'})`
      : '';
    lines.push(
      `- ${regime.symbol} : ${STATUS_LABEL[regime.status]}, ` +
      `close ${money(regime.close)}, SMA50 ${money(regime.sma50)}, ` +
      `SMA200 ${money(regime.sma200)}, SMA50 ${regime.sma50Rising ? 'haussière' : 'non haussière'}, ` +
      `${regime.distributionDays} jour(s) de distribution${weeklyInfo}`,
    );
  }
  lines.push('');
  lines.push('## Entonnoir');
  lines.push('');
  const funnel = report.funnel;
  lines.push(`- Univers : ${funnel.universe}`);
  lines.push(`- Liquides : ${funnel.liquid}`);
  lines.push(`- ADR : ${funnel.adrPass}`);
  lines.push(`- Trend Template (Daily) : ${funnel.templatePass}`);
  lines.push(`- Phase 2 Weinstein (Weekly) : ${funnel.weeklyTrendPass}`);
  lines.push(`- Figures chartistes : ${funnel.chartSetups}`);
  lines.push(`- Episodic pivots candidats / retenus : ${funnel.episodicCandidates} / ${funnel.episodicPass}`);
  lines.push(`- Écartés car résistance Weekly trop proche (< 2R) : ${funnel.rejectedOverheadSupply}`);
  lines.push(`- Écartés car le stop dépasse 8 % : ${funnel.rejectedWideRisk}`);
  lines.push(`- Fiches publiées : ${funnel.published}`);
  lines.push('');
  lines.push('## Fiches');
  lines.push('');
  if (report.cards.length === 0) {
    lines.push('Aucune fiche aujourd\'hui.');
    return lines.join('\n');
  }

  report.cards.forEach((card, index) => {
    lines.push(`### ${index + 1}. ${card.symbol} — ${card.grade} (${card.masterScore}/100)`);
    lines.push('');
    lines.push(`[Graphique](${card.tradingViewUrl})`);
    lines.push('');
    lines.push(`${card.pattern} / ${card.state}. ${card.thesis}`);
    if (card.catalystHeadline) {
      lines.push(`Catalyseur : ${card.catalystHeadline}`);
    }
    lines.push('');
    lines.push(`- Clôture : ${money(card.close)}`);
    lines.push(`- Pivot : ${money(card.pivot)}`);
    lines.push(`- Stop : ${money(card.stop)} (risque ${pct(card.riskPct)})`);
    lines.push(`- Entrée de référence : ${money(card.entry)}`);
    lines.push(`- Objectif 2R : ${money(card.target2r)}`);
    lines.push(`- Objectif 3R : ${money(card.target3r)}`);
    lines.push(`- Taille indicative : ${card.referenceQty} titre(s)`);
    lines.push(`- RS : ${card.rsRating ?? 'n/a'}`);
    lines.push(`- ADR : ${card.adrPct.toFixed(2)} %`);
    lines.push(`- RVOL : ${card.rvol === null ? 'n/a' : card.rvol.toFixed(2) + 'x'}`);
    lines.push(
      `- Distance au plus haut 52 semaines : ` +
      `${card.distanceFromHigh52wPct === null ? 'n/a' : pct(card.distanceFromHigh52wPct)}`,
    );
    lines.push(
      `- Daily MM : EMA10 ${card.ema10 === null ? 'n/a' : money(card.ema10)}, ` +
      `EMA20 ${card.ema20 === null ? 'n/a' : money(card.ema20)}, ` +
      `SMA50 ${card.sma50 === null ? 'n/a' : money(card.sma50)}`,
    );
    const stageStr = card.weeklyStage ? STAGE_LABEL[card.weeklyStage] : 'n/a';
    const tightStr = card.tightWeeksCount >= 3 ? ` (${card.tightWeeksCount} semaines serrées)` : '';
    lines.push(
      `- Weekly Tendance : ${stageStr}${tightStr} — ` +
      `SMA10W ${card.sma10w === null ? 'n/a' : money(card.sma10w)}, ` +
      `SMA30W ${card.sma30w === null ? 'n/a' : money(card.sma30w)}, ` +
      `SMA40W ${card.sma40w === null ? 'n/a' : money(card.sma40w)}` +
      `${card.weeklyMaAligned ? ' [alignées]' : ''}`,
    );
    const resistanceStr = card.weeklyBlueSky
      ? 'Voie libre (Blue Sky)'
      : card.weeklyResistance !== null
        ? `${money(card.weeklyResistance)} (${card.roomToResistanceR !== null ? card.roomToResistanceR.toFixed(1) + 'R' : 'n/a'})`
        : 'n/a';
    lines.push(
      `- Weekly S/R : Support ${card.weeklySupport === null ? 'n/a' : money(card.weeklySupport)} | ` +
      `Résistance ${resistanceStr}`,
    );
    lines.push('');
  });

  return lines.join('\n');
}

export function formatSwingAlert(report: SwingStudyReport): string {
  const header =
    `${STATUS_LABEL[report.combinedStatus]} — exposition ${report.recommendedExposurePct} %\n` +
    `${report.cards.length} fiche(s)`;
  if (report.cards.length === 0) return header;

  const top = report.cards.slice(0, 8).map(card => {
    const sr = card.weeklyBlueSky
      ? 'BlueSky'
      : card.roomToResistanceR !== null
        ? `R:${card.roomToResistanceR.toFixed(1)}R`
        : 'W';
    return `${card.symbol} ${card.grade} ${card.pattern} [${sr}] pivot ${card.pivot.toFixed(2)} stop ${card.stop.toFixed(2)}`;
  });
  return `${header}\n${top.join('\n')}`;
}
