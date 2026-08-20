// Action executors; each returns { ok, message }

const ACTION_TIMEOUT_MS = 5000;
const NAVIGATE_TIMEOUT_MS = 15000;
const SETTLE_MS = 300;
const WAIT_MS = 1000;
const SCROLL_FRACTION = 0.8;

const ok = message => ({ ok: true, message });
const fail = message => ({ ok: false, message });

export async function navigate(page, url) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATE_TIMEOUT_MS,
    });
  } catch (err) {
    return fail(`could not load ${url}: ${firstLine(err)}`);
  }

  await settle(page);
  return ok(`navigated to ${page.url()}`);
}

export async function click(page, map, id, { popups } = {}) {
  const { entry, error } = resolve(map, id);
  if (error) return fail(error);

  try {
    await entry.handle.click({ timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    return fail(`could not click ${entry.line}: ${firstLine(err)}`);
  }

  await settle(page);

  if (popups?.()) {
    return fail(
      `clicked ${entry.line} — it opened a new tab, which is not supported. ` +
      `The page did not change; try a different element.`
    );
  }

  return ok(`clicked ${entry.line}`);
}

export async function type(page, map, id, text) {
  const { entry, error } = resolve(map, id);
  if (error) return fail(error);

  try {
    await entry.handle.fill(text, { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    return fail(`could not type into ${entry.line}: ${firstLine(err)}`);
  }

  await settle(page);
  return ok(`typed "${text}" into ${entry.line}`);
}

export async function scroll(page, direction) {
  if (direction !== 'up' && direction !== 'down') {
    return fail(`unknown scroll direction "${direction}" — use "up" or "down"`);
  }

  const { height } = page.viewportSize() ?? { height: 800 };
  const delta = Math.round(height * SCROLL_FRACTION);
  await page.mouse.wheel(0, direction === 'down' ? delta : -delta);
  await page.waitForTimeout(SETTLE_MS);

  // Tell the model when there's nothing left or it will keep scrolling
  const edge = await page.evaluate(() => ({
    top: window.scrollY <= 2,
    bottom:
      window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - 2,
  }));

  if (direction === 'down' && edge.bottom) {
    return ok('scrolled down — this is the bottom of the page');
  }
  if (direction === 'up' && edge.top) {
    return ok('scrolled up — this is the top of the page');
  }
  return ok(`scrolled ${direction}`);
}

export async function wait(page) {
  await page.waitForTimeout(WAIT_MS);
  return ok(`waited ${WAIT_MS}ms for the page to settle`);
}

// popup guard
export async function suppressPopups(context, page) {
  await page.addInitScript(() => {
    window.open = url => {
      if (url) location.href = url;
      return null;
    };
  });

  let seen = false;
  context.on('page', async popup => {
    if (popup === page) return;
    seen = true;
    await popup.close().catch(() => {});
  });

  return () => {
    const was = seen;
    seen = false;
    return was;
  };
}

// Waits out a navigation the click may have started
async function settle(page) {
  await page
    .waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT_MS })
    .catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
}

function resolve(map, id) {
  if (!Number.isInteger(id) || id < 0 || id >= map.length) {
    const range = map.length ? `0–${map.length - 1}` : 'none';
    return { error: `no element with id ${id} — this page has ${map.length} (${range})` };
  }
  return { entry: map[id] };
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0].trim();
}

export async function executeAction(page, map, action, options = {}) {
  switch (action.name) {
    case 'navigate':
      return navigate(page, action.url);
    case 'click':
      return click(page, map, action.id, options);
    case 'type':
      return type(page, map, action.id, action.text);
    case 'scroll':
      return scroll(page, action.direction);
    case 'wait':
      return wait(page);
    default:
      return fail(`unknown action "${action.name}"`);
  }
}
