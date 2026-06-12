/**
 * AutoCoins Service
 *
 * Singleton service that auto-selects trading pairs from all available USDT
 * perpetual futures on AsterDEX, filtered by 24h volume and volatility criteria.
 *
 * @notExportedAsIndex The singleton `autoCoinsService` is the intended consumer.
 */

import { EventEmitter } from 'events';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { AutoCoinsConfig, AutoCoinSymbol, Kline } from '../types';
import { getKlines } from '../api/market';
import { logWithTimestamp, logErrorWithTimestamp } from '../utils/timestamp';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://fapi.asterdex.com';
const ATR_PERIOD = 14;
const BLACKLIST_FILE = path.resolve(process.cwd(), 'data', 'autocoins-blacklist.json');
const DEFAULT_BLACKLIST_DURATION_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Types (internal)
// ---------------------------------------------------------------------------

interface ExchangeInfoSymbol {
  symbol: string;
  status: string;
  quoteAsset: string;
  contractType: string;
  onboardDate: number;
  filters: Array<{ filterType: string; [key: string]: any }>;
}

interface ExchangeInfoResponse {
  symbols: ExchangeInfoSymbol[];
}

interface Ticker24hr {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
}

interface BlacklistEntry {
  symbol: string;
  reason: string;
  blacklistedAt: number;
  durationMs: number;
}

interface BlacklistData {
  entries: BlacklistEntry[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AutoCoinsService extends EventEmitter {
  /** Currently selected auto-coin symbols */
  private symbolCache: AutoCoinSymbol[] = [];

  /** Whether the service has been initialised */
  private initialised = false;

  /** In-memory blacklist */
  private blacklist: Map<string, BlacklistEntry> = new Map();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Initialise the service: load the blacklist from disk.
   */
  public async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;

    await this._loadBlacklist();
    this._purgeExpiredBlacklistEntries();

    logWithTimestamp('[autoCoins] Service initialised');
  }

  /**
   * Stop and release resources.
   */
  public destroy(): void {
    this.initialised = false;
    this.symbolCache = [];
    logWithTimestamp('[autoCoins] Service stopped');
  }

  // -----------------------------------------------------------------------
  // Symbol discovery & filtering
  // -----------------------------------------------------------------------

  /**
   * Refresh the list of auto-selected symbols based on the provided config.
   * Fetches exchange info, 24h tickers, and klines for volatility checks.
   *
   * Emits 'symbolsRefreshed' with the new array of AutoCoinSymbol[].
   */
  public async refreshSymbols(config: AutoCoinsConfig): Promise<AutoCoinSymbol[]> {
    if (!config.enabled) {
      this.symbolCache = [];
      return [];
    }

    logWithTimestamp('[autoCoins] Refreshing symbol list...');

    try {
      // 1. Fetch all available symbols
      const exchangeInfo = await this._fetchExchangeInfo();
      let candidates = this._filterExchangeSymbols(exchangeInfo, config);

      if (candidates.length === 0) {
        logWithTimestamp('[autoCoins] No USDT perpetual symbols found after exchange info filter');
        this.symbolCache = [];
        return [];
      }

      // 2. Fetch 24h ticker for all candidates
      const allTickers = await this._fetchAll24hrTickers();
      const tickerMap = new Map<string, Ticker24hr>();
      for (const t of allTickers) {
        tickerMap.set(t.symbol, t);
      }

      // 3. Filter by volume and price, build initial results
      const results: AutoCoinSymbol[] = [];

      for (const sym of candidates) {
        const ticker = tickerMap.get(sym.symbol);
        if (!ticker) continue;

        const volume24h = parseFloat(ticker.quoteVolume);
        const price = parseFloat(ticker.lastPrice);

        // Volume filter
        if (volume24h < config.minVolume24h) continue;
        if (config.maxVolume24h !== undefined && volume24h > config.maxVolume24h) continue;

        // Price filter
        if (price < config.minPrice) continue;
        if (config.maxPrice !== undefined && price > config.maxPrice) continue;

        // Compute minimum notional from exchange filters
        const minNotionalFilter = sym.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
        const notionalFromFilter = parseFloat(minNotionalFilter?.notional || '0') || 0;
        // Fallback: compute from LOT_SIZE (minQty × price)
        const lotFilter = sym.filters?.find(f => f.filterType === 'LOT_SIZE');
        const minQty = parseFloat(lotFilter?.minQty || '0') || 0;
        const notionalFromLot = minQty > 0 ? minQty * price : 0;
        // Use whichever is higher, floor at $5
        const minNotional = Math.max(notionalFromFilter, notionalFromLot, 5);

        results.push({
          symbol: sym.symbol,
          price,
          volume24h,
          maxVolatility: 0,
          atrPercent: 0,
          recommendedSL: 0,
          recommendedTP: 0,
          recommendedLeverage: 0,
          recommendedThreshold: volume24h / 1440 * 2,
          recommendedTradeSize: Math.max(5, Math.ceil(minNotional * 1.3)),
          blacklisted: false,
          _minNotional: minNotional,
        } as any);
      }

      // 4. Volatility check (if enabled)
      if (config.volatilityEnabled) {
        await this._applyVolatilityFilter(results, config);
      }

      // 5. Sort by volume (highest first)
      results.sort((a, b) => b.volume24h - a.volume24h);

      // 6. Take top N
      const selected = results.slice(0, config.maxSymbols);

      this.symbolCache = selected;
      this.emit('symbolsRefreshed', selected);

      logWithTimestamp(`[autoCoins] Selected ${selected.length} symbols`);

      return selected;
    } catch (error) {
      logErrorWithTimestamp('[autoCoins] Refresh failed:', error);
      // Return cached results on failure
      return this.symbolCache;
    }
  }

  /**
   * Return the cached auto-coin symbols.
   */
  public getSymbols(): AutoCoinSymbol[] {
    return [...this.symbolCache];
  }

  /**
   * Apply auto-selected symbols to the config. Merges recommendations into existing
   * symbol configs, keeping manual configs for symbols that overlap.
   */
  public applyToConfig(
    symbols: AutoCoinSymbol[],
    currentConfig: { symbols: Record<string, any> },
  ): { symbols: Record<string, any> } {
    const newSymbols: Record<string, any> = { ...currentConfig.symbols };

    for (const coin of symbols) {
      const existing = newSymbols[coin.symbol];

      if (existing) {
        // Keep existing config but overlay auto-recommended values
        const tradeMargin = coin.recommendedTradeSize || 10;
        newSymbols[coin.symbol] = {
          ...existing,
          longVolumeThresholdUSDT: coin.recommendedThreshold,
          shortVolumeThresholdUSDT: coin.recommendedThreshold,
          slPercent: coin.recommendedSL,
          tpPercent: coin.recommendedTP,
          leverage: coin.recommendedLeverage,
          tradeSize: tradeMargin,
          longTradeSize: tradeMargin,
          shortTradeSize: tradeMargin,
        };
      } else {
        // Create new config entry from recommendations with all smart defaults
        const tradeMargin = coin.recommendedTradeSize || 10;
        newSymbols[coin.symbol] = {
          longVolumeThresholdUSDT: coin.recommendedThreshold,
          shortVolumeThresholdUSDT: coin.recommendedThreshold,
          tradeSize: tradeMargin,
          longTradeSize: tradeMargin,
          shortTradeSize: tradeMargin,
          maxPositionMarginUSDT: Math.max(tradeMargin * 5, 200),
          leverage: coin.recommendedLeverage,
          tpPercent: coin.recommendedTP,
          slPercent: coin.recommendedSL,
          priceOffsetBps: 2,
          maxSlippageBps: 50,
          orderType: 'LIMIT',
          vwapProtection: true,
          vwapTimeframe: '5m',
          vwapLookback: 200,
          useThreshold: false,
          adaptiveParams: { enabled: true },
          cvdFilter: { enabled: true, neutralThreshold: 0.20, minTradeCount: 10, candleDurationMs: 60000 },
          fundingFilter: { enabled: true, extremeThreshold: 0.0005, cacheMs: 60000 },
          cascadeDetector: { enabled: true, windowMs: 60000, minClusterSize: 3, acceleratingThresholdMs: 5000, peakThresholdMs: 2000, exhaustionMinMs: 8000, oiCheckEnabled: true },
        };
      }
    }

    logWithTimestamp(
      `[autoCoins] Applied ${symbols.length} symbols to config (${Object.keys(newSymbols).length} total)`,
    );

    return { symbols: newSymbols };
  }

  // -----------------------------------------------------------------------
  // Blacklist management
  // -----------------------------------------------------------------------

  /**
   * Get all currently blacklisted symbols.
   */
  public getBlacklistedSymbols(): BlacklistEntry[] {
    this._purgeExpiredBlacklistEntries();
    return Array.from(this.blacklist.values());
  }

  /**
   * Add a symbol to the blacklist.
   */
  public async addToBlacklist(
    symbol: string,
    reason: string,
    durationMs: number = DEFAULT_BLACKLIST_DURATION_MS,
  ): Promise<void> {
    this.blacklist.set(symbol, {
      symbol,
      reason,
      blacklistedAt: Date.now(),
      durationMs,
    });

    await this._saveBlacklist();
    logWithTimestamp(`[autoCoins] Blacklisted ${symbol}: ${reason} (${durationMs}ms)`);
  }

  /**
   * Remove a symbol from the blacklist.
   */
  public async removeFromBlacklist(symbol: string): Promise<void> {
    this.blacklist.delete(symbol);
    await this._saveBlacklist();
    logWithTimestamp(`[autoCoins] Removed ${symbol} from blacklist`);
  }

  /**
   * Check if a symbol is blacklisted.
   */
  public isBlacklisted(symbol: string): boolean {
    this._purgeExpiredBlacklistEntries();
    return this.blacklist.has(symbol);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Fetch exchange info to get all available symbols.
   */
  private async _fetchExchangeInfo(): Promise<ExchangeInfoSymbol[]> {
    const response = await axios.get<ExchangeInfoResponse>(
      `${BASE_URL}/fapi/v3/exchangeInfo`,
      { timeout: 10_000 },
    );
    return response.data.symbols;
  }

  /**
   * Filter exchange symbols to only USDT perpetual futures that are trading.
   */
  private _filterExchangeSymbols(
    symbols: ExchangeInfoSymbol[],
    config: AutoCoinsConfig,
  ): ExchangeInfoSymbol[] {
    return symbols.filter((sym) => {
      // Must be TRADING status
      if (sym.status !== 'TRADING') return false;

      // Must be USDT quoted perpetual
      if (sym.quoteAsset !== 'USDT') return false;
      if (sym.contractType !== 'PERPETUAL') return false;

      // Must end with USDT (no underscores like BTCUSDT_251226)
      if (!sym.symbol.endsWith('USDT')) return false;

      // Reject symbols with underscore (dated futures)
      if (sym.symbol.includes('_')) return false;

      // Reject symbols with numbers after USDT or weird patterns
      // Like BTCUSDT1234 or other non-standard pairs
      const baseAsset = sym.symbol.replace('USDT', '');
      if (!/^[A-Z]+$/.test(baseAsset)) return false;

      // Check blacklist
      if (this.isBlacklisted(sym.symbol)) return false;
      if (config.blacklistedSymbols.includes(sym.symbol)) return false;

      return true;
    });
  }

  /**
   * Fetch 24hr ticker for all symbols (public endpoint, no auth).
   */
  private async _fetchAll24hrTickers(): Promise<Ticker24hr[]> {
    const response = await axios.get<Ticker24hr[]>(
      `${BASE_URL}/fapi/v3/ticker/24hr`,
      { timeout: 15_000 },
    );
    return response.data;
  }

  /**
   * Apply volatility filter to candidate symbols.
   * Fetches klines and checks that no candle exceeds the volatility threshold.
   * Symbols that exceed the threshold get auto-blacklisted.
   */
  private async _applyVolatilityFilter(
    candidates: AutoCoinSymbol[],
    config: AutoCoinsConfig,
  ): Promise<void> {
    const batchSize = 10; // process in batches to avoid overwhelming the API

    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (coin) => {
          try {
            const klines = await getKlines(
              coin.symbol,
              config.volatilityTimeframe,
              config.volatilityLength + 5,
            );

            // Calculate volatility: check each candle's high-low range as %
            let maxVolatility = 0;

            for (let j = 0; j < klines.length; j++) {
              const high = parseFloat(klines[j].high);
              const low = parseFloat(klines[j].low);
              const open = parseFloat(klines[j].open);
              const movePct = open > 0 ? Math.abs(high - low) / open * 100 : 0;
              if (movePct > maxVolatility) {
                maxVolatility = movePct;
              }
            }

            // Calculate ATR(14)
            const atrPercent = this._calcATRPercent(klines, ATR_PERIOD);

            // Determine if volatility threshold is exceeded
            const exceeded = maxVolatility > config.volatilityThreshold;

            if (exceeded) {
              // Auto-blacklist
              await this.addToBlacklist(
                coin.symbol,
                `Volatility exceeded: ${maxVolatility.toFixed(2)}% > ${config.volatilityThreshold}%`,
              );
            }

            // Update coin with calculated values
            coin.maxVolatility = parseFloat(maxVolatility.toFixed(2));
            coin.atrPercent = parseFloat(atrPercent.toFixed(2));
            coin.recommendedSL = parseFloat(Math.max(atrPercent * 1.5, 0.5).toFixed(2));
            coin.recommendedTP = parseFloat(Math.max(atrPercent * 3.0, 1.0).toFixed(2));
            // Leverage = 2 / ATR%. 0.5% ATR → 4x. 2% ATR → 1x.
            coin.recommendedLeverage = Math.max(1, Math.min(Math.floor(2 / (atrPercent || 0.01)), 10));
            coin.recommendedThreshold = parseFloat((coin.volume24h / 1440 * 2).toFixed(2));
            coin.blacklisted = exceeded;

            // Trade size: respect exchange minimum notional with 30% buffer
            const minNotional = (coin as any)._minNotional ?? 5;
            const minMargin = Math.ceil((minNotional / coin.recommendedLeverage) * 1.3);
            coin.recommendedTradeSize = Math.max(5, minMargin);

            return coin;
          } catch (error) {
            logErrorWithTimestamp(
              `[autoCoins] Failed to fetch klines for ${coin.symbol}:`,
              error,
            );
            // On error, still include the symbol with default values
            return coin;
          }
        }),
      );

      // Collect results
      for (const result of results) {
        if (result.status === 'rejected') {
          logErrorWithTimestamp('[autoCoins] Batch item failed:', result.reason);
        }
      }
    }

    // Remove blacklisted symbols from candidates
    const remaining = candidates.filter((c) => !c.blacklisted);
    candidates.length = 0;
    candidates.push(...remaining);
  }

  /**
   * Calculate ATR as a percentage of the current price.
   */
  private _calcATRPercent(klines: Kline[], period: number): number {
    if (klines.length < period + 1) {
      return 0;
    }

    const trueRanges: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const high = parseFloat(klines[i].high);
      const low = parseFloat(klines[i].low);
      const prevClose = parseFloat(klines[i - 1].close);

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose),
      );
      trueRanges.push(tr);
    }

    const slice = trueRanges.slice(-period);
    const atr = slice.reduce((sum, tr) => sum + tr, 0) / slice.length;

    const currentPrice = parseFloat(klines[klines.length - 1].close);
    return currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  }

  // -----------------------------------------------------------------------
  // Blacklist persistence
  // -----------------------------------------------------------------------

  /**
   * Load blacklist from disk.
   */
  private async _loadBlacklist(): Promise<void> {
    try {
      if (fs.existsSync(BLACKLIST_FILE)) {
        const raw = fs.readFileSync(BLACKLIST_FILE, 'utf-8');
        const data: BlacklistData = JSON.parse(raw);

        this.blacklist.clear();
        for (const entry of data.entries) {
          this.blacklist.set(entry.symbol, entry);
        }

        logWithTimestamp(
          `[autoCoins] Loaded ${data.entries.length} blacklist entries from disk`,
        );
      }
    } catch (error) {
      logErrorWithTimestamp('[autoCoins] Failed to load blacklist:', error);
      this.blacklist.clear();
    }
  }

  /**
   * Save blacklist to disk.
   */
  private async _saveBlacklist(): Promise<void> {
    try {
      const dir = path.dirname(BLACKLIST_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: BlacklistData = {
        entries: Array.from(this.blacklist.values()),
      };

      fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      logErrorWithTimestamp('[autoCoins] Failed to save blacklist:', error);
    }
  }

  /**
   * Remove expired blacklist entries.
   */
  private _purgeExpiredBlacklistEntries(): void {
    const now = Date.now();
    let purged = 0;

    for (const [symbol, entry] of this.blacklist.entries()) {
      if (now - entry.blacklistedAt >= entry.durationMs) {
        this.blacklist.delete(symbol);
        purged++;
      }
    }

    if (purged > 0) {
      logWithTimestamp(`[autoCoins] Purged ${purged} expired blacklist entries`);
    }
  }
}

// Export singleton
export const autoCoinsService = new AutoCoinsService();
