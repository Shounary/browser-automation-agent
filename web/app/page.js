'use client';

import { useState } from 'react';
import { useAgentRun } from './useAgentRun';
import { Timeline } from './Timeline';

const EXAMPLES = [
  'who was Ada Lovelace',
  'what is the top story on Hacker News right now, and how many points does it have',
  'log in to saucedemo.com with the demo credentials on the page, then name the cheapest product',
];

export default function Home() {
  const { connected, status, meta, events, screenshot, outcome, start, stop } = useAgentRun();
  const [task, setTask] = useState(EXAMPLES[0]);
  const running = status === 'running';

  return (
    <main>
      <header>
        <h1>
          Browser Automation Agent
          <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'backend connected' : 'backend unreachable'} />
        </h1>

        <form
          onSubmit={e => {
            e.preventDefault();
            running ? stop() : start(task);
          }}
        >
          <input
            value={task}
            onChange={e => setTask(e.target.value)}
            placeholder="Describe a task in plain English"
            disabled={running}
          />
          <button type="submit" className={running ? 'stop' : 'start'} disabled={!connected}>
            {running ? 'Stop' : 'Start'}
          </button>
        </form>

        <div className="controls">
          <div className="modes">
            <span>Grounding</span>
            <button className="mode active" type="button">DOM</button>
            <button className="mode" type="button" disabled title="Not implemented yet — Phase 5">
              Vision
            </button>
          </div>
          <div className="examples">
            {EXAMPLES.map((e, i) => (
              <button key={e} type="button" onClick={() => setTask(e)} disabled={running}>
                example {i + 1}
              </button>
            ))}
          </div>
        </div>
      </header>

      <StatusBanner status={status} meta={meta} outcome={outcome} />

      <section className="split">
        <div className="view">
          {screenshot ? (
            <img src={screenshot} alt="What the agent currently sees" />
          ) : (
            <p className="placeholder">
              {running ? 'Launching browser…' : 'The live browser view appears here once a run starts.'}
            </p>
          )}
        </div>
        <Timeline events={events} running={running} />
      </section>
    </main>
  );
}

function StatusBanner({ status, meta, outcome }) {
  if (status === 'idle') {
    return <div className="banner idle">Idle — enter a task and press Start.</div>;
  }
  if (status === 'running') {
    return (
      <div className="banner running">
        <span className="spinner" />
        Running “{meta?.task}” · {meta?.model} · max {meta?.maxSteps} steps
      </div>
    );
  }
  return (
    <div className={`banner ${outcome?.ok ? 'done' : 'gave-up'}`}>
      <strong>{outcome?.ok ? 'Done' : 'Gave up'}</strong>
      <span className="text">{outcome?.text}</span>
    </div>
  );
}
