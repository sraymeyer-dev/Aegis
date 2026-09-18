/**
 * triggers.js — the trigger expression evaluator.
 *
 * Triggers are small JSON objects, not a string DSL. A string DSL means
 * writing a parser and debugging authored syntax errors at runtime; a JSON
 * object gets validated by the schema for free.
 *
 * The dialogue system is not a branching tree. It is a flag store plus a
 * trigger-evaluated node pool — a rules engine over game state rather than a
 * flowchart. A tree requires the author to anticipate every path; a flat pool
 * of conditionally-firing nodes composes with a live simulation.
 *
 * 14 predicates, 3 combinators. Two of the predicates exist specifically so
 * the tactical picture can drive the narrative rather than only the reverse:
 * contactSelected fires when the player clicks a contact, and ownshipWithin
 * lets crossing a line on the chart speak.
 */

import { range } from '../core/geometry.js';
import { totalIntegrity } from '../core/state.js';

/** Keys that modify a sibling predicate rather than being predicates themselves. */
const MODIFIERS = new Set(['is']);

export function evaluate(expr, state) {
  if (expr == null) return false;
  if (typeof expr === 'boolean') return expr;
  if (typeof expr !== 'object' || Array.isArray(expr)) return false;

  const keys = Object.keys(expr).filter((k) => !MODIFIERS.has(k));
  if (keys.length === 0) return false;

  // Several predicate keys in one object are an implicit AND.
  for (const key of keys) {
    if (!evaluateKey(key, expr[key], expr, state)) return false;
  }
  return true;
}

function evaluateKey(key, val, whole, state) {
  switch (key) {
    /* --- combinators ------------------------------------------------ */
    case 'all': return val.every((sub) => evaluate(sub, state));
    case 'any': return val.some((sub) => evaluate(sub, state));
    case 'not': return !evaluate(val, state);

    /* --- 14 predicates ---------------------------------------------- */
    case 'always':
      return val === true;

    case 'timeAfter':
      return state.clock.t >= val;

    case 'timeBefore':
      return state.clock.t < val;

    case 'flag': {
      const actual = state.flags.get(val);
      const expected = whole.is;
      // An unset flag is falsey, so {flag:"k", is:false} is true before anyone sets it.
      if (expected === false) return actual === false || actual === undefined;
      return actual === expected;
    }

    case 'roeIs':
      return state.roe === val;

    case 'integrityBelow':
      return totalIntegrity(state.ownship) < val;

    case 'nodeFired':
      return state.dialogue.fired.has(val);

    case 'magazineBelow': {
      const have = state.ownship.magazines[val.magazine] ?? 0;
      return have < val.count;
    }

    case 'contactDetected': {
      const c = contactOf(state, val);
      return !!c && c.detected;
    }

    case 'contactSelected': {
      const c = contactOf(state, val);
      return !!c && state.ui.selectedContactId === c.id;
    }

    case 'contactDestroyed': {
      const c = contactOf(state, val);
      // A contact that never spawned has not been destroyed.
      return !!c && !c.alive && c.destroyedAt != null;
    }

    case 'contactClassified': {
      const c = contactOf(state, val);
      if (!c) return false;
      const min = val?.min ?? 75;
      return c.confidence >= min;
    }

    case 'contactWithin': {
      const c = contactOf(state, val);
      if (!c || !c.alive || !c.active) return false;
      return range(state.ownship.pos, c.pos) <= val.nm;
    }

    case 'ownshipWithin': {
      const nm = val.nm;
      if (val.id !== undefined) {
        const c = contactOf(state, val);
        if (!c || !c.alive || !c.active) return false;
        return range(state.ownship.pos, c.pos) <= nm;
      }
      return range(state.ownship.pos, val.pos) <= nm;
    }

    default:
      // The validator rejects unknown predicates at load. Reaching here at
      // runtime means a mission bypassed validation; fail closed and loudly.
      if (typeof console !== 'undefined') {
        console.warn(`triggers: unknown predicate "${key}" evaluated as false`);
      }
      return false;
  }
}

function contactOf(state, val) {
  const id = typeof val === 'string' ? val : val?.id;
  if (id === 'ownship') return state.ownship;
  return state.contacts.get(id) ?? null;
}

/** Contacts and areas named by a node's focus list, resolved for the scope. */
export function resolveFocus(focus, state) {
  if (!Array.isArray(focus)) return [];
  const out = [];
  for (const f of focus) {
    if (typeof f === 'string') {
      const c = state.contacts.get(f);
      if (c) out.push({ kind: 'contact', id: f, contact: c });
    } else if (f && f.pos) {
      out.push({ kind: 'area', pos: f.pos, nm: f.nm });
    }
  }
  return out;
}

/**
 * Why a `requires` clause is failing, in one line, for the option tooltip.
 * An option greyed out for a reason the player cannot see reads as a bug.
 */
export function explainRequirement(expr, state) {
  if (!expr || typeof expr !== 'object') return 'unavailable';
  for (const [key, val] of Object.entries(expr)) {
    if (MODIFIERS.has(key)) continue;
    if (evaluate({ [key]: val, ...(key === 'flag' ? { is: expr.is } : {}) }, state)) continue;
    switch (key) {
      case 'all': {
        for (const sub of val) {
          if (!evaluate(sub, state)) return explainRequirement(sub, state);
        }
        return 'conditions not met';
      }
      case 'any': return 'none of the required conditions are met';
      case 'not': return 'a blocking condition is present';
      case 'contactClassified': {
        const c = contactOf(state, val);
        const min = val?.min ?? 75;
        return `contact not classified (${c?.confidence ?? 0}% of ${min}% required)`;
      }
      case 'contactWithin': {
        const c = contactOf(state, val);
        if (!c) return 'contact not on the scope';
        const r = range(state.ownship.pos, c.pos);
        return `contact is ${r.toFixed(1)} nm away, inside ${val.nm} nm required`;
      }
      case 'ownshipWithin':
        return `ownship is not within ${val.nm} nm of that position`;
      case 'contactDetected': return 'contact not detected';
      case 'contactDestroyed': return 'contact still afloat';
      case 'contactSelected': return 'select that contact on the scope first';
      case 'roeIs': return `requires ROE ${val}`;
      case 'magazineBelow': return `requires fewer than ${val.count} ${val.magazine} remaining`;
      case 'integrityBelow': return 'requires the ship to be more heavily damaged';
      case 'nodeFired': return 'that has not come up yet';
      case 'timeAfter': return 'too early';
      case 'timeBefore': return 'too late';
      case 'flag': return 'conditions not met';
      default: return 'unavailable';
    }
  }
  return 'unavailable';
}
