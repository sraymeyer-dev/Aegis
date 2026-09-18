/**
 * damage.js — six hit zones, the systems they disable, and damage control.
 *
 * Damage-control parties can work one zone at a time. They repair hull plating.
 * They do not restore a destroyed system: a SPY-1 face that is gone is gone.
 */

import {
  DAMAGE_ZONES, ZONE_ORDER, DAMAGE_CONTROL_HP_PER_SEC, CRIPPLED_THRESHOLD,
} from '../data/constants.js';
import { totalIntegrity } from '../core/state.js';

/** Where a hit lands. Weighted so the hull and superstructure take most of it. */
const HIT_WEIGHTS = { hull: 0.30, bridge: 0.20, engineering: 0.18, spy: 0.14, vlsForward: 0.09, vlsAft: 0.09 };

export function rollHitZone(rng) {
  let roll = rng.next();
  for (const [zone, w] of Object.entries(HIT_WEIGHTS)) {
    if (roll < w) return zone;
    roll -= w;
  }
  return 'hull';
}

export function damageOwnship(state, zone, amount) {
  const o = state.ownship;
  if (!ZONE_ORDER.includes(zone)) return;

  const before = o.integrity[zone];
  o.integrity[zone] = Math.max(0, before - amount);
  state.metrics.damageByZone[zone] = (state.metrics.damageByZone[zone] ?? 0) + Math.min(before, amount);
  state.flags.set('sys.ownshipDamaged', true);

  state.events.push({ kind: 'damage:taken', zone, amount, remaining: o.integrity[zone] });

  if (before > 0 && o.integrity[zone] === 0) {
    const system = DAMAGE_ZONES[zone].disables;
    o.systems[system] = false;
    state.events.push({ kind: 'system:lost', zone, system });
    state.flags.set(`sys.systemLost.${system}`, true);

    // A destroyed array face costs range and one bearing quadrant.
    if (system === 'radar') {
      o.blindQuadrant = Math.floor(state.rng.next() * 4) * 90;
    }
  }

  const frac = totalIntegrity(o);
  const wasCrippled = o.crippled;
  o.crippled = frac < CRIPPLED_THRESHOLD;
  if (o.crippled && !wasCrippled) {
    state.flags.set('sys.crippled', true);
    state.events.push({ kind: 'ownship:crippled' });
  }

  if (o.integrity.hull <= 0) {
    o.alive = false;
    state.events.push({ kind: 'ownship:lost' });
  }
}

export function stepDamage(state, dt) {
  const o = state.ownship;
  const zone = o.damageControlZone;
  if (!zone || !ZONE_ORDER.includes(zone)) return;

  // Repairs restore plating, never a destroyed system.
  const max = o.maxIntegrity[zone];
  if (o.integrity[zone] <= 0) return;           // gone is gone
  if (o.integrity[zone] >= max) { o.damageControlZone = null; return; }

  o.integrity[zone] = Math.min(max, o.integrity[zone] + DAMAGE_CONTROL_HP_PER_SEC * dt);
  o.crippled = totalIntegrity(o) < CRIPPLED_THRESHOLD;
}

export function assignDamageControl(state, zone) {
  if (!ZONE_ORDER.includes(zone)) return { ok: false, reason: `unknown zone "${zone}"` };
  const o = state.ownship;
  if (o.integrity[zone] <= 0) {
    return { ok: false, reason: `${DAMAGE_ZONES[zone].label} is destroyed; parties cannot restore it` };
  }
  o.damageControlZone = zone;
  return { ok: true };
}

export { totalIntegrity };
