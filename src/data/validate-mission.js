/**
 * validate-mission.js — the schema is the contract between content and engine.
 *
 * Errors are things that will break the engine or silently lie to the player.
 * Warnings are the coupling rules: an author may break them deliberately,
 * but never by accident.
 *
 * Runs in the browser (dev mode, on load) and in Node (build + CI).
 */

import {
  DOMAINS, ALLEGIANCES, ROE_LEVELS, BEHAVIOR_KINDS,
  OBJECTIVE_TYPES, RATINGS, ZONE_ORDER, WEAPONS,
} from './constants.js';

const PREDICATES = new Set([
  'timeAfter', 'timeBefore', 'flag', 'contactWithin', 'contactDetected',
  'contactClassified', 'contactDestroyed', 'contactSelected', 'ownshipWithin',
  'integrityBelow', 'roeIs', 'magazineBelow', 'nodeFired', 'always',
]);
const COMBINATORS = new Set(['all', 'any', 'not']);

/** Keys that are not predicates but modifiers consumed by a predicate sibling. */
const MODIFIERS = { is: 'flag' };

/** Predicates whose payload `.id` names a contact. */
const CONTACT_PREDICATES = new Set([
  'contactWithin', 'contactDetected', 'contactClassified',
  'contactDestroyed', 'contactSelected',
]);

const EFFECT_TYPES = new Set([
  'setFlag', 'spawnContact', 'orderContact', 'setRoe', 'damageOwnship',
  'revealTruth', 'setDeception', 'addObjective', 'completeObjective',
  'failObjective', 'endMission', 'queueNode',
]);

class Report {
  constructor(sourcePath) {
    this.sourcePath = sourcePath || '<mission>';
    this.errors = [];
    this.warnings = [];
  }
  error(rule, path, message) { this.errors.push({ rule, path, message }); }
  warn(rule, path, message) { this.warnings.push({ rule, path, message }); }
  get ok() { return this.errors.length === 0; }
  format() {
    const lines = [];
    for (const e of this.errors) lines.push(`ERROR  [${e.rule}] ${e.path}: ${e.message}`);
    for (const w of this.warnings) lines.push(`WARN   [${w.rule}] ${w.path}: ${w.message}`);
    return lines.join('\n');
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * @param {object} mission parsed mission JSON
 * @param {object} [opts] { filename } for the id-matches-filename check
 * @returns {Report}
 */
export function validateMission(mission, opts = {}) {
  const r = new Report(opts.filename);

  if (!isObj(mission)) {
    r.error('shape', 'root', 'mission must be a JSON object');
    return r;
  }
  if (mission.schemaVersion !== 1) {
    r.error('schemaVersion', 'schemaVersion',
      `expected 1, got ${JSON.stringify(mission.schemaVersion)}`);
  }

  for (const key of ['meta', 'ownship', 'contacts', 'speakers', 'nodes', 'objectives', 'outcomes']) {
    if (mission[key] === undefined) r.error('shape', key, 'required top-level key is missing');
  }

  validateMeta(mission, r, opts);
  validateOwnship(mission, r);

  // --- id universes -------------------------------------------------
  const contactIds = new Set();
  if (Array.isArray(mission.contacts)) {
    mission.contacts.forEach((c, i) => {
      if (isObj(c) && isStr(c.id)) {
        if (contactIds.has(c.id)) r.error('duplicateId', `contacts[${i}].id`, `duplicate contact id "${c.id}"`);
        contactIds.add(c.id);
      }
    });
  }
  // Contacts introduced at runtime by spawnContact effects are legal referents.
  forEachEffect(mission, (eff) => {
    if (eff.spawnContact && isStr(eff.spawnContact.id)) contactIds.add(eff.spawnContact.id);
  });
  contactIds.add('ownship');

  const nodeIds = new Set();
  if (Array.isArray(mission.nodes)) {
    mission.nodes.forEach((n, i) => {
      if (!isObj(n)) { r.error('shape', `nodes[${i}]`, 'node must be an object'); return; }
      if (!isStr(n.id)) { r.error('shape', `nodes[${i}].id`, 'node requires a string id'); return; }
      if (nodeIds.has(n.id)) r.error('duplicateId', `nodes[${i}].id`, `duplicate node id "${n.id}"`);
      nodeIds.add(n.id);
    });
  }

  const objectiveIds = new Set();
  if (Array.isArray(mission.objectives)) {
    mission.objectives.forEach((o, i) => {
      if (isObj(o) && isStr(o.id)) {
        if (objectiveIds.has(o.id)) r.error('duplicateId', `objectives[${i}].id`, `duplicate objective id "${o.id}"`);
        objectiveIds.add(o.id);
      }
    });
  }

  const outcomeIds = new Set();
  if (Array.isArray(mission.outcomes)) {
    mission.outcomes.forEach((o, i) => { if (isObj(o) && isStr(o.id)) outcomeIds.add(o.id); });
  }

  const ctx = { contactIds, nodeIds, objectiveIds, outcomeIds, speakers: mission.speakers || {} };

  validateContacts(mission, r, ctx);
  validateSpeakers(mission, r);
  validateNodes(mission, r, ctx);
  validateObjectives(mission, r, ctx);
  validateOutcomes(mission, r, ctx);
  checkTruthLeaks(mission, r);
  checkCouplingWarnings(mission, r, ctx);

  return r;
}

/* ------------------------------------------------------------------ */

function validateMeta(mission, r, opts) {
  const m = mission.meta;
  if (!isObj(m)) { r.error('shape', 'meta', 'meta must be an object'); return; }
  if (!isStr(m.id)) r.error('meta', 'meta.id', 'required, must be a non-empty string slug');
  if (!isStr(m.title)) r.error('meta', 'meta.title', 'required, must be a non-empty string');
  if (!isStr(m.briefing)) r.error('meta', 'meta.briefing', 'required, markdown shown pre-mission');
  if (!isNum(m.difficulty) || m.difficulty < 1 || m.difficulty > 5) {
    r.error('meta', 'meta.difficulty', `must be a number 1-5, got ${JSON.stringify(m.difficulty)}`);
  }
  if (!ROE_LEVELS.includes(m.initialRoe)) {
    r.error('meta', 'meta.initialRoe', `must be one of ${ROE_LEVELS.join('|')}, got ${JSON.stringify(m.initialRoe)}`);
  }
  if (m.durationLimit !== undefined && (!isNum(m.durationLimit) || m.durationLimit <= 0)) {
    r.error('meta', 'meta.durationLimit', 'must be a positive number of seconds when present');
  }
  if (opts.filename && isStr(m.id)) {
    const stem = String(opts.filename).split('/').pop().replace(/\.json$/i, '');
    if (stem !== m.id) {
      r.error('meta', 'meta.id', `must match filename stem: file is "${stem}", meta.id is "${m.id}"`);
    }
  }
}

function validateOwnship(mission, r) {
  const o = mission.ownship;
  if (!isObj(o)) { r.error('shape', 'ownship', 'ownship must be an object'); return; }
  if (o.pos !== undefined && !isPos(o.pos)) r.error('ownship', 'ownship.pos', 'must be {x,y} in nm');
  if (o.course !== undefined && !isNum(o.course)) r.error('ownship', 'ownship.course', 'must be a number, degrees true');
  if (o.speed !== undefined && (!isNum(o.speed) || o.speed < 0)) r.error('ownship', 'ownship.speed', 'must be a non-negative number of knots');
  if (o.magazines !== undefined) {
    if (!isObj(o.magazines)) r.error('ownship', 'ownship.magazines', 'must be an object of magazine counts');
    else for (const [k, v] of Object.entries(o.magazines)) {
      if (!isNum(v) || v < 0) r.error('ownship', `ownship.magazines.${k}`, 'must be a non-negative number');
    }
  }
  if (o.integrity !== undefined) {
    if (!isObj(o.integrity)) r.error('ownship', 'ownship.integrity', 'must be an object of per-zone HP');
    else for (const k of Object.keys(o.integrity)) {
      if (!ZONE_ORDER.includes(k)) r.error('ownship', `ownship.integrity.${k}`, `unknown damage zone "${k}"; expected one of ${ZONE_ORDER.join('|')}`);
    }
  }
}

function isPos(p) { return isObj(p) && isNum(p.x) && isNum(p.y); }

function validateContacts(mission, r, ctx) {
  if (!Array.isArray(mission.contacts)) { r.error('shape', 'contacts', 'contacts must be an array'); return; }
  mission.contacts.forEach((c, i) => validateContactObject(c, r, `contacts[${i}]`, ctx));
}

export function validateContactObject(c, r, path, ctx) {
  if (!isObj(c)) { r.error('shape', path, 'contact must be an object'); return; }
  if (!isStr(c.id)) r.error('contact', `${path}.id`, 'required, referenced by triggers and effects');
  if (!isStr(c.name)) r.error('contact', `${path}.name`, 'required, revealed at high confidence');
  if (!DOMAINS.includes(c.domain)) {
    r.error('contact', `${path}.domain`, `must be one of ${DOMAINS.join('|')}, got ${JSON.stringify(c.domain)}`);
  }
  if (!isObj(c.truth)) {
    r.error('contact', `${path}.truth`, 'required, {allegiance,type} — never rendered');
  } else {
    if (!ALLEGIANCES.includes(c.truth.allegiance)) {
      r.error('contact', `${path}.truth.allegiance`, `must be one of ${ALLEGIANCES.join('|')}, got ${JSON.stringify(c.truth.allegiance)}`);
    }
    if (!isStr(c.truth.type)) r.error('contact', `${path}.truth.type`, 'required, a short hull/airframe description');
  }
  if (!isPos(c.pos)) r.error('contact', `${path}.pos`, 'required, {x,y} in nm from origin');
  if (!isNum(c.course)) r.error('contact', `${path}.course`, 'required, degrees true');
  if (!isNum(c.speed)) r.error('contact', `${path}.speed`, 'required, knots');
  if (c.domain === 'air' && !isNum(c.alt)) {
    r.error('contact', `${path}.alt`, 'required for air contacts, feet');
  }
  if (c.spawnAt !== undefined && (!isNum(c.spawnAt) || c.spawnAt < 0)) {
    r.error('contact', `${path}.spawnAt`, 'must be a non-negative number of seconds');
  }
  if (c.behavior !== undefined) validateBehavior(c.behavior, r, `${path}.behavior`, ctx);
  if (c.deception !== undefined) {
    if (!isObj(c.deception)) r.error('contact', `${path}.deception`, 'must be an object {iff,profile,emitter,allegiance}');
    else {
      for (const k of Object.keys(c.deception)) {
        if (!['iff', 'profile', 'emitter', 'allegiance'].includes(k)) {
          r.error('contact', `${path}.deception.${k}`, `unknown deception key "${k}"; expected iff|profile|emitter|allegiance`);
        }
      }
      if (c.deception.allegiance !== undefined && !ALLEGIANCES.includes(c.deception.allegiance)) {
        r.error('contact', `${path}.deception.allegiance`, `must be one of ${ALLEGIANCES.join('|')}`);
      }
    }
  }
  if (c.sensor !== undefined && !isObj(c.sensor)) {
    r.error('contact', `${path}.sensor`, 'must be an object {rcs,emitting,iffMode}');
  }
  // Runtime fields are engine-owned and must never be authored.
  for (const runtime of ['trackNumber', 'detected', 'resolution', 'displayedClass', 'confidence', 'alive']) {
    if (c[runtime] !== undefined) {
      r.error('authoredRuntimeField', `${path}.${runtime}`,
        `"${runtime}" is a runtime field owned by the engine and must not be authored`);
    }
  }
}

function validateBehavior(b, r, path, ctx) {
  if (!isObj(b)) { r.error('behavior', path, 'must be an object'); return; }
  if (!BEHAVIOR_KINDS.includes(b.kind)) {
    r.error('behavior', `${path}.kind`, `must be one of ${BEHAVIOR_KINDS.join('|')}, got ${JSON.stringify(b.kind)}`);
    return;
  }
  if (b.kind === 'patrol') {
    if (!Array.isArray(b.waypoints) || b.waypoints.length === 0) {
      r.error('behavior', `${path}.waypoints`, 'patrol behaviour requires a non-empty waypoints array');
    } else b.waypoints.forEach((w, i) => {
      if (!isPos(w)) r.error('behavior', `${path}.waypoints[${i}]`, 'waypoint must be {x,y} in nm');
    });
  }
  if (b.kind === 'intercept' || b.kind === 'attack' || b.kind === 'evade') {
    if (!isStr(b.targetId)) {
      r.error('behavior', `${path}.targetId`, `${b.kind} behaviour requires a targetId`);
    } else if (ctx && !ctx.contactIds.has(b.targetId)) {
      r.error('unknownContact', `${path}.targetId`, `references unknown contact "${b.targetId}"`);
    }
  }
  if (b.kind === 'attack') {
    if (!isNum(b.weaponRange)) r.error('behavior', `${path}.weaponRange`, 'attack behaviour requires weaponRange in nm');
    if (!isNum(b.firesAt)) r.error('behavior', `${path}.firesAt`, 'attack behaviour requires firesAt in nm');
  }
}

function validateSpeakers(mission, r) {
  const s = mission.speakers;
  if (!isObj(s)) { r.error('shape', 'speakers', 'speakers must be an object keyed by speaker id'); return; }
  for (const [key, v] of Object.entries(s)) {
    if (!isObj(v)) { r.error('speaker', `speakers.${key}`, 'must be an object {name,role,portrait,color}'); continue; }
    if (!isStr(v.name)) r.error('speaker', `speakers.${key}.name`, 'required');
    if (!isStr(v.role)) r.error('speaker', `speakers.${key}.role`, 'required');
  }
}

/* ------------------------------------------------------------------ *
 * Nodes
 * ------------------------------------------------------------------ */

function validateNodes(mission, r, ctx) {
  if (!Array.isArray(mission.nodes)) { r.error('shape', 'nodes', 'nodes must be an array'); return; }

  mission.nodes.forEach((n, i) => {
    if (!isObj(n)) return;
    const path = `nodes[${i}]${isStr(n.id) ? ` (${n.id})` : ''}`;

    if (!isStr(n.speaker)) {
      r.error('node', `${path}.speaker`, 'required, a key into speakers');
    } else if (!Object.prototype.hasOwnProperty.call(ctx.speakers, n.speaker)) {
      r.error('unknownSpeaker', `${path}.speaker`,
        `speaker "${n.speaker}" is not defined in speakers (have: ${Object.keys(ctx.speakers).join(', ') || 'none'})`);
    }
    if (!isStr(n.text)) r.error('node', `${path}.text`, 'required');
    else validateInterpolation(n.text, r, `${path}.text`, ctx);

    if (n.trigger === undefined) r.error('node', `${path}.trigger`, 'required, a trigger expression object');
    else validateTrigger(n.trigger, r, `${path}.trigger`, ctx);

    if (n.priority !== undefined && (!isNum(n.priority) || n.priority < 0 || n.priority > 10)) {
      r.error('node', `${path}.priority`, 'must be a number 0-10');
    }
    if (n.once !== undefined && typeof n.once !== 'boolean') {
      r.error('node', `${path}.once`, 'must be a boolean');
    }

    const isChoice = Array.isArray(n.options) && n.options.length > 0;

    if (n.options !== undefined && !Array.isArray(n.options)) {
      r.error('node', `${path}.options`, 'must be an array when present');
    }

    // timeoutSeconds and defaultOption: both or neither.
    const hasTimeout = n.timeoutSeconds !== undefined;
    const hasDefault = n.defaultOption !== undefined;
    if (hasTimeout !== hasDefault) {
      r.error('timerPair', path,
        `a choice node must declare both timeoutSeconds and defaultOption or neither (has timeoutSeconds=${hasTimeout}, defaultOption=${hasDefault})`);
    }
    if (hasTimeout && (!isNum(n.timeoutSeconds) || n.timeoutSeconds <= 0)) {
      r.error('node', `${path}.timeoutSeconds`, 'must be a positive number of seconds');
    }
    if (!isChoice && (hasTimeout || hasDefault)) {
      r.error('timerPair', path, 'informational node (no options) must not declare timeoutSeconds/defaultOption');
    }

    const optionIds = new Set();
    if (isChoice) {
      n.options.forEach((o, j) => {
        const opath = `${path}.options[${j}]`;
        if (!isObj(o)) { r.error('option', opath, 'option must be an object'); return; }
        if (!isStr(o.id)) r.error('option', `${opath}.id`, 'required');
        else if (optionIds.has(o.id)) r.error('duplicateId', `${opath}.id`, `duplicate option id "${o.id}" within node`);
        else optionIds.add(o.id);
        if (!isStr(o.text)) r.error('option', `${opath}.text`, 'required');
        if (o.requires !== undefined) validateTrigger(o.requires, r, `${opath}.requires`, ctx);
        if (o.effects !== undefined) validateEffects(o.effects, r, `${opath}.effects`, ctx);
      });
      if (hasDefault && !optionIds.has(n.defaultOption)) {
        r.error('defaultOption', `${path}.defaultOption`,
          `"${n.defaultOption}" is not an option of this node (options: ${[...optionIds].join(', ') || 'none'})`);
      }
      if (n.focus !== undefined) validateFocus(n.focus, r, `${path}.focus`, ctx);
    } else if (n.focus !== undefined) {
      validateFocus(n.focus, r, `${path}.focus`, ctx);
    }

    if (n.effects !== undefined) validateEffects(n.effects, r, `${path}.effects`, ctx);
  });
}

function validateFocus(focus, r, path, ctx) {
  if (!Array.isArray(focus)) { r.error('focus', path, 'must be an array of contact ids and/or {pos,nm} areas'); return; }
  focus.forEach((f, i) => {
    if (typeof f === 'string') {
      if (!ctx.contactIds.has(f)) r.error('unknownContact', `${path}[${i}]`, `focus references unknown contact "${f}"`);
    } else if (isObj(f)) {
      if (!isPos(f.pos) || !isNum(f.nm)) r.error('focus', `${path}[${i}]`, 'area focus must be {pos:{x,y}, nm}');
    } else {
      r.error('focus', `${path}[${i}]`, 'entry must be a contact id string or a {pos,nm} area');
    }
  });
}

function validateInterpolation(text, r, path, ctx) {
  const re = /\{\{(\w+):([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, kind, arg] = m;
    if (kind === 'contact') {
      if (!ctx.contactIds.has(arg.trim())) {
        r.error('unknownContact', path, `interpolation {{contact:${arg}}} references unknown contact`);
      }
    } else if (kind === 'truth') {
      r.error('truthLeak', path, `interpolation {{truth:${arg}}} would render authored truth to the player`);
    } else if (kind !== 'flag' && kind !== 'ownship') {
      r.error('interpolation', path, `unknown interpolation kind "${kind}"; expected contact|flag|ownship`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

export function validateTrigger(t, r, path, ctx) {
  if (!isObj(t)) { r.error('trigger', path, 'trigger must be a JSON object, not a string or array'); return; }
  const keys = Object.keys(t);
  if (keys.length === 0) { r.error('trigger', path, 'trigger object is empty'); return; }

  for (const key of keys) {
    const val = t[key];
    if (Object.prototype.hasOwnProperty.call(MODIFIERS, key)) {
      const owner = MODIFIERS[key];
      if (!Object.prototype.hasOwnProperty.call(t, owner)) {
        r.error('trigger', `${path}.${key}`,
          `"${key}" is a modifier for the "${owner}" predicate and cannot appear without it`);
      }
      continue;
    }
    if (COMBINATORS.has(key)) {
      if (key === 'not') {
        validateTrigger(val, r, `${path}.not`, ctx);
      } else {
        if (!Array.isArray(val)) { r.error('trigger', `${path}.${key}`, `"${key}" takes an array of trigger expressions`); continue; }
        if (val.length === 0) r.error('trigger', `${path}.${key}`, `"${key}" array is empty`);
        val.forEach((sub, i) => validateTrigger(sub, r, `${path}.${key}[${i}]`, ctx));
      }
      continue;
    }
    if (!PREDICATES.has(key)) {
      r.error('unknownPredicate', `${path}.${key}`,
        `unknown predicate "${key}"; expected one of ${[...PREDICATES].join(', ')} or combinators all|any|not`);
      continue;
    }
    validatePredicatePayload(key, val, t, r, `${path}.${key}`, ctx);
  }
}

function validatePredicatePayload(key, val, whole, r, path, ctx) {
  switch (key) {
    case 'always':
      if (val !== true && val !== false) r.error('trigger', path, 'always takes true or false');
      break;
    case 'timeAfter': case 'timeBefore':
      if (!isNum(val) || val < 0) r.error('trigger', path, 'takes a non-negative number of seconds');
      break;
    case 'flag':
      if (!isStr(val)) r.error('trigger', path, 'flag takes a string key, paired with an "is" sibling');
      if (!Object.prototype.hasOwnProperty.call(whole, 'is')) {
        r.error('trigger', path, 'flag predicate requires a sibling "is" value, e.g. {"flag":"k","is":true}');
      }
      break;
    case 'roeIs':
      if (!ROE_LEVELS.includes(val)) r.error('trigger', path, `must be one of ${ROE_LEVELS.join('|')}`);
      break;
    case 'integrityBelow':
      if (!isNum(val)) r.error('trigger', path, 'takes a number: a fraction 0-1 of total integrity');
      else if (val < 0 || val > 1) r.error('trigger', path, `expected a fraction 0-1, got ${val}`);
      break;
    case 'nodeFired':
      if (!isStr(val)) r.error('trigger', path, 'takes a node id string');
      else if (!ctx.nodeIds.has(val)) r.error('unknownNode', path, `references unknown node "${val}"`);
      break;
    case 'magazineBelow': {
      if (!isObj(val)) { r.error('trigger', path, 'takes {magazine, count}'); break; }
      if (!isStr(val.magazine)) r.error('trigger', `${path}.magazine`, 'required');
      else if (!Object.values(WEAPONS).some((w) => w.magazine === val.magazine)) {
        r.error('trigger', `${path}.magazine`, `unknown magazine "${val.magazine}"`);
      }
      if (!isNum(val.count)) r.error('trigger', `${path}.count`, 'required, a number');
      break;
    }
    case 'ownshipWithin': {
      if (!isObj(val)) { r.error('trigger', path, 'takes {pos:{x,y}, nm} or {id, nm}'); break; }
      if (val.id !== undefined) {
        if (!ctx.contactIds.has(val.id)) r.error('unknownContact', `${path}.id`, `references unknown contact "${val.id}"`);
      } else if (!isPos(val.pos)) {
        r.error('trigger', `${path}.pos`, 'required when no id is given: {x,y} in nm');
      }
      if (!isNum(val.nm)) r.error('trigger', `${path}.nm`, 'required, radius in nm');
      break;
    }
    case 'contactClassified': {
      if (!isObj(val)) { r.error('trigger', path, 'takes {id, min}'); break; }
      if (!isStr(val.id)) r.error('trigger', `${path}.id`, 'required');
      else if (!ctx.contactIds.has(val.id)) r.error('unknownContact', `${path}.id`, `references unknown contact "${val.id}"`);
      if (val.min !== undefined && !isNum(val.min)) r.error('trigger', `${path}.min`, 'must be a number 0-100');
      break;
    }
    default: {
      // contactWithin / contactDetected / contactDestroyed / contactSelected
      if (CONTACT_PREDICATES.has(key)) {
        const payload = isObj(val) ? val : { id: val };
        if (!isStr(payload.id)) {
          r.error('trigger', path, `takes {id} (or {id, nm} for contactWithin), got ${JSON.stringify(val)}`);
          break;
        }
        if (!ctx.contactIds.has(payload.id)) {
          r.error('unknownContact', `${path}.id`, `references unknown contact "${payload.id}"`);
        }
        if (key === 'contactWithin' && !isNum(payload.nm)) {
          r.error('trigger', `${path}.nm`, 'contactWithin requires a radius in nm');
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

function validateEffects(effects, r, path, ctx) {
  if (!Array.isArray(effects)) { r.error('effects', path, 'effects must be an array'); return; }
  effects.forEach((eff, i) => {
    const epath = `${path}[${i}]`;
    if (!isObj(eff)) { r.error('effects', epath, 'effect must be an object with one key'); return; }
    const keys = Object.keys(eff);
    if (keys.length !== 1) {
      r.error('effects', epath, `effect must have exactly one key, got ${keys.length} (${keys.join(', ')})`);
      return;
    }
    const [type] = keys;
    const val = eff[type];
    if (!EFFECT_TYPES.has(type)) {
      r.error('unknownEffect', epath, `unknown effect "${type}"; expected one of ${[...EFFECT_TYPES].join(', ')}`);
      return;
    }
    switch (type) {
      case 'setFlag':
        if (!isObj(val) || !isStr(val.key)) r.error('effects', `${epath}.setFlag`, 'takes {key, value}');
        else if (val.key.startsWith('sys.')) r.error('reservedFlag', `${epath}.setFlag.key`, `"sys." flags are engine-owned and must not be set by content`);
        break;
      case 'spawnContact':
        validateContactObject(val, r, `${epath}.spawnContact`, ctx);
        break;
      case 'orderContact': {
        if (!isObj(val)) { r.error('effects', `${epath}.orderContact`, 'takes {id, course?, speed?, waypoints?, behavior?}'); break; }
        if (!isStr(val.id)) r.error('effects', `${epath}.orderContact.id`, 'required');
        else if (!ctx.contactIds.has(val.id)) r.error('unknownContact', `${epath}.orderContact.id`, `references unknown contact "${val.id}"`);
        if (val.behavior !== undefined) validateBehavior(val.behavior, r, `${epath}.orderContact.behavior`, ctx);
        break;
      }
      case 'setRoe':
        if (!isObj(val) || !ROE_LEVELS.includes(val.level)) {
          r.error('effects', `${epath}.setRoe`, `takes {level} where level is one of ${ROE_LEVELS.join('|')}`);
        }
        break;
      case 'damageOwnship': {
        if (!isObj(val)) { r.error('effects', `${epath}.damageOwnship`, 'takes {zone, amount}'); break; }
        if (!ZONE_ORDER.includes(val.zone)) r.error('effects', `${epath}.damageOwnship.zone`, `unknown zone "${val.zone}"; expected one of ${ZONE_ORDER.join('|')}`);
        if (!isNum(val.amount) || val.amount <= 0) r.error('effects', `${epath}.damageOwnship.amount`, 'must be a positive number');
        break;
      }
      case 'revealTruth': {
        const id = isObj(val) ? val.id : val;
        if (!isStr(id)) r.error('effects', `${epath}.revealTruth`, 'takes {id}');
        else if (!ctx.contactIds.has(id)) r.error('unknownContact', `${epath}.revealTruth.id`, `references unknown contact "${id}"`);
        break;
      }
      case 'setDeception': {
        if (!isObj(val) || !isStr(val.id)) { r.error('effects', `${epath}.setDeception`, 'takes {id, block}'); break; }
        if (!ctx.contactIds.has(val.id)) r.error('unknownContact', `${epath}.setDeception.id`, `references unknown contact "${val.id}"`);
        if (val.block !== null && val.block !== undefined && !isObj(val.block)) {
          r.error('effects', `${epath}.setDeception.block`, 'must be a deception object or null to drop the deception');
        }
        break;
      }
      case 'addObjective': case 'completeObjective': case 'failObjective': {
        const id = isObj(val) ? val.id : val;
        if (!isStr(id)) r.error('effects', `${epath}.${type}`, 'takes {id}');
        else if (!ctx.objectiveIds.has(id)) r.error('unknownObjective', `${epath}.${type}.id`, `references unknown objective "${id}"`);
        break;
      }
      case 'endMission': {
        const id = isObj(val) ? val.outcomeId : val;
        if (!isStr(id)) r.error('effects', `${epath}.endMission`, 'takes {outcomeId}');
        else if (!ctx.outcomeIds.has(id)) r.error('unknownOutcome', `${epath}.endMission.outcomeId`, `references unknown outcome "${id}"`);
        break;
      }
      case 'queueNode': {
        if (!isObj(val) || !isStr(val.nodeId)) { r.error('effects', `${epath}.queueNode`, 'takes {nodeId, afterSeconds}'); break; }
        if (!ctx.nodeIds.has(val.nodeId)) r.error('unknownNode', `${epath}.queueNode.nodeId`, `references unknown node "${val.nodeId}"`);
        if (val.afterSeconds !== undefined && !isNum(val.afterSeconds)) {
          r.error('effects', `${epath}.queueNode.afterSeconds`, 'must be a number of seconds');
        }
        break;
      }
    }
  });
}

function forEachEffect(mission, fn) {
  const visit = (effects) => { if (Array.isArray(effects)) effects.forEach(fn); };
  if (Array.isArray(mission.nodes)) {
    for (const n of mission.nodes) {
      if (!isObj(n)) continue;
      visit(n.effects);
      if (Array.isArray(n.options)) for (const o of n.options) if (isObj(o)) visit(o.effects);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Objectives and outcomes
 * ------------------------------------------------------------------ */

function validateObjectives(mission, r, ctx) {
  if (!Array.isArray(mission.objectives)) { r.error('shape', 'objectives', 'objectives must be an array'); return; }
  let hasGeometry = false;

  mission.objectives.forEach((o, i) => {
    const path = `objectives[${i}]${isObj(o) && isStr(o.id) ? ` (${o.id})` : ''}`;
    if (!isObj(o)) { r.error('shape', path, 'objective must be an object'); return; }
    if (!isStr(o.id)) r.error('objective', `${path}.id`, 'required');
    if (!isStr(o.text)) r.error('objective', `${path}.text`, 'required, shown in the objective tray');
    if (!OBJECTIVE_TYPES.includes(o.type)) {
      r.error('objective', `${path}.type`, `must be one of ${OBJECTIVE_TYPES.join('|')}, got ${JSON.stringify(o.type)}`);
      return;
    }
    const p = o.params || {};
    const needContact = ['destroy', 'protect', 'identify'].includes(o.type);
    if (needContact) {
      if (!isStr(p.contactId)) r.error('objective', `${path}.params.contactId`, `${o.type} objective requires params.contactId`);
      else if (!ctx.contactIds.has(p.contactId)) r.error('unknownContact', `${path}.params.contactId`, `references unknown contact "${p.contactId}"`);
    }
    if (o.type === 'identify' && p.min !== undefined && !isNum(p.min)) {
      r.error('objective', `${path}.params.min`, 'must be a number 0-100');
    }
    if (o.type === 'reach') {
      if (!isPos(p.pos)) r.error('objective', `${path}.params.pos`, 'reach objective requires params.pos {x,y}');
      if (!isNum(p.nm)) r.error('objective', `${path}.params.nm`, 'reach objective requires params.nm');
    }
    if (o.type === 'hold') {
      const anchored = isPos(p.pos) || (isStr(p.contactId) && ctx.contactIds.has(p.contactId));
      if (!anchored) r.error('objective', `${path}.params`, 'hold objective requires params.pos {x,y} or params.contactId');
      if (!isNum(p.nm)) r.error('objective', `${path}.params.nm`, 'hold objective requires params.nm');
      if (!isNum(p.seconds)) r.error('objective', `${path}.params.seconds`, 'hold objective requires params.seconds');
    }
    if (o.type === 'flag' && !isStr(p.key)) {
      r.error('objective', `${path}.params.key`, 'flag objective requires params.key');
    }
    if (o.type === 'survive' && p.seconds !== undefined && !isNum(p.seconds)) {
      r.error('objective', `${path}.params.seconds`, 'must be a number of seconds');
    }
    if (!o.optional && ['reach', 'hold', 'protect'].includes(o.type)) hasGeometry = true;
  });

  if (!hasGeometry) {
    r.warn('geometryObjective', 'objectives',
      'no non-optional reach/hold/protect objective: without a geometry constraint the radar scope does no work (GDD pillar 4)');
  }
}

function validateOutcomes(mission, r, ctx) {
  if (!Array.isArray(mission.outcomes)) { r.error('shape', 'outcomes', 'outcomes must be an array'); return; }
  if (mission.outcomes.length === 0) { r.error('outcomes', 'outcomes', 'at least one outcome is required'); return; }

  mission.outcomes.forEach((o, i) => {
    const path = `outcomes[${i}]${isObj(o) && isStr(o.id) ? ` (${o.id})` : ''}`;
    if (!isObj(o)) { r.error('shape', path, 'outcome must be an object'); return; }
    if (!isStr(o.id)) r.error('outcome', `${path}.id`, 'required');
    if (!isStr(o.title)) r.error('outcome', `${path}.title`, 'required');
    if (!isStr(o.debrief)) r.error('outcome', `${path}.debrief`, 'required, markdown — the narrative payoff');
    if (!RATINGS.includes(o.rating)) {
      r.error('outcome', `${path}.rating`, `must be one of ${RATINGS.join('|')}, got ${JSON.stringify(o.rating)}`);
    }
    if (o.condition === undefined) r.error('outcome', `${path}.condition`, 'required, a trigger expression');
    else validateTrigger(o.condition, r, `${path}.condition`, ctx);
  });

  const last = mission.outcomes[mission.outcomes.length - 1];
  if (!isObj(last) || last.condition?.always !== true) {
    r.error('catchAll', `outcomes[${mission.outcomes.length - 1}].condition`,
      'the last outcome must be a catch-all: {"always": true}. A mission whose outcome list can fall through is a validation error');
  }
}

/* ------------------------------------------------------------------ *
 * Truth leaks — the most common authoring mistake
 * ------------------------------------------------------------------ */

function checkTruthLeaks(mission, r) {
  if (!Array.isArray(mission.nodes) || !Array.isArray(mission.contacts)) return;
  const deceptive = mission.contacts.filter((c) => isObj(c) && isObj(c.deception) && isObj(c.truth));

  for (const n of mission.nodes) {
    if (!isObj(n) || !isStr(n.text)) continue;
    const path = `nodes[${n.id}].text`;
    const revealsHere = new Set();
    for (const eff of n.effects || []) {
      if (isObj(eff) && eff.revealTruth) revealsHere.add(isObj(eff.revealTruth) ? eff.revealTruth.id : eff.revealTruth);
    }
    for (const c of deceptive) {
      if (revealsHere.has(c.id)) continue; // the node that breaks the deception may name it
      if (isStr(c.truth.type) && containsWord(n.text, c.truth.type)) {
        r.error('truthLeak', path,
          `text names the hidden truth type "${c.truth.type}" of deceptive contact "${c.id}"; the crew states what it thinks, not what the author knows`);
      }
      if (containsWord(n.text, c.truth.allegiance)) {
        r.warn('truthLeak', path,
          `text contains "${c.truth.allegiance}", the hidden allegiance of deceptive contact "${c.id}" — check this is not a leak`);
      }
    }
  }
}

function containsWord(haystack, needle) {
  if (!isStr(needle)) return false;
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`, 'i').test(haystack);
}

/* ------------------------------------------------------------------ *
 * The three coupling warnings
 * ------------------------------------------------------------------ */

function checkCouplingWarnings(mission, r, ctx) {
  if (!Array.isArray(mission.nodes)) return;

  for (const n of mission.nodes) {
    if (!isObj(n) || !Array.isArray(n.options) || n.options.length === 0) continue;
    const path = `nodes[${n.id}]`;

    // 1. A choice node with no focus list.
    if (!Array.isArray(n.focus) || n.focus.length === 0) {
      r.warn('coupling.focus', path,
        'choice node has no focus list: it asks the player to decide about something the game has not shown them');
    }
    // 2. A choice node where no option has a requires clause.
    if (!n.options.some((o) => isObj(o) && o.requires !== undefined)) {
      r.warn('coupling.requires', path,
        'no option is gated by requires: the choice can be answered without reading the scope');
    }
  }

  // 3. A contact referenced by an outcome condition with no node firing on its detection.
  // A contact is "spoken about" if a node fires on detecting/closing it, or if a
  // node brackets it on the scope -- a focus bracket does the same introducing work.
  const detectionNodes = new Set();
  for (const n of mission.nodes) {
    if (!isObj(n)) continue;
    collectTriggerContacts(n.trigger, detectionNodes, ['contactDetected', 'contactWithin']);
    if (Array.isArray(n.focus)) {
      for (const f of n.focus) if (typeof f === 'string') detectionNodes.add(f);
    }
  }
  const outcomeContacts = new Set();
  for (const o of mission.outcomes || []) {
    if (isObj(o)) collectTriggerContacts(o.condition, outcomeContacts, null);
  }
  for (const id of outcomeContacts) {
    if (id === 'ownship') continue;
    if (!detectionNodes.has(id)) {
      r.warn('coupling.spoken', `outcomes -> ${id}`,
        `contact "${id}" can change the outcome but no node fires on its detection: a threat never spoken about will be missed, and the player will read that as unfair`);
    }
  }
}

function collectTriggerContacts(t, out, onlyKeys) {
  if (!isObj(t)) return;
  for (const [key, val] of Object.entries(t)) {
    if (key === 'not') { collectTriggerContacts(val, out, onlyKeys); continue; }
    if (key === 'all' || key === 'any') {
      if (Array.isArray(val)) val.forEach((s) => collectTriggerContacts(s, out, onlyKeys));
      continue;
    }
    if (!CONTACT_PREDICATES.has(key)) continue;
    if (onlyKeys && !onlyKeys.includes(key)) continue;
    const id = isObj(val) ? val.id : val;
    if (isStr(id)) out.add(id);
  }
}

export { Report };
