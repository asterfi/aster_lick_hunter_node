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

export interface SymbolConfig {
  // Volume thresholds
  volumeThresholdUSDT?: number;       // Legacy field for backward compatibility
  longVolumeThresholdUSDT?: number;   // Min liquidation volume to trigger long trades (buy on sell liquidations)
  shortVolumeThresholdUSDT?: number;  // Min liquidation volume to trigger short trades (sell on buy liquidations)

  // Position sizing
  tradeSize: number;                  // Base quantity for trades (adjusted by leverage)
  longTradeSize?: number;              // Optional: Specific margin in USDT for long positions
  shortTradeSize?: number;             // Optional: Specific margin in USDT for short positions
  maxPositionMarginUSDT?: number;     // Max margin exposure for this symbol (position size × leverage × price)

  // Risk parameters
  leverage: number;            // Leverage (1-125)
  tpPercent: number;           // Take profit as percentage (e.g., 5 for 5%)
  slPercent: number;           // Stop loss as percentage (e.g., 2 for 2%)

  // Limit order specific settings
  priceOffsetBps?: number;     // Price offset in basis points from best bid/ask (default: 1)
  usePostOnly?: boolean;       // Use post-only orders to guarantee maker fees (default: false)
  maxSlippageBps?: number;     // Maximum acceptable slippage in basis points (default: 50)
  orderType?: 'LIMIT' | 'MARKET'; // Order type preference (default: 'LIMIT')
  forceMarketEntry?: boolean;  // Force market orders for opening positions (default: false)

  // VWAP protection settings
  vwapProtection?: boolean;    // Enable VWAP-based entry filtering (default: false)
  vwapTimeframe?: string;      // Timeframe for VWAP calculation: 1m, 5m, 15m, 30m, 1h (default: '1m')
  vwapLookback?: number;       // Number of candles to use for VWAP calculation (default: 100)

  // Threshold system settings (60-second rolling window)
  useThreshold?: boolean;       // Enable threshold-based triggering for this symbol (default: false)
  thresholdTimeWindow?: number; // Time window in ms for volume accumulation (default: 60000)
  thresholdCooldown?: number;   // Cooldown period in ms between triggers (default: 30000)

  // Kill Zone signal stack filters
  cvdFilter?: CvdFilterConfig;
  fundingFilter?: FundingFilterConfig;
  cascadeDetector?: CascadeDetectorConfig;

  // Adaptive parameters (auto-calculated from market data)
  adaptiveParams?: {
    enabled: boolean;              // Master toggle — when true, service overrides static SL/TP/thresholds
    thresholdMultiplier?: number;  // Multiplier for avg1mVolume to calc threshold (default: 2.0)
    slATRMultiplier?: number;      // ATR multiplier for stop loss (default: 1.5)
    tpATRMultiplier?: number;      // ATR multiplier for take profit (default: 3.0)
    refreshIntervalMs?: number;    // How often to refresh (default: 300000 = 5 min)
  };
}

export interface ApiCredentials {
  apiKey?: string;          // V1: API Key from Aster Finance exchange
  secretKey?: string;       // V1: Secret Key from Aster Finance exchange
  walletAddress?: string;   // V3: Main account wallet address
  apiWalletAddress?: string; // V3: API wallet address (signer)
  apiWalletKey?: string;    // V3: API wallet private key (for EIP-712 signing)
}

export interface ServerConfig {
  dashboardPassword?: string;  // Optional password to protect the dashboard
  dashboardPort?: number;       // Port for the web UI (default: 3000)
  websocketPort?: number;       // Port for the WebSocket server (default: 8080)
  useRemoteWebSocket?: boolean; // Enable remote WebSocket access (default: false)
  websocketHost?: string | null; // Optional WebSocket host override (null for auto-detect)
}

export interface RateLimitConfig {
  maxRequestWeight?: number;  // Max request weight per minute (default: 2400)
  maxOrderCount?: number;      // Max orders per minute (default: 1200)
  reservePercent?: number;     // Percentage to reserve for critical operations (default: 30)
  enableBatching?: boolean;    // Enable order batching (default: true)
  queueTimeout?: number;       // Timeout for queued requests in ms (default: 30000)
  enableDeduplication?: boolean; // Enable request deduplication (default: true)
  deduplicationWindowMs?: number; // Time window for request deduplication in ms (default: 1000)
  parallelProcessing?: boolean; // Enable parallel processing of requests (default: false)
  maxConcurrentRequests?: number; // Maximum number of concurrent requests (default: 3)
}

export interface GlobalConfig {
  riskPercent: number;     // Max risk per trade as % of account balance
  paperMode: boolean;      // If true, simulate trades without executing
  positionMode?: 'ONE_WAY' | 'HEDGE'; // Position mode preference (optional)
  maxOpenPositions?: number; // Max number of open positions (hedged pairs count as one)
  useThresholdSystem?: boolean; // Enable 60-second rolling volume threshold system (default: false)
  server?: ServerConfig;    // Optional server configuration
  rateLimit?: RateLimitConfig; // Rate limit configuration
  autoCoins?: AutoCoinsConfig; // Auto-selected trading pairs configuration
}

export interface Config {
  api: ApiCredentials;
  symbols: Record<string, SymbolConfig>; // key: symbol like "BTCUSDT"
  global: GlobalConfig;
  version?: string; // Optional version field for config schema versioning
}

// API response types
export interface LiquidationEvent {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  quantity: number;
  price: number;
  averagePrice: number;
  orderStatus: string;
  orderLastFilledQuantity: number;
  orderFilledAccumulatedQuantity: number;
  orderTradeTime: number;
  eventTime: number;

  // Keep for backward compatibility
  qty: number;
  time: number;
}

export interface Order {
  symbol: string;
  orderId: string;
  clientOrderId?: string;
  side: 'BUY' | 'SELL';
  type: string;
  quantity: number;
  price: number;
  status: string;
  updateTime: number;
}

export interface Position {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  liquidationPrice?: number;
  leverage: number;
}

// Other types as needed
export interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface MarkPrice {
  symbol: string;
  markPrice: string;
  indexPrice: string;
};

// Adaptive parameters — returned by the adaptiveParamsService
export interface AdaptiveParams {
  symbol: string;
  recommendedSLPercent: number;
  recommendedTPPercent: number;
  recommendedLeverage: number;
  recommendedLongThreshold: number;
  recommendedShortThreshold: number;
  recommendedVWAPTimeframe: string;
  recommendedVWAPLookback: number;
  marketRegime: 'RANGING' | 'TRENDING' | 'STRONGLY_TRENDING';
  regimeConfidence: number; // 0-1
  atrPercent: number;
  avg1mVolume: number;
  winRate?: number;        // from performance tracking
  profitFactor?: number;   // from performance tracking
  riskAdjustment: number;  // 0.5-2.0 multiplier based on win rate + regime
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// AutoCoins — auto-selected trading pairs based on volume & volatility filters
// ---------------------------------------------------------------------------

export interface AutoCoinsConfig {
  enabled: boolean;
  minVolume24h: number;          // Minimum 24h USDT volume (default: 10_000_000)
  maxVolume24h?: number;         // Optional maximum 24h USDT volume
  volatilityEnabled: boolean;    // Enable volatility filtering
  volatilityTimeframe: string;   // '5m' | '15m' | '1h' (default: '5m')
  volatilityThreshold: number;   // Max % move per candle (default: 5)
  volatilityLength: number;      // Number of candles to check (default: 24)
  minPrice: number;              // Minimum price in USDT (default: 0.01)
  maxPrice?: number;             // Optional maximum price in USDT
  blacklistedSymbols: string[];  // Manually blacklisted symbols
  maxSymbols: number;            // Maximum symbols to select (default: 20)
}

export interface AutoCoinSymbol {
  symbol: string;
  price: number;
  volume24h: number;
  maxVolatility: number;   // max candle move % in the lookback period
  atrPercent: number;      // ATR(14) as % of price
  recommendedSL: number;
  recommendedTP: number;
  recommendedLeverage: number;
  recommendedThreshold: number;   // thresholdUSDT = volume24h / 1440 * 2
  recommendedTradeSize: number;   // margin in USDT (min $5, respects exchange min notional)
  blacklisted?: boolean;          // true if auto-blacklisted due to volatility
}
