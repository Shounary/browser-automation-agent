import { chromium } from "playwright";


const browser = await chromium.launch({headless: false})
const page = await browser.newPage()
await page.goto("https://en.wikipedia.org")
console.log(await page.content())
await page.waitForTimeout(5000)
await browser.close()
