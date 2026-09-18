/**
 * bus.js — minimal pub/sub.
 *
 * UI emits intents, the sim emits facts. The UI never calls sim functions
 * directly; the sim never touches the DOM.
 *
 * Intents are QUEUED and drained at the top of the next tick, never applied
 * synchronously. That is why a click during a paused game behaves identically
 * to a click during 4x compression, and it removes a whole category of
 * timing bugs.
 */

export const INTENTS = [
  'order:select', 'order:deselect', 'order:hail', 'order:iff', 'order:esm',
  'order:illuminate', 'order:engage', 'order:abort', 'order:declare',
  'order:setCourse', 'order:setSpeed', 'order:damageControl', 'order:investigate',
  'dialogue:choose', 'clock:setCompression', 'clock:pause', 'clock:resume',
];

export const FACTS = [
  'contact:detected', 'contact:classified', 'contact:destroyed',
  'weapon:launched', 'weapon:aborted', 'weapon:hit', 'weapon:miss',
  'damage:taken', 'dialogue:queued', 'dialogue:active', 'dialogue:resolved',
  'objective:changed', 'roe:changed', 'mission:ended', 'order:rejected',
  'clock:compressionChanged',
];

export function createBus() {
  const handlers = new Map();
  /** Intents awaiting the top of the next tick. */
  let intentQueue = [];

  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    off(event, fn) { handlers.get(event)?.delete(fn); },

    /** Facts: delivered synchronously to listeners. The sim announces, nobody replies. */
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      for (const fn of [...set]) fn(payload, event);
    },

    /** Intents: queued, drained by the loop at the top of the next tick. */
    intent(type, payload = {}) {
      intentQueue.push({ type, payload });
    },

    drainIntents() {
      const out = intentQueue;
      intentQueue = [];
      return out;
    },

    get pendingIntents() { return intentQueue.length; },

    clear() { handlers.clear(); intentQueue = []; },
  };
}
