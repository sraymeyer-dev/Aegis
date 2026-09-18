/**
 * dialogue-ui.js — speaker cards, the message queue, choice buttons, timer bar.
 *
 * This zone NEVER reads the sim directly. It receives resolved text and
 * resolved option availability, and it emits dialogue:choose intents. That
 * separation is what lets the same node pool run headless in CI.
 */

import { interpolate, activeOptions } from '../narrative/dialogue.js';
import { PORTRAITS } from './portraits.js';

const OPTION_KEYS = ['1', '2', '3', '4', '5', '6'];

export function createDialogueUI(root, state, bus) {
  root.innerHTML = `
    <div id="dialogue-column">
      <div id="dialogue-history" role="log" aria-live="polite" aria-label="Crew traffic"></div>
      <div id="queue-depth"></div>
      <div id="dialogue-choice" class="u-hide">
        <div id="choice-timer-label"></div>
        <div id="choice-timer"><span></span></div>
        <div id="choice-options"></div>
      </div>
    </div>
  `;
  const elHistory = root.querySelector('#dialogue-history');
  const elChoice = root.querySelector('#dialogue-choice');
  const elTimer = root.querySelector('#choice-timer');
  const elTimerBar = elTimer.querySelector('span');
  const elTimerLabel = root.querySelector('#choice-timer-label');
  const elOptions = root.querySelector('#choice-options');
  const elDepth = root.querySelector('#queue-depth');

  /** Lines already rendered, so history is append-only and never re-flows. */
  const rendered = new Set();
  let activeEl = null;
  let activeNodeId = null;
  let lastOptionsSignature = '';

  function speakerOf(key) {
    return state.mission.speakers?.[key] ?? { name: key, role: '', portrait: 'cic', color: 'green' };
  }

  function appendLine(node, { dropped = false } = {}) {
    const spk = speakerOf(node.speaker);
    const el = document.createElement('div');
    el.className = `speech is-active spk-${spk.color === 'amber' ? 'amber' : 'green'}${dropped ? ' is-dropped' : ''}`;
    el.innerHTML = `
      <div class="speech-head">
        <span class="speech-portrait">${PORTRAITS[spk.portrait] ?? PORTRAITS.cic}</span>
        <span class="speech-name">${escapeHtml(spk.name)}</span>
        <span class="speech-role">${escapeHtml(spk.role)}</span>
      </div>
      <div class="speech-text">${escapeHtml(interpolate(node.text, state))}</div>
    `;
    if (activeEl) activeEl.classList.remove('is-active');
    elHistory.appendChild(el);
    elHistory.scrollTop = elHistory.scrollHeight;
    activeEl = el;
    return el;
  }

  // Facts arrive on the bus. The UI listens; it does not poll the node pool.
  bus.on('dialogue:active', ({ nodeId }) => {
    const node = findNode(nodeId);
    if (node && !rendered.has(nodeId)) { rendered.add(nodeId); appendLine(node); }
  });
  bus.on('dialogue:choiceActive', ({ nodeId }) => {
    const node = findNode(nodeId);
    if (node && !rendered.has(nodeId)) { rendered.add(nodeId); appendLine(node); }
    activeNodeId = nodeId;
    lastOptionsSignature = '';
  });
  bus.on('dialogue:dropped', ({ nodeId }) => {
    // Visible, so a player can tell the difference between "nothing happened"
    // and "the watch was too busy to pass it on".
    const node = findNode(nodeId);
    if (node) appendLine({ ...node, text: `[traffic dropped — watch saturated] ${node.text}` }, { dropped: true });
  });
  bus.on('dialogue:resolved', ({ nodeId, optionId, timedOut }) => {
    if (nodeId !== activeNodeId) return;
    const node = findNode(nodeId);
    const opt = node?.options?.find((o) => o.id === optionId);
    if (opt) {
      const el = document.createElement('div');
      el.className = 'speech is-active';
      el.innerHTML = `<div class="speech-head"><span class="speech-name u-hot">CAPTAIN</span>
        <span class="speech-role">${timedOut ? 'no order given' : ''}</span></div>
        <div class="speech-text">${escapeHtml(opt.text)}</div>`;
      if (activeEl) activeEl.classList.remove('is-active');
      elHistory.appendChild(el);
      elHistory.scrollTop = elHistory.scrollHeight;
      activeEl = el;
    }
    activeNodeId = null;
  });

  function findNode(id) {
    return (state.mission.nodes ?? []).find((n) => n.id === id) ?? null;
  }

  let wasChoice = false;

  function render() {
    const d = state.dialogue;
    const isChoice = !!d.active?.isChoice;

    elChoice.classList.toggle('u-hide', !isChoice);
    // Opening the choice panel shrinks the history. Re-anchor to the bottom,
    // or the line that prompted the decision is cut off mid-sentence.
    if (isChoice !== wasChoice) {
      wasChoice = isChoice;
      requestAnimationFrame(() => { elHistory.scrollTop = elHistory.scrollHeight; });
    }
    elDepth.textContent = d.queue.length > 1 ? `${d.queue.length} waiting` : '';

    if (!isChoice) { lastOptionsSignature = ''; return; }

    const node = d.active.node;
    const timeout = node.timeoutSeconds;

    if (timeout == null) {
      // A node with no timeout pauses the sim. Say so rather than showing a
      // frozen bar the player will read as a bug.
      elTimer.classList.add('is-paused');
      elTimerBar.style.width = '100%';
      elTimerLabel.textContent = 'SIM HELD — AWAITING YOUR ORDER';
      elTimerLabel.classList.remove('is-urgent');
    } else {
      const frac = Math.max(0, Math.min(1, d.timerRemaining / timeout));
      const urgent = d.timerRemaining <= 5;
      elTimer.classList.remove('is-paused');
      elTimer.classList.toggle('is-urgent', urgent);
      elTimerLabel.classList.toggle('is-urgent', urgent);
      elTimerBar.style.width = `${frac * 100}%`;
      const def = node.options.find((o) => o.id === node.defaultOption);
      elTimerLabel.textContent =
        `${Math.ceil(Math.max(0, d.timerRemaining))}s — no order defaults to: ${def ? def.text : 'nothing'}`;
    }

    const opts = activeOptions(state);
    // Re-render only when availability actually changes: a requires clause can
    // flip mid-node as the geometry changes, and the player must see that.
    const signature = `${node.id}|${opts.map((o) => `${o.id}:${o.available}:${o.reason ?? ''}`).join(';')}`;
    if (signature === lastOptionsSignature) return;
    lastOptionsSignature = signature;

    elOptions.replaceChildren(...opts.map((o, i) => {
      const b = document.createElement('button');
      b.className = `choice-option${o.isDefault ? ' is-default' : ''}`;
      b.disabled = !o.available;
      b.innerHTML = `<span class="opt-key">${OPTION_KEYS[i] ?? ''}</span>${escapeHtml(o.text)}` +
        (o.reason ? `<span class="opt-reason">${escapeHtml(o.reason)}</span>` : '');
      b.addEventListener('click', () => bus.intent('dialogue:choose', { optionId: o.id }));
      return b;
    }));
  }

  /** Number keys pick options; returns true if the key was consumed. */
  function handleKey(key) {
    const i = OPTION_KEYS.indexOf(key);
    if (i < 0 || !state.dialogue.active?.isChoice) return false;
    const opts = activeOptions(state);
    const opt = opts[i];
    if (!opt || !opt.available) return true;
    bus.intent('dialogue:choose', { optionId: opt.id });
    return true;
  }

  return { render, handleKey };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
