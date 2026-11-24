// Headless driver for the layout spike: loads the isolated serve-web workbench, screenshots each
// stage the spike extension announces, and acks it. Never touches :4100 or the owner's /ide/.
import { chromium } from '/Users/mwk/Development/cluesmith/codev/node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core/index.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SK = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(SK, 'out');
const SHOTS = path.join(SK, 'shots');
const PORT = Number(process.env.SPIKE_PORT);
if (!PORT || PORT === 4100) throw new Error('SPIKE_PORT must be set and must not be 4100');
const url = `http://127.0.0.1:${PORT}/?folder=${encodeURIComponent(path.join(SK, 'ws'))}`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleLog = fs.createWriteStream(path.join(OUT, 'browser-console.log'));
page.on('console', (m) => consoleLog.write(`[${m.type()}] ${m.text()}\n`));
page.on('request', (r) => { const u = r.url(); if (u.includes(':4100')) { consoleLog.write(`!!! REQUEST TO 4100: ${u}\n`); } });

console.log('goto', url);
await page.goto(url, { timeout: 240000, waitUntil: 'domcontentloaded' });
await page.waitForSelector('.monaco-workbench', { timeout: 240000 });
console.log('workbench up');
await page.screenshot({ path: path.join(SHOTS, '00-workbench.png') });

const deadline = Date.now() + 5 * 60 * 1000;
let trustClicked = false;
while (Date.now() < deadline) {
  const btn = page.getByRole('button', { name: /Yes, I trust|Trust Folder/i });
  if (await btn.count()) { await btn.first().click(); trustClicked = true; console.log('trust prompt accepted'); }
  for (const f of fs.readdirSync(OUT)) {
    if (!f.startsWith('stage-') || f.endsWith('.ack')) continue;
    const ack = path.join(OUT, `${f}.ack`);
    if (fs.existsSync(ack)) continue;
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(SHOTS, `${f.slice(6)}.png`) });
    fs.writeFileSync(ack, '');
    console.log('shot', f);
    if (f === 'stage-done') { await browser.close(); process.exit(0); }
  }
  await page.waitForTimeout(500);
}
console.log('timed out waiting for the spike');
await page.screenshot({ path: path.join(SHOTS, 'timeout.png') });
await browser.close();
process.exit(2);
