#!/usr/bin/env node
/**
 * headless-sim.js — run a mission with no DOM, from a scripted input list.
 *
 * The sequencing principle of the whole build: the simulation is validated
 * headless before any pixel is drawn. A sim validated only through a UI cannot
 * be debugged, because every failure has two possible causes.
 *
 * Usage:
 *   node tools/headless-sim.js missions/01-strait-transit.json
 *   node tools/headless-sim.js missions/01-x.json --seconds 600 --script scripts/aggressive.json
 *   node tools/headless-sim.js missions/01-x.json --dump state --at 300
 *
 * A script entry is {intent, payload} plus a firing condition:
 *   {at: 300}                          at or after 300 s of sim time
 *   {when: <trigger expression>}       any trigger expression, same grammar
 *                                      the missions use -- so a script can say
 *                                      "answer this node when it is active"
 *                                      instead of guessing a wall-clock time
 *   {whenNodeActive: "n_fiac_choice"}  sugar for the common case
 * Entries fire once unless `repeat: true`.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { validateMission } from '../src/data/validate-mission.js';
import { hydrateMission } from '../src/core/state.js';
import { createBus } from '../src/core/bus.js';
import { tick } from '../src/core/loop.js';
import { TICK_DT } from '../src/data/constants.js';
import { range, bearing } from '../src/core/geometry.js';
import { evaluate } from '../src/narrative/triggers.js';

export function runHeadless(missionPath, { seconds = 600, script = [], seed, quiet = true, sampleEvery = 0 } = {}) {
  const mission = JSON.parse(readFileSync(missionPath, 'utf8'));
  const report = validateMission(mission, { filename: basename(missionPath) });
  if (!report.ok) throw new Error(`${missionPath} failed validation:\n${report.format()}`);

  const state = hydrateMission(mission, seed ? { seed } : {});
  const bus = createBus();

  const log = [];
  const samples = [];
  for (const kind of ['contact:detected', 'contact:destroyed', 'weapon:launched', 'weapon:hit',
    'dialogue:queued', 'dialogue:resolved', 'dialogue:timedOut', 'dialogue:dropped',
    'objective:changed', 'roe:changed', 'damage:taken', 'mission:ended', 'order:rejected']) {
    bus.on(kind, (ev) => log.push({ t: +state.clock.t.toFixed(1), kind, ...stripNoise(ev) }));
  }

  const pending = script.map((s2, idx) => ({ ...s2, _idx: idx, _fired: false }));
  const totalTicks = Math.round(seconds / TICK_DT);

  for (let i = 0; i < totalTicks; i++) {
    for (const input of pending) {
      if (input._fired && !input.repeat) continue;
      if (!scriptEntryReady(input, state)) continue;
      input._fired = true;
      bus.intent(input.intent, input.payload ?? {});
      log.push({ t: +state.clock.t.toFixed(1), kind: 'input', intent: input.intent, payload: input.payload });
    }
    tick(state, bus, TICK_DT);
    if (sampleEvery && i % Math.round(sampleEvery / TICK_DT) === 0) samples.push(snapshot(state));
    if (state.ended) break;
  }

  return { state, log, samples, mission };
}

function scriptEntryReady(input, state) {
  if (input.at !== undefined && state.clock.t < input.at) return false;
  if (input.whenNodeActive !== undefined) {
    if (state.dialogue.active?.node.id !== input.whenNodeActive) return false;
  }
  if (input.when !== undefined && !evaluate(input.when, state)) return false;
  return true;
}

function stripNoise(ev) {
  const { kind, ...rest } = ev;
  return rest;
}

/** A deterministic, diffable projection of the whole sim. */
export function snapshot(state) {
  return {
    t: +state.clock.t.toFixed(1),
    roe: state.roe,
    ownship: {
      pos: round(state.ownship.pos),
      course: +state.ownship.course.toFixed(2),
      speed: +state.ownship.speed.toFixed(2),
      integrity: Object.fromEntries(Object.entries(state.ownship.integrity).map(([k, v]) => [k, +v.toFixed(1)])),
      magazines: { ...state.ownship.magazines },
    },
    contacts: [...state.contacts.values()].map((c) => ({
      id: c.id,
      alive: c.alive,
      active: c.active,
      pos: round(c.pos),
      course: +c.course.toFixed(2),
      speed: +c.speed.toFixed(2),
      bearing: c.detected ? +bearing(state.ownship.pos, c.pos).toFixed(1) : null,
      range: c.detected ? +range(state.ownship.pos, c.pos).toFixed(2) : null,
      detected: c.detected,
      confidence: c.confidence,
      displayedClass: c.displayedClass,
      apparent: c.apparent,
      declaredHostile: c.declaredHostile,
      // Truth is dumped ONLY here, in the harness, for assertions. It never
      // travels through any UI-facing path.
      _truth: c.truth,
    })),
    projectiles: state.projectiles.filter((p) => p.alive).map((p) => ({ id: p.id, pos: round(p.pos), targetId: p.targetId })),
    flags: Object.fromEntries([...state.flags.entries()].filter(([k]) => k !== 'sys.missionTime')),
    objectives: state.objectives.map((o) => ({ id: o.id, status: o.status, held: +o.heldSeconds.toFixed(1) })),
    dialogue: {
      active: state.dialogue.active?.node.id ?? null,
      queue: state.dialogue.queue.map((q) => q.node.id),
      fired: [...state.dialogue.fired].sort(),
    },
    metrics: state.metrics,
    ended: state.ended,
  };
}

const round = (p) => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) });

/* --- CLI ----------------------------------------------------------- */

function main() {
  const args = process.argv.slice(2);
  const missionPath = args.find((a) => !a.startsWith('--')) ?? 'missions/01-strait-transit.json';
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };

  const scriptPath = flag('script');
  const script = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : [];
  const seconds = Number(flag('seconds', 600));
  const dump = flag('dump', 'log');

  const { state, log } = runHeadless(missionPath, { seconds, script, seed: flag('seed') });

  if (dump === 'state') {
    console.log(JSON.stringify(snapshot(state), null, 2));
  } else if (dump === 'both') {
    console.log(JSON.stringify({ log, final: snapshot(state) }, null, 2));
  } else {
    for (const e of log) {
      const detail = Object.entries(e).filter(([k]) => !['t', 'kind'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
      console.log(`${String(e.t).padStart(7)}s  ${e.kind.padEnd(22)} ${detail}`);
    }
    console.log('\n--- outcome ---');
    console.log(state.ended
      ? `${state.ended.rating}  ${state.ended.title}  (${state.ended.outcomeId}, ${state.ended.reason}) at ${state.ended.t.toFixed(0)}s`
      : `did not end within ${seconds}s`);
    console.log('objectives:', state.objectives.map((o) => `${o.id}=${o.status}`).join(' '));
    console.log('metrics:', JSON.stringify(state.metrics));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
