#!/usr/bin/env node
/**
 * regression.js — CI gate. Runs every mission headless under every scripted
 * input sequence and asserts the outcome is stable.
 *
 * This is what determinism buys: a mission's authored consequences become
 * regression-testable, so a change to the confidence ladder that quietly makes
 * a mission unwinnable fails the build instead of a playtest three weeks later.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from './headless-sim.js';

const EXPECTATIONS = 'tools/expectations.json';

const expectations = existsSync(EXPECTATIONS)
  ? JSON.parse(readFileSync(EXPECTATIONS, 'utf8'))
  : {};

const scripts = Object.fromEntries(
  readdirSync('tools/scripts').filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join('tools/scripts', f), 'utf8'))]),
);

let failures = 0;
const results = {};

for (const file of readdirSync('missions').filter((f) => f.endsWith('.json') && f !== 'manifest.json')) {
  const path = join('missions', file);
  const id = file.replace(/\.json$/, '');
  results[id] = {};

  for (const [name, script] of Object.entries(scripts)) {
    let outcome, rating, err = null;
    try {
      const { state } = runHeadless(path, { seconds: 4000, script });
      outcome = state.ended?.outcomeId ?? null;
      rating = state.ended?.rating ?? null;
    } catch (e) {
      err = e.message;
    }
    results[id][name] = err ? { error: err } : { outcome, rating };

    const expected = expectations[id]?.[name];
    const actual = results[id][name];
    if (expected) {
      const same = JSON.stringify(expected) === JSON.stringify(actual);
      console.log(`${same ? 'ok  ' : 'FAIL'}  ${id} / ${name}: ${JSON.stringify(actual)}${same ? '' : ` (expected ${JSON.stringify(expected)})`}`);
      if (!same) failures++;
    } else {
      console.log(`new   ${id} / ${name}: ${JSON.stringify(actual)}`);
    }
  }
}

if (process.argv.includes('--update')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(EXPECTATIONS, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nwrote ${EXPECTATIONS}`);
  process.exit(0);
}

console.log(`\n${failures} regression failure(s).`);
process.exit(failures ? 1 : 0);
