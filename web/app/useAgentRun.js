'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const URL = process.env.NEXT_PUBLIC_AGENT_WS ?? 'ws://localhost:3001';
const RECONNECT_MS = 2000;

// One socket for the page lifetime; reconnects if the backend restarts.
export function useAgentRun() {
  const socket = useRef(null);
  const retry = useRef(null);

  const [connected, setConnected] = useState(false);
  const [status, setStatusState] = useState('idle');
  // Mirror for the socket callbacks, which close over the first render.
  const statusRef = useRef('idle');
  const setStatus = useCallback(s => { statusRef.current = s; setStatusState(s); }, []);
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
        // The run died with the server; don't leave the UI spinning.
        if (statusRef.current === 'running' || statusRef.current === 'stopping') {
          setOutcome({ kind: 'disconnected', text: 'The backend went away mid-run.' });
          setStatus('gave_up');
        }
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
        if (event.type === 'done') setOutcome({ kind: 'done', text: event.result });
        if (event.type === 'gave_up') setOutcome({ kind: event.kind ?? 'crash', text: event.reason, steps: event.steps });

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
  }, [setStatus]);

  const start = useCallback(task => {
    if (!task.trim() || socket.current?.readyState !== WebSocket.OPEN) return;
    setEvents([]);
    setScreenshot(null);
    setOutcome(null);
    setStatus('running');
    socket.current.send(JSON.stringify({ type: 'start', task }));
  }, [setStatus]);

  // Optimistic: the server's final status event replaces 'stopping'.
  const stop = useCallback(() => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    setStatus('stopping');
    socket.current.send(JSON.stringify({ type: 'stop' }));
  }, [setStatus]);

  return { connected, status, meta, events, screenshot, outcome, start, stop };
}
