// PM Bridge - narrated demo video: scripted walkthrough + TTS voice-over + small captions.
// Usage: node record-demo2.js <entry.html> <out.webm> [demo-script.json] [title]
const { chromium } = require('playwright');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [, , entry, outFile, scriptFile, titleArg] = process.argv;
if (!entry || !outFile) { console.error('usage: node record-demo2.js <entry.html> <out.webm> [script.json] [title]'); process.exit(2); }

let steps = null;
if (scriptFile && fs.existsSync(scriptFile)) {
  try { steps = JSON.parse(fs.readFileSync(scriptFile, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.log('script parse failed, using generic tour'); }
}
const appTitle = titleArg || path.basename(path.dirname(entry));
const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pmb-vid-'));

// ---------- TTS: Windows built-in voice, no admin needed ----------
function tts(text, wavPath) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const ps = `Add-Type -AssemblyName System.Speech; $t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=1; try { $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -match 'Zira|Aria|Jenny' } | Select-Object -First 1; if ($v) { $s.SelectVoice($v.VoiceInfo.Name) } } catch {}; $s.SetOutputToWaveFile('${wavPath.replace(/\\/g, '\\\\')}'); $s.Speak($t); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 60000 });
}
function wavDurationMs(wavPath) {
  try {
    const b = fs.readFileSync(wavPath);
    const byteRate = b.readUInt32LE(28);
    return Math.round(((b.length - 44) / byteRate) * 1000);
  } catch { return 2000; }
}

(async () => {
  let browser = null;
  for (const channel of ['chrome', 'msedge']) {
    try { browser = await chromium.launch({ channel, headless: true }); break; }
    catch (e) { console.log(`channel ${channel} unavailable`); }
  }
  if (!browser) { console.error('no system browser found'); process.exit(3); }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: tmpDir, size: { width: 1280, height: 720 } }
  });
  const page = await ctx.newPage();
  const t0 = Date.now();                       // ~recording start
  const audioCues = [];                        // { ms, wav }
  let cueSeq = 0;

  const speak = (text) => {                    // pre-render voice + schedule at current video time
    try {
      const wav = path.join(tmpDir, `cue${cueSeq++}.wav`);
      tts(text, wav);
      const ms = Date.now() - t0;
      audioCues.push({ ms, wav });
      return wavDurationMs(wav);
    } catch (e) { console.log('tts failed: ' + e.message.split('\n')[0]); return 1500; }
  };

  await page.goto('file:///' + entry.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });

  // ---------- overlays: intro card, SMALL caption bar, ghost cursor ----------
  await page.evaluate(({ title }) => {
    const s = document.createElement('style');
    s.textContent = `
      #__pmb_intro{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;
        align-items:center;justify-content:center;background:linear-gradient(135deg,#0b1220,#1a2a4a);
        color:#fff;font-family:'Segoe UI',sans-serif;transition:opacity .8s}
      #__pmb_intro h1{font-size:46px;margin:0 0 10px}
      #__pmb_intro p{font-size:19px;color:#9fc3ff;margin:3px}
      #__pmb_cap{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483646;
        background:rgba(8,12,22,.72);color:#e8eefc;font-family:'Segoe UI',sans-serif;font-size:13px;
        line-height:1.35;padding:5px 14px;border-radius:7px;max-width:62%;text-align:center;
        opacity:0;transition:opacity .35s;pointer-events:none}
      #__pmb_cur{position:fixed;z-index:2147483647;width:22px;height:22px;border-radius:50%;
        background:rgba(255,210,60,.8);border:2px solid #fff;pointer-events:none;
        transition:all .65s cubic-bezier(.4,0,.2,1);box-shadow:0 0 10px rgba(255,210,60,.8);
        left:640px;top:360px}`;
    document.head.appendChild(s);
    const intro = document.createElement('div');
    intro.id = '__pmb_intro';
    intro.innerHTML = `<h1>${title}</h1><p>Automated demo walkthrough</p><p>built &amp; delivered by PM Bridge + GitHub Copilot</p>`;
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
        c.style.left = (x - 11) + 'px'; c.style.top = (y - 11) + 'px';
        await new Promise(r => setTimeout(r, 680));
        c.style.transform = 'scale(.6)'; await new Promise(r => setTimeout(r, 150));
        c.style.transform = 'scale(1)';
      },
      hideIntro() { const i = document.getElementById('__pmb_intro'); if (i) { i.style.opacity = 0; setTimeout(() => i.remove(), 900); } }
    };
  }, { title: appTitle });

  // Intro with voice
  const introDur = speak(`This is ${appTitle}. An automated demo, built and delivered by P M Bridge.`);
  await page.waitForTimeout(Math.max(introDur + 400, 3000));
  await page.evaluate(() => window.__pmb.hideIntro());
  await page.waitForTimeout(800);

  // caption shows small text AND speaks it; waits for the voice to finish
  const narrate = async (text, extraMs = 500) => {
    await page.evaluate(x => window.__pmb.caption(x), text || '');
    if (!text) return;
    const dur = speak(text);
    await page.waitForTimeout(dur + extraMs);
  };
  const clickWithCursor = async (el) => {
    try {
      await el.scrollIntoViewIfNeeded();
      const box = await el.boundingBox();
      if (!box) return false;
      await page.evaluate(p => window.__pmb.moveCursor(p.x, p.y), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await el.click({ timeout: 1500 });
      return true;
    } catch { return false; }
  };

  if (steps && Array.isArray(steps) && steps.length) {
    console.log(`scripted walkthrough: ${steps.length} steps`);
    for (const st of steps.slice(0, 14)) {
      try {
        if (st.caption) await narrate(st.caption, 300);
        if (st.action === 'click' && st.selector) {
          const el = await page.$(st.selector);
          if (el) await clickWithCursor(el);
          await page.waitForTimeout(1200);
        } else if (st.action === 'type' && st.selector) {
          const el = await page.$(st.selector);
          if (el) { await el.scrollIntoViewIfNeeded(); await el.click({ timeout: 1200 }).catch(() => {}); await el.type(st.text || 'demo', { delay: 85 }).catch(() => {}); }
          await page.waitForTimeout(1000);
        } else if (st.action === 'scroll') {
          await page.evaluate(() => window.scrollBy({ top: 480, behavior: 'smooth' }));
          await page.waitForTimeout(1100);
        } else if (st.action === 'wait') {
          await page.waitForTimeout(Math.min((st.ms || 1200), 5000));
        }
        await page.keyboard.press('Escape').catch(() => {});
      } catch (e) { console.log('step skipped: ' + e.message.split('\n')[0]); }
    }
  } else {
    console.log('generic narrated tour');
    await narrate(`Let's take a quick look around the app.`);
    await page.evaluate(async () => { for (let y = 0; y <= document.body.scrollHeight; y += 300) { window.scrollTo({ top: y, behavior: 'smooth' }); await new Promise(r => setTimeout(r, 300)); } window.scrollTo({ top: 0 }); });
    const clickables = await page.$$('button, a[href="#"], [role="button"], .btn');
    if (clickables.length) await narrate('Now testing the interactive elements.');
    for (let i = 0; i < Math.min(clickables.length, 5); i++) {
      if (await clickWithCursor(clickables[i])) await page.waitForTimeout(1000);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  await narrate('That completes the demo. Build delivered by P M Bridge.', 800);
  await page.evaluate(() => window.__pmb.caption(''));
  await page.waitForTimeout(600);

  await ctx.close();
  const tmpVideo = await page.video().path();
  await browser.close();

  // ---------- mux voice-over into the video ----------
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  let muxed = false;
  if (audioCues.length) {
    try {
      const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
      const args = ['-y', '-i', tmpVideo];
      audioCues.forEach(c => args.push('-i', c.wav));
      const delays = audioCues.map((c, i) => `[${i + 1}:a]adelay=${c.ms}|${c.ms}[a${i}]`).join(';');
      const amix = audioCues.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${audioCues.length}:dropout_transition=0,volume=2.2[aout]`;
      args.push('-filter_complex', `${delays};${amix}`, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '96k', outFile);
      const r = spawnSync(ffmpeg, args, { stdio: 'pipe', timeout: 300000 });
      muxed = r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 10000;
      if (!muxed) console.log('ffmpeg mux failed: ' + (r.stderr || '').toString().split('\n').slice(-4).join(' '));
    } catch (e) { console.log('mux error: ' + e.message.split('\n')[0]); }
  }
  if (!muxed) fs.copyFileSync(tmpVideo, outFile);   // fallback: captions-only video
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  console.log(`video saved: ${outFile} (voice-over: ${muxed ? 'YES' : 'no'})`);
})().catch(e => { console.error(e.message); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { } process.exit(1); });
