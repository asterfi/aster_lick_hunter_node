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

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const [wsUrl, setWsUrl] = useState('ws://localhost:8080');

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then((data) => {
        const port = data.global?.server?.websocketPort || 8080;
        const remoteHost = data.global?.server?.websocketHost;
        const useRemote = data.global?.server?.useRemoteWebSocket;
        const host = remoteHost || (useRemote && typeof window !== 'undefined' ? window.location.hostname : 'localhost');
        const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${protocol}://${host}:${port}`;
        setWsUrl(url);
        websocketService.setUrl(url);
      })
      .catch(() => {
        websocketService.setUrl('ws://localhost:8080');
      });
  }, []);

  return (
    <WebSocketContext.Provider value={{ wsPort: 8080, wsHost: 'localhost', wsUrl }}>
      {children}
    </WebSocketContext.Provider>
  );
}
