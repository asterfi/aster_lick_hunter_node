'use client';

import React, { useState, useCallback, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { DashboardLayout } from '@/components/dashboard-layout';
import { useConfig } from '@/components/ConfigProvider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle2, Settings } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from 'sonner';
import type { AutoCoinSymbol } from '@/lib/types';

// Lazy-load heavy components — they load in separate JS bundles
const SymbolConfigForm = dynamic(() => import('@/components/SymbolConfigForm'), {
  loading: () => <Skeleton className="h-96 w-full" />,
});
const AutoCoinsPanel = dynamic(() => import('@/components/AutoCoinsPanel'), {
  loading: () => <Skeleton className="h-64 w-full" />,
});

export default function ConfigPage() {
  const { config, loading, updateConfig } = useConfig();
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSave = async (newConfig: any) => {
    setSaveStatus('saving');
    try {
      const hasApiKeyChanges = config && (
        newConfig.api.apiKey !== config.api.apiKey ||
        newConfig.api.secretKey !== config.api.secretKey ||
        newConfig.api.walletAddress !== config.api.walletAddress ||
        newConfig.api.apiWalletAddress !== config.api.apiWalletAddress ||
        newConfig.api.apiWalletKey !== config.api.apiWalletKey
      );

      await updateConfig(newConfig);
      setSaveStatus('saved');
      toast.success('Configuration saved successfully');

      // Force refresh if API keys were changed to repull dashboard data
      if (hasApiKeyChanges) {
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        setTimeout(() => setSaveStatus('idle'), 3000);
      }
    } catch (error) {
      console.error('Failed to save config:', error);
      setSaveStatus('error');
      toast.error('Failed to save configuration');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const handleApplySymbols = useCallback(
    async (autoSymbols: AutoCoinSymbol[]) => {
      if (!config) return;

      // Build a new symbols record: merge auto-selected symbols into existing config
      const newSymbols = { ...config.symbols };

      for (const coin of autoSymbols) {
        const existing = newSymbols[coin.symbol];

        if (existing) {
          // Force-apply auto-recommended values over existing config
          newSymbols[coin.symbol] = {
            ...existing,
            longVolumeThresholdUSDT: coin.recommendedThreshold,
            shortVolumeThresholdUSDT: coin.recommendedThreshold,
            slPercent: coin.recommendedSL,
            tpPercent: coin.recommendedTP,
            leverage: coin.recommendedLeverage,
          };
        } else {
          // Create new config entry from recommendations (mirrors autoCoinsService.applyToConfig)
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
            orderType: 'LIMIT' as const,
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

      const updatedConfig = {
        ...config,
        symbols: newSymbols,
      };

      await updateConfig(updatedConfig);
      toast.success(`Applied ${autoSymbols.length} auto-selected symbols`);
    },
    [config, updateConfig],
  );

  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-6 space-y-6">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Card>
            <CardHeader>
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-48" />
            </CardHeader>
            <CardContent className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* Page Header */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                <Settings className="h-8 w-8" />
                Bot Configuration
              </h1>
              <p className="text-muted-foreground">
                Configure your API credentials and trading parameters for each symbol
              </p>
            </div>
            <div className="flex items-center gap-3">
              {saveStatus === 'saved' && (
                <Badge variant="default" className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Saved
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* Status Alert */}
        {config?.global?.paperMode && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <strong>Paper Mode Active:</strong> The bot is currently in simulation mode.
              No real trades will be executed. Disable paper mode in the settings below to start live trading.
            </AlertDescription>
          </Alert>
        )}

        {/* AutoCoins Panel */}
        {config && (
          <AutoCoinsPanel
            config={config}
            onUpdateConfig={(path, value) => {
              // Deep-set a dot-separated path on the config and save it
              const parts = path.split('.');
              const newConfig = JSON.parse(JSON.stringify(config)) as typeof config;
              let obj: any = newConfig;
              for (let i = 0; i < parts.length - 1; i++) {
                if (!obj[parts[i]]) obj[parts[i]] = {};
                obj = obj[parts[i]];
              }
              obj[parts[parts.length - 1]] = value;
              updateConfig(newConfig);
            }}
            onApplySymbols={handleApplySymbols}
          />
        )}

        {/* Configuration Form */}
        {config && (
          <SymbolConfigForm
            onSave={handleSave}
            currentConfig={config}
          />
        )}

        {/* Important Notes */}
        <Card className="border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-yellow-800 dark:text-yellow-400">
              <AlertCircle className="h-5 w-5" />
              Important Notes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc list-inside text-sm text-yellow-700 dark:text-yellow-500 space-y-2">
              <li>Keep your API credentials secure and never share them with anyone</li>
              <li>Always start with Paper Mode enabled to test your configuration</li>
              <li>Use conservative stop-loss percentages to limit risk (recommended: 1-2%)</li>
              <li>Monitor your positions regularly when running in live mode</li>
              <li>The bot must be running locally (npm run bot) for trading to occur</li>
              <li>Ensure you have sufficient balance before enabling live trading</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}