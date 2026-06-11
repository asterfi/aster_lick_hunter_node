import { NextResponse } from 'next/server';
import { autoCoinsService } from '@/lib/services/autoCoinsService';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { symbol, action } = body;

    if (!symbol || !action) {
      return NextResponse.json(
        { error: 'Missing symbol or action in request body' },
        { status: 400 },
      );
    }

    // Ensure service is initialised
    await autoCoinsService.init();

    if (action === 'add') {
      await autoCoinsService.addToBlacklist(symbol, 'Manually blacklisted from UI');
      return NextResponse.json({ success: true, action: 'added', symbol });
    } else if (action === 'remove') {
      await autoCoinsService.removeFromBlacklist(symbol);
      return NextResponse.json({ success: true, action: 'removed', symbol });
    } else {
      return NextResponse.json(
        { error: `Unknown action: ${action}. Use 'add' or 'remove'.` },
        { status: 400 },
      );
    }
  } catch (error: any) {
    console.error('[autoCoins API] Blacklist operation failed:', error);
    return NextResponse.json(
      { error: error.message ?? 'Failed to update blacklist' },
      { status: 500 },
    );
  }
}
