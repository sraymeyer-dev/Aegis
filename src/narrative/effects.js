/**
 * effects.js — how narrative writes back into the sim.
 *
 * This is the one direction of coupling that matters, and it is what keeps
 * content authorable without code. Every effect type here is reachable from a
 * mission JSON file and nothing in /src/ knows what any particular mission
 * does with them.
 */

import { hydrateContact } from '../core/state.js';
import { damageOwnship } from '../sim/damage.js';
import { logTrack, recomputeClassification } from '../sim/sensors.js';

export function applyEffects(state, effects, ctx = {}) {
  if (!Array.isArray(effects)) return;
  for (const eff of effects) applyEffect(state, eff, ctx);
}

export function applyEffect(state, eff, ctx = {}) {
  if (!eff || typeof eff !== 'object') return;
  const [type] = Object.keys(eff);
  const val = eff[type];

  switch (type) {
    case 'setFlag':
      state.flags.set(val.key, val.value);
      state.events.push({ kind: 'flag:set', key: val.key, value: val.value });
      break;

    case 'spawnContact': {
      if (state.contacts.has(val.id)) break;
      const c = hydrateContact({ ...val, spawnAt: 0 });
      c.active = true;
      state.contacts.set(c.id, c);
      state.events.push({ kind: 'contact:spawned', id: c.id, viaEffect: true });
      break;
    }

    case 'orderContact': {
      const c = state.contacts.get(val.id);
      if (!c) break;
      if (val.course !== undefined) c.course = val.course;
      if (val.speed !== undefined) c.speed = val.speed;
      if (val.waypoints !== undefined) {
        c.waypoints = structuredClone(val.waypoints);
        c.waypointIndex = 0;
        c.behavior = { kind: 'patrol', waypoints: c.waypoints, loop: !!val.loop };
      }
      if (val.behavior !== undefined) {
        c.behavior = structuredClone(val.behavior);
        if (c.behavior.kind === 'patrol') { c.waypoints = structuredClone(c.behavior.waypoints); c.waypointIndex = 0; }
      }
      state.events.push({ kind: 'contact:ordered', id: val.id });
      break;
    }

    case 'setRoe': {
      const before = state.roe;
      state.roe = val.level;
      if (before !== val.level) state.events.push({ kind: 'roe:changed', from: before, to: val.level });
      break;
    }

    case 'damageOwnship':
      damageOwnship(state, val.zone, val.amount);
      break;

    case 'revealTruth': {
      const id = typeof val === 'string' ? val : val.id;
      const c = state.contacts.get(id);
      if (!c) break;
      c.truthRevealed = true;
      c.resolution.visual = true;
      recomputeClassification(state, c);
      logTrack(state, c, 'revealed', 'identity confirmed by external means');
      state.events.push({ kind: 'contact:revealed', id });
      break;
    }

    case 'setDeception': {
      const c = state.contacts.get(val.id);
      if (!c) break;
      c.deception = val.block ? structuredClone(val.block) : null;
      recomputeClassification(state, c);
      logTrack(state, c, 'deception',
        val.block ? 'contact changed what it is claiming to be' : 'contact dropped its false profile');
      state.events.push({ kind: 'contact:deceptionChanged', id: val.id });
      break;
    }

    case 'addObjective': {
      const id = typeof val === 'string' ? val : val.id;
      const o = state.objectives.find((x) => x.id === id);
      if (!o) break;
      o.hidden = false;
      if (o.status === 'pending') o.status = 'active';
      state.flags.set(o.id, o.status);
      state.events.push({ kind: 'objective:changed', id, status: o.status });
      break;
    }

    case 'completeObjective':
    case 'failObjective': {
      const id = typeof val === 'string' ? val : val.id;
      const o = state.objectives.find((x) => x.id === id);
      if (!o || o.status === 'complete' || o.status === 'failed') break;
      o.status = type === 'completeObjective' ? 'complete' : 'failed';
      o.hidden = false;
      state.flags.set(o.id, o.status);
      if (o.status === 'complete') state.metrics.objectivesCompleted++;
      else state.metrics.objectivesFailed++;
      state.events.push({ kind: 'objective:changed', id, status: o.status });
      break;
    }

    case 'endMission': {
      const outcomeId = typeof val === 'string' ? val : val.outcomeId;
      state.pendingEnd = { reason: 'effect', outcomeId };
      break;
    }

    case 'queueNode': {
      state.dialogue.scheduled.push({
        nodeId: val.nodeId,
        at: state.clock.t + (val.afterSeconds ?? 0),
      });
      break;
    }

    default:
      if (typeof console !== 'undefined') console.warn(`effects: unknown effect "${type}" ignored`);
  }
}
