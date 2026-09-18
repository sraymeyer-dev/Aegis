/**
 * mission-loader.js — fetch, validate, hydrate.
 *
 * The loader interface is deliberately the only thing that knows how missions
 * are discovered. If a bundler is added later, swap the manifest fetch for
 * import.meta.glob('/missions/*.json') and delete tools/build-manifest.js;
 * everything above this file stays identical. That is the point of the file.
 */

import { validateMission } from './validate-mission.js';
import { hydrateMission } from '../core/state.js';

const MISSIONS_BASE = 'missions/';

export async function loadManifest(fetchImpl = fetch) {
  const res = await fetchImpl(`${MISSIONS_BASE}manifest.json`);
  if (!res.ok) throw new Error(`could not read ${MISSIONS_BASE}manifest.json (${res.status}). Run: npm run missions`);
  const entries = await res.json();
  if (!Array.isArray(entries)) throw new Error('manifest.json must be an array of {file,id,title,subtitle,difficulty}');
  return entries;
}

/**
 * Fetch and validate one mission. In dev, throws on any error with the path.
 * In production, logs and returns null so one bad file cannot take down the
 * mission select screen.
 */
export async function loadMission(file, { dev = true, fetchImpl = fetch } = {}) {
  const path = file.startsWith(MISSIONS_BASE) ? file : `${MISSIONS_BASE}${file}`;
  const res = await fetchImpl(path);
  if (!res.ok) throw new Error(`could not fetch ${path} (${res.status})`);

  let mission;
  try {
    mission = await res.json();
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  const report = validateMission(mission, { filename: path });
  for (const w of report.warnings) {
    console.warn(`[mission ${path}] WARN [${w.rule}] ${w.path}: ${w.message}`);
  }
  if (!report.ok) {
    const message = `[mission ${path}] failed validation:\n${report.format()}`;
    if (dev) throw new Error(message);
    console.error(message);
    return null;
  }
  return mission;
}

/** Build the initial GameState. The mission object is never mutated. */
export function startMission(mission, opts = {}) {
  return hydrateMission(mission, opts);
}

/** Restart is re-running hydrateMission on the same parsed object: instant and free. */
export function restartMission(state, opts = {}) {
  return hydrateMission(state.mission, { ...opts, run: (opts.run ?? 0) });
}

export { validateMission, hydrateMission };
