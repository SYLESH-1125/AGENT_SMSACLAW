// PM Bridge - narrated demo video v3: neural voice-over, pre-generated audio (fast pacing),
// real keyboard gameplay via "press" action, small captions, ghost cursor.
// Usage: node record-demo2.js <entry.html> <out.webm> [demo-script.json] [title]
const { chromium } = require('playwright');
const { execFileSync, spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const [, , entry, outFile, scriptFile, titleArg] = process.argv;
if (!entry || !outFile) { console.error('usage: node record-demo2.js <entry.html> <out.webm> [script.json] [title]'); process.exit(2); }

const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
const ttsPy = path.join(__dirname, 'tts.py');
const VOICE = process.env.PMB_VOICE || 'en-US-AriaNeural';
const RATE = process.env.PMB_RATE || '-5%';

let steps = null;
if (scriptFile && fs.existsSync(scriptFile)) {
  try { steps = JSON.parse(fs.readFileSync(scriptFile, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { console.log('script parse failed, using generic tour'); }
}
if (steps && !Array.isArray(steps)) steps = null;
const appTitle = titleArg || path.basename(path.dirname(entry));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmb-vid-'));

// ---------- TTS: neural (edge-tts) with SAPI fallback, pre-generated in parallel ----------
function sapiTts(text, wavPath) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const ps = `Add-Type -AssemblyName System.Speech; $t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=0; $s.SetOutputToWaveFile('${wavPath.replace(/\\/g, '\\\\')}'); $s.Speak($t); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 60000 });
}
function mp3ToWav(mp3, wav) {
  const r = spawnSync(ffmpeg, ['-y', '-i', mp3, '-ar', '48000', '-ac', '1', wav], { stdio: 'ignore', timeout: 60000 });
  return r.status === 0 && fs.existsSync(wav);
}
function wavDurationMs(wavPath) {
  try { const b = fs.readFileSync(wavPath); return Math.round(((b.length - 44) / b.readUInt32LE(28)) * 1000); }
  catch { return 2000; }
}
function neuralTts(text, wav) {
  return new Promise(resolve => {
    const mp3 = wav.replace(/\.wav$/, '.mp3');
    const p = spawn('python', [ttsPy, VOICE, RATE, mp3], { stdio: ['pipe', 'ignore', 'ignore'] });
    const to = setTimeout(() => { try { p.kill(); } catch { } resolve(false); }, 45000);
    p.stdin.write(text, 'utf8'); p.stdin.end();
    p.on('exit', c => { clearTimeout(to); resolve(c === 0 && fs.existsSync(mp3) && fs.statSync(mp3).size > 500 && mp3ToWav(mp3, wav)); });
    p.on('error', () => { clearTimeout(to); resolve(false); });
  });
}
async function pregenAudio(lines) {                 // lines: [{key,text}] -> map key->{wav,dur}
  const out = {}; let neuralOk = true;
  const jobs = lines.map((l, i) => async () => {
    const wav = path.join(tmpDir, `n${i}.wav`);
    let ok = neuralOk ? await neuralTts(l.text, wav) : false;
    if (!ok) {
      if (neuralOk) { neuralOk = false; console.log('neural TTS unavailable -> Windows voice fallback'); }
      try { sapiTts(l.text, wav); ok = fs.existsSync(wav); } catch { ok = false; }
    }
    out[l.key] = ok ? { wav, dur: wavDurationMs(wav) } : { wav: null, dur: Math.max(1400, l.text.length * 55) };
  });
  const POOL = 4;                                   // parallel synthesis = fast
  for (let i = 0; i < jobs.length; i += POOL) await Promise.all(jobs.slice(i, i + POOL).map(j => j()));
  return out;
}

(async () => {
  // ---------- 1. collect all narration up front ----------
  const narration = [{ key: 'intro', text: `This is ${appTitle}. An automated walk-through of the app we just built for you.` }];
  const stepList = (steps || []).slice(0, 20);
  stepList.forEach((st, i) => { if (st.caption) narration.push({ key: `s${i}`, text: String(st.caption) }); });
  if (!stepList.length) {
    narration.push({ key: 'g1', text: `Let's take a quick look around the interface.` });
    narration.push({ key: 'g2', text: 'Now testing the interactive elements of the app.' });
  }
  narration.push({ key: 'outro', text: 'That completes the demo. This build was delivered automatically by P M Bridge.' });

  console.log(`generating ${narration.length} voice lines (${VOICE})...`);
  const tract = Date.now();
  const audio = await pregenAudio(narration);
  console.log(`voice ready in ${Math.round((Date.now() - tract) / 1000)}s`);

  // ---------- 2. record ----------
  let browser = null;
  for (const channel of ['chrome', 'msedge']) {
    try { browser = await chromium.launch({ channel, headless: true }); break; }
    catch { console.log(`channel ${channel} unavailable`); }
  }
  if (!browser) { console.error('no system browser found'); process.exit(3); }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: tmpDir, size: { width: 1280, height: 720 } }
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  const audioCues = [];                              // { ms, wav }

  const say = async (key, capText, minMs = 0) => {   // caption + queue voice + wait its length
    await page.evaluate(x => window.__pmb && window.__pmb.caption(x), capText || '').catch(() => { });
    const a = audio[key];
    if (a) { if (a.wav) audioCues.push({ ms: Date.now() - t0, wav: a.wav }); await page.waitForTimeout(Math.max(a.dur + 350, minMs)); }
  };

  await page.goto('file:///' + entry.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 30000 });
  await page.evaluate(({ title }) => {
    const s = document.createElement('style');
    s.textContent = `
      #__pmb_intro{position:fixed;inset:0;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:linear-gradient(135deg,#0b1220,#1a2a4a);color:#fff;font-family:'Segoe UI',sans-serif;transition:opacity .8s}
      #__pmb_intro h1{font-size:46px;margin:0 0 10px} #__pmb_intro p{font-size:19px;color:#9fc3ff;margin:3px}
      #__pmb_cap{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:2147483646;background:rgba(8,12,22,.72);
        color:#e8eefc;font-family:'Segoe UI',sans-serif;font-size:13px;line-height:1.35;padding:5px 14px;border-radius:7px;
        max-width:62%;text-align:center;opacity:0;transition:opacity .35s;pointer-events:none}
      #__pmb_cur{position:fixed;z-index:2147483647;width:22px;height:22px;border-radius:50%;background:rgba(255,210,60,.8);
        border:2px solid #fff;pointer-events:none;transition:all .6s cubic-bezier(.4,0,.2,1);box-shadow:0 0 10px rgba(255,210,60,.8);left:640px;top:360px}`;
    document.head.appendChild(s);
    const intro = document.createElement('div'); intro.id = '__pmb_intro';
    intro.innerHTML = `<h1>${title}</h1><p>Automated demo walkthrough</p><p>built &amp; delivered by PM Bridge + GitHub Copilot</p>`;
    document.body.appendChild(intro);
    const cap = document.createElement('div'); cap.id = '__pmb_cap'; document.body.appendChild(cap);
    const cur = document.createElement('div'); cur.id = '__pmb_cur'; document.body.appendChild(cur);
    window.__pmb = {
      caption(t) { const c = document.getElementById('__pmb_cap'); if (!t) { c.style.opacity = 0; return; } c.textContent = t; c.style.opacity = 1; },
      async moveCursor(x, y) { const c = document.getElementById('__pmb_cur'); c.style.left = (x - 11) + 'px'; c.style.top = (y - 11) + 'px';
        await new Promise(r => setTimeout(r, 620)); c.style.transform = 'scale(.6)'; await new Promise(r => setTimeout(r, 140)); c.style.transform = 'scale(1)'; },
      hideIntro() { const i = document.getElementById('__pmb_intro'); if (i) { i.style.opacity = 0; setTimeout(() => i.remove(), 900); } }
    };
  }, { title: appTitle });

  await say('intro', '', 3000);
  await page.evaluate(() => window.__pmb.hideIntro());
  await page.waitForTimeout(700);

  const clickWithCursor = async (el) => {
    try {
      await el.scrollIntoViewIfNeeded();
      const box = await el.boundingBox(); if (!box) return false;
      await page.evaluate(p => window.__pmb.moveCursor(p.x, p.y), { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await el.click({ timeout: 1500 }); return true;
    } catch { return false; }
  };
  const KEYMAP = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: 'Space', enter: 'Enter', esc: 'Escape' };

  if (stepList.length) {
    console.log(`scripted walkthrough: ${stepList.length} steps`);
    for (let i = 0; i < stepList.length; i++) {
      const st = stepList[i];
      try {
        if (st.caption) await say(`s${i}`, st.caption, 800);
        if (st.action === 'click' && st.selector) {
          const el = await page.$(st.selector); if (el) await clickWithCursor(el);
          await page.waitForTimeout(900);
        } else if (st.action === 'type' && st.selector) {
          const el = await page.$(st.selector);
          if (el) { await el.scrollIntoViewIfNeeded(); await el.click({ timeout: 1200 }).catch(() => { }); await el.type(st.text || 'demo', { delay: 80 }).catch(() => { }); }
          await page.waitForTimeout(800);
        } else if (st.action === 'press') {
          let key = String(st.key || st.text || 'ArrowRight');
          key = KEYMAP[key.toLowerCase()] || key;
          const times = Math.min(parseInt(st.times) || 1, 40);
          const delay = Math.min(parseInt(st.delayMs) || 160, 1000);
          await page.click('body', { timeout: 800 }).catch(() => { });   // focus for key events
          for (let k = 0; k < times; k++) { await page.keyboard.press(key).catch(() => { }); await page.waitForTimeout(delay); }
        } else if (st.action === 'scroll') {
          await page.evaluate(() => window.scrollBy({ top: 480, behavior: 'smooth' })); await page.waitForTimeout(900);
        } else if (st.action === 'wait') {
          await page.waitForTimeout(Math.min(parseInt(st.ms) || 1000, 6000));
        }
        if (st.action !== 'press') await page.keyboard.press('Escape').catch(() => { });
      } catch (e) { console.log('step skipped: ' + e.message.split('\n')[0]); }
    }
  } else {
    console.log('generic narrated tour');
    await say('g1', `Let's take a quick look around the interface.`);
    await page.evaluate(async () => { for (let y = 0; y <= document.body.scrollHeight; y += 300) { window.scrollTo({ top: y, behavior: 'smooth' }); await new Promise(r => setTimeout(r, 280)); } window.scrollTo({ top: 0 }); });
    await say('g2', 'Now testing the interactive elements of the app.');
    const startBtn = await page.$('#startBtn, .start, button');
    if (startBtn) await clickWithCursor(startBtn);
    if (await page.$('canvas')) {                    // looks like a game: play it
      await page.click('body').catch(() => { });
      const seq = ['ArrowRight', 'ArrowRight', 'ArrowUp', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowRight'];
      for (const k of seq) { await page.keyboard.press(k).catch(() => { }); await page.waitForTimeout(450); }
    }
    const clickables = await page.$$('button, a[href="#"], [role="button"], .btn');
    for (let i = 0; i < Math.min(clickables.length, 4); i++) { if (await clickWithCursor(clickables[i])) await page.waitForTimeout(800); await page.keyboard.press('Escape').catch(() => { }); }
  }

  await say('outro', 'Demo complete - delivered by PM Bridge.', 800);
  await page.evaluate(() => window.__pmb.caption('')).catch(() => { });
  await page.waitForTimeout(500);

  await ctx.close();
  const tmpVideo = await page.video().path();
  await browser.close();

  // ---------- 3. mux ----------
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  let muxed = false;
  if (audioCues.length) {
    try {
      const args = ['-y', '-i', tmpVideo];
      audioCues.forEach(c => args.push('-i', c.wav));
      const delays = audioCues.map((c, i) => `[${i + 1}:a]adelay=${c.ms}|${c.ms}[a${i}]`).join(';');
      const amix = audioCues.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${audioCues.length}:dropout_transition=0,volume=2.0[aout]`;
      args.push('-filter_complex', `${delays};${amix}`, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '96k', outFile);
      const r = spawnSync(ffmpeg, args, { stdio: 'pipe', timeout: 300000 });
      muxed = r.status === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 10000;
      if (!muxed) console.log('mux failed: ' + (r.stderr || '').toString().split('\n').slice(-3).join(' '));
    } catch (e) { console.log('mux error: ' + e.message.split('\n')[0]); }
  }
  if (!muxed) fs.copyFileSync(tmpVideo, outFile);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  console.log(`video saved: ${outFile} (voice-over: ${muxed ? 'YES (' + VOICE + ')' : 'no'})`);
})().catch(e => { console.error(e.message); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { } process.exit(1); });
