/**
 * sensors.js — detection, the confidence ladder, deception, and the derivation
 * of displayedClass.
 *
 * Detection is binary and generous: if it is in range, it is on the scope.
 * CLASSIFICATION is the real system, and it is the only thing the player is
 * actually short of.
 *
 * Deception is the mission author's primary tool. A deception block makes the
 * ladder CONVERGE ON THE WRONG ANSWER: confidence climbs, the symbol hardens
 * from hollow to solid, the readout stops saying "probable" — and all of it is
 * wrong, until a rung of authority 5 contradicts it. That is why the ladder
 * has redundant rungs and why the top of it costs range and risk.
 *
 * Authority levels:
 *   1  passive radar profile      defeated by deception.profile
 *   2  IFF interrogation          defeated by deception.iff
 *   2  radio hail                 defeated by deception (they say what they like)
 *   3  ESM emitter fingerprint    defeated by deception.emitter
 *   3  illumination               supplies no identity at all, only pressure
 *   5  visual / helo / VBSS       defeats everything
 */

import {
  LADDER, PASSIVE_GAIN_PER_SEC, CONFIDENCE_UNKNOWN, CONFIDENCE_CONFIRMED,
} from '../data/constants.js';
import { range, bearing, normaliseDeg } from '../core/geometry.js';
import { nextTrackNumber } from '../core/state.js';

/** Hull and airframe profiles a radar return alone is enough to call civilian. */
const CIVILIAN_PROFILES = new Set([
  'fishing vessel', 'dhow', 'tanker', 'crude tanker', 'container ship',
  'merchant', 'bulk carrier', 'airliner', 'ferry', 'yacht', 'trawler',
  'survey vessel', 'tug', 'cargo aircraft',
]);

/** What a bare radar profile implies about allegiance. Usually: nothing. */
function allegianceFromProfile(type) {
  return CIVILIAN_PROFILES.has(String(type).toLowerCase()) ? 'neutral' : null;
}

/**
 * A deception block is ONE COHERENT PERSONA, not a bag of independent lies.
 * A contact squawking a false friendly IFF tells the same story on the radio
 * that it tells on the transponder. Each rung is still defeated only by the
 * deception field that covers it -- but when a rung is defeated, the story it
 * hears is the same story.
 */
function deceptionPersona(d) {
  if (!d) return null;
  const type = d.profile ?? null;
  let allegiance = d.allegiance ?? null;
  if (!allegiance && ['friendly', 'neutral', 'hostile'].includes(d.iff)) allegiance = d.iff;
  if (!allegiance && d.emitter) allegiance = allegianceFromEmitter(d.emitter);
  if (!allegiance && type) allegiance = allegianceFromProfile(type);
  return { allegiance: allegiance ?? 'neutral', type };
}

/** What an IFF reply of a given mode conveys. */
function allegianceFromIffMode(mode, truthAllegiance) {
  if (mode === 'mil') return truthAllegiance;   // a mode-4 reply is a real answer
  if (mode === 'civil') return 'neutral';       // a civilian transponder says "civilian"
  return null;                                  // silent
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

export function detectionRangeFor(ownship, contact) {
  const s = ownship.sensors;
  // A destroyed SPY-1 face halves radar range and blinds one bearing quadrant.
  const radarFactor = ownship.systems.radar ? 1 : 0.5;
  switch (contact.domain) {
    case 'air':       return s.radarRange * radarFactor;
    case 'missile':   return s.radarRange * radarFactor;
    case 'subsurface': return ownship.sonarActive ? s.sonarRangeActive : s.sonarRangePassive;
    default:          return s.surfaceRange * radarFactor;
  }
}

function inBlindQuadrant(ownship, contact) {
  if (ownship.systems.radar || ownship.blindQuadrant === null) return false;
  const b = normaliseDeg(bearing(ownship.pos, contact.pos));
  const start = ownship.blindQuadrant;
  return b >= start && b < start + 90;
}

/* ------------------------------------------------------------------ *
 * The per-tick sensor pass
 * ------------------------------------------------------------------ */

export function stepSensors(state, dt) {
  const own = state.ownship;

  for (const c of state.contacts.values()) {
    if (!c.alive || !c.active) continue;

    const r = range(own.pos, c.pos);
    const detectRange = detectionRangeFor(own, c);
    const visible = r <= detectRange && !inBlindQuadrant(own, c);

    if (visible && !c.detected) {
      c.detected = true;
      c.detectedAt = state.clock.t;
      c.trackNumber = nextTrackNumber();
      state.events.push({ kind: 'contact:detected', id: c.id });
      logTrack(state, c, 'detected', `entered sensor range at ${r.toFixed(1)} nm`);
    }
    if (!c.detected) continue;

    // Losing a contact does not erase what has been learned about it.
    c.inRange = visible;

    advanceResolutionActions(state, c, dt);

    // Passive track: free, automatic, and capped. It never identifies anything.
    if (visible) {
      c.resolution.passiveSeconds = Math.min(
        LADDER.passive.cap / PASSIVE_GAIN_PER_SEC,
        c.resolution.passiveSeconds + dt,
      );
    }

    // Visual identification is automatic inside visual range and defeats deception.
    if (visible && r <= own.sensors.visualRange && !c.resolution.visual && c.domain !== 'subsurface') {
      c.resolution.visual = true;
      c.truthRevealed = true;
      state.events.push({ kind: 'contact:visual', id: c.id });
      logTrack(state, c, 'visual', `resolved visually at ${r.toFixed(1)} nm`);
    }

    recomputeClassification(state, c);
  }
}

/** Resolution actions take time. Time is the resource the player is short of. */
function advanceResolutionActions(state, c, dt) {
  if (c.resolution.pending.length === 0) return;
  const still = [];
  for (const p of c.resolution.pending) {
    p.remaining -= dt;
    if (p.remaining > 0) { still.push(p); continue; }
    completeResolutionAction(state, c, p.action);
  }
  c.resolution.pending = still;
}

export function beginResolutionAction(state, c, action) {
  const rung = LADDER[action];
  if (!rung) return { ok: false, reason: `unknown resolution action "${action}"` };
  if (c.resolution.pending.some((p) => p.action === action)) {
    return { ok: false, reason: 'already running' };
  }
  if (action === 'iff' && c.resolution.iff) return { ok: false, reason: 'already interrogated' };
  if (action === 'esm' && c.resolution.esm) return { ok: false, reason: 'already fingerprinted' };
  if (action === 'hail' && c.resolution.hail) return { ok: false, reason: 'already hailed' };
  if (action === 'illuminate' && c.resolution.illuminated) return { ok: false, reason: 'already illuminated' };

  state.metrics.resolutionActions++;
  if (rung.seconds <= 0) {
    completeResolutionAction(state, c, action);
  } else {
    c.resolution.pending.push({ action, remaining: rung.seconds, total: rung.seconds });
  }
  return { ok: true };
}

function completeResolutionAction(state, c, action) {
  switch (action) {
    case 'iff': {
      // A deception block answers the interrogation in the voice it chooses.
      const squawks = c.deception?.iff != null || c.sensor.iffMode !== 'none';
      c.resolution.iff = squawks ? 'squawk' : 'silent';
      logTrack(state, c, 'iff', squawks ? 'IFF interrogation answered' : 'IFF interrogation: silent');
      break;
    }
    case 'esm':
      c.resolution.esm = true;
      logTrack(state, c, 'esm',
        c.sensor.emitting ? 'ESM fingerprint obtained' : 'ESM: no emissions to fingerprint');
      break;
    case 'hail':
      c.resolution.hail = true;
      c.resolution.hailAnswered = respondsToHail(c);
      logTrack(state, c, 'hail',
        c.resolution.hailAnswered ? 'answered the hail' : 'did not answer the hail');
      break;
    case 'illuminate':
      c.resolution.illuminated = true;
      logTrack(state, c, 'illuminate', 'illuminated with fire-control radar');
      applyIlluminationRisk(state, c);
      break;
    case 'investigate':
      c.resolution.investigated = true;
      c.truthRevealed = true;
      logTrack(state, c, 'investigate', 'investigated at close quarters');
      break;
    case 'visual':
      c.resolution.visual = true;
      c.truthRevealed = true;
      break;
  }
  state.events.push({ kind: 'contact:resolutionAction', id: c.id, action });
}

/** Whether a contact answers a radio hail. Silence is itself information --
 *  just not the information most players assume it is. */
function respondsToHail(c) {
  if (c.deception) return true;             // a liar is happy to talk
  return c.truth.allegiance !== 'hostile';  // and so is anyone with nothing to hide
}

/**
 * Painting a contact with fire-control radar tells you a lot and may also
 * start a fight. All randomness here is seeded.
 */
function applyIlluminationRisk(state, c) {
  if (c.truth.allegiance === 'hostile') {
    if (state.rng.chance(0.35)) {
      c.hasActedHostile = true;
      c.truthRevealed = true;
      state.events.push({ kind: 'contact:reactsToIllumination', id: c.id, reaction: 'aggressive' });
      logTrack(state, c, 'reaction', 'reacted to illumination by turning in and accelerating');
      if (c.behavior.kind !== 'attack') c.speed = Math.min(c.speed * 1.3, 45);
    }
  } else if (c.truth.allegiance === 'neutral') {
    if (state.rng.chance(0.6)) {
      state.events.push({ kind: 'contact:reactsToIllumination', id: c.id, reaction: 'flees' });
      logTrack(state, c, 'reaction', 'turned away and increased speed after being illuminated');
      c.behavior = { kind: 'evade', targetId: 'ownship' };
      state.flags.set('sys.illuminatedNeutral', true);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Confidence and apparent identity
 * ------------------------------------------------------------------ */

export function computeConfidence(c) {
  let conf = Math.min(LADDER.passive.cap, c.resolution.passiveSeconds * PASSIVE_GAIN_PER_SEC);
  if (c.resolution.iff === 'squawk') conf += LADDER.iff.confidence;
  else if (c.resolution.iff === 'silent') conf += LADDER.iff.silentConfidence;
  if (c.resolution.esm && c.sensor.emitting) conf += LADDER.esm.confidence;
  if (c.resolution.hail) conf += LADDER.hail.confidence;
  if (c.resolution.illuminated) conf += LADDER.illuminate.confidence;
  if (c.resolution.visual || c.resolution.investigated || c.truthRevealed) return 100;
  return Math.max(0, Math.min(100, Math.round(conf)));
}

/**
 * What the evidence says this contact is. The highest-authority evidence wins.
 * This is a pure function of the resolution record, the deception block and
 * the truth — and it is the only function in the codebase permitted to let
 * truth influence what the player sees, which it does only at authority 5.
 */
export function computeApparent(c) {
  const entries = [];
  const d = c.deception;

  // Authority 5: visual, helo/VBSS, revealTruth, or an unambiguous hostile act.
  if (c.truthRevealed) {
    entries.push({ authority: 5, rank: 9, allegiance: c.truth.allegiance, type: c.truth.type, source: 'visual' });
  }

  // Authority 3: ESM. A captured vessel can carry a friendly emitter.
  if (c.resolution.esm && c.sensor.emitting) {
    const emitter = d?.emitter;
    entries.push({
      authority: 3,
      rank: 3,
      allegiance: emitter ? deceptionPersona(d).allegiance : c.truth.allegiance,
      type: emitter ?? c.truth.type,
      source: 'esm',
    });
  }

  // Authority 2: the hail. They tell you what they want you to hear -- and a
  // liar keeps its story straight across every channel it answers on.
  if (c.resolution.hail && c.resolution.hailAnswered) {
    const persona = deceptionPersona(d);
    entries.push({
      authority: 2,
      rank: 1,
      allegiance: persona ? persona.allegiance : c.truth.allegiance,
      type: (persona?.type) ?? c.truth.type,
      source: 'hail',
    });
  }

  // Authority 2: IFF. A false squawk is the classic deception, and it is a
  // harder answer than a voice on the radio, so it outranks the hail on a tie.
  if (c.resolution.iff === 'squawk') {
    const allegiance = d?.iff != null
      ? deceptionPersona(d).allegiance
      : allegianceFromIffMode(c.sensor.iffMode, c.truth.allegiance);
    if (allegiance) entries.push({ authority: 2, rank: 2, allegiance, type: null, source: 'iff' });
  }

  // Authority 1: the bare radar/acoustic profile.
  if (c.detected) {
    const profileType = d?.profile ?? c.truth.type;
    entries.push({
      authority: 1,
      rank: 0,
      allegiance: allegianceFromProfile(profileType),
      type: profileType,
      source: 'profile',
    });
  }

  const best = (key) => entries
    .filter((e) => e[key] != null)
    .sort((a, b) => (b.authority - a.authority) || (b.rank - a.rank))[0];

  const aEntry = best('allegiance');
  const tEntry = best('type');

  return {
    allegiance: aEntry?.allegiance ?? 'unknown',
    type: tEntry?.type ?? 'unknown',
    authority: Math.max(aEntry?.authority ?? 0, tEntry?.authority ?? 0),
    source: aEntry?.source ?? tEntry?.source ?? 'none',
  };
}

/** displayedClass is a pure function of confidence and apparent identity. */
export function computeDisplayedClass(c, confidence, apparent) {
  if (c.domain === 'missile') return 'confirmed-hostile';
  if (c.declaredHostile) return 'declared-hostile';
  if (confidence < CONFIDENCE_UNKNOWN) return 'unknown';
  const level = confidence >= CONFIDENCE_CONFIRMED ? 'confirmed' : 'probable';
  const allegiance = apparent.allegiance === 'unknown' ? 'unknown' : apparent.allegiance;
  if (allegiance === 'unknown') return 'unknown';
  return `${level}-${allegiance}`;
}

/** The label the track readout shows. Never contains truth. */
export function displayedLabel(c, confidence, apparent) {
  if (c.domain === 'missile') return 'MISSILE — INBOUND';
  if (confidence < CONFIDENCE_UNKNOWN) return 'UNKNOWN';
  const type = apparent.type === 'unknown' ? 'contact' : apparent.type;
  const prefix = confidence >= CONFIDENCE_CONFIRMED ? '' : 'PROBABLE ';
  const declared = c.declaredHostile ? ' [DECLARED HOSTILE]' : '';
  return `${prefix}${String(type).toUpperCase()}${declared}`;
}

/** Contact name is revealed only once the ladder has actually been climbed. */
export function displayedName(c, confidence) {
  if (confidence >= CONFIDENCE_CONFIRMED) return c.name;
  return `TRACK ${c.trackNumber ?? '----'}`;
}

function allegianceFromEmitter(emitter) {
  const e = String(emitter).toLowerCase();
  if (e.includes('friendly') || e.includes('allied') || e.includes('nato')) return 'friendly';
  if (e.includes('civil') || e.includes('merchant') || e.includes('navigation')) return 'neutral';
  return null;
}

export function recomputeClassification(state, c) {
  const before = c.displayedClass;
  const beforeConf = c.confidence;
  c.confidence = computeConfidence(c);
  c.apparent = computeApparent(c);
  c.displayedClass = computeDisplayedClass(c, c.confidence, c.apparent);

  if (beforeConf < 75 && c.confidence >= 75) {
    state.metrics.classifyTimeSum += state.clock.t - (c.detectedAt ?? state.clock.t);
    state.metrics.classifyCount++;
    state.events.push({ kind: 'contact:classified', id: c.id });
    logTrack(state, c, 'classified', `crossed confirmation threshold as ${c.apparent.type}`);
  }
  if (before !== c.displayedClass) {
    state.events.push({ kind: 'contact:displayChanged', id: c.id, from: before, to: c.displayedClass });
  }
}

/**
 * The Aegis data recorder. Every entry is what the player believed and what
 * they did, alongside what the contact actually was. Written throughout;
 * shown only at debrief.
 */
export function logTrack(state, c, event, detail) {
  state.trackLog.push({
    t: state.clock.t,
    contactId: c.id,
    trackNumber: c.trackNumber,
    event,
    detail,
    believedClass: c.displayedClass,
    believedType: c.apparent?.type ?? 'unknown',
    confidence: c.confidence,
    // Recorded, not rendered, until the mission is over.
    actualAllegiance: c.truth?.allegiance,
    actualType: c.truth?.type,
  });
}
