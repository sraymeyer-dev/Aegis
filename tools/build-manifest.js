#!/usr/bin/env node
/**
 * build-manifest.js — globs /missions/*.json, validates each, writes manifest.json.
 *
 * Browsers cannot list a directory. This is the honest answer: add a file,
 * run `npm run missions`, it appears in mission select.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateMission } from '../src/data/validate-mission.js';

const MISSIONS_DIR = 'missions';
const OUT = join(MISSIONS_DIR, 'manifest.json');

const files = readdirSync(MISSIONS_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
  .sort();

const entries = [];
let failed = 0;

for (const file of files) {
  const path = join(MISSIONS_DIR, file);
  let mission;
  try {
    mission = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`skip ${file}: ${err.message}`);
    failed++;
    continue;
  }
  const report = validateMission(mission, { filename: file });
  if (!report.ok) {
    console.error(`skip ${file}: ${report.errors.length} validation error(s)`);
    console.error(report.format());
    failed++;
    continue;
  }
  for (const w of report.warnings) console.warn(`warn ${file}: [${w.rule}] ${w.path}: ${w.message}`);
  entries.push({
    file,
    id: mission.meta.id,
    title: mission.meta.title,
    subtitle: mission.meta.subtitle ?? '',
    difficulty: mission.meta.difficulty,
  });
}

writeFileSync(OUT, JSON.stringify(entries, null, 2) + '\n');
console.log(`wrote ${OUT} with ${entries.length} mission(s)${failed ? `, ${failed} skipped` : ''}`);
process.exit(failed ? 1 : 0);
