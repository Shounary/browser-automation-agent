// Phase 1 checkpoint: a hardcoded task on a real site, no LLM.
// Run: node src/wikipedia-run.js   (HEADED=1 to watch it)

import { chromium } from 'playwright';
import { extractInteractiveElements } from './page-extractor.js';
import { executeAction, suppressPopups } from './page-actions.js';

const START = 'https://en.wikipedia.org/wiki/Main_Page';
const QUERY = 'Ada Lovelace';

// Stands in for what the model will emit in Phase 2. `match` is resolved
// against the freshly extracted lines each step, since ids shift as the page does.
const PLAN = [
  { name: 'navigate', url: START },
  { name: 'type', match: /input "Search Wikipedia"/i, text: QUERY },
  { name: 'click', match: /button "Search"/i },
];

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const popups = await suppressPopups(page.context(), page);

let failed = false;

for (const [step, planned] of PLAN.entries()) {
  // Re-extract every step; never reuse a map across actions.
  const { text, map } = await extractInteractiveElements(page);
  console.log(`\n--- step ${step} --- ${map.length} elements`);

  const action = { ...planned };
  if (planned.match) {
    action.id = map.findIndex(e => planned.match.test(e.line));
    if (action.id === -1) {
      console.log(text);
      console.error(`no element matching ${planned.match}`);
      failed = true;
      break;
    }
  }

  const result = await executeAction(page, map, action, { popups });
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${result.message}`);
  if (!result.ok) {
    failed = true;
    break;
  }
}

if (!failed) {
  const title = await page.title();
  console.log(`\nlanded on: ${title} — ${page.url()}`);
  failed = !title.includes(QUERY);
  console.log(failed ? 'task FAILED' : 'task complete');
}

await browser.close();
process.exit(failed ? 1 : 0);
