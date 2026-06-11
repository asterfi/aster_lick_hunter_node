import { NextResponse } from 'next/server';
import { autoCoinsService } from '@/lib/services/autoCoinsService';
import { AutoCoinsConfig } from '@/lib/types';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const config = body.config as AutoCoinsConfig;

    if (!config) {
      return NextResponse.json(
        { error: 'Missing autoCoins config in request body' },
        { status: 400 },
      );
    }

    // Ensure service is initialised
    await autoCoinsService.init();

    const symbols = await autoCoinsService.refreshSymbols(config);

    return NextResponse.json({ symbols, count: symbols.length });
  } catch (error: any) {
    console.error('[autoCoins API] Refresh failed:', error);
    return NextResponse.json(
      { error: error.message ?? 'Failed to refresh auto-coins symbols' },
      { status: 500 },
    );
  }
}
