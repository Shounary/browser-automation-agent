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

export async function extractInteractiveElements(page) {
    const map = [];
    const lines = [];
    const handles = await page.$$(SELECTOR);

    for (const h of handles) {
        if (!(await h.isVisible())) continue;
        if (await h.isDisabled().catch(() => false)) continue;

        const id = map.length;
        const role = await describeRole(h);
        const name = await accessibleName(h);
        const extra = (role === 'input') ? ` (${await inputType(h)})` : "";

        map.push(h)
        lines.push(`[${id}] ${role} "${name}"${extra}`);
    }

    return {text: lines.join('\n'), map};
}

async function describeRole(h) {
  const role = await h.getAttribute('role');
  if (role) return role;

  const tag = await h.evaluate(el => el.tagName.toLowerCase());
  if (tag === 'a') return 'link';
  if (tag === 'input') {
    const type = await h.getAttribute('type');
    if (type === 'checkbox' || type === 'radio' || type === 'submit') return type;
    return 'input';
  }
  return tag;
}

async function accessibleName(h) {
  const candidates = [
    await h.getAttribute('aria-label'),
    await h.evaluate(el => el.innerText),
    await h.getAttribute('placeholder'),
    await h.getAttribute('value'),
    await h.getAttribute('alt'),
    await h.getAttribute('title'),
  ];
  const name = candidates.find(c => c && c.trim());
  return (name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

async function inputType(h) {
  const type = await h.getAttribute('type');
  return type || 'text';
}