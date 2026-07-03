// PM Bridge - records an explanatory demo video of a built web app.
// Usage: node record-demo.js <entry.html> <out.webm> [demo-script.json] [title]
// demo-script.json: [{ "action":"click|type|scroll|wait|goto", "selector":"css", "text":"...", "caption":"what this shows" }]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const [, , entry, outFile, scriptFile, titleArg] = process.argv;
if (!entry || !outFile) { console.error('usage: node record-demo.js <entry.html> <out.webm> [script.json] [title]'); process.exit(2); }

let steps = null;
if (scriptFile && fs.existsSync(scriptFile)) {
  try { steps = JSON.parse(fs.readFileSync(scriptFile, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.log('script parse failed, using generic tour'); }
}
const appTitle = titleArg || path.basename(path.dirname(entry));

(async () => {
  let browser = null;
  for (const channel of ['chrome', 'msedge']) {
    try { browser = await chromium.launch({ channel, headless: true }); break; }
    catch (e) { console.log(`channel ${channel} unavailable`); }
  }
  if (!browser) { console.error('no system browser found'); process.exit(3); }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: path.dirname(outFile), size: { width: 1280, height: 720 } }
  });
  const page = await ctx.newPage();
  await page.goto('file:///' + entry.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });

  // ---------- overlay toolkit (intro card, caption bar, ghost cursor) ----------
  await page.evaluate(({ title }) => {
    const s = document.createElement('style');
    s.textContent = `
      #__pmb_intro{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;
        align-items:center;justify-content:center;background:linear-gradient(135deg,#0b1220,#1a2a4a);
        color:#fff;font-family:'Segoe UI',sans-serif;transition:opacity .8s}
      #__pmb_intro h1{font-size:52px;margin:0 0 12px}
      #__pmb_intro p{font-size:22px;color:#9fc3ff;margin:4px}
      #__pmb_cap{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:2147483646;
        background:rgba(10,16,28,.92);color:#fff;font-family:'Segoe UI',sans-serif;font-size:24px;
        padding:14px 30px;border-radius:12px;border:1px solid #3d6fb4;max-width:85%;
        opacity:0;transition:opacity .4s;box-shadow:0 6px 24px rgba(0,0,0,.5)}
      #__pmb_cur{position:fixed;z-index:2147483647;width:26px;height:26px;border-radius:50%;
        background:rgba(255,210,60,.85);border:3px solid #fff;pointer-events:none;
        transition:all .7s cubic-bezier(.4,0,.2,1);box-shadow:0 0 14px rgba(255,210,60,.9);
        left:640px;top:360px}`;
    document.head.appendChild(s);
    const intro = document.createElement('div');
    intro.id = '__pmb_intro';
    intro.innerHTML = `<h1>${title}</h1><p>Automated build demo</p><p>built by PM Bridge + GitHub Copilot</p>`;
    document.body.appendChild(intro);
    const cap = document.createElement('div'); cap.id = '__pmb_cap'; document.body.appendChild(cap);
    const cur = document.createElement('div'); cur.id = '__pmb_cur'; document.body.appendChild(cur);
    window.__pmb = {
      caption(t) {
        const c = document.getElementById('__pmb_cap');
        if (!t) { c.style.opacity = 0; return; }
        c.textContent = t; c.style.opacity = 1;
      },
      async moveCursor(x, y) {
        const c = document.getElementById('__pmb_cur');
        c.style.left = (x - 13) + 'px'; c.style.top = (y - 13) + 'px';
        await new Promise(r => setTimeout(r, 750));
        c.style.transform = 'scale(.6)'; await new Promise(r => setTimeout(r, 160));
        c.style.transform = 'scale(1)';
      },
      hideIntro() { const i = document.getElementById('__pmb_intro'); i.style.opacity = 0; setTimeout(() => i.remove(), 900); }
    };
  }, { title: appTitle });

  await page.waitForTimeout(3200);                       // intro card
  await page.evaluate(() => window.__pmb.hideIntro());
  await page.waitForTimeout(1000);

  const caption = async (t, ms = 900) => { await page.evaluate(x => window.__pmb.caption(x), t || ''); await page.waitForTimeout(ms); };
  const clickWithCursor = async (el) => {
    await el.scrollIntoViewIfNeeded();
    const box = await el.boundingBox();
    if (!box) return false;
    await page.evaluate(p => window.__pmb.moveCursor(p.x, p.y), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    try { await el.click({ timeout: 1500 }); return true; } catch { return false; }
  };

  if (steps && Array.isArray(steps) && steps.length) {
    console.log(`running scripted demo: ${steps.length} steps`);
    for (const st of steps.slice(0, 14)) {
      try {
        if (st.caption) await caption(st.caption, 1400);
        if (st.action === 'click' && st.selector) {
          const el = await page.$(st.selector);
          if (el) await clickWithCursor(el);
          await page.waitForTimeout(1400);
        } else if (st.action === 'type' && st.selector) {
          const el = await page.$(st.selector);
          if (el) { await el.scrollIntoViewIfNeeded(); await el.click({ timeout: 1200 }).catch(() => {}); await el.fill('', { timeout: 1200 }).catch(() => {}); await el.type(st.text || 'demo', { delay: 90 }); }
          await page.waitForTimeout(1200);
        } else if (st.action === 'scroll') {
          await page.evaluate(async () => { window.scrollBy({ top: 500, behavior: 'smooth' }); });
          await page.waitForTimeout(1300);
        } else if (st.action === 'wait') {
          await page.waitForTimeout(Math.min((st.ms || 1500), 5000));
        }
        await page.keyboard.press('Escape').catch(() => {});
      } catch (e) { console.log('step skipped: ' + e.message.split('\n')[0]); }
    }
  } else {
    console.log('running generic tour');
    await caption(`This is ${appTitle} - let's take a quick look around.`, 2000);
    await page.evaluate(async () => { for (let y = 0; y <= document.body.scrollHeight; y += 300) { window.scrollTo({ top: y, behavior: 'smooth' }); await new Promise(r => setTimeout(r, 320)); } window.scrollTo({ top: 0 }); });
    const inputs = await page.$$('input[type="text"], input[type="search"], input:not([type])');
    if (inputs.length) { await caption('Trying the input fields...', 1200); try { await inputs[0].type('demo', { delay: 100 }); } catch {} }
    const clickables = await page.$$('button, a[href="#"], [role="button"], .btn');
    if (clickables.length) await caption('Testing the interactive elements...', 1200);
    for (let i = 0; i < Math.min(clickables.length, 5); i++) {
      try { await clickWithCursor(clickables[i]); await page.waitForTimeout(1100); await page.keyboard.press('Escape').catch(() => {}); } catch {}
    }
  }

  await caption('Build complete - delivered by PM Bridge.', 2600);
  await caption('');
  await page.waitForTimeout(700);

  await ctx.close();
  const video = await page.video();
  const tmp = await video.path();
  await browser.close();
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  fs.renameSync(tmp, outFile);
  console.log('video saved: ' + outFile);
})().catch(e => { console.error(e.message); process.exit(1); });
