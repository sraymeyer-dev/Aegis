#!/usr/bin/env node
/**
 * smoke.js — drives the real game in a real browser.
 *
 * The headless harness proves the sim. This proves the other half: that the
 * four zones render, that input reaches the bus, and that the render loop
 * never writes to state. Any console error or page exception fails the run.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { mkdirSync } from 'node:fs';

const ROOT = process.cwd();
const OUT = '.aegis-out';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let path = normalize(join(ROOT, url === '/' ? 'index.html' : url));
        if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
        const info = await stat(path).catch(() => null);
        if (info?.isDirectory()) path = join(path, 'index.html');
        res.writeHead(200, { 'content-type': (TYPES[extname(path)] ?? 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
        res.end(await readFile(path));
      } catch { res.writeHead(404).end('not found'); }
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

const steps = [];
let failures = 0;
function check(label, ok, detail = '') {
  steps.push({ label, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

const run = async () => {
  mkdirSync(OUT, { recursive: true });
  const { server, port } = await serve();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });

  /* --- M6: mission select ---------------------------------------- */
  await page.waitForSelector('.mission-card', { timeout: 8000 });
  const missionCount = await page.locator('.mission-card').count();
  check('mission select lists the whole manifest', missionCount >= 4, `${missionCount} missions`);
  check('title is the renamed game', (await page.title()).includes('Horizon Command'));
  await page.screenshot({ path: `${OUT}/01-select.png` });

  /* --- M6: briefing ---------------------------------------------- */
  await page.locator('.mission-card').first().click();
  await page.waitForSelector('#btn-start');
  check('briefing renders the authored markdown',
    (await page.locator('#screen-briefing .prose').first().innerText()).includes('ARGO SPIRIT'));
  await page.screenshot({ path: `${OUT}/02-briefing.png` });

  /* --- M4/M5: the playing screen ---------------------------------- */
  await page.click('#btn-start');
  await page.waitForSelector('#screen-playing.is-active');
  await page.waitForTimeout(1800);

  const canvas = await page.locator('#scope-canvas').boundingBox();
  check('scope canvas has real size', canvas.width > 400 && canvas.height > 300,
    `${Math.round(canvas.width)}x${Math.round(canvas.height)}`);

  check('status strip shows ROE', (await page.locator('#roe-value').innerText()).includes('TIGHT'));
  check('objective tray is populated', (await page.locator('.objective-row').count()) >= 3);
  check('ship profile drew six zones', (await page.locator('.zone-shape').count()) === 6);
  check('system lamps present', (await page.locator('.lamp').count()) === 6);
  check('order rail has sensor verbs', (await page.locator('#rail-sensors .order-btn').count()) === 5);
  check('crew dialogue is speaking', (await page.locator('.speech').count()) >= 1);

  /* --- the canvas actually painted something ---------------------- */
  const painted = await page.evaluate(() => {
    const c = document.getElementById('scope-canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return lit;
  });
  check('scope has drawn phosphor', painted > 3000, `${painted} lit pixels`);

  /* --- selecting a contact emits an intent and moves state -------- */
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  const selected = await page.evaluate(() => document.querySelector('#track-data .readout-name')?.textContent ?? '');
  check('Tab cycles to a contact and fills the readout', /TRACK|ARGO|NAVY|Dhow/i.test(selected), selected);

  /* --- a resolution action runs and costs time -------------------- */
  await page.keyboard.press('i');   // IFF, 3 s
  await page.waitForTimeout(400);
  const running = await page.locator('#resolution-ladder .rung.is-running, #resolution-ladder .rung.is-done').count();
  check('a resolution action is visible on the ladder', running >= 1);
  await page.waitForTimeout(3500);
  check('IFF completed and raised confidence',
    (await page.locator('#resolution-ladder .rung.is-done').count()) >= 1);

  /* --- time compression ------------------------------------------- */
  await page.keyboard.press('3');
  await page.waitForTimeout(300);
  const comp = await page.evaluate(() => [...document.querySelectorAll('#compression-controls button')]
    .filter((b) => b.classList.contains('is-on')).map((b) => b.textContent));
  check('time compression responds to the number keys', comp.includes('4×'), comp.join(','));

  /* --- pause does not block orders -------------------------------- */
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  const pausedClock = await page.locator('#clock-value').innerText();
  await page.keyboard.press('h');   // hail while paused
  await page.waitForTimeout(600);
  check('clock is held while paused', (await page.locator('#clock-value').innerText()) === pausedClock);
  await page.keyboard.press('Space');
  await page.waitForTimeout(800);
  check('the order given while paused was accepted',
    (await page.locator('#resolution-ladder .rung.is-running, #resolution-ladder .rung.is-done').count()) >= 2);

  await page.screenshot({ path: `${OUT}/03-playing.png` });

  /* --- ROE gate is visible and refuses ----------------------------- */
  const engageDisabled = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#rail-weapons .order-btn')].find((x) => x.textContent.startsWith('Engage'));
    return { disabled: b?.disabled, title: b?.title ?? '' };
  });
  check('engage is gated by ROE with a stated reason',
    engageDisabled.disabled === true && /TIGHT|classified|magazine|Select/.test(engageDisabled.title),
    engageDisabled.title);

  /* --- THE RULE: the render loop must never mutate state ----------- */
  const mutation = await page.evaluate(async () => {
    // Freeze the clock, let several animation frames run, and confirm nothing
    // the renderer touches has changed.
    const snap = () => JSON.stringify({
      t: window.__aegis?.state.clock.t,
      contacts: [...(window.__aegis?.state.contacts.values() ?? [])]
        .map((c) => `${c.id}:${c.pos.x.toFixed(6)},${c.pos.y.toFixed(6)}:${c.confidence}`),
    });
    if (!window.__aegis) return 'no debug handle';
    window.__aegis.loop.stop();
    const before = snap();
    await new Promise((r) => {
      let n = 0;
      const frame = () => { window.__aegis.render(window.__aegis.state, 0.016); if (++n < 20) requestAnimationFrame(frame); else r(); };
      requestAnimationFrame(frame);
    });
    const after = snap();
    window.__aegis.loop.start();
    return before === after ? 'clean' : `MUTATED\n${before}\n${after}`;
  });
  check('the render loop reads state and never writes it', mutation === 'clean', mutation.slice(0, 200));

  /* --- fast-forward to a decision and answer it -------------------- */
  await page.evaluate(() => { window.__aegis.state.clock.compression = 8; });
  await page.waitForFunction(() => document.querySelector('#dialogue-choice:not(.u-hide)'), null, { timeout: 40000 })
    .then(() => check('a timed choice node reached the player', true))
    .catch(() => check('a timed choice node reached the player', false, 'timed out'));

  {
    const info = await page.evaluate(() => ({
      timer: document.querySelector('#choice-timer-label')?.textContent ?? '',
      count: document.querySelectorAll('.choice-option').length,
      focus: window.__aegis.state.dialogue.focus.length,
      silentlyDisabled: [...document.querySelectorAll('.choice-option')]
        .filter((b) => b.disabled && !b.querySelector('.opt-reason')).length,
    }));
    check('choice node shows options', info.count >= 3);
    check('the timer names the default option', /defaults to/.test(info.timer), info.timer);
    check('the active node brackets its contacts on the scope', info.focus >= 1, `${info.focus} focused`);
    check('no option is ever disabled without a stated reason', info.silentlyDisabled === 0);
    await page.screenshot({ path: `${OUT}/04-choice.png` });

    await page.click('.choice-option:not([disabled])');
    await page.waitForTimeout(500);
    check('answering the node clears the choice panel',
      await page.locator('#dialogue-choice').evaluate((el) => el.classList.contains('u-hide')));
  }

  // The genuinely gated node arrives deep into the mission. Run real ticks to
  // get there rather than waiting in wall-clock time: this is still the real
  // sim and the real UI, just not in real time.
  const gated = await page.evaluate(async () => {
    const A = window.__aegis;
    A.loop.stop();
    let guard = 0;
    while (A.state.clock.t < 2600 && !A.state.ended && guard++ < 40000) {
      A.tick(A.state, A.bus, 0.1);
      if (A.state.dialogue.active?.isChoice) {
        const opts = A.activeOptions(A.state);
        if (opts.some((o) => !o.available)) break;
        const pick = opts.find((o) => o.available);
        if (pick) A.bus.intent('dialogue:choose', { optionId: pick.id });
      }
    }
    A.render(A.state, 0.016);
    await new Promise((r) => requestAnimationFrame(r));
    return {
      node: A.state.dialogue.active?.node.id ?? null,
      t: Math.round(A.state.clock.t),
      options: [...document.querySelectorAll('.choice-option')].map((b) => ({
        text: b.innerText.split('\n')[0],
        disabled: b.disabled,
        reason: b.querySelector('.opt-reason')?.textContent ?? null,
      })),
    };
  });

  check('a gated option is disabled WITH a visible reason',
    gated.options.some((o) => o.disabled && o.reason && o.reason.length > 4),
    `${gated.node} @${gated.t}s: ${JSON.stringify(gated.options.filter((o) => o.disabled).map((o) => o.reason))}`);

  /* --- M6: run to the debrief -------------------------------------- */
  await page.evaluate(() => {
    const A = window.__aegis;
    let guard = 0;
    while (!A.state.ended && guard++ < 60000) {
      A.tick(A.state, A.bus, 0.1);
      if (A.state.dialogue.active?.isChoice) {
        const pick = A.activeOptions(A.state).find((o) => o.available);
        if (pick) A.bus.intent('dialogue:choose', { optionId: pick.id });
      }
    }
    A.loop.start();
  });
  await page.waitForSelector('#screen-debrief.is-active', { timeout: 30000 });
  const debrief = await page.evaluate(() => ({
    rating: document.querySelector('.rating-letter')?.textContent.trim(),
    title: document.querySelector('.rating-card h2')?.textContent.trim(),
    metricRows: document.querySelectorAll('table.metrics tr').length,
    teaching: [...document.querySelectorAll('table.metrics tr.is-teaching')].map((r) => r.textContent.trim()),
    logRows: document.querySelectorAll('table.tracklog tbody tr').length,
    mismatches: document.querySelectorAll('table.tracklog tr.mismatch').length,
  }));
  check('debrief shows an authored outcome', !!debrief.rating && !!debrief.title, `${debrief.rating} — ${debrief.title}`);
  check('metrics table is populated', debrief.metricRows >= 14, `${debrief.metricRows} rows`);
  check('the two teaching metrics are emphasised', debrief.teaching.length === 2, debrief.teaching.join(' | '));
  check('track log has entries', debrief.logRows > 5, `${debrief.logRows} rows`);
  await page.screenshot({ path: `${OUT}/05-debrief.png`, fullPage: true });

  /* --- no console errors anywhere in the whole run ----------------- */
  check('no console errors or page exceptions', errors.length === 0, errors.slice(0, 3).join(' | '));

  await browser.close();
  server.close();

  console.log(`\n${steps.length} checks, ${failures} failing. Screenshots in ${OUT}/`);
  process.exit(failures ? 1 : 0);
};

run().catch((e) => { console.error(e); process.exit(1); });
