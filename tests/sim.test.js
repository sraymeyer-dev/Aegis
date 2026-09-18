import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateMission } from '../src/core/state.js';
import { createBus } from '../src/core/bus.js';
import { tick, runFor } from '../src/core/loop.js';
import { TICK_DT } from '../src/data/constants.js';
import { range, bearing, advance } from '../src/core/geometry.js';
import { computeApparent, computeConfidence, computeDisplayedClass, beginResolutionAction } from '../src/sim/sensors.js';
import { runHeadless, snapshot } from '../tools/headless-sim.js';

const MISSION = 'missions/01-strait-transit.json';
const mission = () => JSON.parse(readFileSync(MISSION, 'utf8'));

/* --- geometry -------------------------------------------------------- */

test('course 000 is north, 090 is east', () => {
  const north = advance({ x: 0, y: 0 }, 0, 10);
  assert.ok(Math.abs(north.x) < 1e-9 && Math.abs(north.y - 10) < 1e-9);
  const east = advance({ x: 0, y: 0 }, 90, 10);
  assert.ok(Math.abs(east.x - 10) < 1e-9 && Math.abs(east.y) < 1e-9);
});

test('bearing is degrees true, clockwise from north', () => {
  assert.equal(Math.round(bearing({ x: 0, y: 0 }, { x: 0, y: 5 })), 0);
  assert.equal(Math.round(bearing({ x: 0, y: 0 }, { x: 5, y: 0 })), 90);
  assert.equal(Math.round(bearing({ x: 0, y: 0 }, { x: 0, y: -5 })), 180);
  assert.equal(Math.round(bearing({ x: 0, y: 0 }, { x: -5, y: 0 })), 270);
});

/* --- M2 check: authored paths ---------------------------------------- */

test('contacts follow their authored paths', () => {
  const { state } = runHeadless(MISSION, { seconds: 600 });
  const argo = state.contacts.get('c_argo');
  // 600 s at 14 kts is 2.333 nm along course 110.
  const expected = advance({ x: -3, y: 1.5 }, 110, 14 * (600 / 3600));
  assert.ok(range(argo.pos, expected) < 0.05,
    `argo drifted from its authored track: ${JSON.stringify(argo.pos)} vs ${JSON.stringify(expected)}`);
  assert.equal(argo.alive, true);
});

test('a contact with spawnAt is inactive until its time', () => {
  const { state } = runHeadless(MISSION, { seconds: 500 });
  assert.equal(state.contacts.get('c_fiac_1').active, false, 'FIAC spawns at 600 s');
  const later = runHeadless(MISSION, { seconds: 700 }).state;
  assert.equal(later.contacts.get('c_fiac_1').active, true);
});

test('a patrol contact steers toward its waypoints', () => {
  const { state } = runHeadless(MISSION, { seconds: 1200 });
  const dhow = state.contacts.get('c_dhow_1');
  const target = { x: 2, y: 14 };
  const closing = bearing(dhow.pos, target);
  assert.ok(Math.abs(((dhow.course - closing + 540) % 360) - 180) < 5,
    'dhow should be steering at its current waypoint');
});

/* --- M2 check: determinism ------------------------------------------- */

test('the same seed produces byte-identical output', () => {
  const script = [
    { at: 40, intent: 'order:select', payload: { id: 'c_dhow_1' } },
    { at: 45, intent: 'order:iff', payload: { id: 'c_dhow_1' } },
    { at: 700, intent: 'order:select', payload: { id: 'c_fiac_1' } },
    { at: 705, intent: 'order:illuminate', payload: { id: 'c_fiac_1' } },
    { at: 900, intent: 'order:engage', payload: { id: 'c_fiac_1' } },
  ];
  const a = runHeadless(MISSION, { seconds: 1500, script, seed: 'fixed-seed' });
  const b = runHeadless(MISSION, { seconds: 1500, script, seed: 'fixed-seed' });
  assert.equal(JSON.stringify(snapshot(a.state)), JSON.stringify(snapshot(b.state)));
  assert.equal(JSON.stringify(a.log), JSON.stringify(b.log));
});

test('a different seed changes stochastic outcomes but not the authored track', () => {
  const a = runHeadless(MISSION, { seconds: 600, seed: 'seed-a' });
  const b = runHeadless(MISSION, { seconds: 600, seed: 'seed-b' });
  assert.equal(
    JSON.stringify(a.state.contacts.get('c_argo').pos),
    JSON.stringify(b.state.contacts.get('c_argo').pos),
    'authored movement must not depend on the seed');
});

test('no Math.random anywhere under src/sim', async () => {
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync('src/sim')) {
    const src = readFileSync(`src/sim/${f}`, 'utf8');
    assert.ok(!/Math\.random/.test(src), `Math.random found in src/sim/${f}; use rng.js`);
  }
});

/* --- M2 check: the deception ladder ----------------------------------- */

function fakeContact(overrides = {}) {
  return {
    id: 'c_test', name: 'Test', domain: 'surface', detected: true,
    truth: { allegiance: 'hostile', type: 'missile boat' },
    sensor: { rcs: 'medium', emitting: true, iffMode: 'none' },
    deception: null,
    truthRevealed: false,
    declaredHostile: false,
    resolution: {
      passiveSeconds: 25, iff: null, esm: false, hail: false,
      illuminated: false, visual: false, investigated: false, pending: [],
    },
    ...overrides,
  };
}

test('deception.iff makes the ladder converge on the wrong answer', () => {
  const c = fakeContact({ deception: { iff: 'friendly' } });

  // Passive only: a warship profile implies nothing about allegiance.
  assert.equal(computeApparent(c).allegiance, 'unknown');
  assert.equal(computeConfidence(c), 25);
  assert.equal(computeDisplayedClass(c, 25, computeApparent(c)), 'unknown');

  // IFF interrogation: the false squawk answers, and it answers "friendly".
  c.resolution.iff = 'squawk';
  let conf = computeConfidence(c);
  let apparent = computeApparent(c);
  assert.equal(apparent.allegiance, 'friendly', 'the false squawk must be believed');
  assert.equal(conf, 55);
  assert.equal(computeDisplayedClass(c, conf, apparent), 'probable-friendly');

  // Hail: another rung, still fooled. Confidence is now high and wrong.
  c.resolution.hail = true;
  c.resolution.hailAnswered = true;
  conf = computeConfidence(c);
  apparent = computeApparent(c);
  assert.ok(conf >= 75, `expected confirmed-level confidence, got ${conf}`);
  assert.equal(apparent.allegiance, 'friendly');
  assert.equal(computeDisplayedClass(c, conf, apparent), 'confirmed-friendly',
    'the ladder must be able to confirm the wrong answer -- that is the whole game');

  // Visual range: authority 5 defeats every lower rung at once.
  c.resolution.visual = true;
  c.truthRevealed = true;
  conf = computeConfidence(c);
  apparent = computeApparent(c);
  assert.equal(conf, 100);
  assert.equal(apparent.allegiance, 'hostile');
  assert.equal(computeDisplayedClass(c, conf, apparent), 'confirmed-hostile');
});

test('deception.profile survives every rung below visual', () => {
  const c = fakeContact({
    deception: { profile: 'fishing vessel' },
    sensor: { rcs: 'small', emitting: false, iffMode: 'none' },
  });
  assert.equal(computeApparent(c).type, 'fishing vessel');
  assert.equal(computeApparent(c).allegiance, 'neutral', 'a civilian profile reads as civilian');

  c.resolution.iff = 'silent';
  c.resolution.illuminated = true;
  const apparent = computeApparent(c);
  assert.equal(apparent.allegiance, 'neutral', 'illumination supplies pressure, never identity');
  assert.ok(computeConfidence(c) >= 40);

  c.truthRevealed = true;
  assert.equal(computeApparent(c).allegiance, 'hostile');
  assert.equal(computeApparent(c).type, 'missile boat');
});

test('deception.emitter beats a bare profile but loses to visual', () => {
  const c = fakeContact({ deception: { emitter: 'friendly air search radar' } });
  c.resolution.esm = true;
  assert.equal(computeApparent(c).allegiance, 'friendly');
  assert.equal(computeApparent(c).authority, 3);
  c.truthRevealed = true;
  assert.equal(computeApparent(c).allegiance, 'hostile');
});

test('an honest contact resolves honestly', () => {
  const c = fakeContact({
    truth: { allegiance: 'friendly', type: 'destroyer' },
    sensor: { rcs: 'large', emitting: true, iffMode: 'mil' },
  });
  c.resolution.iff = 'squawk';
  assert.equal(computeApparent(c).allegiance, 'friendly');
});

test('in the reference mission the FIAC reads civilian until visual range', () => {
  const script = [
    { at: 610, intent: 'order:select', payload: { id: 'c_fiac_1' } },
    { at: 615, intent: 'order:iff', payload: { id: 'c_fiac_1' } },
    { at: 640, intent: 'order:hail', payload: { id: 'c_fiac_1' } },
    { at: 700, intent: 'order:illuminate', payload: { id: 'c_fiac_1' } },
  ];
  const mid = runHeadless(MISSION, { seconds: 1200, script, seed: 'ladder' }).state;
  const f = mid.contacts.get('c_fiac_1');
  assert.ok(range(mid.ownship.pos, f.pos) > 5, 'still outside visual range');
  assert.equal(f.apparent.type, 'fishing vessel',
    'every rung short of visual reports the profile it was given');
  assert.notEqual(f.apparent.allegiance, 'hostile');
  assert.ok(f.confidence >= 75, `deception should produce HIGH confidence, got ${f.confidence}`);
  assert.equal(f.displayedClass, 'confirmed-neutral',
    'a confidently wrong classification is the point of the deception system');
});

/* --- detection, resolution timing ------------------------------------ */

test('resolution actions cost the time the ladder says they cost', () => {
  const state = hydrateMission(mission(), { seed: 't' });
  const bus = createBus();
  runFor(state, bus, 5);
  const c = state.contacts.get('c_dhow_1');
  beginResolutionAction(state, c, 'hail');           // 15 s
  runFor(state, bus, 10);
  assert.equal(c.resolution.hail, false, 'a hail must not complete early');
  runFor(state, bus, 8);
  assert.equal(c.resolution.hail, true);
});

test('surface contacts are detected at the radar horizon, air far beyond it', () => {
  const state = hydrateMission(mission(), { seed: 't' });
  const bus = createBus();
  tick(state, bus, TICK_DT);
  const orion = state.contacts.get('c_orion');  // air, ~61 nm out
  assert.equal(orion.detected, true, 'air contacts are seen well past the surface horizon');
  assert.ok(range(state.ownship.pos, orion.pos) > state.ownship.sensors.surfaceRange);
});

/* --- weapons, ROE ----------------------------------------------------- */

test('WEAPONS TIGHT refuses release on an unclassified contact, with a reason', () => {
  const state = hydrateMission(mission(), { seed: 't' });
  const bus = createBus();
  const rejections = [];
  bus.on('order:rejected', (e) => rejections.push(e));
  runFor(state, bus, 650);
  bus.intent('order:engage', { id: 'c_fiac_1' });
  runFor(state, bus, 1);
  assert.equal(rejections.length, 1);
  assert.match(rejections[0].reason, /WEAPONS TIGHT/);
  assert.equal(state.metrics.shotsFired, 0);
});

test('a missile in flight can be aborted inside the window and not outside it', async () => {
  const { abortProjectile } = await import('../src/sim/weapons.js');
  const state = hydrateMission(mission(), { seed: 'abort' });
  const bus = createBus();
  runFor(state, bus, 650);
  state.flags.set('auth.release.c_fiac_1', true);      // authorise, so ROE is not the subject
  bus.intent('order:engage', { id: 'c_fiac_1', weapon: 'harpoon' });
  runFor(state, bus, 1);
  const p = state.projectiles[0];
  assert.ok(p, 'a harpoon should be in flight');
  runFor(state, bus, 5);
  assert.equal(abortProjectile(state, p.id).ok, true, 'abortable 5 s after launch');

  bus.intent('order:engage', { id: 'c_fiac_1', weapon: 'harpoon' });
  runFor(state, bus, 1);
  const q = state.projectiles.find((x) => x.alive);
  runFor(state, bus, 25);
  const late = abortProjectile(state, q.id);
  assert.equal(late.ok, false);
  assert.match(late.reason, /abort window closed/);
});

test('engaging below the confirmation threshold is recorded', () => {
  const state = hydrateMission(mission(), { seed: 'vincennes' });
  const bus = createBus();
  runFor(state, bus, 650);
  state.flags.set('auth.release.c_fiac_1', true);
  bus.intent('order:engage', { id: 'c_fiac_1', weapon: 'harpoon' });
  runFor(state, bus, 1);
  assert.equal(state.metrics.engagedBelowConfirmed, 1);
  assert.equal(state.flags.get('sys.lowConfidenceEngagement'), true);
});

/* --- damage ----------------------------------------------------------- */

test('destroying a zone disables its system and never comes back', async () => {
  const { damageOwnship } = await import('../src/sim/damage.js');
  const { assignDamageControl } = await import('../src/sim/damage.js');
  const state = hydrateMission(mission(), { seed: 'dmg' });
  damageOwnship(state, 'engineering', 999);
  assert.equal(state.ownship.systems.propulsion, false);
  assert.equal(assignDamageControl(state, 'engineering').ok, false,
    'damage control repairs plating, not destroyed systems');
});

test('losing engineering caps speed at 12 knots', () => {
  const state = hydrateMission(mission(), { seed: 'dmg2' });
  const bus = createBus();
  state.ownship.orderedSpeed = 30;
  runFor(state, bus, 60);
  assert.ok(state.ownship.speed > 25);
  state.ownship.integrity.engineering = 0;
  state.ownship.systems.propulsion = false;
  runFor(state, bus, 90);
  assert.ok(state.ownship.speed <= 12.01, `expected <=12 kts, got ${state.ownship.speed}`);
});
