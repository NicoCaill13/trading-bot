/**
 * Offline replay CLI — injects fixture MarketDataEvent into the market-data bus.
 * No Alpaca / WebSocket. Full live strategy consumer wiring is a follow-up.
 *
 * Usage:
 *   npm run replay -- --fixture fixtures/replay/sample-session.jsonl
 *   npm run replay -- --fixture path.jsonl --trades journal.json --slippage-bps 5
 */
import path from 'path';
import fs from 'fs/promises';
import config from '../config';
import { createMarketDataBus } from '../marketDataBus';
import {
  formatExpectancyLine,
  normalizeTradeRecords,
} from '../expectancy';
import {
  loadReplayEvents,
  runReplay,
} from '../replayEngine';
import { createLogger } from '../logger';
import type { TradeRecord } from '../types';

const log = createLogger('REPLAY');

interface CliArgs {
  fixture: string;
  trades: string | null;
  slippageBps: number;
  fillDelayMs: number;
  seed: string;
}

function printHelp(): void {
  console.log(`Usage: npm run replay -- --fixture <path.jsonl> [options]

Options:
  --fixture <path>       Replay fixture (JSONL or JSON array of MarketDataEvent)
  --trades <path>        Optional closed TradeRecord[] JSON for E_R report
  --slippage-bps <n>     Adverse fill slippage in bps (default REPLAY_SLIPPAGE_BPS)
  --fill-delay-ms <n>    Delay before each publish (default REPLAY_FILL_DELAY_MS)
  --seed <s>             Documented seed (default REPLAY_SEED)
  --help                 Show this help
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    fixture: path.resolve('fixtures/replay/sample-session.jsonl'),
    trades: null,
    slippageBps: config.replay.slippageBps,
    fillDelayMs: config.replay.fillDelayMs,
    seed: config.replay.seed,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    }
    if (a === '--fixture') {
      args.fixture = path.resolve(argv[++i] ?? '');
      continue;
    }
    if (a === '--trades') {
      args.trades = path.resolve(argv[++i] ?? '');
      continue;
    }
    if (a === '--slippage-bps') {
      args.slippageBps = Number(argv[++i]);
      continue;
    }
    if (a === '--fill-delay-ms') {
      args.fillDelayMs = Number(argv[++i]);
      continue;
    }
    if (a === '--seed') {
      args.seed = argv[++i] ?? args.seed;
      continue;
    }
  }

  if (!Number.isFinite(args.slippageBps) || args.slippageBps < 0) {
    throw new Error('Invalid --slippage-bps');
  }
  if (!Number.isFinite(args.fillDelayMs) || args.fillDelayMs < 0) {
    throw new Error('Invalid --fill-delay-ms');
  }
  return args;
}

async function loadTrades(filePath: string): Promise<TradeRecord[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('--trades must be a JSON array of TradeRecord');
  }
  return normalizeTradeRecords(parsed as TradeRecord[]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const events = await loadReplayEvents(args.fixture);
  const trades = args.trades ? await loadTrades(args.trades) : undefined;

  const bus = createMarketDataBus({
    maxQueueSize: config.bus.maxQueueSize,
    dropPolicy: config.bus.dropPolicy,
  });

  const report = await runReplay({
    bus,
    events,
    trades,
    options: {
      slippageBps: args.slippageBps,
      fillDelayMs: args.fillDelayMs,
      seed: args.seed,
    },
  });

  const sample = report.simulatedFills.slice(0, 5).map(
    f => `${f.symbol}@${f.receivedAt}: ${f.rawClose} → ${f.fillPrice}`,
  );

  console.log(JSON.stringify({
    fixture: args.fixture,
    published: report.published,
    consumed: report.events.length,
    dropped: report.dropped,
    seed: report.seed,
    slippageBps: report.slippageBps,
    fillDelayMs: report.fillDelayMs,
    fills: report.simulatedFills.length,
    sampleFills: sample,
    expectancy: report.expectancy && report.expectancy.n > 0
      ? {
          n: report.expectancy.n,
          winRate: report.expectancy.winRate,
          eR: report.expectancy.eR,
          scenario: report.expectancy.scenario,
        }
      : null,
  }, null, 2));

  if (report.expectancy && report.expectancy.n > 0) {
    log.info(formatExpectancyLine('Replay trades', report.expectancy));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
