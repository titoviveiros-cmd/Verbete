// Captura /login para verificação visual da uniformização.
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto("http://localhost:5173/login");
await page.waitForTimeout(2500);
await page.screenshot({ path: "shots-login.png" });
await browser.close();
console.log("ok: shots-login.png");
