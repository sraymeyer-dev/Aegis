/**
 * hud.js — status strip, objective tray, time compression controls.
 */

import { COMPRESSION_STEPS, ROE_LABEL, CRIPPLED_THRESHOLD } from '../data/constants.js';
import { totalIntegrity } from '../core/state.js';
import { range } from '../core/geometry.js';
import { CLOCK_HELP } from './help-text.js';

const AUTODROP_TEXT = {
  'choice-node': 'held at 1× — decision pending',
  'weapons-release': 'held at 1× — weapons release',
  'contact-inside-10nm': 'held at 1× — contact inside 10 nm',
  'damage-event': 'held at 1× — damage',
};

export function createHud(statusRoot, trayRoot, state, bus, { tips } = {}) {
  statusRoot.innerHTML = `
    <div class="status-cell"><span class="u-label">Mission time</span>
      <span class="status-value" id="clock-value">00:00</span></div>
    <div class="status-cell"><span class="u-label">Condition</span>
      <span class="status-value" id="condition-value">READY</span></div>
    <div class="status-cell"><span class="u-label">ROE</span>
      <span class="status-value" id="roe-value">—</span></div>
    <div class="status-cell"><span class="u-label">Course / speed</span>
      <span class="status-value" id="nav-value">000° / 00 kts</span></div>
    <div class="status-cell"><span class="u-label">Integrity</span>
      <span class="status-value" id="integrity-value">100%</span></div>
    <div class="status-cell is-grow"><span class="u-label">Time compression</span>
      <span class="status-value" id="compression-controls"></span></div>
  `;

  const elClock = statusRoot.querySelector('#clock-value');
  const elCondition = statusRoot.querySelector('#condition-value');
  const elRoe = statusRoot.querySelector('#roe-value');
  const elNav = statusRoot.querySelector('#nav-value');
  const elIntegrity = statusRoot.querySelector('#integrity-value');
  const elComp = statusRoot.querySelector('#compression-controls');

  const buttons = new Map();
  for (const step of COMPRESSION_STEPS) {
    const b = document.createElement('button');
    b.textContent = `${step}×`;
    b.title = `Time compression ${step}× (key ${COMPRESSION_STEPS.indexOf(step) + 1})`;
    b.addEventListener('click', () => bus.intent('clock:setCompression', { compression: step }));
    elComp.appendChild(b);
    if (tips) tips.bind(b, () => ({
      ...CLOCK_HELP.compression,
      title: `TIME COMPRESSION ${step}\u00d7`,
      cost: step === 1
        ? 'Real time. One second of your life is one second of the watch.'
        : `${step} seconds of the watch per second of yours.`,
      reason: state.clock.paused ? 'The clock is paused. Resume before changing compression.' : null,
    }));
    buttons.set(step, b);
  }
  const pauseBtn = document.createElement('button');
  pauseBtn.textContent = 'PAUSE';
  pauseBtn.title = 'Space. Pause does not block orders.';
  pauseBtn.addEventListener('click', () =>
    bus.intent(state.clock.paused ? 'clock:resume' : 'clock:pause', {}));
  elComp.appendChild(pauseBtn);
  if (tips) tips.bind(pauseBtn, () => ({
    ...CLOCK_HELP.pause,
    title: state.clock.paused ? 'RESUME' : 'PAUSE',
  }));

  const note = document.createElement('span');
  note.id = 'autodrop-note';
  elComp.appendChild(note);

  function render() {
    const t = Math.floor(state.clock.t);
    elClock.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

    const frac = totalIntegrity(state.ownship);
    const crippled = frac < CRIPPLED_THRESHOLD;
    elCondition.textContent = !state.ownship.alive ? 'LOST'
      : crippled ? 'CRIPPLED'
      : state.projectiles.some((p) => p.alive && p.targetId === 'ownship') ? 'INBOUND'
      : anyThreatClose(state) ? 'ALERT' : 'READY';
    elCondition.className = `status-value${crippled || !state.ownship.alive ? ' condition-crippled' : ''}`;

    elRoe.textContent = ROE_LABEL[state.roe];
    elRoe.className = `status-value roe-${state.roe}`;

    const o = state.ownship;
    elNav.textContent = `${String(Math.round(o.course)).padStart(3, '0')}° / ${Math.round(o.speed)} kts`;
    elIntegrity.textContent = `${Math.round(frac * 100)}%`;
    elIntegrity.className = `status-value${frac < 0.6 ? ' u-amber' : ''}${frac < CRIPPLED_THRESHOLD ? ' u-red' : ''}`;

    for (const [step, b] of buttons) {
      b.classList.toggle('is-on', !state.clock.paused && state.clock.compression === step);
      b.disabled = state.clock.paused;
    }
    pauseBtn.classList.toggle('is-on', state.clock.paused);
    pauseBtn.textContent = state.clock.paused ? 'RESUME' : 'PAUSE';
    note.textContent = state.clock.autoDropReason ? AUTODROP_TEXT[state.clock.autoDropReason] ?? '' : '';

    renderTray();
  }

  function renderTray() {
    const rows = state.objectives.filter((o) => !o.hidden || o.status !== 'pending');
    trayRoot.innerHTML = rows.map((o) => {
      const mark = o.status === 'complete' ? '✓' : o.status === 'failed' ? '✗' : '·';
      let progress = '';
      if (o.type === 'hold' && o.status === 'active') {
        progress = ` ${Math.floor(o.heldSeconds)}/${o.params.seconds}s`;
      } else if (o.type === 'reach' && o.status === 'active' && o.params.pos) {
        progress = ` ${range(state.ownship.pos, o.params.pos).toFixed(1)} nm`;
      }
      return `<div class="objective-row status-${o.status}${o.optional ? ' is-optional' : ''}">
        <span class="obj-mark">${mark}</span>
        <span>${escapeHtml(o.text)}${o.optional ? ' (optional)' : ''}<span class="obj-progress">${progress}</span></span>
      </div>`;
    }).join('');
  }

  return { render };
}

function anyThreatClose(state) {
  for (const c of state.contacts.values()) {
    if (!c.alive || !c.active || !c.detected) continue;
    if (c.declaredHostile || c.displayedClass.includes('hostile')) {
      if (range(state.ownship.pos, c.pos) < 20) return true;
    }
  }
  return false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
