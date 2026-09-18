/**
 * contact.js — movement, behaviours, and the guard on the truth/display split.
 *
 * ============================================================================
 * THE SPLIT. READ THIS BEFORE EDITING ANYTHING IN THIS DIRECTORY.
 *
 *   contact.truth      authored, never rendered, never reaches the UI
 *   contact.apparent   what the evidence obtained so far says it is
 *   contact.displayedClass  what the scope draws
 *
 * truth is legal to read in exactly three places:
 *   1. sensors.js, to decide what a resolution action reveals
 *   2. weapons.js, to score what was actually destroyed
 *   3. debrief.js, after the mission has ended
 *
 * Anywhere else and the Vincennes scenario stops being expressible, because
 * the machine would be telling the player the answer it is supposed to make
 * them work for.
 * ============================================================================
 *
 * Behaviours are deliberately dumb. A contact running real tactical AI would
 * make missions unauthorable, because the author could no longer predict what
 * the scenario does.
 */

import { KTS_TO_NM_PER_SEC } from '../data/constants.js';
import { courseVector, range, bearing, turnToward, normaliseDeg } from '../core/geometry.js';

/** Degrees per second a contact may turn. Surface ships are slow, missiles are not. */
const TURN_RATE = { surface: 3, air: 8, subsurface: 2, missile: 20 };

/** Assert-style guard used by the sim: reading truth outside the sanctioned
 *  call sites is a programming error, not a gameplay event. */
export function readTruth(contact, reason) {
  const SANCTIONED = ['sensors', 'weapons', 'debrief', 'headless-dump'];
  if (!SANCTIONED.includes(reason)) {
    throw new Error(
      `contact.truth read from "${reason}"; only ${SANCTIONED.join('/')} may read truth. ` +
      'The renderer reads displayedClass. See the header of contact.js.');
  }
  return contact.truth;
}

/**
 * Advance every active contact by dt seconds.
 * @param {object} state GameState
 * @param {number} dt seconds
 */
export function stepContacts(state, dt) {
  for (const c of state.contacts.values()) {
    if (!c.alive) continue;
    if (!c.active) {
      if (state.clock.t >= c.spawnAt) {
        c.active = true;
        state.events.push({ kind: 'contact:spawned', id: c.id });
      } else continue;
    }
    applyBehavior(state, c, dt);
    moveContact(c, dt);
    if (c.fireCooldown > 0) c.fireCooldown = Math.max(0, c.fireCooldown - dt);
  }
  moveOwnship(state, dt);
}

function moveContact(c, dt) {
  const nm = c.speed * KTS_TO_NM_PER_SEC * dt;
  const v = courseVector(c.course);
  c.pos.x += v.x * nm;
  c.pos.y += v.y * nm;
}

function moveOwnship(state, dt) {
  const o = state.ownship;
  if (!o.alive) return;

  // A waypoint list overrides the ordered course: the player plotted a track.
  if (o.waypoints.length > 0) {
    const wp = o.waypoints[0];
    if (range(o.pos, wp) < 0.25) {
      o.waypoints.shift();
    } else {
      o.orderedCourse = bearing(o.pos, wp);
    }
  }

  const maxTurn = TURN_RATE.surface * dt;
  o.course = turnToward(o.course, o.orderedCourse, maxTurn);

  // Engineering out caps us at 12 knots. Nothing else touches max speed.
  const cap = o.systems.propulsion ? 32 : 12;
  const target = Math.min(o.orderedSpeed, cap);
  // Acceleration is 0.5 kts/s; a cruiser does not change speed instantly.
  const delta = target - o.speed;
  const step = 0.5 * dt;
  o.speed += Math.abs(delta) <= step ? delta : Math.sign(delta) * step;

  const nm = o.speed * KTS_TO_NM_PER_SEC * dt;
  const v = courseVector(o.course);
  o.pos.x += v.x * nm;
  o.pos.y += v.y * nm;
}

/* ------------------------------------------------------------------ *
 * The five behaviours
 * ------------------------------------------------------------------ */

function applyBehavior(state, c, dt) {
  const b = c.behavior ?? { kind: 'static' };
  const turn = (TURN_RATE[c.domain] ?? 3) * dt;

  switch (b.kind) {
    case 'static':
      c.speed = 0;
      break;

    case 'patrol': {
      const wps = c.waypoints ?? b.waypoints ?? [];
      if (wps.length === 0) break;
      const wp = wps[c.waypointIndex % wps.length];
      if (range(c.pos, wp) < 0.3) {
        c.waypointIndex++;
        if (c.waypointIndex >= wps.length) {
          if (b.loop) c.waypointIndex = 0;
          else { c.waypointIndex = wps.length - 1; c.speed = 0; break; }
        }
      }
      c.course = turnToward(c.course, bearing(c.pos, wps[c.waypointIndex % wps.length]), turn);
      break;
    }

    case 'intercept': {
      const target = resolveTarget(state, b.targetId);
      if (!target || !target.alive) break;
      c.course = turnToward(c.course, bearing(c.pos, target.pos), turn);
      break;
    }

    case 'evade': {
      const threat = resolveTarget(state, b.targetId);
      if (!threat || !threat.alive) break;
      c.course = turnToward(c.course, normaliseDeg(bearing(c.pos, threat.pos) + 180), turn);
      break;
    }

    case 'attack': {
      const target = resolveTarget(state, b.targetId);
      if (!target || !target.alive) { c.behavior = { kind: 'patrol', waypoints: [{ ...c.pos }] }; break; }
      const r = range(c.pos, target.pos);
      c.course = turnToward(c.course, bearing(c.pos, target.pos), turn);
      if (r <= (b.firesAt ?? 2) && c.fireCooldown === 0) {
        state.events.push({ kind: 'contact:fires', id: c.id, targetId: b.targetId });
        c.fireCooldown = b.reloadSeconds ?? 30;
      }
      break;
    }
  }
}

function resolveTarget(state, id) {
  if (id === 'ownship') return state.ownship;
  return state.contacts.get(id);
}

/** Every entity the sim can see, ownship included, for range queries. */
export function allEntities(state) {
  const out = [state.ownship];
  for (const c of state.contacts.values()) if (c.alive && c.active) out.push(c);
  for (const p of state.projectiles) if (p.alive) out.push(p);
  return out;
}

export function getEntity(state, id) {
  if (id === 'ownship') return state.ownship;
  return state.contacts.get(id) ?? state.projectiles.find((p) => p.id === id) ?? null;
}
