import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hydrateMission } from '../src/core/state.js';
import { createBus } from '../src/core/bus.js';
import { runFor } from '../src/core/loop.js';
import { evaluate, explainRequirement, resolveFocus } from '../src/narrative/triggers.js';
import { applyEffects } from '../src/narrative/effects.js';
import { interpolate, activeOptions, readTimeFor, chooseOption, stepDialogueTriggers } from '../src/narrative/dialogue.js';
import { selectOutcome } from '../src/sim/objectives.js';
import { runHeadless } from '../tools/headless-sim.js';

const MISSION = 'missions/01-strait-transit.json';
const mission = () => JSON.parse(readFileSync(MISSION, 'utf8'));
const fresh = (seed = 'test') => hydrateMission(mission(), { seed });

/* ==================================================================== *
 * Every predicate, a true case and a false case.
 * ==================================================================== */

test('predicate: always', () => {
  const s = fresh();
  assert.equal(evaluate({ always: true }, s), true);
  assert.equal(evaluate({ always: false }, s), false);
});

test('predicate: timeAfter', () => {
  const s = fresh();
  s.clock.t = 100;
  assert.equal(evaluate({ timeAfter: 50 }, s), true);
  assert.equal(evaluate({ timeAfter: 150 }, s), false);
});

test('predicate: timeBefore', () => {
  const s = fresh();
  s.clock.t = 100;
  assert.equal(evaluate({ timeBefore: 150 }, s), true);
  assert.equal(evaluate({ timeBefore: 50 }, s), false);
});

test('predicate: flag', () => {
  const s = fresh();
  s.flags.set('k', 'complete');
  assert.equal(evaluate({ flag: 'k', is: 'complete' }, s), true);
  assert.equal(evaluate({ flag: 'k', is: 'failed' }, s), false);
  // An unset flag counts as false, so authors can test "has not happened yet".
  assert.equal(evaluate({ flag: 'never_set', is: false }, s), true);
  assert.equal(evaluate({ flag: 'never_set', is: true }, s), false);
});

test('predicate: roeIs', () => {
  const s = fresh();
  assert.equal(evaluate({ roeIs: 'tight' }, s), true);
  assert.equal(evaluate({ roeIs: 'free' }, s), false);
});

test('predicate: integrityBelow', () => {
  const s = fresh();
  assert.equal(evaluate({ integrityBelow: 0.99 }, s), false);
  s.ownship.integrity.hull = 0;
  s.ownship.integrity.engineering = 0;
  assert.equal(evaluate({ integrityBelow: 0.7 }, s), true);
});

test('predicate: nodeFired', () => {
  const s = fresh();
  assert.equal(evaluate({ nodeFired: 'n_open' }, s), false);
  s.dialogue.fired.add('n_open');
  assert.equal(evaluate({ nodeFired: 'n_open' }, s), true);
});

test('predicate: magazineBelow', () => {
  const s = fresh();
  assert.equal(evaluate({ magazineBelow: { magazine: 'sm2', count: 4 } }, s), false);
  s.ownship.magazines.sm2 = 2;
  assert.equal(evaluate({ magazineBelow: { magazine: 'sm2', count: 4 } }, s), true);
});

test('predicate: contactDetected', () => {
  const s = fresh();
  assert.equal(evaluate({ contactDetected: { id: 'c_argo' } }, s), false);
  runFor(s, createBus(), 1);
  assert.equal(evaluate({ contactDetected: { id: 'c_argo' } }, s), true);
  assert.equal(evaluate({ contactDetected: { id: 'c_fiac_1' } }, s), false);
});

test('predicate: contactSelected', () => {
  const s = fresh();
  assert.equal(evaluate({ contactSelected: { id: 'c_argo' } }, s), false);
  s.ui.selectedContactId = 'c_argo';
  assert.equal(evaluate({ contactSelected: { id: 'c_argo' } }, s), true);
  assert.equal(evaluate({ contactSelected: { id: 'c_dhow_1' } }, s), false);
});

test('predicate: contactDestroyed', () => {
  const s = fresh();
  assert.equal(evaluate({ contactDestroyed: { id: 'c_argo' } }, s), false);
  const c = s.contacts.get('c_argo');
  c.alive = false; c.destroyedAt = 10;
  assert.equal(evaluate({ contactDestroyed: { id: 'c_argo' } }, s), true);
});

test('predicate: contactClassified', () => {
  const s = fresh();
  const c = s.contacts.get('c_dhow_1');
  c.confidence = 50;
  assert.equal(evaluate({ contactClassified: { id: 'c_dhow_1', min: 40 } }, s), true);
  assert.equal(evaluate({ contactClassified: { id: 'c_dhow_1', min: 75 } }, s), false);
  // min defaults to the confirmation threshold.
  assert.equal(evaluate({ contactClassified: { id: 'c_dhow_1' } }, s), false);
});

test('predicate: contactWithin', () => {
  const s = fresh();
  assert.equal(evaluate({ contactWithin: { id: 'c_argo', nm: 10 } }, s), true);
  assert.equal(evaluate({ contactWithin: { id: 'c_argo', nm: 1 } }, s), false);
  // An unspawned contact is nowhere.
  assert.equal(evaluate({ contactWithin: { id: 'c_fiac_1', nm: 500 } }, s), false);
});

test('predicate: ownshipWithin, by position and by contact', () => {
  const s = fresh();
  assert.equal(evaluate({ ownshipWithin: { pos: { x: 0, y: 0 }, nm: 1 } }, s), true);
  assert.equal(evaluate({ ownshipWithin: { pos: { x: 50, y: 50 }, nm: 1 } }, s), false);
  assert.equal(evaluate({ ownshipWithin: { id: 'c_argo', nm: 10 } }, s), true);
  assert.equal(evaluate({ ownshipWithin: { id: 'c_argo', nm: 1 } }, s), false);
});

/* --- combinators ----------------------------------------------------- */

test('combinators: all, any, not', () => {
  const s = fresh();
  assert.equal(evaluate({ all: [{ always: true }, { roeIs: 'tight' }] }, s), true);
  assert.equal(evaluate({ all: [{ always: true }, { roeIs: 'free' }] }, s), false);
  assert.equal(evaluate({ any: [{ roeIs: 'free' }, { roeIs: 'tight' }] }, s), true);
  assert.equal(evaluate({ any: [{ roeIs: 'free' }, { roeIs: 'selfDefense' }] }, s), false);
  assert.equal(evaluate({ not: { roeIs: 'free' } }, s), true);
  assert.equal(evaluate({ not: { roeIs: 'tight' } }, s), false);
});

test('several predicate keys in one object are an implicit AND', () => {
  const s = fresh();
  s.clock.t = 100;
  assert.equal(evaluate({ timeAfter: 50, roeIs: 'tight' }, s), true);
  assert.equal(evaluate({ timeAfter: 50, roeIs: 'free' }, s), false);
});

/* ==================================================================== *
 * Effects
 * ==================================================================== */

test('every effect type writes back into the sim', () => {
  const s = fresh();
  const bus = createBus();
  runFor(s, bus, 1);

  applyEffects(s, [{ setFlag: { key: 'mood', value: 'tense' } }]);
  assert.equal(s.flags.get('mood'), 'tense');

  applyEffects(s, [{ spawnContact: {
    id: 'c_new', name: 'New', domain: 'surface',
    truth: { allegiance: 'hostile', type: 'patrol boat' },
    pos: { x: 5, y: 5 }, course: 180, speed: 20,
  } }]);
  assert.ok(s.contacts.has('c_new'));
  assert.equal(s.contacts.get('c_new').active, true);

  applyEffects(s, [{ orderContact: { id: 'c_new', course: 90, speed: 30 } }]);
  assert.equal(s.contacts.get('c_new').course, 90);
  assert.equal(s.contacts.get('c_new').speed, 30);

  applyEffects(s, [{ setRoe: { level: 'free' } }]);
  assert.equal(s.roe, 'free');

  applyEffects(s, [{ damageOwnship: { zone: 'spy', amount: 999 } }]);
  assert.equal(s.ownship.systems.radar, false);

  const fiac = s.contacts.get('c_fiac_1');
  applyEffects(s, [{ revealTruth: { id: 'c_fiac_1' } }]);
  assert.equal(fiac.truthRevealed, true);
  assert.equal(fiac.confidence, 100);

  applyEffects(s, [{ setDeception: { id: 'c_dhow_1', block: { iff: 'friendly' } } }]);
  assert.deepEqual(s.contacts.get('c_dhow_1').deception, { iff: 'friendly' });
  applyEffects(s, [{ setDeception: { id: 'c_dhow_1', block: null } }]);
  assert.equal(s.contacts.get('c_dhow_1').deception, null);

  applyEffects(s, [{ completeObjective: { id: 'ob_gate' } }]);
  assert.equal(s.objectives.find((o) => o.id === 'ob_gate').status, 'complete');
  assert.equal(s.flags.get('ob_gate'), 'complete');

  applyEffects(s, [{ queueNode: { nodeId: 'n_open_cic', afterSeconds: 5 } }]);
  assert.equal(s.dialogue.scheduled.length, 1);

  applyEffects(s, [{ endMission: { outcomeId: 'fallback' } }]);
  assert.equal(s.pendingEnd.outcomeId, 'fallback');
});

/* ==================================================================== *
 * Dialogue: queue, priority, timers, focus, gating
 * ==================================================================== */

test('a choice node blocks the queue until answered or timed out', () => {
  const s = fresh();
  const bus = createBus();
  runFor(s, bus, 700);
  // Drive to the FIAC choice node.
  runFor(s, bus, 400);
  const timedOut = s.metrics.choiceNodesTimedOut;
  assert.ok(timedOut > 0, 'unanswered choice nodes must resolve by timeout, not stall');
});

test('timing out picks the authored default option', () => {
  const { state, log } = runHeadless(MISSION, { seconds: 1400 });
  const timeout = log.find((e) => e.kind === 'dialogue:timedOut' && e.nodeId === 'n_dhow_choice');
  assert.ok(timeout, 'the dhow choice should time out on a no-input run');
  assert.equal(timeout.optionId, 'o_dhow_watch', 'the passive option is the default');
});

test('higher-priority nodes jump the chatter queue', () => {
  const s = fresh();
  const bus = createBus();
  runFor(s, bus, 1);
  // n_open has priority 8, n_dhow_first priority 5; both fire in the first tick.
  const order = [...(s.dialogue.active ? [s.dialogue.active] : []), ...s.dialogue.queue]
    .map((e) => e.node.id);
  assert.equal(order[0], 'n_open');
});

test('an option gated by requires is unavailable, with a readable reason', () => {
  const s = fresh();
  const bus = createBus();
  runFor(s, bus, 700);
  let guard = 0;
  while (s.dialogue.active?.node.id !== 'n_fiac_choice' && guard++ < 20000) runFor(s, bus, 1);
  assert.equal(s.dialogue.active?.node.id, 'n_fiac_choice');

  const opts = activeOptions(s);
  const engage = opts.find((o) => o.id === 'o_fiac_free');
  assert.equal(engage.available, false, 'the aggressive option must not exist until the work is done');
  assert.match(engage.reason, /not classified/);
  assert.ok(opts.find((o) => o.id === 'o_fiac_wait').available);
  assert.equal(opts.find((o) => o.id === 'o_fiac_wait').isDefault, true);
});

test('choosing a gated option is refused rather than silently applied', () => {
  const s = fresh();
  const bus = createBus();
  runFor(s, bus, 700);
  let guard = 0;
  while (s.dialogue.active?.node.id !== 'n_fiac_choice' && guard++ < 20000) runFor(s, bus, 1);
  const res = chooseOption(s, 'o_fiac_free');
  assert.equal(res.ok, false);
  assert.match(res.reason, /not classified/);
});

test('focus resolves contacts for the scope to bracket', () => {
  const s = fresh();
  const node = mission().nodes.find((n) => n.id === 'n_fiac_choice');
  const focus = resolveFocus(node.focus, s);
  assert.equal(focus.length, 2);
  assert.deepEqual(focus.map((f) => f.id), ['c_fiac_1', 'c_argo']);
});

test('selecting a contact promotes queued nodes about it', () => {
  const s = fresh();
  const bus = createBus();
  runFor(s, bus, 1);
  const before = s.dialogue.queue.findIndex((e) => e.node.id === 'n_dhow_first');
  assert.ok(before > 0, 'the dhow node should be behind others to start with');
  bus.intent('order:select', { id: 'c_dhow_1' });
  runFor(s, bus, 0.1);
  const after = s.dialogue.queue.findIndex((e) => e.node.id === 'n_dhow_first');
  assert.ok(after < before, 'selecting a contact should promote nodes about it');
});

test('the queue drops low-priority chatter rather than stacking it', () => {
  const s = fresh();
  s.metrics.queueDepthPeak = 0;
  for (let i = 0; i < 12; i++) {
    s.dialogue.queue.push({ node: { id: `filler_${i}` }, priority: 5, queuedAt: 0, isChoice: false });
  }
  // Filler occupies the queue; a low-priority informational node must be dropped.
  s.clock.t = 20;
  stepDialogueTriggers(s);
  assert.ok((s.metrics.nodesDropped ?? 0) > 0, 'queue-depth cap should drop low-priority chatter');
});

test('text interpolation renders track numbers, never truth', () => {
  const s = fresh();
  const bus = createBus();
  runFor(s, bus, 1);
  const c = s.contacts.get('c_dhow_1');
  assert.match(interpolate('Contact {{contact:c_dhow_1}} is crossing.', s), /TRACK \d{4}/);
  c.confidence = 90;
  assert.match(interpolate('Contact {{contact:c_dhow_1}} is crossing.', s), /Dhow/);
  assert.ok(!interpolate('{{contact:c_fiac_1}}', s).includes('FIAC'));
});

test('read time scales with the length of the line', () => {
  assert.ok(readTimeFor('Short.') < readTimeFor('A considerably longer line of crew dialogue that takes real time to read on screen.'));
});

/* ==================================================================== *
 * M3 check: three scripted sequences, three authored outcomes
 * ==================================================================== */

const script = (name) => JSON.parse(readFileSync(`tools/scripts/${name}.json`, 'utf8'));

test('no input at all reaches the all-timeouts outcome', () => {
  const { state } = runHeadless(MISSION, { seconds: 3700, script: [] });
  assert.ok(state.ended, 'the mission must end');
  assert.equal(state.ended.outcomeId, 'tanker_lost');
  assert.equal(state.ended.rating, 'F');
  assert.ok(state.metrics.choiceNodesTimedOut >= 3);
  assert.equal(state.metrics.choiceNodesAnswered, 0);
});

test('climbing the whole ladder earns the top outcome', () => {
  const { state } = runHeadless(MISSION, { seconds: 3700, script: script('procedural') });
  assert.ok(state.ended);
  assert.equal(state.ended.outcomeId, 'clean');
  assert.equal(state.ended.rating, 'S');
  assert.equal(state.metrics.neutralsDestroyed, 0);
  assert.equal(state.metrics.hostilesDestroyed, 2);
  // The two teaching metrics: the S run identifies before it shoots, every time.
  assert.equal(state.metrics.engagedBelowConfirmed, 0);
  assert.equal(state.metrics.choiceNodesTimedOut, 0);
});

test('shooting a civilian reaches INQUIRY and overrides every other success', () => {
  const { state } = runHeadless(MISSION, { seconds: 3700, script: script('trigger-happy') });
  assert.ok(state.ended);
  assert.equal(state.ended.outcomeId, 'inquiry_neutral');
  assert.equal(state.ended.rating, 'INQUIRY');
  assert.equal(state.metrics.neutralsDestroyed, 1);
  // The INQUIRY band catches first: other objectives completing does not save it.
  assert.ok(state.objectives.some((o) => o.status === 'complete'));
});

test('the three scripts reach three different outcomes', () => {
  const ids = ['timid', 'procedural', 'trigger-happy'].map((n) =>
    runHeadless(MISSION, { seconds: 3700, script: script(n) }).state.ended?.outcomeId);
  assert.equal(new Set(ids).size, 3, `expected three distinct outcomes, got ${JSON.stringify(ids)}`);
});

test('outcome evaluation takes the first match, not the best match', () => {
  const s = fresh();
  s.flags.set('sys.neutralKilled', true);
  s.flags.set('ob_escort', 'complete');
  s.flags.set('ob_station', 'complete');
  s.flags.set('ob_gate', 'complete');
  const outcome = selectOutcome(s);
  assert.equal(outcome.id, 'inquiry_neutral',
    'a neutral casualty must override every other success in the mission');
});

test('the catch-all outcome is reachable', () => {
  const s = fresh();
  assert.equal(selectOutcome(s).id, 'fallback');
});
