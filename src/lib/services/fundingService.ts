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
      const response = await axios.get(`${BASE_URL}/fapi/v3/premiumIndex`, {
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

  public updateConfig(config: Config): void {
    this.configs.clear();
    for (const [symbol, symConfig] of Object.entries(config.symbols)) {
      if (symConfig.fundingFilter?.enabled) {
        this.configs.set(symbol, symConfig.fundingFilter);
      }
    }
  }
}

export const fundingService = new FundingService();
