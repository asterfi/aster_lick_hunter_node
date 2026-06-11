# Kill Zone Signal Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 signal-quality filters (CVD Delta, Funding Rate, Cascade Detector) as binary gates in Hunter's `handleLiquidationEvent()` to eliminate false entries and convert cascades from enemy to opportunity.

**Architecture:** Three new singleton services following the existing VWAPStreamer pattern (EventEmitter + singleton export). Each is independently enabled per-symbol via SymbolConfig. Hunter wires them as fail-open gates before VWAP check. No changes to PositionManager, order placement, or UI.

**Tech Stack:** TypeScript, WebSocket (ws), axios, EventEmitter — same as existing codebase

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/lib/services/cvdService.ts` | **New** — Real-time CVD per symbol via aggTrade WebSocket |
| `src/lib/services/fundingService.ts` | **New** — Cached funding rate via REST |
| `src/lib/services/cascadeDetector.ts` | **New** — Cascade state machine extending thresholdMonitor data |
| `src/lib/types.ts` | **Edit** — Add `CvdFilterConfig`, `FundingFilterConfig`, `CascadeDetectorConfig` to `SymbolConfig` |
| `config.default.json` | **Edit** — Add filter config defaults |
| `src/lib/bot/hunter.ts` | **Edit** — Import and wire 3 filters into `handleLiquidationEvent()` |

---

### Task 1: Add Filter Config Types

**Files:**
- Modify: `src/lib/types.ts` (append to `SymbolConfig` interface)

- [ ] **Step 1: Add filter config interfaces to types.ts**

Add these three interfaces **before** the `SymbolConfig` interface, and add their optional properties to `SymbolConfig`:

```typescript
// CVD Filter configuration — real-time volume delta per symbol
export interface CvdFilterConfig {
  enabled: boolean;
  neutralThreshold: number;   // |ratio| below this is neutral (default 0.20)
  minTradeCount: number;      // minimum aggTrades in current candle to evaluate (default 10)
  candleDurationMs: number;   // reset CVD each candle period (default 60000)
}

// Funding Rate Filter configuration
export interface FundingFilterConfig {
  enabled: boolean;
  extremeThreshold: number;   // funding rate above/below this is extreme (default 0.0005 = 0.05%)
  cacheMs: number;            // how long to cache funding before re-fetch (default 60000)
}

// Cascade Detector configuration
export interface CascadeDetectorConfig {
  enabled: boolean;
  windowMs: number;              // cluster window in ms (default 60000)
  minClusterSize: number;        // minimum liquidations to call it a cascade (default 3)
  acceleratingThresholdMs: number; // inter-arrival below this = accelerating (default 5000)
  peakThresholdMs: number;       // inter-arrival below this = peak (default 2000)
  exhaustionMinMs: number;       // inter-arrival above this = exhausting (default 8000)
  oiCheckEnabled: boolean;       // check OI direction during cluster (default true)
}
```

Then add these optional properties to `SymbolConfig`:

```typescript
export interface SymbolConfig {
  // ... existing fields remain unchanged ...

  // Kill Zone signal stack filters
  cvdFilter?: CvdFilterConfig;
  fundingFilter?: FundingFilterConfig;
  cascadeDetector?: CascadeDetectorConfig;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No new type errors from the additions.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add CvdFilterConfig, FundingFilterConfig, CascadeDetectorConfig interfaces"
```

---

### Task 2: CVD Delta Service

**Files:**
- Create: `src/lib/services/cvdService.ts`

- [ ] **Step 1: Create cvdService.ts — CVD streamer class**

Create the file with complete implementation. The CVD service:
- Connects to `wss://fstream.asterdex.com/stream?streams=<symbol>@aggTrade` for each symbol with CVD filter enabled
- Accumulates buy volume (taker is buyer, m === true means seller is taker) and sell volume per candle
- Computes `cvdRatio = (buyVol - sellVol) / (buyVol + sellVol)` ranging from -1 (pure selling) to +1 (pure buying)
- Provides `shouldAllowLong(symbol)` and `shouldAllowShort(symbol)` methods returning `{ allowed: boolean; reason: string }`

```typescript
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
    // m = true means buyer is maker (seller is taker/aggressor)
    // Aggressor sells → sell volume
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
   * Long entry: we expect buying pressure. If CVD is strongly negative,
   * sellers are dominating — trend is real, don't fade it.
   */
  public shouldAllowLong(symbol: string): CvdResult {
    const state = this.symbolStates.get(symbol);

    // Fail-open: if no state, allow the trade
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
   * Short entry: we expect selling pressure. If CVD is strongly positive,
   * buyers are dominating — trend is real, don't fade it.
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors from cvdService.ts.

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/cvdService.ts
git commit -m "feat(cvd): add CVD delta service with aggTrade streaming"
```

---

### Task 3: Funding Rate Filter Service

**Files:**
- Create: `src/lib/services/fundingService.ts`

- [ ] **Step 1: Create fundingService.ts — cached funding fetcher**

```typescript
import { EventEmitter } from 'events';
import axios from 'axios';
import { Config, FundingFilterConfig } from '../types';

interface FundingResult {
  allowed: boolean;
  reason: string;
  fundingRate: number;
  symbol: string;
}

interface FundingCache {
  rate: number;
  timestamp: number;
  symbol: string;
}

const BASE_URL = 'https://fapi.asterdex.com';

export class FundingService extends EventEmitter {
  private cache: Map<string, FundingCache> = new Map();
  private configs: Map<string, FundingFilterConfig> = new Map();
  private isRunning = false;

  constructor() {
    super();
  }

  public start(config: Config): void {
    this.configs.clear();
    for (const [symbol, symConfig] of Object.entries(config.symbols)) {
      if (symConfig.fundingFilter?.enabled) {
        this.configs.set(symbol, symConfig.fundingFilter);
      }
    }

    if (this.configs.size === 0) {
      console.log('Funding Service: No symbols with funding filter enabled');
      return;
    }

    this.isRunning = true;
    console.log(`Funding Service: Monitoring ${this.configs.size} symbols`);

    // Prime the cache immediately
    this.prefetchAll();
  }

  private async prefetchAll(): Promise<void> {
    const symbols = Array.from(this.configs.keys());
    await Promise.allSettled(symbols.map(s => this.fetchFunding(s)));
  }

  private async fetchFunding(symbol: string): Promise<number | null> {
    try {
      const response = await axios.get(`${BASE_URL}/fapi/v1/premiumIndex`, {
        params: { symbol },
      });

      const fundingRate = parseFloat(response.data.lastFundingRate || '0');
      const timestamp = Date.now();

      this.cache.set(symbol, { rate: fundingRate, timestamp, symbol });
      return fundingRate;
    } catch (error) {
      console.error(`Funding Service: Failed to fetch funding for ${symbol}:`, error);
      return null;
    }
  }

  private async getFundingRate(symbol: string): Promise<FundingCache | null> {
    const config = this.configs.get(symbol);
    if (!config) return null;

    const cached = this.cache.get(symbol);
    const now = Date.now();

    // Return cached if fresh
    if (cached && (now - cached.timestamp) < config.cacheMs) {
      return cached;
    }

    // Fetch fresh
    const rate = await this.fetchFunding(symbol);
    if (rate !== null) {
      return this.cache.get(symbol) || null;
    }

    // If fetch failed but we have stale cache, use it (fail-soft — up to 5 min)
    if (cached && (now - cached.timestamp) < 300000) {
      console.log(`Funding Service: Using stale cache for ${symbol} (${Math.round((now - cached.timestamp) / 1000)}s old)`);
      return cached;
    }

    return null;
  }

  /**
   * Check LONG entry (we buy on SELL liquidation).
   *
   * If funding is very negative (shorts paying longs = shorts crowded):
   *   short liquidations are genuine unwinding → REJECT long entry
   *
   * If funding is very positive (longs paying shorts = longs crowded):
   *   long liquidations are capitulation → ALLOW (high conviction)
   */
  public async shouldAllowLong(symbol: string): Promise<FundingResult> {
    const config = this.configs.get(symbol);

    if (!config) {
      return { allowed: true, reason: 'Funding: not configured (fail-open)', fundingRate: 0, symbol };
    }

    const cached = await this.getFundingRate(symbol);

    if (!cached) {
      return { allowed: true, reason: 'Funding: unavailable (fail-open)', fundingRate: 0, symbol };
    }

    const { rate } = cached;
    const threshold = config.extremeThreshold;

    if (rate < -threshold) {
      return {
        allowed: false,
        reason: `Funding: extreme negative (${(rate * 100).toFixed(4)}%) — shorts crowded, rejecting long`,
        fundingRate: rate,
        symbol,
      };
    }

    const conviction = rate > threshold ? ' (high conviction — longs capitulating)' : '';
    return {
      allowed: true,
      reason: `Funding: ${rate >= -threshold ? 'neutral' : 'favorable'} ${(rate * 100).toFixed(4)}%${conviction}`,
      fundingRate: rate,
      symbol,
    };
  }

  /**
   * Check SHORT entry (we sell on BUY liquidation).
   *
   * If funding is very positive (longs pay shorts = longs crowded):
   *   long liquidations are genuine unwinding → REJECT short entry
   *
   * If funding is very negative (shorts pay longs = shorts crowded):
   *   short liquidations are capitulation → ALLOW (high conviction)
   */
  public async shouldAllowShort(symbol: string): Promise<FundingResult> {
    const config = this.configs.get(symbol);

    if (!config) {
      return { allowed: true, reason: 'Funding: not configured (fail-open)', fundingRate: 0, symbol };
    }

    const cached = await this.getFundingRate(symbol);

    if (!cached) {
      return { allowed: true, reason: 'Funding: unavailable (fail-open)', fundingRate: 0, symbol };
    }

    const { rate } = cached;
    const threshold = config.extremeThreshold;

    if (rate > threshold) {
      return {
        allowed: false,
        reason: `Funding: extreme positive (${(rate * 100).toFixed(4)}%) — longs crowded, rejecting short`,
        fundingRate: rate,
        symbol,
      };
    }

    const conviction = rate < -threshold ? ' (high conviction — shorts capitulating)' : '';
    return {
      allowed: true,
      reason: `Funding: ${rate <= threshold ? 'neutral' : 'favorable'} ${(rate * 100).toFixed(4)}%${conviction}`,
      fundingRate: rate,
      symbol,
    };
  }

  public stop(): void {
    this.isRunning = false;
    this.cache.clear();
    this.configs.clear();
  }
}

export const fundingService = new FundingService();
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors from fundingService.ts.

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/fundingService.ts
git commit -m "feat(funding): add funding rate filter service with caching"
```

---

### Task 4: Cascade Detector Service

**Files:**
- Create: `src/lib/services/cascadeDetector.ts`

- [ ] **Step 1: Create cascadeDetector.ts — cascade state machine**

```typescript
import { EventEmitter } from 'events';
import { LiquidationEvent, CascadeDetectorConfig } from '../types';

export type CascadeState = 'IDLE' | 'BUILDING' | 'ACCELERATING' | 'PEAK' | 'EXHAUSTING';

interface CascadeEntry {
  eventTime: number;
  side: 'BUY' | 'SELL';
  volumeUSDT: number;
}

export interface CascadeResult {
  shouldEnter: boolean;
  state: CascadeState;
  reason: string;
  clusterSize: number;
  avgInterArrivalMs: number;
}

interface SymbolCascadeState {
  config: CascadeDetectorConfig;
  entries: CascadeEntry[];
  state: CascadeState;
  lastStateChange: number;
}

export class CascadeDetector extends EventEmitter {
  private symbolStates: Map<string, SymbolCascadeState> = new Map();

  constructor() {
    super();
  }

  public start(): void {
    // No WebSocket needed — processes liquidation events fed in from Hunter
    console.log('Cascade Detector: Initialized');
  }

  public updateConfigs(configs: Map<string, CascadeDetectorConfig>): void {
    this.symbolStates.clear();
    for (const [symbol, cfg] of configs.entries()) {
      this.symbolStates.set(symbol, {
        config: cfg,
        entries: [],
        state: 'IDLE',
        lastStateChange: Date.now(),
      });
    }
  }

  /**
   * Feed a liquidation event into the cascade detector.
   * Called by Hunter.handleLiquidationEvent() BEFORE the trade decision.
   */
  public processLiquidation(liquidation: LiquidationEvent): CascadeResult {
    const state = this.symbolStates.get(liquidation.symbol);

    if (!state) {
      return {
        shouldEnter: true,
        state: 'IDLE',
        reason: 'Cascade: not monitored (pass-through)',
        clusterSize: 0,
        avgInterArrivalMs: 0,
      };
    }

    const now = Date.now();
    const cutoff = now - state.config.windowMs;

    // Purge old entries
    state.entries = state.entries.filter(e => e.eventTime > cutoff);

    // Add this event
    state.entries.push({
      eventTime: liquidation.eventTime,
      side: liquidation.side,
      volumeUSDT: liquidation.qty * liquidation.price,
    });

    // Compute state
    const clusterSize = state.entries.length;
    const newState = this.computeState(state);

    if (newState !== state.state) {
      const prevState = state.state;
      state.state = newState;
      state.lastStateChange = Date.now();

      this.emit('stateChange', {
        symbol: liquidation.symbol,
        fromState: prevState,
        toState: newState,
        clusterSize,
        timestamp: now,
      });
    }

    // Compute inter-arrival time
    const avgInterArrivalMs = this.computeAvgInterArrival(state);

    // Decision based on state
    switch (newState) {
      case 'IDLE':
      case 'BUILDING':
        return {
          shouldEnter: true,
          state: newState,
          reason: `Cascade: ${newState.toLowerCase()} (${clusterSize} events in window)`,
          clusterSize,
          avgInterArrivalMs,
        };

      case 'ACCELERATING':
      case 'PEAK':
        return {
          shouldEnter: false,
          state: newState,
          reason: `Cascade: ${newState.toLowerCase()} — waiting for exhaustion (${clusterSize} events, ${avgInterArrivalMs}ms avg)`,
          clusterSize,
          avgInterArrivalMs,
        };

      case 'EXHAUSTING':
        return {
          shouldEnter: true,
          state: newState,
          reason: `Cascade: EXHAUSTING — high-conviction entry (${clusterSize} events, slowing to ${avgInterArrivalMs}ms avg)`,
          clusterSize,
          avgInterArrivalMs,
        };

      default:
        return {
          shouldEnter: true,
          state: newState,
          reason: `Cascade: unknown state (pass-through)`,
          clusterSize,
          avgInterArrivalMs,
        };
    }
  }

  private computeState(state: SymbolCascadeState): CascadeState {
    const { entries, config } = state;
    const count = entries.length;

    if (count < config.minClusterSize) {
      return count === 0 ? 'IDLE' : 'BUILDING';
    }

    // Calculate inter-arrival trend
    const interArrivals: number[] = [];
    for (let i = 1; i < entries.length; i++) {
      interArrivals.push(entries[i].eventTime - entries[i - 1].eventTime);
    }

    const avgInterArrival = interArrivals.length > 0
      ? interArrivals.reduce((a, b) => a + b, 0) / interArrivals.length
      : Infinity;

    // Determine trend: compare first half vs second half inter-arrival times
    if (interArrivals.length >= 4) {
      const mid = Math.floor(interArrivals.length / 2);
      const firstHalf = interArrivals.slice(0, mid);
      const secondHalf = interArrivals.slice(mid);

      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      // If second half is slower (longer inter-arrival) → exhausting
      if (secondAvg > firstAvg * 1.3 && avgInterArrival > config.exhaustionMinMs) {
        return 'EXHAUSTING';
      }

      // If second half is faster (shorter inter-arrival) → accelerating
      if (secondAvg < firstAvg * 0.7 && avgInterArrival < config.acceleratingThresholdMs) {
        return 'ACCELERATING';
      }
    }

    // Fallback: classify by absolute inter-arrival time
    if (avgInterArrival < config.peakThresholdMs) {
      return 'PEAK';
    }
    if (avgInterArrival < config.acceleratingThresholdMs) {
      return 'ACCELERATING';
    }
    if (avgInterArrival > config.exhaustionMinMs) {
      return 'EXHAUSTING';
    }

    return 'ACCELERATING'; // default for active cluster
  }

  private computeAvgInterArrival(state: SymbolCascadeState): number {
    const { entries } = state;
    if (entries.length < 2) return 0;

    let total = 0;
    for (let i = 1; i < entries.length; i++) {
      total += entries[i].eventTime - entries[i - 1].eventTime;
    }
    return Math.round(total / (entries.length - 1));
  }

  public getState(symbol: string): CascadeState {
    return this.symbolStates.get(symbol)?.state || 'IDLE';
  }

  public stop(): void {
    this.symbolStates.clear();
  }
}

export const cascadeDetector = new CascadeDetector();
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors from cascadeDetector.ts.

- [ ] **Step 3: Commit**

```bash
git add src/lib/services/cascadeDetector.ts
git commit -m "feat(cascade): add cascade detector with state machine"
```

---

### Task 5: Wire Filters into Hunter

**Files:**
- Modify: `src/lib/bot/hunter.ts` (imports + `handleLiquidationEvent()`)

- [ ] **Step 1: Add imports at top of hunter.ts**

After line 13 (the `import { symbolPrecision }` line), add:

```typescript
import { cvdService } from '../services/cvdService';
import { fundingService } from '../services/fundingService';
import { cascadeDetector } from '../services/cascadeDetector';
```

- [ ] **Step 2: Add filter check in `handleLiquidationEvent()` — after cooldown check, before VWAP**

In the `handleLiquidationEvent()` method, find the section after the cooldown check (around line 570 where it calls `analyzeAndTrade`), and add the filter gates. Specifically, add the filter block right before the `await this.analyzeAndTrade(liquidation, symbolConfig, tradeSide)` call in both the threshold system branch and the instant trigger branch.

For the **instant trigger branch** (the `else` block starting around line 527), find this line:
```typescript
await this.analyzeAndTrade(liquidation, symbolConfig);
```

Replace with:
```typescript
// Kill Zone Filters — sequential gates before trade entry
const killZoneResult = await this.checkKillZoneFilters(liquidation, symbolConfig, tradeSide);
if (!killZoneResult.allowed) {
  logWithTimestamp(`Hunter: Kill Zone blocked — ${killZoneResult.reason}`);
  this.emit('tradeBlocked', {
    symbol: liquidation.symbol,
    side: tradeSide,
    reason: killZoneResult.reason,
    blockType: 'KILL_ZONE',
    details: killZoneResult,
  });
  return;
}

await this.analyzeAndTrade(liquidation, symbolConfig);
```

For the **threshold system branch** (around line 525), find:
```typescript
await this.analyzeAndTrade(liquidation, symbolConfig, tradeSide);
```

Replace with:
```typescript
const killZoneResult = await this.checkKillZoneFilters(liquidation, symbolConfig, tradeSide);
if (!killZoneResult.allowed) {
  logWithTimestamp(`Hunter: Kill Zone blocked — ${killZoneResult.reason}`);
  this.emit('tradeBlocked', {
    symbol: liquidation.symbol,
    side: tradeSide,
    reason: killZoneResult.reason,
    blockType: 'KILL_ZONE',
    details: killZoneResult,
  });
  return;
}

await this.analyzeAndTrade(liquidation, symbolConfig, tradeSide);
```

- [ ] **Step 3: Add `checkKillZoneFilters()` method to Hunter class**

Add this new private method anywhere in the Hunter class (e.g., right before `analyzeAndTrade`):

```typescript
/**
 * Kill Zone Signal Stack — runs CVD, Funding, and Cascade filters
 * as sequential binary gates before trade entry.
 *
 * All filters are fail-open: if a filter is disabled or data is unavailable,
 * it returns allowed=true so trades are never blocked by missing data.
 */
private async checkKillZoneFilters(
  liquidation: LiquidationEvent,
  symbolConfig: SymbolConfig,
  tradeSide: 'BUY' | 'SELL'
): Promise<{ allowed: boolean; reason: string; details?: any }> {
  const symbol = liquidation.symbol;

  // === CVD Filter ===
  if (symbolConfig.cvdFilter?.enabled) {
    const cvdResult = tradeSide === 'BUY'
      ? cvdService.shouldAllowLong(symbol)
      : cvdService.shouldAllowShort(symbol);

    if (!cvdResult.allowed) {
      return { allowed: false, reason: cvdResult.reason, details: { cvd: cvdResult } };
    }
    // Log passing filter for diagnostics
    logWithTimestamp(`Hunter: ✓ CVD Filter passed for ${symbol} ${tradeSide} — ${cvdResult.reason}`);
  }

  // === Funding Filter ===
  if (symbolConfig.fundingFilter?.enabled) {
    const fundingResult = tradeSide === 'BUY'
      ? await fundingService.shouldAllowLong(symbol)
      : await fundingService.shouldAllowShort(symbol);

    if (!fundingResult.allowed) {
      return { allowed: false, reason: fundingResult.reason, details: { funding: fundingResult } };
    }
    logWithTimestamp(`Hunter: ✓ Funding Filter passed for ${symbol} ${tradeSide} — ${fundingResult.reason}`);
  }

  // === Cascade Detector ===
  if (symbolConfig.cascadeDetector?.enabled) {
    const cascadeResult = cascadeDetector.processLiquidation(liquidation);

    if (!cascadeResult.shouldEnter) {
      return { allowed: false, reason: cascadeResult.reason, details: { cascade: cascadeResult } };
    }
    if (cascadeResult.state !== 'IDLE' && cascadeResult.state !== 'BUILDING') {
      logWithTimestamp(`Hunter: ✓ Cascade Detector: ${cascadeResult.reason}`);
    }
  }

  return { allowed: true, reason: 'All kill zone filters passed' };
}
```

- [ ] **Step 4: Add `updateConfig()` call for kill zone services**

In the Hunter's `updateConfig()` method (around line 77), add after the `thresholdMonitor.updateConfig(newConfig)` line:

```typescript
// Update kill zone signal services
cvdService.updateConfig(newConfig);
fundingService.updateConfig(newConfig);

// Update cascade detector configs
const cascadeConfigs = new Map<string, CascadeDetectorConfig>();
for (const [symbol, symConfig] of Object.entries(newConfig.symbols)) {
  if (symConfig.cascadeDetector?.enabled) {
    cascadeConfigs.set(symbol, symConfig.cascadeDetector);
  }
}
cascadeDetector.updateConfigs(cascadeConfigs);
```

To make this work, add the import for `CascadeDetectorConfig` near the top:
```typescript
import { Config, LiquidationEvent, SymbolConfig, CascadeDetectorConfig } from '../types';
```

- [ ] **Step 5: Start kill zone services in Hunter.start()**

In Hunter's `start()` method (around line 292, before the `// Initialize symbol precision manager` comment), add:

```typescript
// Start kill zone signal services
cvdService.start(this.config);
fundingService.start(this.config);

const cascadeConfigs = new Map<string, CascadeDetectorConfig>();
for (const [symbol, symConfig] of Object.entries(this.config.symbols)) {
  if (symConfig.cascadeDetector?.enabled) {
    cascadeConfigs.set(symbol, symConfig.cascadeDetector);
  }
}
cascadeDetector.start();
cascadeDetector.updateConfigs(cascadeConfigs);
```

- [ ] **Step 6: Stop kill zone services in Hunter.stop()**

In Hunter's `stop()` method (around line 322, after `this.stopPeriodicCleanup()`), add:

```typescript
// Stop kill zone signal services
cvdService.stop();
fundingService.stop();
cascadeDetector.stop();
```

- [ ] **Step 7: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors. If there are errors, fix them before committing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/bot/hunter.ts
git commit -m "feat(hunter): wire kill zone signal stack into liquidation handling"
```

---

### Task 6: Add Config Defaults

**Files:**
- Modify: `config.default.json` (add filter configs to the ASTERUSDT symbol block)

- [ ] **Step 1: Add filter config to config.default.json**

After the `"thresholdCooldown": 30000` line in the ASTERUSDT symbol, add:

```json
        "cvdFilter": {
          "enabled": true,
          "neutralThreshold": 0.20,
          "minTradeCount": 10,
          "candleDurationMs": 60000
        },
        "fundingFilter": {
          "enabled": true,
          "extremeThreshold": 0.0005,
          "cacheMs": 60000
        },
        "cascadeDetector": {
          "enabled": true,
          "windowMs": 60000,
          "minClusterSize": 3,
          "acceleratingThresholdMs": 5000,
          "peakThresholdMs": 2000,
          "exhaustionMinMs": 8000,
          "oiCheckEnabled": true
        }
```

- [ ] **Step 2: Commit**

```bash
git add config.default.json
git commit -m "feat(config): add kill zone filter defaults to config.default.json"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Full TypeScript check**

Run: `npx tsc --noEmit`
Expected: Zero errors.

- [ ] **Step 2: Run existing tests**

Run: `npm test`
Expected: All existing tests still pass. No regressions.

- [ ] **Step 3: Build check**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: final verification — all tests pass, build succeeds"
```

---

## Self-Review

**Spec coverage:**
- ✓ CVD Filter → Task 2 (cvdService.ts)
- ✓ Funding Filter → Task 3 (fundingService.ts)
- ✓ Cascade Detector → Task 4 (cascadeDetector.ts)
- ✓ Types → Task 1 (types.ts)
- ✓ Config defaults → Task 6 (config.default.json)
- ✓ Hunter integration → Task 5 (hunter.ts)
- ✓ Validation gates → Task 7 (tsc, tests, build)

**No placeholders:** All code is complete, all commands exact, all expected outputs specified.

**Type consistency:** `CvdFilterConfig`, `FundingFilterConfig`, `CascadeDetectorConfig` defined in Task 1, used consistently in Tasks 2-5. Methods `shouldAllowLong`/`shouldAllowShort` named consistently across services. `CascadeResult`/`CvdResult`/`FundingResult` interfaces have consistent shapes.
