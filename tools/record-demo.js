// PM Bridge - records a short demo video of a built web app using system Chrome/Edge.
// Usage: node record-demo.js <absolute path to index.html> <output .webm>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [, , entry, outFile] = process.argv;
if (!entry || !outFile) { console.error('usage: node record-demo.js <entry.html> <out.webm>'); process.exit(2); }

(async () => {
  let browser = null;
  for (const channel of ['chrome', 'msedge']) {
    try { browser = await chromium.launch({ channel, headless: true }); break; }
    catch (e) { console.log(`channel ${channel} unavailable: ${e.message.split('\n')[0]}`); }
  }
  if (!browser) { console.error('no system browser found'); process.exit(3); }

  const dir = path.dirname(outFile);
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir, size: { width: 1280, height: 720 } }
  });
  const page = await ctx.newPage();
  await page.goto('file:///' + entry.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2500);

  // gentle generic interactions so the video shows the app working
  const clickables = await page.$$('button, a[href="#"], [role="button"], .btn, input[type="submit"]');
  for (let i = 0; i < Math.min(clickables.length, 6); i++) {
    try {
      await clickables[i].scrollIntoViewIfNeeded();
      await clickables[i].click({ timeout: 1500, force: false });
      await page.waitForTimeout(1200);
      // close any dialog/modal that opened
      await page.keyboard.press('Escape').catch(() => {});
    } catch { /* ignore uninteractable elements */ }
  }
  // scroll tour
  await page.evaluate(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y <= h; y += 250) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 180)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(1500);

  await ctx.close();          // finalizes the video
  const video = await page.video();
  const tmp = await video.path();
  await browser.close();
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  fs.renameSync(tmp, outFile);
  console.log('video saved: ' + outFile);
})().catch(e => { console.error(e.message); process.exit(1); });
