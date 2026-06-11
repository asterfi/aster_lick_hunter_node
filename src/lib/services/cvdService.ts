import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Config, CvdFilterConfig } from '../types';

interface AggTradeEvent {
  e: string;      // "aggTrade"
  E: number;      // event time
  s: string;      // symbol
  a: number;      // aggregate trade ID
  p: string;      // price
  q: string;      // quantity
  f: number;      // first trade ID
  l: number;      // last trade ID
  T: number;      // trade time
  m: boolean;     // true = buyer is maker (seller is taker), false = buyer is taker
}

interface CvdResult {
  allowed: boolean;
  reason: string;
  cvdRatio: number;
  buyVol: number;
  sellVol: number;
}

interface SymbolCvdState {
  config: CvdFilterConfig;
  buyVol: number;
  sellVol: number;
  tradeCount: number;
  candleStart: number;
  latestRatio: number;
}

export class CvdService extends EventEmitter {
  private ws: WebSocket | null = null;
  private isRunning = false;
  private symbolStates: Map<string, SymbolCvdState> = new Map();
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor() {
    super();
  }

  public start(config: Config): void {
    if (this.isRunning) return;

    const symbols: string[] = [];
    for (const [sym, symConfig] of Object.entries(config.symbols)) {
      if (symConfig.cvdFilter?.enabled) {
        this.symbolStates.set(sym, {
          config: symConfig.cvdFilter,
          buyVol: 0,
          sellVol: 0,
          tradeCount: 0,
          candleStart: Date.now(),
          latestRatio: 0,
        });
        symbols.push(sym.toLowerCase());
      }
    }

    if (symbols.length === 0) {
      console.log('CVD Service: No symbols with CVD filter enabled');
      return;
    }

    this.isRunning = true;

    const streams = symbols.map(s => `${s}@aggTrade`).join('/');
    const url = `wss://fstream.asterdex.com/stream?streams=${streams}`;
    console.log(`CVD Service: Connecting to ${symbols.length} aggTrade streams`);

    this.connect(url);
  }

  private connect(url: string): void {
    if (!this.isRunning) return;

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('CVD Service: WebSocket connected');
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.stream && message.data) {
          this.processTrade(message.data);
        }
      } catch (error) {
        console.error('CVD Service: Parse error:', error);
      }
    });

    this.ws.on('error', (error) => {
      console.error('CVD Service: WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('CVD Service: WebSocket closed');
      if (this.isRunning) {
        this.reconnectTimeout = setTimeout(() => this.connect(url), 5000);
      }
    });
  }

  private processTrade(trade: AggTradeEvent): void {
    if (trade.e !== 'aggTrade') return;

    const state = this.symbolStates.get(trade.s);
    if (!state) return;

    const now = Date.now();

    // Reset candle if duration elapsed
    if (now - state.candleStart >= state.config.candleDurationMs) {
      this.emit('candleClosed', {
        symbol: trade.s,
        cvdRatio: state.latestRatio,
        buyVol: state.buyVol,
        sellVol: state.sellVol,
      });
      state.buyVol = 0;
      state.sellVol = 0;
      state.tradeCount = 0;
      state.candleStart = now;
    }

    const qty = parseFloat(trade.q);
    // m = true means buyer is maker → seller is taker/aggressor → sell volume
    // m = false means buyer is taker/aggressor → buy volume
    if (trade.m) {
      state.sellVol += qty;
    } else {
      state.buyVol += qty;
    }
    state.tradeCount += 1;

    const totalVol = state.buyVol + state.sellVol;
    state.latestRatio = totalVol > 0 ? (state.buyVol - state.sellVol) / totalVol : 0;
  }

  /**
   * Check if a LONG entry (BUY on SELL liquidation) should be allowed.
   * If CVD is strongly negative, sellers dominating → trend is real, reject long.
   */
  public shouldAllowLong(symbol: string): CvdResult {
    const state = this.symbolStates.get(symbol);

    if (!state) {
      return { allowed: true, reason: 'CVD: no data (fail-open)', cvdRatio: 0, buyVol: 0, sellVol: 0 };
    }

    const { latestRatio, tradeCount, buyVol, sellVol } = state;
    const threshold = state.config.neutralThreshold;
    const minTrades = state.config.minTradeCount;

    if (tradeCount < minTrades) {
      return { allowed: true, reason: `CVD: insufficient trades (${tradeCount}/${minTrades})`, cvdRatio: latestRatio, buyVol, sellVol };
    }

    if (latestRatio < -threshold) {
      return { allowed: false, reason: `CVD: strong selling pressure (${(latestRatio * 100).toFixed(1)}%) — rejecting long`, cvdRatio: latestRatio, buyVol, sellVol };
    }

    return { allowed: true, reason: `CVD: no selling dominance (${(latestRatio * 100).toFixed(1)}%)`, cvdRatio: latestRatio, buyVol, sellVol };
  }

  /**
   * Check if a SHORT entry (SELL on BUY liquidation) should be allowed.
   * If CVD is strongly positive, buyers dominating → trend is real, reject short.
   */
  public shouldAllowShort(symbol: string): CvdResult {
    const state = this.symbolStates.get(symbol);

    if (!state) {
      return { allowed: true, reason: 'CVD: no data (fail-open)', cvdRatio: 0, buyVol: 0, sellVol: 0 };
    }

    const { latestRatio, tradeCount, buyVol, sellVol } = state;
    const threshold = state.config.neutralThreshold;
    const minTrades = state.config.minTradeCount;

    if (tradeCount < minTrades) {
      return { allowed: true, reason: `CVD: insufficient trades (${tradeCount}/${minTrades})`, cvdRatio: latestRatio, buyVol, sellVol };
    }

    if (latestRatio > threshold) {
      return { allowed: false, reason: `CVD: strong buying pressure (${(latestRatio * 100).toFixed(1)}%) — rejecting short`, cvdRatio: latestRatio, buyVol, sellVol };
    }

    return { allowed: true, reason: `CVD: no buying dominance (${(latestRatio * 100).toFixed(1)}%)`, cvdRatio: latestRatio, buyVol, sellVol };
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.symbolStates.clear();
  }

  public updateConfig(config: Config): void {
    this.stop();
    this.start(config);
  }
}

export const cvdService = new CvdService();
