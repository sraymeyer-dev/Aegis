#!/usr/bin/env node
/**
 * prodcheck.js -- verify the game on the PRODUCTION code path: a hostname that is not
 * localhost, so main.js's DEV flag is false. That disables the debug handle
 * and switches mission loading from throw-on-invalid to log-and-skip, which is
 * exactly what Vercel will serve.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

// Defaults to the repo root; pass a staged directory to check exactly what
// will be deployed (see .vercelignore).
//   node tools/prodcheck.js
//   node tools/prodcheck.js /path/to/staged-deploy
const ROOT = process.argv[2] ?? process.cwd();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let path = normalize(join(ROOT, url === '/' ? 'index.html' : url));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    // Mirror the Cache-Control and nosniff headers vercel.json will set.
    res.writeHead(200, {
      'content-type': (TYPES[extname(path)] ?? 'application/octet-stream') + '; charset=utf-8',
      'cache-control': 'public, max-age=0, must-revalidate',
      'x-content-type-options': 'nosniff',
    });
    res.end(await readFile(path));
  } catch { res.writeHead(404).end('not found'); }
});

await new Promise((r) => server.listen(8099, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  // Give the page a hostname that is NOT localhost, so DEV evaluates false.
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP aegis.example 127.0.0.1'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};

await page.goto('http://aegis.example:8099/', { waitUntil: 'networkidle' });
check('served under a non-localhost hostname', new URL(page.url()).hostname === 'aegis.example');
check('production build exposes no debug handle',
  await page.evaluate(() => typeof window.__aegis === 'undefined'));

await page.waitForSelector('.mission-card', { timeout: 8000 });
check('all four missions load from the manifest', (await page.locator('.mission-card').count()) === 4);

// Play each mission far enough to prove its JSON parses, validates and hydrates.
for (let i = 0; i < 4; i++) {
  await page.locator('.mission-card').nth(i).click();
  await page.waitForSelector('#btn-start', { timeout: 5000 });
  const title = await page.locator('#screen-briefing h1').innerText();
  await page.click('#btn-start');
  await page.waitForSelector('#screen-playing.is-active', { timeout: 5000 });
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => ({
    contacts: document.querySelectorAll('.objective-row').length,
    speech: document.querySelectorAll('.speech').length,
    clock: document.querySelector('#clock-value')?.textContent,
  }));
  check(`mission ${i + 1} "${title}" starts and runs`,
    state.contacts > 0 && state.speech > 0 && state.clock !== '00:00',
    `${state.contacts} objectives, ${state.speech} lines, t=${state.clock}`);
  await page.goto('http://aegis.example:8099/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mission-card');
}

check('no console errors on the production path', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
console.log(`\n${fails} failing.`);
process.exit(fails ? 1 : 0);
