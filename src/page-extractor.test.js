import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { extractInteractiveElements } from "./page-extractor.js";

// One browser for the whole file; a fresh page per test so state can't leak.
let browser;
let page;

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
});

after(async () => {
  await browser?.close();
});

// Helper: load an HTML fragment and run the extractor against it.
async function extractFrom(html) {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  return extractInteractiveElements(page);
}

test("lists visible interactive elements with contiguous ids", async () => {
  const { text, map } = await extractFrom(`
    <a href="/home">Home</a>
    <button>Search</button>
  `);

  assert.equal(map.length, 2);
  assert.equal(text, '[0] link "Home"\n[1] button "Search"');
});

test("skips hidden and disabled elements without gapping ids", async () => {
  const { text, map } = await extractFrom(`
    <a href="/a">Visible</a>
    <a href="/b" style="display:none">Hidden</a>
    <button disabled>Disabled</button>
    <button>Enabled</button>
  `);

  // Only the two usable controls survive, and ids stay 0,1 — no gap left
  // by the skipped elements.
  assert.equal(map.length, 2);
  assert.equal(text, '[0] link "Visible"\n[1] button "Enabled"');
});

test("prefers aria-label over inner text for the name", async () => {
  const { text } = await extractFrom(`
    <button aria-label="Close dialog">X</button>
  `);

  assert.equal(text, '[0] button "Close dialog"');
});

test("names text inputs by placeholder and tags the input type", async () => {
  const { text } = await extractFrom(`
    <input placeholder="Search Wikipedia">
    <input type="email" placeholder="Email">
  `);

  assert.equal(
    text,
    '[0] input "Search Wikipedia" (text)\n[1] input "Email" (email)'
  );
});

test("promotes checkbox/radio inputs to their own role, no type suffix", async () => {
  const { text } = await extractFrom(`
    <input type="checkbox" aria-label="Accept">
  `);

  // describeRole pulls checkbox out of the generic 'input' bucket,
  // so there is no "(checkbox)" suffix.
  assert.equal(text, '[0] checkbox "Accept"');
});

test("collapses and truncates messy accessible names", async () => {
  const { text } = await extractFrom(`
    <button>  lots\n\n   of   whitespace  </button>
  `);

  assert.equal(text, '[0] button "lots of whitespace"');
});

test("returns empty text and map for a page with no controls", async () => {
  const { text, map } = await extractFrom(`<p>just some prose</p>`);

  assert.equal(map.length, 0);
  assert.equal(text, "");
});

test("drops elements that have no usable name", async () => {
  const { text, map } = await extractFrom(`
    <button></button>
    <button>Real</button>
  `);

  // A nameless control is not something the model can reason about, so it is
  // left out rather than listed as [n] button "".
  assert.equal(map.length, 1);
  assert.equal(text, '[0] button "Real"');
});

test("names an icon link from the tail of its href", async () => {
  const { text } = await extractFrom(`<a href="/wiki/Ada_Lovelace"><svg></svg></a>`);

  assert.equal(text, '[0] link "Ada_Lovelace"');
});

test("hides off-screen elements unless viewportOnly is disabled", async () => {
  const html = `
    <a href="/top">Top</a>
    <div style="height:4000px"></div>
    <a href="/bottom">Bottom</a>
  `;

  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const visible = await extractInteractiveElements(page);
  const all = await extractInteractiveElements(page, { viewportOnly: false });

  assert.equal(visible.text, '[0] link "Top"');
  assert.equal(all.map.length, 2);
});

test("reports url and title alongside the elements", async () => {
  const { url, title } = await extractFrom(`<title>A Page</title><button>Go</button>`);

  assert.equal(title, "A Page");
  assert.ok(url.startsWith("about:") || url.startsWith("http"));
});

test("reads page text without the surrounding nav chrome", async () => {
  const { pageText } = await extractFrom(`
    <main>
      <nav>Article Talk Read Edit</nav>
      <p>Ada Lovelace was a mathematician.</p>
    </main>
  `);

  assert.equal(pageText, "Ada Lovelace was a mathematician.");
});
