# Kill Zone Signal Stack + Cascade Filter — Design Spec

**Date:** 2026-06-11
**Status:** Approved
**Goal:** Layer 3 proven confirmation signals onto the existing contrarian liquidation strategy to increase win rate, reduce cascade losses, and produce positive expectancy with <$100 capital.

---

## 1. Problem Statement

The current strategy has exactly 3 gates before entering a trade:
1. Volume threshold (is the liquidation big enough?)
2. Price proximity (is the liquidation price close to mark?)
3. VWAP (is price on the favorable side of volume-weighted average?)

This is insufficient. The bot fades every qualifying liquidation regardless of market context. The biggest losses come from:
- **Trend continuation**: liquidation happens because of genuine directional pressure, fading it gets run over
- **Cascades**: sequential liquidations where the first one triggers an entry, then 10 more push price straight through the stop

Academic research (Unal 2024, Ali 2025) confirms liquidation cascades are: (a) the primary P&L killer, (b) predictable with basic features like inter-arrival time and open interest change.

---

## 2. Solution: 3-Layer Signal Stack

### Layer 1: CVD Delta Filter (`src/lib/services/cvdService.ts`)

**What it does:** Tracks real-time cumulative volume delta per symbol — buy volume minus sell volume over the current candle. Determines whether the liquidation direction aligns with or fights the dominant order flow.

**Data source:** `wss://fstream.asterdex.com/ws/<symbol>@aggTrade` — public WebSocket, no auth needed.

**Signal logic:**
```
If liquidation is SELL (longs liquidated, we want to BUY):
  - CVD is POSITIVE (buy pressure dominating) → reversal likely → ALLOW
  - CVD is NEUTRAL (±20% of total volume) → no conviction → ALLOW
  - CVD is NEGATIVE (sell pressure dominating) → trend is real → REJECT

If liquidation is BUY (shorts liquidated, we want to SELL):
  - CVD is NEGATIVE (sell pressure dominating) → reversal likely → ALLOW
  - CVD is NEUTRAL → no conviction → ALLOW
  - CVD is POSITIVE (buy pressure dominating) → trend is real → REJECT
```

**CVD calculation per candle:**
```
buyVol = sum of all aggTrade quantities where maker is buyer (m === false)
sellVol = sum of all aggTrade quantities where maker is seller (m === true)
CVD = buyVol - sellVol
totalVol = buyVol + sellVol
ratio = CVD / totalVol  // ranges from -1 (pure selling) to +1 (pure buying)
```

**Config interface:**
```typescript
interface CvdFilterConfig {
  enabled: boolean;
  neutralThreshold: number;  // default 0.20 — |ratio| < 0.20 is neutral
  minTradeCount: number;     // default 10 — need at least 10 trades in current candle
  candleDurationMs: number;  // default 60000 — reset CVD each minute
}
```

### Layer 2: Funding Rate Filter (`src/lib/services/fundingService.ts`)

**What it does:** Fetches current funding rate per symbol. Extreme funding means one side is crowded — liquidations on the crowded side are genuine position unwinding, not noise.

**Data source:** `GET /fapi/v1/premiumIndex?symbol=BTCUSDT` — REST, cached 60 seconds.

**Signal logic:**
```
If liquidation is SELL (longs liquidated, we want to BUY):
  - Funding < -0.05% (shorts paying longs, shorts crowded) → shorts getting wrecked is real → REJECT
  - Funding > +0.05% (longs paying shorts, longs crowded) → longs getting liquidated is capitulation → ALLOW (high conviction)
  - Funding between -0.05% and +0.05% → neutral → ALLOW

If liquidation is BUY (shorts liquidated, we want to SELL):
  - Funding > +0.05% (longs paying shorts) → longs getting wrecked is real → REJECT
  - Funding < -0.05% (shorts paying longs) → shorts getting liquidated is capitulation → ALLOW (high conviction)
  - Funding between -0.05% and +0.05% → neutral → ALLOW
```

**Config interface:**
```typescript
interface FundingFilterConfig {
  enabled: boolean;
  extremeThreshold: number;  // default 0.0005 (0.05%)
  cacheMs: number;           // default 60000
}
```

### Layer 3: Cascade Detector (`src/lib/services/cascadeDetector.ts`)

**What it does:** Extends the existing `thresholdMonitor` which already tracks rolling 60-second cumulative liquidation volume. Adds: inter-arrival timing, cluster counting, and acceleration detection. Determines whether we're at the start, middle, or exhaustion of a cascade.

**The cascade state machine:**
```
States: IDLE → BUILDING → ACCELERATING → PEAK → EXHAUSTING → IDLE

IDLE: No liquidations in window
BUILDING: 1-2 liquidations, inter-arrival > 5s
ACCELERATING: 3+ liquidations, inter-arrival decreasing (speeding up) → DO NOT ENTER
PEAK: Highest density, inter-arrival < 2s → DO NOT ENTER
EXHAUSTING: Liquidations slowing, inter-arrival increasing, OI dropping → ENTER HERE (this is the reversal zone)
```

**Features computed:**
```
- clusterCount: number of liquidations in current window
- avgInterArrivalMs: average time between liquidations
- interArrivalTrend: is inter-arrival decreasing or increasing? (simple: compare last 3 vs prior 3)
- oiDirection: is OI rising or falling during cluster? (from markPrice data — needs OI field)
```

**Signal logic:**
```
If cascade state is ACCELERATING or PEAK:
  → WAIT (do not enter, this is the danger zone)
  → Optionally: set a pending entry at exhaustion trigger price

If cascade state is EXHAUSTING:
  → ENTER (this is the highest-conviction entry)
  → Inter-arrival is slowing AND OI is dropping = forced positions are done

If cascade state is IDLE or BUILDING:
  → Use CVD + Funding filters only (no cascade gate, normal entry)
```

**Config interface:**
```typescript
interface CascadeDetectorConfig {
  enabled: boolean;
  windowMs: number;              // default 60000 — cluster window
  minClusterSize: number;        // default 3 — minimum liquidations to call it a cascade
  acceleratingThresholdMs: number; // default 5000 — inter-arrival below this = accelerating
  peakThresholdMs: number;       // default 2000 — inter-arrival below this = peak
  exhaustionMinMs: number;       // default 8000 — inter-arrival above this = exhausting
  oiCheckEnabled: boolean;       // default true
}
```

---

## 3. Signal Flow (Modified)

```
Liquidation Event
  │
  ├─ thresholdMonitor.processLiquidation()   [existing]
  ├─ cascadeDetector.processLiquidation()    [NEW]
  │
  └─ handleLiquidationEvent()
       │
       ├─ Volume threshold check             [existing]
       ├─ Price proximity check              [existing]
       ├─ Cooldown check                     [existing]
       │
       ├─ CVD Filter     → REJECT? return    [NEW]
       ├─ Funding Filter → REJECT? return    [NEW]
       ├─ Cascade Gate   → WAIT? return      [NEW]
       │                  → ENTER_AT_EXHAUSTION? set watch
       │
       ├─ VWAP Protection → REJECT? return   [existing]
       │
       └─ analyzeAndTrade()                  [existing]
```

Each filter is independently enabled/disabled per symbol in config, and each filter emits diagnostic events for the dashboard.

---

## 4. Files

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/services/cvdService.ts` | **New** | Real-time CVD streaming per symbol |
| `src/lib/services/fundingService.ts` | **New** | Cached funding rate fetcher |
| `src/lib/services/cascadeDetector.ts` | **New** | Cascade state machine |
| `src/lib/bot/hunter.ts` | **Edit** | Wire 3 filters into `handleLiquidationEvent()` |
| `src/lib/types.ts` | **Edit** | Add filter config interfaces |
| `config.default.json` | **Edit** | Filter configuration defaults |

**No changes to:** positionManager.ts, bot/index.ts, order placement, SL/TP logic, WebSocket server, or UI components. This is purely a signal-quality improvement at the entry gate.

---

## 5. Configuration Defaults

```json
{
  "symbols": {
    "BTCUSDT": {
      "...existing...": "...",
      "cvdFilter": { "enabled": true, "neutralThreshold": 0.20, "minTradeCount": 10, "candleDurationMs": 60000 },
      "fundingFilter": { "enabled": true, "extremeThreshold": 0.0005, "cacheMs": 60000 },
      "cascadeDetector": { "enabled": true, "windowMs": 60000, "minClusterSize": 3, "acceleratingThresholdMs": 5000, "peakThresholdMs": 2000, "exhaustionMinMs": 8000, "oiCheckEnabled": true }
    }
  }
}
```

---

## 6. Validation Gates (Before Live Trading)

1. **TypeScript check:** `npx tsc --noEmit` passes
2. **Turbo replay:** Replay stored liquidation DB through all 3 filters, compare filtered vs unfiltered win rate and profit factor
3. **Accelerated paper:** 1 day at 10x speed with filters enabled
4. **Live micro:** $10 positions, 50-trade minimum sample before scaling to full $100

---

## 7. Edge Cases

- **CVD service:** What if aggTrade WebSocket disconnects? Fall back to allowing the trade (fail-open — don't block trades due to missing data)
- **Funding cache:** What if REST call fails? Use last cached value up to 5 minutes old; if older, fail-open
- **Cascade detector:** What if OI data unavailable? Cascade detector works without OI check; OI is an additional confirmation, not required
- **All filters disabled:** Bot operates identically to current behavior (backward compatible)
- **Paper mode:** Mock CVD data needed for filter validation in paper mode
