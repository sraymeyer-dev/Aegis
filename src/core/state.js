/**
 * state.js — the GameState shape and hydrateMission().
 *
 * hydrateMission() is the boundary that keeps authored data immutable. The
 * parsed mission object is NEVER mutated; GameState is built from it. That is
 * what makes restart instant and free: re-run hydrateMission() on the same
 * parsed object.
 *
 * THE CRITICAL SPLIT, and the single easiest thing to collapse by accident:
 *
 *   contact.truth.allegiance is AUTHORED and never shown.
 *   contact.displayedClass is DERIVED every tick from what the player has
 *   actually done to resolve the contact.
 *
 * The renderer only ever reads displayedClass, apparent, and confidence.
 * If you find yourself reaching for truth outside of sensors.js, weapons.js,
 * or the debrief track log, you are about to break the game.
 */

import { createRng } from './rng.js';
import {
  SENSOR_DEFAULTS, MAGAZINE_DEFAULTS, DAMAGE_ZONES, ZONE_ORDER,
  DEFAULT_HP, CRIPPLED_THRESHOLD,
} from '../data/constants.js';

export const PHASES = ['select', 'briefing', 'playing', 'debrief'];

let trackCounter = 0;

/** Track numbers are assigned in detection order and are stable for the run. */
function nextTrackNumber() {
  trackCounter = (trackCounter % 9999) + 1;
  return String(trackCounter).padStart(4, '0');
}

export function resetTrackNumbers() { trackCounter = 0; }

/** Fresh resolution record: what has been done to a contact, and when. */
export function emptyResolution() {
  return {
    passiveSeconds: 0,
    iff: null,          // null | 'squawk' | 'silent'
    esm: false,
    hail: false,
    illuminated: false,
    visual: false,
    investigated: false,
    /** In-flight resolution actions: {action, remaining} */
    pending: [],
  };
}

export function hydrateContact(authored, opts = {}) {
  const c = {
    // --- authored, treated as read-only -----------------------------
    id: authored.id,
    name: authored.name,
    domain: authored.domain,
    truth: { allegiance: authored.truth.allegiance, type: authored.truth.type },
    behavior: authored.behavior ? structuredClone(authored.behavior) : { kind: 'static' },
    sensor: {
      rcs: authored.sensor?.rcs ?? 'medium',
      emitting: authored.sensor?.emitting ?? false,
      iffMode: authored.sensor?.iffMode ?? 'none',
    },
    deception: authored.deception ? structuredClone(authored.deception) : null,
    spawnAt: authored.spawnAt ?? 0,

    // --- runtime, engine-owned, never authored ----------------------
    pos: { x: authored.pos.x, y: authored.pos.y },
    course: authored.course,
    speed: authored.speed,
    alt: authored.alt ?? 0,
    hp: authored.hp ?? DEFAULT_HP[authored.domain] ?? 100,
    maxHp: authored.hp ?? DEFAULT_HP[authored.domain] ?? 100,
    alive: true,
    active: (authored.spawnAt ?? 0) <= 0,
    trackNumber: null,
    detected: false,
    detectedAt: null,
    confidence: 0,
    resolution: emptyResolution(),
    /** What the evidence says this contact is. Derived; see sensors.js. */
    apparent: { allegiance: 'unknown', type: 'unknown', authority: 0 },
    displayedClass: 'unknown',
    /** Set only by visual range, helo/VBSS, revealTruth, or a hostile act. */
    truthRevealed: false,
    /** Declared hostile by the player or the crew. Never authored, never spawned. */
    declaredHostile: false,
    /** This contact has committed a hostile act: relevant under SELF-DEFENSE ONLY. */
    hasActedHostile: false,
    /** Waypoint index for patrol behaviour. */
    waypointIndex: 0,
    /** Weapon cooldown for attack behaviour. */
    fireCooldown: 0,
    /** Set for projectiles: the weapon that launched it. */
    projectile: opts.projectile ?? null,
  };
  if (authored.behavior?.kind === 'patrol') c.waypoints = structuredClone(authored.behavior.waypoints);
  return c;
}

export function hydrateOwnship(mission) {
  const a = mission.ownship ?? {};
  const integrity = {};
  const maxIntegrity = {};
  for (const zone of ZONE_ORDER) {
    maxIntegrity[zone] = DAMAGE_ZONES[zone].hp;
    integrity[zone] = a.integrity?.[zone] ?? DAMAGE_ZONES[zone].hp;
  }
  const systems = { command: true, magForward: true, magAft: true, radar: true, propulsion: true, buoyancy: true };
  for (const s of a.systemsDisabled ?? []) systems[s] = false;
  for (const zone of ZONE_ORDER) {
    if (integrity[zone] <= 0) systems[DAMAGE_ZONES[zone].disables] = false;
  }

  return {
    id: 'ownship',
    name: a.name ?? 'USS VALLEY FORGE',
    domain: 'surface',
    pos: { x: a.pos?.x ?? 0, y: a.pos?.y ?? 0 },
    course: a.course ?? 0,
    speed: a.speed ?? 15,
    orderedCourse: a.course ?? 0,
    orderedSpeed: a.speed ?? 15,
    waypoints: [],
    alt: 0,
    alive: true,
    active: true,
    truth: { allegiance: 'friendly', type: 'Ticonderoga-class cruiser' },
    integrity,
    maxIntegrity,
    systems,
    magazines: { ...MAGAZINE_DEFAULTS, ...(a.magazines ?? {}) },
    magazinesInitial: { ...MAGAZINE_DEFAULTS, ...(a.magazines ?? {}) },
    sensors: { ...SENSOR_DEFAULTS, ...(a.sensors ?? {}) },
    damageControlZone: null,
    /** Per-weapon reload, in seconds. A cruiser does not fire a salvo per tick. */
    weaponCooldowns: {},
    /** Active sonar is a timed state bought by pinging, not a toggle. */
    sonarActiveUntil: -1,
    clockNow: 0,
    /** Bearing quadrant blinded when the SPY-1 face is destroyed, or null. */
    blindQuadrant: null,
    crippled: false,
  };
}

export function totalIntegrity(ownship) {
  let hp = 0;
  let max = 0;
  for (const zone of ZONE_ORDER) { hp += Math.max(0, ownship.integrity[zone]); max += ownship.maxIntegrity[zone]; }
  return max === 0 ? 0 : hp / max;
}

export function emptyMetrics() {
  return {
    neutralsDestroyed: 0,
    friendliesDestroyed: 0,
    hostilesDestroyed: 0,
    hostilesEscaped: 0,
    roundsExpended: {},
    damageByZone: {},
    /** Sum and count, so mean time-to-classify is derivable at debrief. */
    classifyTimeSum: 0,
    classifyCount: 0,
    /** THE Vincennes metric. This is the one that should sting. */
    engagedBelowConfirmed: 0,
    choiceNodesTimedOut: 0,
    choiceNodesAnswered: 0,
    objectivesCompleted: 0,
    objectivesFailed: 0,
    shotsFired: 0,
    shotsHit: 0,
    resolutionActions: 0,
  };
}

export function hydrateObjectives(mission) {
  return (mission.objectives ?? []).map((o) => ({
    id: o.id,
    text: o.text,
    type: o.type,
    params: structuredClone(o.params ?? {}),
    optional: !!o.optional,
    hidden: !!o.hidden,
    /** pending | active | complete | failed */
    status: o.hidden ? 'pending' : 'active',
    /** Accumulator for hold objectives, in seconds. */
    heldSeconds: 0,
  }));
}

/**
 * Build a fresh GameState from a parsed mission object.
 * The mission object is not mutated and is retained by reference for reload.
 */
export function hydrateMission(mission, opts = {}) {
  resetTrackNumbers();
  const seed = opts.seed ?? `${mission.meta.id}#${opts.run ?? 0}`;

  const contacts = new Map();
  for (const authored of mission.contacts ?? []) {
    contacts.set(authored.id, hydrateContact(authored));
  }

  const flags = new Map();
  // Engine-owned flags exist from tick zero so triggers can test them honestly.
  flags.set('sys.neutralKilled', false);
  flags.set('sys.friendlyKilled', false);
  flags.set('sys.lowConfidenceEngagement', false);
  flags.set('sys.weaponReleased', false);
  flags.set('sys.ownshipDamaged', false);
  flags.set('sys.missionTime', 0);

  const objectives = hydrateObjectives(mission);
  for (const o of objectives) flags.set(o.id, o.status);

  return {
    phase: 'playing',
    mission,                       // immutable after load
    clock: { t: 0, ticks: 0, compression: 1, paused: false, autoDropReason: null },
    ownship: hydrateOwnship(mission),
    contacts,
    projectiles: [],
    flags,
    roe: mission.meta.initialRoe,
    dialogue: {
      fired: new Set(),
      queue: [],
      active: null,
      timerRemaining: 0,
      /** Nodes scheduled by queueNode: {nodeId, at} */
      scheduled: [],
      /** Contacts/areas bracketed by the active node. */
      focus: [],
      /** Read delay remaining on an informational node. */
      readRemaining: 0,
    },
    objectives,
    metrics: emptyMetrics(),
    trackLog: [],
    ended: null,                   // {outcomeId, rating, title, debrief, reason}
    rng: createRng(seed),
    seed,
    ui: {
      selectedContactId: null,
      hoveredId: null,
      zoom: 20,
      orientation: 'north-up',
      plotting: false,
    },
    /** Ephemeral, per-tick: cleared at the top of every tick. */
    events: [],
  };
}

export { nextTrackNumber, CRIPPLED_THRESHOLD };
