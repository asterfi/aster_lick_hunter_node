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
  const [wsHost, setWsHost] = useState('');
  const [wsPort, setWsPort] = useState(8080);

  useEffect(() => {
    // Use the same /api/config that ConfigProvider already loads.
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        const port = data.global?.server?.websocketPort || 8080;
        const remoteHost = data.global?.server?.websocketHost;
        const useRemote = data.global?.server?.useRemoteWebSocket;
        const host = remoteHost || (useRemote && typeof window !== 'undefined' ? window.location.hostname : 'localhost');

        setWsPort(port);
        setWsHost(host);

        const url = buildWsUrl(host, port);
        websocketService.setUrl(url);
      })
      .catch(() => {
        // Fallback: localhost + default port
        const host = 'localhost';
        setWsHost(host);
        websocketService.setUrl(buildWsUrl(host, 8080));
      });
  }, []);

  const wsUrl = buildWsUrl(wsHost, wsPort);

  return (
    <WebSocketContext.Provider value={{ wsPort, wsHost, wsUrl }}>
      {children}
    </WebSocketContext.Provider>
  );
}