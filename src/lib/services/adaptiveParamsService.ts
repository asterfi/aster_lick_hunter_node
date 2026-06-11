/**
 * Adaptive Parameter Engine
 *
 * Dynamically calculates per-symbol trading parameters based on real-time
 * market data (ATR, volume, market regime) instead of relying on hardcoded
 * static values. Integrates with the existing config system and provides
 * recommendations that Hunter can use at trade time.
 *
 * @notExportedAsIndex The singleton `adaptiveParamsService` is the intended consumer.
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import { Config, SymbolConfig, AdaptiveParams, Kline } from '../types';
import { getKlines } from '../api/market';
import { logWithTimestamp, logErrorWithTimestamp } from '../utils/timestamp';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLD_MULTIPLIER = 2.0;
const DEFAULT_SL_ATR_MULTIPLIER = 1.5;
const DEFAULT_TP_ATR_MULTIPLIER = 3.0;
const DEFAULT_REFRESH_INTERVAL_MS = 300_000; // 5 minutes
const MIN_SL_PERCENT = 0.5;
const MIN_TP_PERCENT = 1.0;
const MIN_LEVERAGE = 1;
const MAX_LEVERAGE = 10;
const ATR_PERIOD = 14;
const TREND_LOOKBACK_CANDLES = 20;
const TREND_PRICE_CANDLES = 24; // 1h candles for regime detection
const MIN_WIN_RATE_FOR_FULL_SIZE = 0.35;
const PERFORMANCE_WINDOW = 20; // last N trades tracked
const REGIME_RANGING_THRESHOLD = 1.5;
const REGIME_TRENDING_THRESHOLD = 3.0;

const BASE_URL = 'https://fapi.asterdex.com';

// ---------------------------------------------------------------------------
// Types (internal)
// ---------------------------------------------------------------------------

interface PerformanceSnapshot {
  wins: number;
  losses: number;
  totalPnL: number;
  avgWin: number;
  avgLoss: number;
  trades: number[];
  lastUpdated: number;
}

interface Ticker24hr {
  symbol: string;
  quoteVolume: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AdaptiveParamsService extends EventEmitter {
  /** Per-symbol cached adaptive parameters */
  private paramsCache: Map<string, AdaptiveParams> = new Map();

  /** Per-symbol performance tracking */
  private performance: Map<string, PerformanceSnapshot> = new Map();

  /** Refresh interval handle */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether the service has been initialised */
  private initialised = false;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Initialise the service: perform an immediate refresh, then schedule
   * periodic refreshes for every symbol that has adaptiveParams.enabled.
   */
  public async init(config: Config): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;

    logWithTimestamp('[adaptiveParams] Initialising adaptive parameter engine...');
    await this.refreshAll(config);

    const intervalMs = this._resolveInterval(config);
    this.refreshTimer = setInterval(() => {
      this.refreshAll(config).catch((err) =>
        logErrorWithTimestamp('[adaptiveParams] Periodic refresh failed:', err),
      );
    }, intervalMs);

    logWithTimestamp(`[adaptiveParams] Engine initialised, refresh interval=${intervalMs}ms`);
  }

  /**
   * Stop the periodic refresh timer and release resources.
   */
  public destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.initialised = false;
    logWithTimestamp('[adaptiveParams] Engine stopped');
  }

  /**
   * Fetch fresh data for every enabled symbol and update the cache.
   * Emits 'paramsUpdated' with a map of symbol -> AdaptiveParams.
   */
  public async refreshAll(config: Config): Promise<Map<string, AdaptiveParams>> {
    const symbols = Object.entries(config.symbols).filter(
      ([_, sym]) => sym.adaptiveParams?.enabled,
    );

    if (symbols.length === 0) {
      return this.paramsCache;
    }

    const results = await Promise.allSettled(
      symbols.map(async ([symbol, symConfig]) => {
        const params = await this._calculateForSymbol(symbol, symConfig);
        if (params) {
          this.paramsCache.set(symbol, params);
        }
        return params;
      }),
    );

    // Log any failures
    for (const result of results) {
      if (result.status === 'rejected') {
        logErrorWithTimestamp('[adaptiveParams] Symbol refresh failed:', result.reason);
      }
    }

    this.emit('paramsUpdated', this.paramsCache);
    return this.paramsCache;
  }

  /**
   * Force a single-symbol refresh and return its parameters (or undefined if
   * the symbol is not enabled for adaptive params).
   */
  public async refreshSymbol(
    symbol: string,
    symConfig: SymbolConfig,
  ): Promise<AdaptiveParams | undefined> {
    if (!symConfig.adaptiveParams?.enabled) return undefined;

    const params = await this._calculateForSymbol(symbol, symConfig);
    if (params) {
      this.paramsCache.set(symbol, params);
      this.emit('paramsUpdated', this.paramsCache);
    }
    return params;
  }

  /**
   * Return cached adaptive parameters for a symbol (or undefined).
   */
  public getParams(symbol: string): AdaptiveParams | undefined {
    return this.paramsCache.get(symbol);
  }

  /**
   * Return all cached adaptive parameters.
   */
  public getAllParams(): Map<string, AdaptiveParams> {
    return new Map(this.paramsCache);
  }

  // -----------------------------------------------------------------------
  // Config integration — merge adaptive values into a SymbolConfig
  // -----------------------------------------------------------------------

  /**
   * Take a base SymbolConfig and overlay adaptive parameter recommendations
   * for the given symbol.  If adaptiveParams is not enabled, the original
   * config is returned unchanged.
   */
  public applyAdaptiveParams(symConfig: SymbolConfig, symbol: string): SymbolConfig {
    if (!symConfig.adaptiveParams?.enabled) return symConfig;

    const ad = this.paramsCache.get(symbol);
    if (!ad) return symConfig;

    const merged: SymbolConfig = {
      ...symConfig,
      slPercent: ad.recommendedSLPercent,
      tpPercent: ad.recommendedTPPercent,
      leverage: ad.recommendedLeverage,
      longVolumeThresholdUSDT: ad.recommendedLongThreshold,
      shortVolumeThresholdUSDT: ad.recommendedShortThreshold,
      vwapTimeframe: ad.recommendedVWAPTimeframe,
      vwapLookback: ad.recommendedVWAPLookback,
    };

    return merged;
  }

  // -----------------------------------------------------------------------
  // Performance tracking
  // -----------------------------------------------------------------------

  /**
   * Record a realised trade PnL for a symbol.  Positive = win, negative = loss.
   */
  public recordTrade(symbol: string, pnl: number): void {
    let perf = this.performance.get(symbol);
    if (!perf) {
      perf = {
        wins: 0,
        losses: 0,
        totalPnL: 0,
        avgWin: 0,
        avgLoss: 0,
        trades: [],
        lastUpdated: Date.now(),
      };
      this.performance.set(symbol, perf);
    }

    // Keep a sliding window of the last 20 trade PnLs
    perf.trades.push(pnl);
    if (perf.trades.length > PERFORMANCE_WINDOW) {
      perf.trades.shift();
    }

    // Recalculate aggregates
    const wins = perf.trades.filter((t) => t > 0);
    const losses = perf.trades.filter((t) => t <= 0);

    perf.wins = wins.length;
    perf.losses = losses.length;
    perf.totalPnL = perf.trades.reduce((sum, t) => sum + t, 0);
    perf.avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t, 0) / wins.length : 0;
    perf.avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t, 0) / losses.length : 0;
    perf.lastUpdated = Date.now();

    // Update the cached params with the new win rate / profit factor
    const cached = this.paramsCache.get(symbol);
    if (cached) {
      cached.winRate = this.getWinRate(symbol);
      cached.profitFactor = this.getProfitFactor(symbol);
      cached.riskAdjustment = this._calcRiskAdjustment(symbol, cached);
      cached.lastUpdated = Date.now();
      this.paramsCache.set(symbol, cached);
      this.emit('paramsUpdated', this.paramsCache);
    }

    logWithTimestamp(
      `[adaptiveParams] Trade recorded: ${symbol} PnL=${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ` +
        `(${perf.wins}W/${perf.losses}L, winRate=${this.getWinRate(symbol).toFixed(2)})`,
    );
  }

  /**
   * Win rate over tracked trades for a symbol (0-1). Returns 0 if no data.
   */
  public getWinRate(symbol: string): number {
    const perf = this.performance.get(symbol);
    if (!perf || perf.trades.length === 0) return 0;
    return perf.wins / perf.trades.length;
  }

  /**
   * Profit factor (gross wins / gross losses) for a symbol.
   * Returns 1.0 if no losing trades, 0 if no data.
   */
  public getProfitFactor(symbol: string): number {
    const perf = this.performance.get(symbol);
    if (!perf || perf.trades.length === 0) return 1.0;

    const grossWin = perf.trades.filter((t) => t > 0).reduce((s, t) => s + t, 0) || 0;
    const grossLoss = Math.abs(perf.trades.filter((t) => t < 0).reduce((s, t) => s + t, 0)) || 0;

    return grossLoss === 0 ? 1.0 : grossWin / grossLoss;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Calculate adaptive parameters for a single symbol.  Falls back to cached
   * values (or static defaults) on any fetch error.
   */
  private async _calculateForSymbol(
    symbol: string,
    symConfig: SymbolConfig,
  ): Promise<AdaptiveParams | undefined> {
    if (!symConfig.adaptiveParams?.enabled) return undefined;

    const adaptCfg = symConfig.adaptiveParams;
    const slMult = adaptCfg.slATRMultiplier ?? DEFAULT_SL_ATR_MULTIPLIER;
    const tpMult = adaptCfg.tpATRMultiplier ?? DEFAULT_TP_ATR_MULTIPLIER;
    const threshMult = adaptCfg.thresholdMultiplier ?? DEFAULT_THRESHOLD_MULTIPLIER;

    try {
      // --- 1. ATR Calculation (1m klines) ---
      const klines1m = await getKlines(symbol, '1m', ATR_PERIOD + 5);
      const { atr, atrPercent, currentPrice } = this._calcATR(klines1m, ATR_PERIOD);

      // --- 2. 24h Volume ---
      const ticker = await this._fetch24hrTicker(symbol);
      const quoteVolume = ticker ? parseFloat(ticker.quoteVolume) : 0;
      const avg1mVolume = quoteVolume > 0 ? quoteVolume / 1440 : 0;

      // --- 3. Market Regime (1h candles) ---
      const klines1h = await getKlines(symbol, '1h', TREND_PRICE_CANDLES);
      const { regime, regimeConfidence } = this._detectRegime(klines1h);

      // --- 4. Build recommendations ---
      const recommendedSLPercent = Math.max(atrPercent * slMult, MIN_SL_PERCENT);
      const recommendedTPPercent = Math.max(atrPercent * tpMult, MIN_TP_PERCENT);
      const recommendedLeverage = Math.max(
        MIN_LEVERAGE,
        Math.min(Math.floor(2 / atrPercent), MAX_LEVERAGE),
      );
      const recommendedLongThreshold = avg1mVolume * threshMult;
      const recommendedShortThreshold = avg1mVolume * threshMult;

      // 5. VWAP param recommendations based on volatility
      const { recommendedVWAPTimeframe, recommendedVWAPLookback } =
        this._recommendVWAPParams(atrPercent);

      // 6. Performance overlay
      const winRate = this.getWinRate(symbol);
      const profitFactor = this.getProfitFactor(symbol);

      // 7. Risk adjustment
      const riskAdjustment = this._calcRiskAdjustment(symbol, {
        marketRegime: regime,
        winRate,
        recommendedSLPercent,
      } as AdaptiveParams);

      const params: AdaptiveParams = {
        symbol,
        recommendedSLPercent: parseFloat(recommendedSLPercent.toFixed(2)),
        recommendedTPPercent: parseFloat(recommendedTPPercent.toFixed(2)),
        recommendedLeverage,
        recommendedLongThreshold: parseFloat(recommendedLongThreshold.toFixed(2)),
        recommendedShortThreshold: parseFloat(recommendedShortThreshold.toFixed(2)),
        recommendedVWAPTimeframe,
        recommendedVWAPLookback,
        marketRegime: regime,
        regimeConfidence: parseFloat(regimeConfidence.toFixed(2)),
        atrPercent: parseFloat(atrPercent.toFixed(4)),
        avg1mVolume: parseFloat(avg1mVolume.toFixed(2)),
        winRate: parseFloat(winRate.toFixed(4)),
        profitFactor: parseFloat(profitFactor.toFixed(2)),
        riskAdjustment: parseFloat(riskAdjustment.toFixed(2)),
        lastUpdated: Date.now(),
      };

      logWithTimestamp(
        `[adaptiveParams] ${symbol}: ATR=${atrPercent.toFixed(2)}%, ` +
          `SL=${params.recommendedSLPercent}%, TP=${params.recommendedTPPercent}%, ` +
          `lev=${params.recommendedLeverage}x, threshold=${params.recommendedLongThreshold.toFixed(0)} USDT, ` +
          `regime=${regime}, riskAdj=${riskAdjustment.toFixed(2)}`,
      );

      return params;
    } catch (error) {
      logErrorWithTimestamp(`[adaptiveParams] Failed to compute params for ${symbol}:`, error);

      // Fall back to cached values or build a minimal entry from static config
      const cached = this.paramsCache.get(symbol);
      if (cached) {
        logWithTimestamp(`[adaptiveParams] ${symbol}: using stale cached params`);
        return cached;
      }

      // Worst case — build safe defaults from static config
      return this._fallbackParams(symbol, symConfig);
    }
  }

  /**
   * Calculate ATR(period) from 1m klines.
   */
  private _calcATR(
    klines: Kline[],
    period: number,
  ): { atr: number; atrPercent: number; currentPrice: number } {
    if (klines.length < period + 1) {
      throw new Error(`Not enough klines for ATR: have ${klines.length}, need ${period + 1}`);
    }

    const trueRanges: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const high = parseFloat(klines[i].high);
      const low = parseFloat(klines[i].low);
      const prevClose = parseFloat(klines[i - 1].close);

      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }

    // SMA of the last `period` true ranges
    const slice = trueRanges.slice(-period);
    const atr = slice.reduce((sum, tr) => sum + tr, 0) / slice.length;

    const currentPrice = parseFloat(klines[klines.length - 1].close);
    const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

    return { atr, atrPercent, currentPrice };
  }

  /**
   * Fetch 24h ticker data for a single symbol (public endpoint, no auth).
   */
  private async _fetch24hrTicker(symbol: string): Promise<Ticker24hr | null> {
    try {
      const response = await axios.get(`${BASE_URL}/fapi/v3/ticker/24hr`, {
        params: { symbol },
        timeout: 10_000,
      });
      return response.data as Ticker24hr;
    } catch {
      return null;
    }
  }

  /**
   * Detect market regime using ADX-like metric over 1h candles.
   *
   * trendStrength = |price - SMA(20)| / ATR(14)
   *   < 1.5   → RANGING
   *   1.5-3.0 → TRENDING
   *   > 3.0   → STRONGLY_TRENDING
   */
  private _detectRegime(klines: Kline[]): {
    regime: 'RANGING' | 'TRENDING' | 'STRONGLY_TRENDING';
    regimeConfidence: number;
  } {
    if (klines.length < TREND_LOOKBACK_CANDLES + 1) {
      return { regime: 'RANGING', regimeConfidence: 0 };
    }

    const prices = klines.map((k) => parseFloat(k.close));
    const currentPrice = prices[prices.length - 1];
    const sma20 = prices.slice(-TREND_LOOKBACK_CANDLES).reduce((s, p) => s + p, 0) / TREND_LOOKBACK_CANDLES;

    // Calculate ATR over the same window
    const trueRanges: number[] = [];
    for (let i = klines.length - TREND_LOOKBACK_CANDLES + 1; i < klines.length; i++) {
      const high = parseFloat(klines[i].high);
      const low = parseFloat(klines[i].low);
      const prevClose = parseFloat(klines[i - 1].close);
      trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    const atr14 = trueRanges.length > 0
      ? trueRanges.reduce((s, tr) => s + tr, 0) / trueRanges.length
      : 1;

    const trendStrength = atr14 > 0 ? Math.abs(currentPrice - sma20) / atr14 : 0;

    let regime: 'RANGING' | 'TRENDING' | 'STRONGLY_TRENDING';
    let regimeConfidence: number;

    if (trendStrength < REGIME_RANGING_THRESHOLD) {
      regime = 'RANGING';
      regimeConfidence = 1 - trendStrength / REGIME_RANGING_THRESHOLD;
    } else if (trendStrength < REGIME_TRENDING_THRESHOLD) {
      regime = 'TRENDING';
      regimeConfidence = (trendStrength - REGIME_RANGING_THRESHOLD) / (REGIME_TRENDING_THRESHOLD - REGIME_RANGING_THRESHOLD);
    } else {
      regime = 'STRONGLY_TRENDING';
      regimeConfidence = Math.min(1, (trendStrength - REGIME_TRENDING_THRESHOLD) / REGIME_TRENDING_THRESHOLD);
    }

    return { regime, regimeConfidence };
  }

  /**
   * Recommend VWAP parameters based on volatility.
   * High vol → shorter timeframe, shorter lookback.
   * Low vol  → longer timeframe, longer lookback.
   */
  private _recommendVWAPParams(atrPercent: number): {
    recommendedVWAPTimeframe: string;
    recommendedVWAPLookback: number;
  } {
    if (atrPercent > 2.0) {
      // Very high vol — fast VWAP
      return { recommendedVWAPTimeframe: '1m', recommendedVWAPLookback: 50 };
    }
    if (atrPercent > 1.0) {
      // Elevated vol
      return { recommendedVWAPTimeframe: '1m', recommendedVWAPLookback: 100 };
    }
    if (atrPercent > 0.5) {
      // Moderate vol
      return { recommendedVWAPTimeframe: '3m', recommendedVWAPLookback: 100 };
    }
    // Low vol — stable VWAP
    return { recommendedVWAPTimeframe: '5m', recommendedVWAPLookback: 200 };
  }

  /**
   * Calculate a risk adjustment multiplier (0.5-2.0) based on:
   * - Win rate (below 35% → reduce size by 50%)
   * - Market regime (STRONGLY_TRENDING → tighten by 30%)
   * - Combined effect clamped to [0.5, 2.0]
   */
  private _calcRiskAdjustment(symbol: string, ad: Partial<AdaptiveParams>): number {
    let adj = 1.0;

    // Win rate penalty
    if (ad.winRate !== undefined && ad.winRate < MIN_WIN_RATE_FOR_FULL_SIZE) {
      adj *= 0.5;
    }

    // Regime penalty — strongly trending is bad for contrarian
    if (ad.marketRegime === 'STRONGLY_TRENDING') {
      adj *= 0.7;
    } else if (ad.marketRegime === 'TRENDING') {
      adj *= 0.85;
    }

    // Clamp
    return Math.max(0.5, Math.min(2.0, adj));
  }

  /**
   * Build a safe fallback from the static SymbolConfig when market data is
   * unavailable.  This ensures the bot can still operate with static values.
   */
  private _fallbackParams(symbol: string, symConfig: SymbolConfig): AdaptiveParams {
    const sl = symConfig.slPercent;
    const tp = symConfig.tpPercent;
    const lev = symConfig.leverage;
    const longThresh = symConfig.longVolumeThresholdUSDT ?? symConfig.volumeThresholdUSDT ?? 10000;
    const shortThresh = symConfig.shortVolumeThresholdUSDT ?? symConfig.volumeThresholdUSDT ?? 10000;
    const winRate = this.getWinRate(symbol);
    const profitFactor = this.getProfitFactor(symbol);

    return {
      symbol,
      recommendedSLPercent: sl,
      recommendedTPPercent: tp,
      recommendedLeverage: lev,
      recommendedLongThreshold: longThresh,
      recommendedShortThreshold: shortThresh,
      recommendedVWAPTimeframe: symConfig.vwapTimeframe ?? '1m',
      recommendedVWAPLookback: symConfig.vwapLookback ?? 100,
      marketRegime: 'RANGING',
      regimeConfidence: 0,
      atrPercent: 0,
      avg1mVolume: 0,
      winRate,
      profitFactor,
      riskAdjustment: this._calcRiskAdjustment(symbol, { winRate, marketRegime: 'RANGING' } as AdaptiveParams),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Resolve the refresh interval across all enabled symbols.
   * Uses the minimum interval found, defaulting to DEFAULT_REFRESH_INTERVAL_MS.
   */
  private _resolveInterval(config: Config): number {
    let minInterval = DEFAULT_REFRESH_INTERVAL_MS;
    for (const sym of Object.values(config.symbols)) {
      const iv = sym.adaptiveParams?.refreshIntervalMs;
      if (iv && iv > 0 && iv < minInterval) {
        minInterval = iv;
      }
    }
    return minInterval;
  }
}

// Export singleton
export const adaptiveParamsService = new AdaptiveParamsService();
