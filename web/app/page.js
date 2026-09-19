'use client';

import { useState } from 'react';
import { useAgentRun } from './useAgentRun';
import { Timeline } from './Timeline';

const EXAMPLES = [
  'who was Ada Lovelace',
  'what is the top story on Hacker News right now, and how many points does it have',
  'log in to saucedemo.com with the demo credentials on the page, then name the cheapest product',
];

// Headline and hint per outcome kind; the raw reason stays in the timeline.
const OUTCOMES = {
  done:         { title: 'Done',                 tone: 'done' },
  stopped:      { title: 'Stopped',              tone: 'stopped', hint: o => `Stopped after ${o.steps} steps.` },
  step_limit:   { title: 'Ran out of steps',     tone: 'gave-up', hint: () => 'The agent hit its step limit without finishing. Try a more specific task.' },
  timeout:      { title: 'Timed out',            tone: 'gave-up', hint: () => 'The run hit its time limit, usually because the model API was slow to answer.' },
  quota:        { title: 'Model quota used up',  tone: 'gave-up', hint: () => 'The free-tier Gemini quota is exhausted. It resets daily, so try again later.' },
  model:        { title: 'Model error',          tone: 'gave-up', hint: () => 'The model API returned an error. Details are in the timeline.' },
  crash:        { title: 'Something broke',      tone: 'gave-up', hint: () => 'The browser or server hit an error. Details are in the timeline.' },
  disconnected: { title: 'Lost connection',      tone: 'gave-up', hint: () => 'The backend went away mid-run. It reconnects on its own, so start again once the dot is green.' },
};

export default function Home() {
  const { connected, status, meta, events, screenshot, outcome, start, stop } = useAgentRun();
  const [task, setTask] = useState(EXAMPLES[0]);
  const running = status === 'running' || status === 'stopping';
  const stopping = status === 'stopping';

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
          <button type="submit" className={running ? 'stop' : 'start'} disabled={!connected || stopping}>
            {stopping ? 'Stopping…' : running ? 'Stop' : 'Start'}
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
              {!running
                ? 'The live browser view appears here once a run starts.'
                : events.length ? 'Planning the first step…' : 'Launching browser…'}
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
  if (status === 'stopping') {
    return (
      <div className="banner stopped">
        <span className="spinner" />
        Stopping…
      </div>
    );
  }
  const o = OUTCOMES[outcome?.kind] ?? OUTCOMES.crash;
  return (
    <div className={`banner ${o.tone}`}>
      <strong>{o.title}</strong>
      <span className="text">{o.hint ? o.hint(outcome) : outcome?.text}</span>
    </div>
  );
}
