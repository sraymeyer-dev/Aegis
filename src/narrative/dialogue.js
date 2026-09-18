/**
 * dialogue.js — the node pool, the queue, timers, and focus resolution.
 *
 * Three objects, per the design:
 *   FLAGS  a flat key/value map: the entire narrative memory of the mission
 *   NODES  authored units with a trigger, a speaker, text, options, effects
 *   QUEUE  nodes that have fired but not yet been read
 *
 * The attention constraint is what turns this from a menu into a game. Only
 * one node is actionable at a time, the queue backs up while the sim runs,
 * and a choice node that times out picks its default -- usually the passive
 * option, which is sometimes exactly wrong.
 *
 * RISK BEING INSTRUMENTED HERE (GDD "open risks", #2): six nodes queueing
 * during the thirty seconds that actually matter means the player reads none
 * of them. queueDepthPeak and nodesDropped are recorded from this milestone
 * on, so the problem is visible before it is felt.
 */

import { evaluate, resolveFocus, explainRequirement } from './triggers.js';
import { applyEffects } from './effects.js';

/** Informational nodes auto-advance after this many seconds plus reading time. */
const READ_BASE_SECONDS = 2.5;
const READ_SECONDS_PER_WORD = 0.16;

/** Above this depth, low-priority informational nodes are dropped outright. */
const QUEUE_DEPTH_CAP = 5;

export function readTimeFor(text) {
  const words = String(text).trim().split(/\s+/).length;
  return READ_BASE_SECONDS + words * READ_SECONDS_PER_WORD;
}

export function isChoiceNode(node) {
  return Array.isArray(node.options) && node.options.length > 0;
}

/* ------------------------------------------------------------------ *
 * Trigger evaluation pass
 * ------------------------------------------------------------------ */

export function stepDialogueTriggers(state) {
  const d = state.dialogue;

  // Nodes chained directly by queueNode, when a tree really is wanted.
  const due = [];
  d.scheduled = d.scheduled.filter((s) => {
    if (state.clock.t >= s.at) { due.push(s.nodeId); return false; }
    return true;
  });
  for (const id of due) {
    const node = findNode(state, id);
    if (node) pushNode(state, node, { forced: true });
  }

  for (const node of state.mission.nodes ?? []) {
    const once = node.once !== false;
    if (once && d.fired.has(node.id)) continue;
    if (d.queue.some((q) => q.node.id === node.id)) continue;
    if (d.active?.node.id === node.id) continue;
    if (!evaluate(node.trigger, state)) continue;
    pushNode(state, node);
  }
}

function findNode(state, id) {
  return (state.mission.nodes ?? []).find((n) => n.id === id) ?? null;
}

function pushNode(state, node, opts = {}) {
  const d = state.dialogue;
  d.fired.add(node.id);

  const entry = {
    node,
    priority: node.priority ?? 5,
    queuedAt: state.clock.t,
    isChoice: isChoiceNode(node),
    forced: !!opts.forced,
  };

  // Queue-depth cap: under load, low-priority chatter is dropped rather than
  // stacked, because a queue the player stops reading is worse than silence.
  if (!entry.isChoice && entry.priority < 6 && d.queue.length >= QUEUE_DEPTH_CAP) {
    state.metrics.nodesDropped = (state.metrics.nodesDropped ?? 0) + 1;
    state.events.push({ kind: 'dialogue:dropped', nodeId: node.id, depth: d.queue.length });
    return;
  }

  d.queue.push(entry);
  // Choice nodes and high-priority reports jump the chatter ahead of them.
  d.queue.sort((a, b) => (b.priority - a.priority) || (a.queuedAt - b.queuedAt));

  state.metrics.queueDepthPeak = Math.max(state.metrics.queueDepthPeak ?? 0, d.queue.length);
  state.events.push({ kind: 'dialogue:queued', nodeId: node.id, depth: d.queue.length });
}

/**
 * Selecting a contact on the scope promotes any queued node referencing it to
 * the head of the queue. This is the scope reaching back into the dialogue
 * column; it goes through state, never through a direct call from the UI.
 */
export function promoteNodesForContact(state, contactId) {
  const d = state.dialogue;
  let promoted = 0;
  for (const entry of d.queue) {
    if (entry.promoted) continue;
    if (nodeReferencesContact(entry.node, contactId)) {
      entry.priority = Math.min(10, entry.priority + 3);
      entry.promoted = true;
      promoted++;
    }
  }
  if (promoted) {
    d.queue.sort((a, b) => (b.priority - a.priority) || (a.queuedAt - b.queuedAt));
    state.events.push({ kind: 'dialogue:promoted', contactId, count: promoted });
  }
}

function nodeReferencesContact(node, contactId) {
  if (Array.isArray(node.focus) && node.focus.includes(contactId)) return true;
  return JSON.stringify(node.trigger ?? {}).includes(`"${contactId}"`);
}

/* ------------------------------------------------------------------ *
 * Queue advance and timers
 * ------------------------------------------------------------------ */

export function stepDialogue(state, dt) {
  const d = state.dialogue;

  if (!d.active) { activateNext(state); return; }

  if (d.active.isChoice) {
    const node = d.active.node;
    if (node.timeoutSeconds == null) return;   // a node with no timeout pauses the sim
    d.timerRemaining -= dt;
    if (d.timerRemaining <= 0) {
      const option = node.options.find((o) => o.id === node.defaultOption);
      state.metrics.choiceNodesTimedOut++;
      state.events.push({ kind: 'dialogue:timedOut', nodeId: node.id, optionId: option?.id });
      resolveChoice(state, option, { timedOut: true });
    }
    return;
  }

  d.readRemaining -= dt;
  if (d.readRemaining <= 0) {
    state.events.push({ kind: 'dialogue:resolved', nodeId: d.active.node.id });
    d.active = null;
    d.focus = [];
    activateNext(state);
  }
}

function activateNext(state) {
  const d = state.dialogue;
  if (d.queue.length === 0) return;

  const entry = d.queue.shift();
  d.active = entry;
  d.focus = resolveFocus(entry.node.focus, state);

  if (entry.isChoice) {
    d.timerRemaining = entry.node.timeoutSeconds ?? Infinity;
    // A node with no timeout pauses the simulation. Use sparingly: it breaks
    // the attention pressure the whole design runs on.
    if (entry.node.timeoutSeconds == null) state.clock.paused = true;
    state.events.push({ kind: 'dialogue:choiceActive', nodeId: entry.node.id });
  } else {
    d.readRemaining = readTimeFor(entry.node.text);
    applyEffects(state, entry.node.effects, { nodeId: entry.node.id });
    state.events.push({ kind: 'dialogue:active', nodeId: entry.node.id });
  }
}

/** The player picked an option. Called from the intent drain, never directly by UI. */
export function chooseOption(state, optionId) {
  const d = state.dialogue;
  if (!d.active || !d.active.isChoice) return { ok: false, reason: 'no choice is active' };

  const node = d.active.node;
  const option = node.options.find((o) => o.id === optionId);
  if (!option) return { ok: false, reason: `no option "${optionId}" on node ${node.id}` };

  if (option.requires && !evaluate(option.requires, state)) {
    return { ok: false, reason: explainRequirement(option.requires, state) };
  }

  state.metrics.choiceNodesAnswered++;
  resolveChoice(state, option, { timedOut: false });
  return { ok: true };
}

function resolveChoice(state, option, { timedOut }) {
  const d = state.dialogue;
  const node = d.active.node;

  state.trackLog.push({
    t: state.clock.t,
    contactId: null,
    event: 'decision',
    detail: `${node.id}: ${option ? option.text : '(no default option)'}${timedOut ? ' [timed out]' : ''}`,
    nodeId: node.id,
    optionId: option?.id ?? null,
    timedOut,
  });

  if (option) applyEffects(state, option.effects, { nodeId: node.id, optionId: option.id });

  state.clock.paused = false;
  d.active = null;
  d.focus = [];
  state.events.push({ kind: 'dialogue:resolved', nodeId: node.id, optionId: option?.id, timedOut });
  activateNext(state);
}

/* ------------------------------------------------------------------ *
 * Presentation helpers -- text interpolation
 * ------------------------------------------------------------------ */

/**
 * {{contact:id}} renders the track number, or the name once the ladder has
 * actually been climbed. It never renders truth. Crew speak about what they
 * can see on their own console, like everyone else in the room.
 */
export function interpolate(text, state) {
  return String(text).replace(/\{\{(\w+):([^}]+)\}\}/g, (match, kind, arg) => {
    const key = arg.trim();
    if (kind === 'contact') {
      const c = state.contacts.get(key);
      if (!c) return match;
      return c.confidence >= 75 ? c.name : `TRACK ${c.trackNumber ?? '----'}`;
    }
    if (kind === 'flag') return String(state.flags.get(key) ?? '');
    if (kind === 'ownship') return String(state.ownship[key] ?? '');
    return match;
  });
}

/** Options with their availability resolved, for the dialogue column. */
export function activeOptions(state) {
  const d = state.dialogue;
  if (!d.active?.isChoice) return [];
  return d.active.node.options.map((o) => {
    const available = !o.requires || evaluate(o.requires, state);
    return {
      id: o.id,
      text: o.text,
      available,
      // Every requires failure carries a one-line reason. An option greyed out
      // for a reason the player cannot see reads as a bug, not as a rule.
      reason: available ? null : explainRequirement(o.requires, state),
      isDefault: o.id === d.active.node.defaultOption,
    };
  });
}
