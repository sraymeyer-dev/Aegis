#!/usr/bin/env node
/**
 * validate-all.js — CLI validator. Also the CI gate.
 *
 * Usage:
 *   node tools/validate-all.js                      validate every mission
 *   node tools/validate-all.js missions/01-x.json   validate one
 *
 * Exit 1 on any error, or on more than MAX_WARNINGS warnings in one mission
 * (the coupling rules should be broken deliberately, never by accident).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateMission } from '../src/data/validate-mission.js';

const MAX_WARNINGS = 2;
const MISSIONS_DIR = 'missions';

const args = process.argv.slice(2);
const files = args.length
  ? args
  : readdirSync(MISSIONS_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
      .sort()
      .map((f) => join(MISSIONS_DIR, f));

let failed = 0;
let totalWarnings = 0;

for (const file of files) {
  let mission;
  try {
    mission = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.log(`\n${file}`);
    console.log(`ERROR  [json] ${file}: ${err.message}`);
    failed++;
    continue;
  }
  const report = validateMission(mission, { filename: basename(file) });
  const warnCount = report.warnings.length;
  totalWarnings += warnCount;

  const status = report.errors.length ? 'FAIL' : warnCount > MAX_WARNINGS ? 'FAIL' : 'ok';
  console.log(`\n${file}  [${status}]  ${report.errors.length} error(s), ${warnCount} warning(s)`);
  if (report.errors.length || warnCount) console.log(report.format());
  if (report.errors.length) failed++;
  else if (warnCount > MAX_WARNINGS) {
    console.log(`ERROR  [warningBudget] ${file}: ${warnCount} warnings exceeds the budget of ${MAX_WARNINGS}`);
    failed++;
  }
}

console.log(`\n${files.length} mission(s) checked, ${failed} failing, ${totalWarnings} warning(s) total.`);
process.exit(failed ? 1 : 0);
