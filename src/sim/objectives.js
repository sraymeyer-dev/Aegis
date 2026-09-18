/**
 * objectives.js — objective evaluation and outcome selection.
 *
 * reach and hold are the geometry constraints. Without at least one of them a
 * mission lets the player park anywhere and the radar scope becomes wallpaper,
 * which is the single most likely way this design fails.
 *
 * Outcomes are evaluated top to bottom and the FIRST MATCH WINS, so the
 * mission author -- not the engine -- decides what winning means. A mission
 * can legitimately grade a technically successful engagement as a failure.
 */

import { range } from '../core/geometry.js';
import { evaluate } from '../narrative/triggers.js';

export function stepObjectives(state, dt) {
  for (const o of state.objectives) {
    if (o.status !== 'active') continue;
    const done = evaluateObjective(state, o, dt);
    if (done === true) setStatus(state, o, 'complete');
    else if (done === false) setStatus(state, o, 'failed');
  }
}

function setStatus(state, o, status) {
  o.status = status;
  state.flags.set(o.id, status);
  if (status === 'complete') state.metrics.objectivesCompleted++;
  else state.metrics.objectivesFailed++;
  state.events.push({ kind: 'objective:changed', id: o.id, status });
}

/** @returns true (complete), false (failed), or null (still running) */
function evaluateObjective(state, o, dt) {
  const p = o.params ?? {};
  const own = state.ownship;

  switch (o.type) {
    case 'destroy': {
      const c = state.contacts.get(p.contactId);
      if (!c) return null;
      return !c.alive && c.destroyedAt != null ? true : null;
    }

    case 'protect': {
      const c = state.contacts.get(p.contactId);
      if (!c) return null;
      if (!c.alive && c.destroyedAt != null) return false;
      // A protect objective completes when the mission ends with the charge alive.
      return state.pendingEnd || (state.mission.meta.durationLimit && state.clock.t >= state.mission.meta.durationLimit)
        ? true : null;
    }

    case 'identify': {
      const c = state.contacts.get(p.contactId);
      if (!c) return null;
      return c.confidence >= (p.min ?? 75) ? true : null;
    }

    case 'reach':
      return range(own.pos, p.pos) <= p.nm ? true : null;

    case 'hold': {
      const anchor = p.contactId ? state.contacts.get(p.contactId) : null;
      if (p.contactId && (!anchor || !anchor.alive)) return null;
      const target = anchor ? anchor.pos : p.pos;
      const inside = range(own.pos, target) <= p.nm;
      if (inside) o.heldSeconds += dt;
      return o.heldSeconds >= p.seconds ? true : null;
    }

    case 'survive': {
      if (!own.alive) return false;
      const limit = p.seconds ?? state.mission.meta.durationLimit;
      return limit && state.clock.t >= limit ? true : null;
    }

    case 'flag': {
      const actual = state.flags.get(p.key);
      const expected = p.value;
      const matches = expected === false ? (actual === false || actual === undefined) : actual === expected;
      // A flag objective is a standing condition: it holds until the mission
      // ends, and it fails the moment it stops holding.
      if (!matches) return false;
      return state.pendingEnd ? true : null;
    }

    default:
      return null;
  }
}

/** Has a non-optional objective become unachievable? One of the end conditions. */
export function anyObjectiveUnachievable(state) {
  return state.objectives.some((o) => !o.optional && o.status === 'failed');
}

export function allRequiredObjectivesComplete(state) {
  const required = state.objectives.filter((o) => !o.optional && !o.hidden);
  return required.length > 0 && required.every((o) => o.status === 'complete');
}

/**
 * Evaluate the outcome ladder. First match wins, so author most-specific first.
 * The validator guarantees a catch-all, so this cannot return null for a
 * mission that passed validation.
 */
export function selectOutcome(state, forcedId) {
  const outcomes = state.mission.outcomes ?? [];
  if (forcedId) {
    const forced = outcomes.find((o) => o.id === forcedId);
    if (forced) return forced;
  }
  for (const o of outcomes) {
    if (evaluate(o.condition, state)) return o;
  }
  return outcomes[outcomes.length - 1] ?? null;
}

/**
 * Objectives whose status is still open are resolved at mission end: a protect
 * objective whose charge survived is complete, a hold that never accumulated
 * its time is failed.
 */
export function settleObjectivesAtEnd(state) {
  for (const o of state.objectives) {
    if (o.status !== 'active') continue;
    const p = o.params ?? {};
    let status = 'failed';
    if (o.type === 'protect') {
      const c = state.contacts.get(p.contactId);
      status = c && c.alive ? 'complete' : 'failed';
    } else if (o.type === 'survive') {
      status = state.ownship.alive ? 'complete' : 'failed';
    } else if (o.type === 'flag') {
      const actual = state.flags.get(p.key);
      const expected = p.value;
      status = (expected === false ? (actual === false || actual === undefined) : actual === expected)
        ? 'complete' : 'failed';
    }
    o.status = status;
    state.flags.set(o.id, status);
    if (status === 'complete') state.metrics.objectivesCompleted++;
    else state.metrics.objectivesFailed++;
  }
}
