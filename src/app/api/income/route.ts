import { NextResponse } from 'next/server';
import { getTimeRangeIncome, aggregateDailyPnLWithTrades, calculatePerformanceMetrics } from '@/lib/api/income';
import { configLoader } from '@/lib/config/configLoader';
import { withAuth } from '@/lib/auth/with-auth';

export const GET = withAuth(async (request: Request, _user) => {
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') as '24h' | '7d' | '30d' | '90d' | '1y' | 'all' || '7d';

    // Load config to get API credentials and symbols
    let config = configLoader.getConfig();
    if (!config) {
      config = await configLoader.loadConfig();
    }

    const hasV1 = config.api?.apiKey && config.api?.secretKey;
    const hasV3 = config.api?.apiWalletAddress && config.api?.apiWalletKey;
    if (!hasV1 && !hasV3) {
      return NextResponse.json(
        { error: 'API credentials not configured' },
        { status: 500 }
      );
    }

    const credentials = {
      apiKey: config.api.apiKey,
      secretKey: config.api.secretKey,
    };

    // Fetch income history for fees and funding
    const records = await getTimeRangeIncome(credentials, range);

    // Discover symbols from income records (includes ALL traded symbols, not just configured ones)
    const symbolsFromIncome = Array.from(new Set(records.map(r => r.symbol).filter(s => s)));
    const configuredSymbols = config.symbols ? Object.keys(config.symbols) : [];

    // Use income symbols if available, fallback to configured symbols
    const symbols = symbolsFromIncome.length > 0 ? symbolsFromIncome : configuredSymbols;

    console.log(`[Income API] Fetching trades for ${symbols.length} symbols: ${symbols.join(', ')}`);

    // Calculate time range for trade fetching
    const now = Date.now();
    let startTime: number;

    switch (range) {
      case '24h':
        startTime = now - 24 * 60 * 60 * 1000;
        break;
      case '7d':
        startTime = now - 7 * 24 * 60 * 60 * 1000;
        break;
      case '30d':
        startTime = now - 30 * 24 * 60 * 60 * 1000;
        break;
      case '90d':
        startTime = now - 90 * 24 * 60 * 60 * 1000;
        break;
      case '1y':
        startTime = now - 365 * 24 * 60 * 60 * 1000;
        break;
      case 'all':
        startTime = now - 2 * 365 * 24 * 60 * 60 * 1000;
        break;
      default:
        startTime = now - 7 * 24 * 60 * 60 * 1000;
    }

    // Aggregate with REAL realized PnL from user trades
    const dailyPnL = await aggregateDailyPnLWithTrades(
      records,
      credentials,
      symbols,
      startTime,
      now
    );

    // Calculate performance metrics
    const metrics = calculatePerformanceMetrics(dailyPnL);

    return NextResponse.json({
      dailyPnL,
      metrics,
      range,
      recordCount: records.length,
    });
  } catch (error) {
    console.error('Error fetching income history:', error);

    // Return empty data with proper structure on error
    const { searchParams } = new URL(request.url);
    return NextResponse.json({
      dailyPnL: [],
      metrics: calculatePerformanceMetrics([]),
      range: searchParams.get('range') || '7d',
      recordCount: 0,
      error: 'Failed to fetch income history'
    });
  }
});