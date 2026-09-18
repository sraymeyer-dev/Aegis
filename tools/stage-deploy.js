#!/usr/bin/env node
/**
 * stage-deploy.js — copy exactly what Vercel will deploy into .aegis-out/deploy.
 *
 * Reads .vercelignore and applies it to the tracked file list, so the staged
 * tree is what the host actually serves rather than what we assume it serves.
 * Pair with tools/prodcheck.js to play the staged tree before pushing.
 */
import { readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const OUT = '.aegis-out/deploy';
const ignores = readFileSync('.vercelignore', 'utf8')
  .split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const ignored = (file) => ignores.some((pattern) =>
  pattern.endsWith('/') ? file.startsWith(pattern) : file === pattern);

rmSync(OUT, { recursive: true, force: true });
const files = execSync('git ls-files', { encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !ignored(f));

for (const f of files) {
  mkdirSync(join(OUT, dirname(f)), { recursive: true });
  copyFileSync(f, join(OUT, f));
}
console.log(`staged ${files.length} file(s) into ${OUT}/`);
console.log(`excluded by .vercelignore: ${ignores.join(', ')}`);
