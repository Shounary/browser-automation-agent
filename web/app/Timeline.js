'use client';

import { useEffect, useRef } from 'react';

export function Timeline({ events, running }) {
  const end = useRef(null);

  // Newest at the bottom, so follow it.
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [events.length]);

  return (
    <div className="timeline">
      <h2>Reasoning &amp; actions</h2>
      <ol>
        {events.map((event, i) => (
          <Event key={i} event={event} />
        ))}
      </ol>
      {!events.length && !running && <p className="placeholder">Each step the agent takes shows up here.</p>}
      <div ref={end} />
    </div>
  );
}

function Event({ event }) {
  switch (event.type) {
    case 'observe':
      return (
        <li className="observe">
          <span className="step">step {event.step}</span>
          <span className="where">{event.title || event.url}</span>
          <span className="count">{event.elements} elements</span>
        </li>
      );

    case 'action':
      return (
        <li className="action">
          <code>{describe(event.action)}</code>
          <p className="why">{event.action.reason}</p>
        </li>
      );

    case 'result':
      return <li className={event.ok ? 'ok' : 'fail'}>{event.message}</li>;

    case 'done':
      return <li className="final done"><strong>Done</strong> — {event.result}</li>;

    case 'gave_up':
      return <li className="final gave-up"><strong>Gave up</strong> — {event.reason}</li>;

    case 'error':
      return <li className="fail">{event.message}</li>;

    default:
      return null;
  }
}

function describe(a) {
  switch (a.name) {
    case 'navigate': return `navigate ${a.url}`;
    case 'click':    return `click [${a.id}]`;
    case 'type':     return `type "${a.text}" into [${a.id}]`;
    case 'scroll':   return `scroll ${a.direction}`;
    case 'wait':     return 'wait';
    case 'done':     return 'done';
    default:         return a.name;
  }
}
