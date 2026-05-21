export interface BarData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: string;
}

export interface SessionBarData {
  vwap: number;
  high: number;
  lastBarLow: number;
}

export interface PendingSignal {
  symbol: string;
  score: number;
  barData: BarData;
  vwap: number;
  avgVolume: number;
}

export interface WatchlistSymbol {
  symbol: string;
  relativeReturn: number;
  symbolReturn: number;
  gapUp: number;
  gapHeld: boolean;
  relativeVolume: number;
  dollarVolume: number;
  lastClose: number;
  lastOpen: number;
}

export interface Watchlist {
  generatedAt: string;
  benchmarkReturn: number | null;
  universeSize: number;
  liquidFiltered: number;
  symbols: WatchlistSymbol[];
}

export interface PositionSizeResult {
  qty: number;
  stopLossPrice: number;
  atr: number;
}

export interface DailyReportData {
  startEquity: number;
  endEquity: number;
  tradesEntered: number;
  circuitBreakerFired: boolean;
  symbols: string[];
}

export interface SessionState {
  date: string;
  enteredSymbols: string[];
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface WsBarMessage {
  T: 'b';
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
}

export interface WsSuccessMessage {
  T: 'success';
  msg: string;
}

export interface WsErrorMessage {
  T: 'error';
  code: number;
  msg: string;
}

export type WsMessage =
  | WsBarMessage
  | WsSuccessMessage
  | WsErrorMessage
  | { T: string };
