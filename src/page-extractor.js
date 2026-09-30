const SELECTOR = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="tab"]'
].join(', ');

// The model has to read the page to answer, but a full article blows the
// budget. Enough for a lead paragraph or a result list.
const MAX_PAGE_TEXT = 2000;

export async function extractInteractiveElements(page, { viewportOnly = true } = {}) {
    // A fixed four round trips per page. Three per element cost 100s on one
    // Wikipedia step on a 0.1 CPU host.
    const found = await page.evaluateHandle(collect, { selector: SELECTOR, viewportOnly });
    const infos = await found.evaluate(f => f.infos);
    const els = await found.getProperty('els');
    const handles = [];
    for (const [i, h] of await els.getProperties()) handles[Number(i)] = h.asElement();
    await Promise.all([found.dispose(), els.dispose()]);

    const map = [];
    const lines = [];
    for (const [id, d] of infos.entries()) {
        const extra = (d.role === 'input') ? ` (${d.type})` : "";
        const line = `[${id}] ${d.role} "${d.name}"${extra}`;

        // Handles die on navigation
        map.push({handle: handles[id], line})
        lines.push(line);
    }

    return {
        text: lines.join('\n'),
        map,
        url: page.url(),
        title: await page.title().catch(() => ''),
        pageText: await readablePageText(page),
    };
}

// Runs in the page, so it can't reference anything else in this module.
function collect({ selector, viewportOnly }) {
  const els = [];
  const infos = [];
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    // Same rule as Playwright's isVisible/isDisabled, which this replaces.
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    if (viewportOnly && !(r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) continue;

    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');

    let role = el.getAttribute('role');
    if (!role) {
      if (tag === 'a') {
        role = 'link';
      } else if (tag === 'input') {
        role = (type === 'checkbox' || type === 'radio' || type === 'submit') ? type : 'input';
      } else {
        role = tag;
      }
    }

    const name = [
      el.getAttribute('aria-label'),
      el.innerText,
      el.getAttribute('placeholder'),
      el.getAttribute('value'),
      el.getAttribute('alt'),
      el.getAttribute('title'),
      // Icon links carry no text. The tail of the href is usually meaningful
      // ("/wiki/Ada_Lovelace") and beats dropping the element entirely.
      tag === 'a' ? decodeURIComponent(el.getAttribute('href') || '').split(/[/#?]/).filter(Boolean).pop() : null,
      el.getAttribute('name'),
    ].find(c => c && c.trim()) || '';
    // An element with no name is not something the model can reason about.
    if (!name.trim()) continue;

    els.push(el);
    infos.push({ role, type: type || 'text', name: name.trim().replace(/\s+/g, ' ').slice(0, 60) });
  }
  return { els, infos };
}

async function readablePageText(page) {
  const raw = await page
    .evaluate(() => {
      const container = document.querySelector('article, main, [role="main"]') || document.body;

      // innerText needs layout, so the chrome has to actually be hidden rather
      // than cloned away. Hidden and restored within this one call.
      const chrome = container.querySelectorAll(
        'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="complementary"], script, style'
      );
      const restore = [];
      for (const el of chrome) {
        restore.push([el, el.style.display]);
        el.style.display = 'none';
      }

      const text = container.innerText || '';
      for (const [el, display] of restore) el.style.display = display;
      return text;
    })
    .catch(() => '');

  const clean = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > MAX_PAGE_TEXT
    ? `${clean.slice(0, MAX_PAGE_TEXT)}\n…[truncated]`
    : clean;
}
