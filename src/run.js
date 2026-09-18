// run a plain-English task in the terminal.
//
//   node src/run.js "who was Ada Lovelace"
//   HEADED=1 node src/run.js "find the cheapest backpack on saucedemo"

import { chromium } from 'playwright';
import { suppressPopups } from './page-actions.js';
import { createGeminiClient } from './llm-gemini.js';
import { runTask, ALLOWED_DOMAINS } from './agent.js';

// Node reads .env natively; absent is fine if the key is exported instead.
try {
  process.loadEnvFile();
} catch {}

const task = process.argv.slice(2).join(' ').trim();
if (!task) {
  console.error('usage: node src/run.js "<task>"');
  console.error(`allowed sites: ${ALLOWED_DOMAINS.join(', ')}`);
  process.exit(2);
}

const llm = createGeminiClient();

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const popups = await suppressPopups(page.context(), page);

console.log(`task:  ${task}`);
console.log(`model: ${llm.models.join(' -> ')}\n`);

const run = await runTask({ task, page, llm, popups, onEvent: log });

console.log();
if (run.status === 'done') {
  console.log(`RESULT: ${run.result}`);
} else {
  console.log(`GAVE UP: ${run.reason}`);
}

await browser.close();
process.exit(run.status === 'done' ? 0 : 1);

function log(event) {
  switch (event.type) {
    case 'observe':
      console.log(`--- step ${event.step} --- ${event.elements} elements — ${event.title || event.url}`);
      break;
    case 'action':
      console.log(`  ${describe(event.action)}`);
      console.log(`  why: ${event.action.reason}`);
      break;
    case 'result':
      console.log(`  ${event.ok ? 'ok  ' : 'FAIL'} ${event.message}\n`);
      break;
  }
}

function describe(a) {
  switch (a.name) {
    case 'navigate': return `navigate ${a.url}`;
    case 'click':    return `click [${a.id}]`;
    case 'type':     return `type "${a.text}" into [${a.id}]`;
    case 'scroll':   return `scroll ${a.direction}`;
    case 'done':     return 'done';
    default:         return a.name;
  }
}
