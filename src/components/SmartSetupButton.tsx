"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2, CheckCircle2 } from "lucide-react";

export function SmartSetupButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSmartSetup = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/optimizer/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights: { pnl: 50, sharpe: 30, drawdown: 20 }, mode: "smart-setup" }) });
      if (!res.ok) throw new Error("Smart setup failed");
      const data = await res.json();
      setResult(`Smart setup complete! Optimized ${data.symbolsOptimized || "N/A"} symbols. ${data.recommendations ? "Refresh to apply settings." : ""}`);
      // Reload config after 3 seconds
      setTimeout(() => window.location.reload(), 3000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button onClick={handleSmartSetup} disabled={loading} variant="outline" className="gap-2">
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        Smart Setup
      </Button>
      {result && <p className="text-sm text-green-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> {result}</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
