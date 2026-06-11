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
   * Called by Hunter BEFORE the trade decision.
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
          reason: 'Cascade: unknown state (pass-through)',
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
