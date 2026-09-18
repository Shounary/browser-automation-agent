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
    const map = [];
    const lines = [];
    const handles = await page.$$(SELECTOR);

    for (const h of handles) {
        if (!(await h.isVisible())) continue;
        if (await h.isDisabled().catch(() => false)) continue;

        // One round trip per element. Reading the attributes one at a time
        // cost six, which on a 250-element page is most of the step latency.
        const d = await describe(h);
        if (viewportOnly && !d.inViewport) continue;
        // An element with no name is not something the model can reason about.
        if (!d.name) continue;

        const id = map.length;
        const extra = (d.role === 'input') ? ` (${d.type})` : "";
        const line = `[${id}] ${d.role} "${d.name}"${extra}`;

        // Handles die on navigation
        map.push({handle: h, line})
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

async function describe(h) {
  return h.evaluate(el => {
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

    const r = el.getBoundingClientRect();

    return {
      role,
      type: type || 'text',
      name: name.trim().replace(/\s+/g, ' ').slice(0, 60),
      inViewport:
        r.bottom > 0 && r.right > 0 &&
        r.top < window.innerHeight && r.left < window.innerWidth,
    };
  });
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
