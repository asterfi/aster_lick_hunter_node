'use client';

import React, { useState, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { toast } from 'sonner';
import {
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Ban,
  Loader2,
  Sparkles,
} from 'lucide-react';
import type { AutoCoinsConfig, AutoCoinSymbol } from '@/lib/types';

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULT_AUTOCOINS_CONFIG: AutoCoinsConfig = {
  enabled: false,
  minVolume24h: 10_000_000,
  maxVolume24h: undefined,
  volatilityEnabled: true,
  volatilityTimeframe: '5m',
  volatilityThreshold: 5,
  volatilityLength: 24,
  minPrice: 0.01,
  maxPrice: undefined,
  blacklistedSymbols: [],
  maxSymbols: 20,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `${(vol / 1_000).toFixed(1)}K`;
  return vol.toFixed(0);
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toFixed(8);
}

function formatPercent(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AutoCoinsPanelProps {
  config: {
    global?: { autoCoins?: AutoCoinsConfig };
    symbols?: Record<string, any>;
  };
  onUpdateConfig: (path: string, value: any) => void;
  onApplySymbols: (symbols: AutoCoinSymbol[]) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AutoCoinsPanel({
  config,
  onUpdateConfig,
  onApplySymbols,
}: AutoCoinsPanelProps) {
  const acConfig: AutoCoinsConfig = config.global?.autoCoins ?? DEFAULT_AUTOCOINS_CONFIG;

  const [symbols, setSymbols] = useState<AutoCoinSymbol[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [blacklistExpanded, setBlacklistExpanded] = useState(false);
  const [localBlacklist, setLocalBlacklist] = useState<string[]>(
    acConfig.blacklistedSymbols ?? [],
  );
  // Local state for inputs — only saved to config on blur, not on every keystroke
  const [minVolInput, setMinVolInput] = useState(acConfig.minVolume24h / 1_000_000);
  const [maxSymbolsInput, setMaxSymbolsInput] = useState(acConfig.maxSymbols);
  const [volThresholdInput, setVolThresholdInput] = useState(acConfig.volatilityThreshold);
  const [volLengthInput, setVolLengthInput] = useState(acConfig.volatilityLength);
  const [volTfInput, setVolTfInput] = useState(acConfig.volatilityTimeframe);

  // -----------------------------------------------------------------------
  // Refresh
  // -----------------------------------------------------------------------

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setApplied(false);

    try {
      const response = await fetch('/api/autocoins/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: acConfig }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error ?? `Request failed: ${response.status}`);
      }

      const data = await response.json();
      setSymbols(data.symbols ?? []);
      toast.success(`AutoCoins refreshed: ${data.symbols?.length ?? 0} symbols found`);
    } catch (err: any) {
      setError(err.message ?? 'Failed to refresh symbols');
      toast.error(`AutoCoins refresh failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [acConfig]);

  // -----------------------------------------------------------------------
  // Apply
  // -----------------------------------------------------------------------

  const handleApply = useCallback(async () => {
    if (symbols.length === 0) return;

    try {
      onApplySymbols(symbols);
      setApplied(true);
      toast.success(`Applied ${symbols.length} auto-selected symbols to config`);
    } catch (err: any) {
      toast.error(`Failed to apply symbols: ${err.message}`);
    }
  }, [symbols, onApplySymbols]);

  // -----------------------------------------------------------------------
  // Blacklist
  // -----------------------------------------------------------------------

  const handleBlacklist = useCallback(
    async (symbol: string) => {
      try {
        const response = await fetch('/api/autocoins/blacklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, action: 'add' }),
        });

        if (!response.ok) throw new Error('Failed to blacklist');

        const updatedBlacklist = [...localBlacklist, symbol];
        setSymbols((prev) => prev.filter((s) => s.symbol !== symbol));
        setLocalBlacklist(updatedBlacklist);
        onUpdateConfig('global.autoCoins.blacklistedSymbols', updatedBlacklist);
        toast.success(`Blacklisted ${symbol}`);
      } catch (err: any) {
        toast.error(`Failed to blacklist ${symbol}: ${err.message}`);
      }
    },
    [localBlacklist, onUpdateConfig],
  );

  const handleUnblacklist = useCallback(
    async (symbol: string) => {
      try {
        const response = await fetch('/api/autocoins/blacklist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, action: 'remove' }),
        });

        if (!response.ok) throw new Error('Failed to unblacklist');

        const updatedBlacklist = localBlacklist.filter((s) => s !== symbol);
        setLocalBlacklist(updatedBlacklist);
        onUpdateConfig('global.autoCoins.blacklistedSymbols', updatedBlacklist);
        toast.success(`Removed ${symbol} from blacklist`);
      } catch (err: any) {
        toast.error(`Failed to unblacklist ${symbol}: ${err.message}`);
      }
    },
    [localBlacklist, onUpdateConfig],
  );

  // -----------------------------------------------------------------------
  // Config updaters
  // -----------------------------------------------------------------------

  const toggleEnabled = useCallback(
    (checked: boolean) => {
      onUpdateConfig('global.autoCoins.enabled', checked);
    },
    [onUpdateConfig],
  );

  const saveMinVolume = useCallback(() => {
    onUpdateConfig('global.autoCoins.minVolume24h', Math.max(1, Math.min(100, minVolInput)) * 1_000_000);
  }, [onUpdateConfig, minVolInput]);

  const saveMaxSymbols = useCallback(() => {
    onUpdateConfig('global.autoCoins.maxSymbols', Math.max(5, Math.min(50, maxSymbolsInput)));
  }, [onUpdateConfig, maxSymbolsInput]);

  const saveVolThreshold = useCallback(() => {
    onUpdateConfig('global.autoCoins.volatilityThreshold', Math.max(0.5, Math.min(20, volThresholdInput)));
  }, [onUpdateConfig, volThresholdInput]);

  const saveVolLength = useCallback(() => {
    onUpdateConfig('global.autoCoins.volatilityLength', Math.max(1, Math.min(200, volLengthInput)));
  }, [onUpdateConfig, volLengthInput]);

  const saveVolTf = useCallback(() => {
    onUpdateConfig('global.autoCoins.volatilityTimeframe', volTfInput);
  }, [onUpdateConfig, volTfInput]);

  const toggleVolatility = useCallback(
    (checked: boolean) => {
      onUpdateConfig('global.autoCoins.volatilityEnabled', checked);
    },
    [onUpdateConfig],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <CardTitle>Auto-Select Trading Pairs (AutoCoins)</CardTitle>
          </div>
          <Switch
            checked={acConfig.enabled}
            onCheckedChange={toggleEnabled}
            aria-label="Toggle AutoCoins"
          />
        </div>
        <CardDescription>
          Automatically discover and select trading pairs based on volume and volatility filters.
        </CardDescription>
      </CardHeader>

      {acConfig.enabled && (
        <CardContent className="space-y-6">
          {/* ---- Filters ---- */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {/* Min Volume */}
            <div className="space-y-2">
              <Label htmlFor="ac-min-vol">Min 24h Volume ($M)</Label>
              <Input
                id="ac-min-vol"
                type="number"
                min={1}
                max={100}
                step={1}
                value={minVolInput}
                onChange={(e) => setMinVolInput(Number(e.target.value))}
                onBlur={saveMinVolume}
              />
              <p className="text-xs text-muted-foreground">Current: ${formatVolume(acConfig.minVolume24h)}</p>
            </div>

            {/* Max Symbols */}
            <div className="space-y-2">
              <Label htmlFor="ac-max-sym">Max Symbols</Label>
              <Input
                id="ac-max-sym"
                type="number"
                min={5}
                max={50}
                step={1}
                value={maxSymbolsInput}
                onChange={(e) => setMaxSymbolsInput(Number(e.target.value))}
                onBlur={saveMaxSymbols}
              />
              <p className="text-xs text-muted-foreground">Current: {acConfig.maxSymbols} pairs</p>
            </div>

            {/* Volatility Filter */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Volatility Filter</Label>
                <Switch
                  checked={acConfig.volatilityEnabled}
                  onCheckedChange={toggleVolatility}
                  aria-label="Toggle volatility filter"
                />
              </div>
              {acConfig.volatilityEnabled && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="ac-vol-len" className="text-xs">Candles</Label>
                    <Input
                      id="ac-vol-len"
                      type="number"
                      min={1}
                      max={200}
                      step={1}
                      value={volLengthInput}
                      onChange={(e) => setVolLengthInput(Number(e.target.value))}
                      onBlur={saveVolLength}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ac-vol-pct" className="text-xs">Max Move %</Label>
                    <Input
                      id="ac-vol-pct"
                      type="number"
                      min={0.5}
                      max={20}
                      step={0.5}
                      value={volThresholdInput}
                      onChange={(e) => setVolThresholdInput(Number(e.target.value))}
                      onBlur={saveVolThreshold}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ac-vol-tf" className="text-xs">Timeframe</Label>
                    <select
                      id="ac-vol-tf"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={volTfInput}
                      onChange={(e) => { setVolTfInput(e.target.value); saveVolTf(); }}
                    >
                      <option value="1m">1m</option>
                      <option value="3m">3m</option>
                      <option value="5m">5m</option>
                      <option value="15m">15m</option>
                      <option value="30m">30m</option>
                      <option value="1h">1h</option>
                      <option value="4h">4h</option>
                    </select>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Blacklists pairs where any of the last {acConfig.volatilityLength} {acConfig.volatilityTimeframe} candles moved more than {acConfig.volatilityThreshold}%
              </p>
              {!acConfig.volatilityEnabled && (
                <p className="text-xs text-muted-foreground">Volatility filtering disabled</p>
              )}
            </div>
          </div>

          {/* ---- Action buttons ---- */}
          <div className="flex items-center gap-3">
            <Button
              variant="default"
              onClick={handleRefresh}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {loading ? 'Refreshing...' : 'Refresh Symbols'}
            </Button>

            {symbols.length > 0 && (
              <>
                <Button
                  variant="secondary"
                  onClick={handleApply}
                  disabled={applied}
                >
                  {applied ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {applied ? 'Applied' : `Apply ${symbols.length} Symbols`}
                </Button>

                <Badge variant="outline" className="ml-auto">
                  {symbols.length} symbols selected
                </Badge>
              </>
            )}
          </div>

          {/* ---- Error ---- */}
          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}

          {/* ---- Symbols Table ---- */}
          {symbols.length > 0 && (
            <div className="border rounded-lg overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>24h Vol</TableHead>
                    <TableHead>Max Volatility</TableHead>
                    <TableHead>ATR%</TableHead>
                    <TableHead>Rec. SL</TableHead>
                    <TableHead>Rec. TP</TableHead>
                    <TableHead>Rec. Lev</TableHead>
                    <TableHead>Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {symbols.map((coin) => (
                    <TableRow key={coin.symbol}>
                      <TableCell className="font-medium">
                        {coin.symbol}
                        {coin.blacklisted && (
                          <Badge variant="destructive" className="ml-2 text-[10px]">
                            BL
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>{formatPrice(coin.price)}</TableCell>
                      <TableCell>{formatVolume(coin.volume24h)}</TableCell>
                      <TableCell>{formatPercent(coin.maxVolatility)}</TableCell>
                      <TableCell>{formatPercent(coin.atrPercent)}</TableCell>
                      <TableCell>{formatPercent(coin.recommendedSL)}</TableCell>
                      <TableCell>{formatPercent(coin.recommendedTP)}</TableCell>
                      <TableCell>{coin.recommendedLeverage}x</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleBlacklist(coin.symbol)}
                          title="Blacklist this symbol"
                        >
                          <Ban className="h-3 w-3 mr-1" />
                          Exclude
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* ---- No symbols message ---- */}
          {!loading && !error && symbols.length === 0 && acConfig.enabled && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Sparkles className="h-8 w-8 mb-2 opacity-50" />
              <p className="text-sm">No symbols loaded yet. Click &quot;Refresh Symbols&quot; to discover trading pairs.</p>
            </div>
          )}

          {/* ---- Blacklist Section ---- */}
          {(localBlacklist.length > 0) && (
            <Collapsible
              open={blacklistExpanded}
              onOpenChange={setBlacklistExpanded}
            >
              <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${blacklistExpanded ? 'rotate-0' : '-rotate-90'}`}
                />
                Blacklisted Symbols ({localBlacklist.length})
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <div className="flex flex-wrap gap-2">
                  {localBlacklist.map((sym) => (
                    <Badge
                      key={sym}
                      variant="secondary"
                      className="flex items-center gap-1"
                    >
                      <XCircle className="h-3 w-3" />
                      {sym}
                      <button
                        className="ml-1 hover:text-destructive transition-colors"
                        onClick={() => handleUnblacklist(sym)}
                        title="Remove from blacklist"
                      >
                        &times;
                      </button>
                    </Badge>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {symbols.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <AlertCircle className="h-3 w-3 inline mr-1" />
              Threshold = 24h volume / 1440 min * 2. Click &quot;Apply&quot; to merge into your symbol config.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
