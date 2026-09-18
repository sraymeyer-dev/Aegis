/**
 * weapons.js — launch, flight, Pk resolution, and the abort window.
 *
 * All engagements are abstracted to a time of flight and a probability of
 * kill. No ballistics, no terminal guidance. A missile in flight is itself a
 * contact with domain "missile", visible on the scope to both sides.
 *
 * Player-launched missiles can be aborted up to ABORT_WINDOW_SECONDS after
 * launch. This is deliberate design, not realism: it gives the player a second
 * beat of dread after a wrong call, which is far better drama than an instant
 * unrecoverable mistake.
 */

import {
  WEAPONS, ABORT_WINDOW_SECONDS, KTS_TO_NM_PER_SEC, CONFIDENCE_CONFIRMED,
} from '../data/constants.js';
import { range, bearing, courseVector } from '../core/geometry.js';
import { logTrack } from './sensors.js';
import { getEntity } from './contact.js';

let projectileCounter = 0;
export function resetProjectileCounter() { projectileCounter = 0; }

/**
 * Is the player permitted to release on this contact right now?
 * ROE is a hard gate on the order rail, not advice.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkRoe(state, contact) {
  const roe = state.roe;
  if (state.flags.get(`auth.release.${contact.id}`) === true) {
    return { allowed: true, reason: 'released by authorisation' };
  }
  switch (roe) {
    case 'free':
      if (contact.declaredHostile) return { allowed: true };
      return { allowed: false, reason: 'WEAPONS FREE covers declared hostiles only — declare the contact first' };
    case 'selfDefense':
      if (contact.hasActedHostile) return { allowed: true };
      return { allowed: false, reason: 'SELF-DEFENCE ONLY — that contact has not committed a hostile act' };
    case 'tight':
    default:
      if (contact.confidence >= CONFIDENCE_CONFIRMED && contact.apparent.allegiance === 'hostile') {
        return { allowed: true };
      }
      if (contact.hasActedHostile) return { allowed: true, reason: 'self-defence' };
      return {
        allowed: false,
        reason: contact.confidence < CONFIDENCE_CONFIRMED
          ? `WEAPONS TIGHT — contact not classified (${contact.confidence}% of ${CONFIDENCE_CONFIRMED}% required)`
          : 'WEAPONS TIGHT — contact is not classified hostile',
      };
  }
}

/** Which weapon can engage this contact from here, given magazines and systems. */
export function selectWeapon(state, contact, preferred) {
  const own = state.ownship;
  const r = range(own.pos, contact.pos);
  const candidates = preferred ? [WEAPONS[preferred]].filter(Boolean) : Object.values(WEAPONS);

  for (const w of candidates) {
    if (!w || w.automatic) continue;
    if (!w.domains.includes(contact.domain)) continue;
    if (r > w.range) continue;
    if (w.magazine && (own.magazines[w.magazine] ?? 0) < (w.rounds ?? 1)) continue;
    if (w.vls && !own.systems.magForward && !own.systems.magAft) continue;
    return w;
  }
  return null;
}

/**
 * Attempt a player-ordered engagement.
 * @returns {{ok: boolean, reason?: string, projectileId?: string}}
 */
export function engage(state, contactId, preferredWeapon) {
  const contact = state.contacts.get(contactId);
  if (!contact || !contact.alive) return { ok: false, reason: 'no such contact' };
  if (!contact.detected) return { ok: false, reason: 'contact is not on the scope' };

  const roe = checkRoe(state, contact);
  if (!roe.allowed) return { ok: false, reason: roe.reason };

  const weapon = selectWeapon(state, contact, preferredWeapon);
  if (weapon) {
    const ready = state.ownship.weaponCooldowns[weapon.id] ?? 0;
    if (ready > 0) return { ok: false, reason: `${weapon.label} reloading (${ready.toFixed(1)}s)` };
  }
  if (!weapon) {
    const r = range(state.ownship.pos, contact.pos);
    return { ok: false, reason: `no weapon available: nothing in the magazine reaches a ${contact.domain} contact at ${r.toFixed(1)} nm` };
  }

  return fire(state, weapon, contact, 'ownship');
}

function fire(state, weapon, target, shooterId) {
  const own = state.ownship;
  const rounds = weapon.rounds ?? 1;
  if (weapon.magazine) own.magazines[weapon.magazine] -= rounds;
  own.weaponCooldowns[weapon.id] = weapon.cooldown ?? 3;

  state.metrics.shotsFired++;
  state.metrics.roundsExpended[weapon.id] = (state.metrics.roundsExpended[weapon.id] ?? 0) + rounds;
  state.flags.set('sys.weaponReleased', true);

  // THE Vincennes metric. Recorded whether or not the shot was justified.
  if (shooterId === 'ownship' && target.confidence < CONFIDENCE_CONFIRMED) {
    state.metrics.engagedBelowConfirmed++;
    state.flags.set('sys.lowConfidenceEngagement', true);
  }

  logTrack(state, target, 'engaged',
    `${weapon.label} released at ${range(own.pos, target.pos).toFixed(1)} nm, confidence ${target.confidence}%`);

  if (weapon.instant) {
    resolveHit(state, weapon, target, shooterId);
    state.events.push({ kind: 'weapon:launched', weapon: weapon.id, targetId: target.id, instant: true });
    return { ok: true, instant: true };
  }

  const id = `p_${++projectileCounter}`;
  const flightTime = range(own.pos, target.pos) / (weapon.speed * KTS_TO_NM_PER_SEC);
  state.projectiles.push({
    id,
    name: weapon.label,
    domain: 'missile',
    weapon: weapon.id,
    shooterId,
    targetId: target.id,
    pos: { x: own.pos.x, y: own.pos.y },
    course: bearing(own.pos, target.pos),
    speed: weapon.speed,
    alive: true,
    active: true,
    detected: true,
    trackNumber: null,
    launchedAt: state.clock.t,
    flightTime,
    confidence: 100,
    apparent: { allegiance: 'hostile', type: weapon.label, authority: 5 },
    displayedClass: 'confirmed-hostile',
    abortable: shooterId === 'ownship',
    truth: { allegiance: 'hostile', type: weapon.label },
    resolution: { pending: [] },
  });

  state.events.push({ kind: 'weapon:launched', weapon: weapon.id, targetId: target.id, projectileId: id });
  return { ok: true, projectileId: id };
}

/** A hostile contact firing at us or at something we are protecting. */
export function contactFires(state, shooter, targetId) {
  const target = getEntity(state, targetId);
  if (!target || !target.alive) return;

  shooter.hasActedHostile = true;
  shooter.truthRevealed = true;   // shooting at people is an unambiguous answer
  state.flags.set(`sys.hostileAct.${shooter.id}`, true);
  logTrack(state, shooter, 'hostileAct', `opened fire on ${targetId}`);

  const id = `p_${++projectileCounter}`;
  // A torpedo runs at 45 knots and gives its target minutes, not seconds.
  // That difference is the whole texture of an ASW engagement.
  const subsurface = shooter.domain === 'subsurface';
  const speed = subsurface ? 45 : 480;
  const flightTime = Math.max(2, range(shooter.pos, target.pos) / (speed * KTS_TO_NM_PER_SEC));
  state.projectiles.push({
    id,
    name: subsurface ? 'Torpedo' : 'Inbound',
    domain: 'missile',
    weapon: 'hostile',
    shooterId: shooter.id,
    targetId,
    pos: { x: shooter.pos.x, y: shooter.pos.y },
    course: bearing(shooter.pos, target.pos),
    speed,
    alive: true,
    active: true,
    detected: true,
    trackNumber: null,
    launchedAt: state.clock.t,
    flightTime,
    confidence: 100,
    apparent: { allegiance: 'hostile', type: subsurface ? 'torpedo' : 'inbound weapon', authority: 5 },
    displayedClass: 'confirmed-hostile',
    abortable: false,
    truth: { allegiance: 'hostile', type: subsurface ? 'torpedo' : 'inbound weapon' },
    resolution: { pending: [] },
    pkOverride: subsurface ? 0.8 : 0.55,
  });
  state.events.push({ kind: 'weapon:inbound', projectileId: id, targetId });
}

export function abortProjectile(state, projectileId) {
  const p = state.projectiles.find((x) => x.id === projectileId && x.alive);
  if (!p) return { ok: false, reason: 'no such weapon in flight' };
  if (!p.abortable) return { ok: false, reason: 'that weapon is not ours to abort' };
  const elapsed = state.clock.t - p.launchedAt;
  if (elapsed > ABORT_WINDOW_SECONDS) {
    return { ok: false, reason: `abort window closed ${(elapsed - ABORT_WINDOW_SECONDS).toFixed(0)}s ago` };
  }
  p.alive = false;
  p.aborted = true;
  state.metrics.shotsAborted = (state.metrics.shotsAborted ?? 0) + 1;
  state.events.push({ kind: 'weapon:aborted', projectileId });
  return { ok: true };
}

/** Advance projectiles; resolve arrivals into damage events. */
export function stepWeapons(state, dt) {
  const own = state.ownship;

  for (const id of Object.keys(own.weaponCooldowns)) {
    if (own.weaponCooldowns[id] > 0) own.weaponCooldowns[id] = Math.max(0, own.weaponCooldowns[id] - dt);
  }

  for (const p of state.projectiles) {
    if (!p.alive) continue;
    const target = getEntity(state, p.targetId);

    if (!target || !target.alive) { p.alive = false; p.wasted = true; continue; }

    // Re-aim: abstracted terminal guidance, one line instead of a seeker model.
    p.course = bearing(p.pos, target.pos);
    const nm = p.speed * KTS_TO_NM_PER_SEC * dt;
    const v = courseVector(p.course);
    p.pos.x += v.x * nm;
    p.pos.y += v.y * nm;

    // CIWS engages inbound weapons automatically. No player order exists for it.
    if (p.targetId === 'ownship' && p.name !== 'Torpedo'
        && range(own.pos, p.pos) <= WEAPONS.ciws.range && !p.ciwsEngaged) {
      p.ciwsEngaged = true;
      if (state.rng.chance(WEAPONS.ciws.pk.missile)) {
        p.alive = false;
        state.events.push({ kind: 'weapon:ciwsKill', projectileId: p.id });
        continue;
      }
    }

    if (range(p.pos, target.pos) <= 0.2) {
      p.alive = false;
      resolveHit(state, WEAPONS[p.weapon] ?? { id: p.weapon, label: p.name, pk: {} }, target, p.shooterId, p.pkOverride);
    }
  }

  state.projectiles = state.projectiles.filter(
    (p) => p.alive || state.clock.t - p.launchedAt < 3,   // linger briefly so the UI can show the end
  );
}

function resolveHit(state, weapon, target, shooterId, pkOverride) {
  const pk = pkOverride ?? weapon.pk?.[target.domain] ?? 0.5;
  const hit = state.rng.chance(pk);

  if (!hit) {
    state.events.push({ kind: 'weapon:miss', weapon: weapon.id, targetId: target.id, shooterId });
    if (target.id !== 'ownship') logTrack(state, target, 'miss', `${weapon.label} missed`);
    return;
  }

  if (shooterId === 'ownship') state.metrics.shotsHit++;
  state.events.push({ kind: 'weapon:hit', weapon: weapon.id, targetId: target.id, shooterId });

  if (target.id === 'ownship') {
    state.events.push({ kind: 'damage:incoming', amount: 60 + Math.round(state.rng.range(0, 40)) });
    return;
  }

  target.hp -= weapon.instant ? 40 : 90;
  if (target.hp <= 0) destroyContact(state, target, shooterId);
  else logTrack(state, target, 'damaged', `${weapon.label} hit; still afloat`);
}

export function destroyContact(state, contact, shooterId) {
  if (!contact.alive) return;
  contact.alive = false;
  contact.destroyedAt = state.clock.t;
  contact.destroyedBy = shooterId;

  state.flags.set(`sys.contactDestroyed.${contact.id}`, true);

  // Scoring reads truth. This is one of the three sanctioned call sites.
  if (shooterId === 'ownship') {
    const a = contact.truth.allegiance;
    if (a === 'neutral') { state.metrics.neutralsDestroyed++; state.flags.set('sys.neutralKilled', true); }
    else if (a === 'friendly') { state.metrics.friendliesDestroyed++; state.flags.set('sys.friendlyKilled', true); }
    else state.metrics.hostilesDestroyed++;
  }

  logTrack(state, contact, 'destroyed',
    shooterId === 'ownship'
      ? `destroyed by ownship at confidence ${contact.confidence}%`
      : `destroyed by ${shooterId}`);

  state.events.push({ kind: 'contact:destroyed', id: contact.id, shooterId });
}
