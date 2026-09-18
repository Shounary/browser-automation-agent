'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const URL = process.env.NEXT_PUBLIC_AGENT_WS ?? 'ws://localhost:3001';
const RECONNECT_MS = 2000;

// One socket for the page lifetime; reconnects if the backend restarts.
export function useAgentRun() {
  const socket = useRef(null);
  const retry = useRef(null);

  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('idle');
  const [meta, setMeta] = useState(null);
  const [events, setEvents] = useState([]);
  const [screenshot, setScreenshot] = useState(null);
  const [outcome, setOutcome] = useState(null);

  useEffect(() => {
    let closed = false;

    const connect = () => {
      const ws = new WebSocket(URL);
      socket.current = ws;

      ws.onopen = () => setConnected(true);

      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry.current = setTimeout(connect, RECONNECT_MS);
      };

      ws.onmessage = ({ data }) => {
        const event = JSON.parse(data);

        if (event.type === 'status') {
          setStatus(event.status);
          if (event.status === 'running') setMeta(event);
          return;
        }

        if (event.type === 'observe' && event.screenshot) {
          setScreenshot(`data:image/jpeg;base64,${event.screenshot}`);
        }
        if (event.type === 'done') setOutcome({ ok: true, text: event.result });
        if (event.type === 'gave_up') setOutcome({ ok: false, text: event.reason });

        // Screenshots are big; keep them out of the timeline's state.
        const { screenshot: _drop, ...rest } = event;
        setEvents(prev => [...prev, rest]);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry.current);
      socket.current?.close();
    };
  }, []);

  const start = useCallback(task => {
    if (!task.trim() || socket.current?.readyState !== WebSocket.OPEN) return;
    setEvents([]);
    setScreenshot(null);
    setOutcome(null);
    setStatus('running');
    socket.current.send(JSON.stringify({ type: 'start', task }));
  }, []);

  const stop = useCallback(() => {
    socket.current?.send(JSON.stringify({ type: 'stop' }));
  }, []);

  return { connected, status, meta, events, screenshot, outcome, start, stop };
}
