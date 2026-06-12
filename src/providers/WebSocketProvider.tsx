'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import websocketService from '@/lib/services/websocketService';

interface WebSocketContextType {
  wsPort: number;
  wsHost: string;
  wsUrl: string;
}

const WebSocketContext = createContext<WebSocketContextType>({
  wsPort: 8080,
  wsHost: 'localhost',
  wsUrl: 'ws://localhost:8080',
});

export const useWebSocketConfig = () => {
  const context = useContext(WebSocketContext);
  if (context === undefined) {
    throw new Error('useWebSocketConfig must be used within a WebSocketProvider');
  }
  return context;
};

function buildWsUrl(host: string, port: number): string {
  if (typeof window === 'undefined') return `ws://${host}:${port}`;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${host}:${port}`;
}

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [wsPort, setWsPort] = useState(8080);
  const [wsHost, setWsHost] = useState(
    typeof window !== 'undefined' ? window.location.hostname : 'localhost',
  );

  useEffect(() => {
    // Use the same /api/config that ConfigProvider already loads.
    // This runs once; subsequent navigations reuse the cached provider state.
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        const port = data.global?.server?.websocketPort || 8080;
        const remoteHost = data.global?.server?.websocketHost;
        const host = remoteHost || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');

        setWsPort(port);
        setWsHost(host);

        const url = buildWsUrl(host, port);
        websocketService.setUrl(url);

        // Lightweight connection check — don't block rendering
        websocketService.testConnection().then((ok) => {
          if (ok) console.log('[WS] Bot reachable at', url);
        });
      })
      .catch(() => {
        // Fallback: use current hostname + default port
        const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
        const url = buildWsUrl(host, 8080);
        setWsHost(host);
        websocketService.setUrl(url);
      });
  }, []);

  const wsUrl = buildWsUrl(wsHost, wsPort);

  return (
    <WebSocketContext.Provider value={{ wsPort, wsHost, wsUrl }}>
      {children}
    </WebSocketContext.Provider>
  );
}