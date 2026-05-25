declare module '@alpacahq/alpaca-trade-api' {
  export interface AlpacaClientConfig {
    keyId: string;
    secretKey: string;
    baseUrl?: string;
    paper?: boolean;
  }

  export interface AlpacaAsset {
    symbol: string;
    tradable: boolean;
    marginable: boolean;
    status: string;
    class: string;
  }

  // Matches the real SDK AlpacaBar (PascalCase — entityv2.d.ts)
  export interface AlpacaBar {
    Symbol: string;
    OpenPrice: number;
    HighPrice: number;
    LowPrice: number;
    ClosePrice: number;
    Volume: number;
    Timestamp: string;
    VWAP: number;
    TradeCount: number;
  }

  // Matches the real SDK AlpacaSnapshot (PascalCase — entityv2.d.ts)
  // getSnapshots returns AlpacaSnapshot[] — Symbol field identifies the ticker
  export interface AlpacaLatestTrade {
    Price: number;
  }

  export interface AlpacaLatestQuote {
    AskPrice: number;
    BidPrice: number;
  }

  export interface AlpacaSnapshot {
    Symbol: string;
    DailyBar?: AlpacaBar;
    PrevDailyBar?: AlpacaBar;
    MinuteBar?: AlpacaBar;
    LatestTrade?: AlpacaLatestTrade;
    LatestQuote?: AlpacaLatestQuote;
  }

  export interface AlpacaPosition {
    symbol: string;
    qty: string;
    avg_entry_price: string;
    current_price: string;
    unrealized_pl: string;
  }

  export interface AlpacaOrder {
    id: string;
    symbol: string;
    type: string;
    side: string;
    qty: string;
    status: string;
    limit_price?: string;
    filled_avg_price?: string;
    order_class?: string;
    legs?: AlpacaOrder[];
  }

  export interface AlpacaAccount {
    cash: string;
    equity: string;
  }

  export interface AlpacaOrderParams {
    symbol: string;
    qty: string;
    side: string;
    type: string;
    time_in_force: string;
    stop_price?: string;
    limit_price?: string;
    trail_percent?: string;
    order_class?: string;
    stop_loss?: { stop_price: string };
    take_profit?: { limit_price: string };
  }

  export interface BarQueryParams {
    start?: string;
    end?: string;
    timeframe?: string;
    feed?: string;
    limit?: number;
    adjustment?: string;
  }

  export interface AlpacaCalendarDay {
    date: string;
    open: string;
    close: string;
  }

  export interface CalendarQueryParams {
    start?: string;
    end?: string;
  }

  export default class Alpaca {
    constructor(config: AlpacaClientConfig);
    getAssets(params: { status?: string; asset_class?: string }): Promise<AlpacaAsset[]>;
    // No second argument — SDK uses this.configuration (credentials) by default
    getSnapshots(symbols: string[]): Promise<AlpacaSnapshot[]>;
    getBarsV2(symbol: string, params: BarQueryParams): AsyncIterable<AlpacaBar>;
    getAccount(): Promise<AlpacaAccount>;
    getPositions(): Promise<AlpacaPosition[]>;
    getPosition(symbol: string): Promise<AlpacaPosition>;
    getOrders(params: {
      status?: string;
      limit?: number;
      nested?: boolean;
      symbols?: string;
    }): Promise<AlpacaOrder[]>;
    createOrder(params: AlpacaOrderParams): Promise<AlpacaOrder>;
    cancelOrder(orderId: string): Promise<void>;
    replaceOrder(orderId: string, params: Partial<AlpacaOrderParams>): Promise<AlpacaOrder>;
    getCalendar(params?: CalendarQueryParams): Promise<AlpacaCalendarDay[]>;
  }
}
