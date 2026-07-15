import { chromium } from "playwright";

chromium.launch().then((browser) => {
    browser.newPage()
})
