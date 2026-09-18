/**
 * loop.js — the fixed 10 Hz tick, the intent drain, and time compression.
 *
 * THE TICK ORDER IS FIXED. Every tick, no exceptions:
 *   0. drain intents queued since the last tick
 *   1. advance clock
 *   2. move contacts (behaviours, waypoints)
 *   3. move projectiles; resolve arrivals -> damage events
 *   4. update sensors: detection, confidence, displayedClass
 *   5. evaluate dialogue triggers -> push to queue
 *   6. advance dialogue timers; auto-pick on timeout
 *   7. apply queued effects (drained from the event list)
 *   8. evaluate objectives
 *   9. check end conditions
 *
 * The render loop runs on requestAnimationFrame and ONLY READS STATE. The
 * render loop must never mutate state -- that rule is what makes the headless
 * harness possible, and it is the second-most-likely thing to violate.
 */

import { TICK_DT, COMPRESSION_STEPS } from '../data/constants.js';
import { stepContacts } from '../sim/contact.js';
import { stepSensors, beginResolutionAction, logTrack, recomputeClassification } from '../sim/sensors.js';
import { stepWeapons, engage, abortProjectile, contactFires, destroyContact } from '../sim/weapons.js';
import { stepDamage, damageOwnship, assignDamageControl, rollHitZone } from '../sim/damage.js';
import { stepObjectives, anyObjectiveUnachievable, allRequiredObjectivesComplete, selectOutcome, settleObjectivesAtEnd } from '../sim/objectives.js';
import { stepDialogueTriggers, stepDialogue, chooseOption, promoteNodesForContact } from '../narrative/dialogue.js';
import { range } from './geometry.js';
import { CONFIDENCE_UNKNOWN } from '../data/constants.js';

/**
 * One logic tick.
 * @param {object} state GameState
 * @param {object} bus event bus
 * @param {number} dt seconds (normally TICK_DT)
 */
export function tick(state, bus, dt = TICK_DT) {
  if (state.ended) return;
  state.events = [];

  // 0. Intents are always drained, even while paused: pause does not block
  //    orders. A pausable tactical picture is how CIC decision-making is
  //    taught, and blocking input at pause just punishes slow readers.
  drainIntents(state, bus);

  if (state.clock.paused) { publishEvents(state, bus); return; }

  // 1. Clock is derived from an integer tick count, not accumulated floats.
  state.clock.ticks += 1;
  state.clock.t = dt === TICK_DT ? state.clock.ticks * TICK_DT : state.clock.t + dt;
  state.flags.set('sys.missionTime', state.clock.t);

  // 2, 3, 4.
  stepContacts(state, dt);
  stepWeapons(state, dt);
  stepSensors(state, dt);
  stepDamage(state, dt);

  // Contacts that opened fire this tick.
  for (const ev of [...state.events]) {
    if (ev.kind === 'contact:fires') {
      const shooter = state.contacts.get(ev.id);
      if (shooter) contactFires(state, shooter, ev.targetId);
    }
  }

  // 5, 6.
  stepDialogueTriggers(state);
  stepDialogue(state, dt);

  // 7. Effects applied by dialogue have already run; resolve their consequences.
  resolveDamageEvents(state);

  // 8.
  stepObjectives(state, dt);

  // 9.
  checkEndConditions(state, bus);

  applyCompressionAutoDrop(state, bus);
  publishEvents(state, bus);
}

/* ------------------------------------------------------------------ *
 * Intents
 * ------------------------------------------------------------------ */

function drainIntents(state, bus) {
  for (const { type, payload } of bus.drainIntents()) {
    const result = applyIntent(state, type, payload);
    if (result && result.ok === false) {
      bus.emit('order:rejected', { type, payload, reason: result.reason });
    }
  }
}

function applyIntent(state, type, payload) {
  const own = state.ownship;

  switch (type) {
    case 'order:select': {
      state.ui.selectedContactId = payload.id ?? null;
      // The scope reaching into the dialogue column: selecting a contact
      // promotes any queued node about it. The UI emitted an intent; it did
      // not call into dialogue.js.
      if (payload.id) promoteNodesForContact(state, payload.id);
      return { ok: true };
    }
    case 'order:deselect':
      state.ui.selectedContactId = null;
      return { ok: true };

    case 'order:iff':
    case 'order:esm':
    case 'order:hail':
    case 'order:illuminate':
    case 'order:investigate': {
      const c = state.contacts.get(payload.id ?? state.ui.selectedContactId);
      if (!c) return { ok: false, reason: 'no contact selected' };
      if (!c.detected) return { ok: false, reason: 'contact is not on the scope' };
      if (!c.alive) return { ok: false, reason: 'contact is gone' };
      const action = type.slice('order:'.length);
      if (action === 'esm' && range(own.pos, c.pos) > own.sensors.esmRange) {
        return { ok: false, reason: 'outside ESM range' };
      }
      return beginResolutionAction(state, c, action);
    }

    case 'order:declare': {
      const c = state.contacts.get(payload.id ?? state.ui.selectedContactId);
      if (!c) return { ok: false, reason: 'no contact selected' };
      // A hostile diamond is one that has been DECLARED hostile, never one
      // that spawned that way. The declaration is the player's, and the
      // recorder keeps the confidence it was made at.
      if (c.confidence < CONFIDENCE_UNKNOWN) {
        return { ok: false, reason: `contact is unknown (${c.confidence}%); nothing to declare yet` };
      }
      c.declaredHostile = !c.declaredHostile;
      recomputeClassification(state, c);
      logTrack(state, c, c.declaredHostile ? 'declared' : 'undeclared',
        `declared hostile by the watch at confidence ${c.confidence}%`);
      if (c.declaredHostile) {
        state.flags.set(`sys.declaredHostile.${c.id}`, true);
        state.metrics.declarations = (state.metrics.declarations ?? 0) + 1;
        if (c.confidence < 75) state.metrics.declarationsBelowConfirmed = (state.metrics.declarationsBelowConfirmed ?? 0) + 1;
      }
      return { ok: true };
    }

    case 'order:engage': {
      const id = payload.id ?? state.ui.selectedContactId;
      if (!id) return { ok: false, reason: 'no contact selected' };
      const result = engage(state, id, payload.weapon);
      if (result.ok) requestCompression(state, 1, 'weapons-release');
      return result;
    }

    case 'order:abort':
      return abortProjectile(state, payload.projectileId);

    case 'order:setCourse': {
      if (Array.isArray(payload.waypoints)) {
        own.waypoints = payload.waypoints.map((w) => ({ x: w.x, y: w.y }));
      } else if (payload.append && payload.waypoint) {
        own.waypoints.push({ x: payload.waypoint.x, y: payload.waypoint.y });
      } else if (payload.waypoint) {
        own.waypoints = [{ x: payload.waypoint.x, y: payload.waypoint.y }];
      } else if (payload.course !== undefined) {
        own.waypoints = [];
        own.orderedCourse = payload.course;
      }
      return { ok: true };
    }

    case 'order:setSpeed':
      own.orderedSpeed = Math.max(0, Math.min(32, payload.speed ?? own.orderedSpeed));
      return { ok: true };

    case 'order:damageControl':
      return assignDamageControl(state, payload.zone);

    case 'dialogue:choose':
      return chooseOption(state, payload.optionId);

    case 'clock:setCompression':
      return setCompression(state, payload.compression);

    case 'clock:pause':
      state.clock.paused = true;
      return { ok: true };

    case 'clock:resume':
      state.clock.paused = false;
      return { ok: true };

    default:
      return { ok: false, reason: `unknown intent "${type}"` };
  }
}

/* ------------------------------------------------------------------ *
 * Damage, time compression, end conditions
 * ------------------------------------------------------------------ */

function resolveDamageEvents(state) {
  for (const ev of [...state.events]) {
    if (ev.kind !== 'damage:incoming') continue;
    const zone = rollHitZone(state.rng);
    damageOwnship(state, zone, ev.amount);
  }
}

export function setCompression(state, value) {
  if (!COMPRESSION_STEPS.includes(value)) {
    return { ok: false, reason: `compression must be one of ${COMPRESSION_STEPS.join(', ')}` };
  }
  state.clock.compression = value;
  state.clock.autoDropReason = null;
  return { ok: true };
}

function requestCompression(state, value, reason) {
  if (state.clock.compression > value) {
    state.clock.compression = value;
    state.clock.autoDropReason = reason;
  }
}

/**
 * Compression auto-drops to 1x on a new choice node, a weapons-release
 * request, a contact crossing inside 10 nm, or a damage event. This is the
 * naval-sim convention and it is also a fairness contract: the player is
 * never fast-forwarded past a decision.
 */
function applyCompressionAutoDrop(state, bus) {
  const before = state.clock.compression;
  for (const ev of state.events) {
    if (ev.kind === 'dialogue:choiceActive') requestCompression(state, 1, 'choice-node');
    else if (ev.kind === 'damage:taken') requestCompression(state, 1, 'damage-event');
    else if (ev.kind === 'weapon:inbound') requestCompression(state, 1, 'weapons-release');
  }
  for (const c of state.contacts.values()) {
    if (!c.alive || !c.active || !c.detected) continue;
    const inside = range(state.ownship.pos, c.pos) <= 10;
    if (inside && !c.wasInsideTen) {
      c.wasInsideTen = true;
      requestCompression(state, 1, 'contact-inside-10nm');
    } else if (!inside) c.wasInsideTen = false;
  }
  if (state.clock.compression !== before) {
    bus.emit('clock:compressionChanged', { compression: state.clock.compression, reason: state.clock.autoDropReason });
  }
}

/**
 * A mission ends when any of these fire, checked once per tick after effects.
 * On end, the outcome ladder is evaluated and the first match is the result.
 */
function checkEndConditions(state, bus) {
  let reason = null;
  let forcedOutcome = null;

  if (state.pendingEnd) { reason = state.pendingEnd.reason; forcedOutcome = state.pendingEnd.outcomeId; }
  else if (!state.ownship.alive) reason = 'ownship-lost';
  else if (anyObjectiveUnachievable(state)) reason = 'objective-unachievable';
  else if (allRequiredObjectivesComplete(state)) reason = 'objectives-complete';
  else if (state.mission.meta.durationLimit && state.clock.t >= state.mission.meta.durationLimit) reason = 'time-limit';

  if (!reason) return;

  // Mark the end before settling, so protect/flag objectives can see it.
  state.pendingEnd = state.pendingEnd ?? { reason };
  settleObjectivesAtEnd(state);

  const outcome = selectOutcome(state, forcedOutcome);
  state.ended = {
    reason,
    outcomeId: outcome?.id ?? null,
    rating: outcome?.rating ?? 'F',
    title: outcome?.title ?? 'Mission Ended',
    debrief: outcome?.debrief ?? '',
    t: state.clock.t,
  };
  state.phase = 'debrief';

  // Hostiles that were never dealt with: consequence without drama.
  for (const c of state.contacts.values()) {
    if (c.alive && c.active && c.truth.allegiance === 'hostile') state.metrics.hostilesEscaped++;
  }

  // Pushed, not emitted: publishEvents delivers it in tick order with
  // everything else that happened this tick.
  state.events.push({ kind: 'mission:ended', ...state.ended });
}

function publishEvents(state, bus) {
  for (const ev of state.events) {
    if (ev.kind.includes(':')) bus.emit(ev.kind, ev);
  }
}

/* ------------------------------------------------------------------ *
 * Drivers
 * ------------------------------------------------------------------ */

/** Headless: run n seconds of sim time as fast as the CPU allows. */
export function runFor(state, bus, seconds, onTick) {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    if (state.ended) break;
    tick(state, bus, TICK_DT);
    if (onTick) onTick(state, i);
  }
  return state;
}

/**
 * Browser: a fixed-step accumulator decoupled from the render loop.
 * Compression multiplies how much sim time each real second buys, never the
 * tick rate, so physics and triggers behave identically at 1x and 8x.
 */
export function createLoop(state, bus, render) {
  let raf = null;
  let last = null;
  let accumulator = 0;
  let running = false;

  function frame(now) {
    if (!running) return;
    if (last === null) last = now;
    let realDt = (now - last) / 1000;
    last = now;
    if (realDt > 0.25) realDt = 0.25;        // a backgrounded tab must not fast-forward the war

    accumulator += realDt * state.clock.compression;
    let guard = 0;
    while (accumulator >= TICK_DT && guard < 400) {
      tick(state, bus, TICK_DT);
      accumulator -= TICK_DT;
      guard++;
      if (state.ended) break;
    }
    if (render) render(state, realDt);       // reads state, never writes it
    raf = requestAnimationFrame(frame);
  }

  return {
    start() { if (running) return; running = true; last = null; raf = requestAnimationFrame(frame); },
    stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = null; },
    get running() { return running; },
  };
}
