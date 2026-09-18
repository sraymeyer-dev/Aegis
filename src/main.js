/**
 * main.js — bootstrap and screen routing.
 *
 * Wires the four UI zones to one GameState and one bus. The render loop reads
 * state; every input becomes an intent. Nothing here contains content: no
 * contact names, no dialogue, no mission logic. If it would differ between
 * missions, it lives in JSON.
 */

import { loadManifest, loadMission, startMission } from './data/mission-loader.js';
import { createBus } from './core/bus.js';
import { createLoop, tick } from './core/loop.js';
import { activeOptions } from './narrative/dialogue.js';
import { COMPRESSION_STEPS, RANGE_RINGS } from './data/constants.js';
import { createScope } from './ui/scope.js';
import { createProfile } from './ui/profile.js';
import { createOrders, ORDER_KEYS } from './ui/orders.js';
import { createDialogueUI } from './ui/dialogue-ui.js';
import { createHud } from './ui/hud.js';
import { renderDebrief } from './ui/debrief.js';
import { renderSelect, renderBriefing } from './ui/select.js';
import { createSound } from './ui/sound.js';
import { displayedLabel, displayedName } from './sim/sensors.js';
import { range, bearing, closureRate } from './core/geometry.js';
import { isRungDone } from './ui/orders.js';

const DEV = new URLSearchParams(location.search).has('dev')
  || ['localhost', '127.0.0.1', ''].includes(location.hostname);

const screens = {
  select: document.getElementById('screen-select'),
  briefing: document.getElementById('screen-briefing'),
  playing: document.getElementById('screen-playing'),
  debrief: document.getElementById('screen-debrief'),
};

const sound = createSound();
let manifest = [];
let currentMission = null;
let currentFile = null;
let state = null;
let bus = null;
let loop = null;
let ui = null;
let runCounter = 0;

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let reducedMotion = localStorage.getItem('aegis.reducedMotion') === 'true' || prefersReduced;
document.body.classList.toggle('reduced-motion', reducedMotion);

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.classList.toggle('is-active', key === name);
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  try {
    manifest = await loadManifest();
    renderSelect(screens.select, manifest, { onPick: pickMission });
  } catch (err) {
    renderSelect(screens.select, [], {
      onPick: () => {},
      error: `${err.message}\n\nIf you are opening index.html directly from disk, the browser will `
        + `block the manifest fetch. Serve the folder instead:\n\n  npm run serve\n\nthen open the printed URL.`,
    });
  }
  show('select');
}

async function pickMission(file) {
  try {
    currentMission = await loadMission(file, { dev: DEV });
    currentFile = file;
  } catch (err) {
    renderSelect(screens.select, [], { onPick: () => {}, error: err.message });
    show('select');
    return;
  }
  if (!currentMission) return;
  renderBriefing(screens.briefing, currentMission, {
    onStart: () => { sound.startHum(); beginMission(); },
    onBack: () => show('select'),
  });
  show('briefing');
}

/* ------------------------------------------------------------------ *
 * The playing screen
 * ------------------------------------------------------------------ */

function beginMission() {
  if (loop) loop.stop();
  if (ui?.scope) ui.scope.destroy();

  state = startMission(currentMission, { run: runCounter++ });
  bus = createBus();

  const scope = createScope(document.getElementById('scope-canvas'), state, bus);
  scope.setReducedMotion(reducedMotion);

  ui = {
    scope,
    profile: createProfile(document.getElementById('zone-profile'), state, bus),
    orders: createOrders(document.getElementById('zone-orders'), state, bus, {
      onPlotToggle: () => scope.setPlotting(!scope.plotting),
    }),
    dialogue: createDialogueUI(document.getElementById('dialogue-host'), state, bus),
    hud: createHud(document.getElementById('zone-status'), document.getElementById('objective-tray'), state, bus),
    hover: document.getElementById('hover-readout'),
    trackData: document.getElementById('track-data'),
  };

  wireScopeControls(scope);
  wireSound(bus);

  loop = createLoop(state, bus, render);
  loop.start();
  show('playing');

  // Debug handle, used by tools/smoke.js to assert the render-loop rule and
  // to drive the game in CI. Read-only as far as the game is concerned.
  if (DEV) window.__aegis = { get state() { return state; }, bus, loop, render, ui, tick, activeOptions };
}

/** The render loop READS state. It never writes it. */
function render(state_, realDt) {
  ui.scope.render(realDt);
  ui.profile.render();
  ui.orders.render();
  ui.dialogue.render();
  ui.hud.render();
  renderHover();
  renderTrackData();

  if (state.ended && loop.running) {
    loop.stop();
    sound.play('missionEnded');
    renderDebrief(screens.debrief, state, {
      onReplay: beginMission,
      onSelect: () => { sound.stopHum(); show('select'); },
    });
    show('debrief');
  }
}

/* --- hover readout: free, instant, never pauses -------------------- */

function renderHover() {
  const info = ui.scope.hoverInfo();
  if (!info) { ui.hover.classList.add('u-hide'); return; }
  const { contact: c, screen } = info;
  const r = range(state.ownship.pos, c.pos);
  const b = bearing(state.ownship.pos, c.pos);
  const closure = closureRate(state.ownship, c);

  ui.hover.innerHTML = `
    <div class="hr-name">${escapeHtml(displayedName(c, c.confidence))}</div>
    <div class="hr-class">${escapeHtml(displayedLabel(c, c.confidence, c.apparent))}</div>
    <div class="hr-grid">
      <span>BRG</span><span>${String(Math.round(b)).padStart(3, '0')}°</span>
      <span>RNG</span><span>${r.toFixed(1)} nm</span>
      <span>CRS</span><span>${String(Math.round(c.course)).padStart(3, '0')}°</span>
      <span>SPD</span><span>${Math.round(c.speed)} kts</span>
      ${c.domain === 'air' ? `<span>ALT</span><span>${Math.round(c.alt).toLocaleString()} ft</span>` : ''}
      <span>CLS</span><span>${closure >= 0 ? '+' : ''}${Math.round(closure)} kts</span>
      <span>CONF</span><span>${c.confidence}%</span>
    </div>
    <div class="hr-rungs">${rungSummary(c)}</div>
  `;
  ui.hover.classList.remove('u-hide');

  const pad = 14;
  const rect = ui.hover.getBoundingClientRect();
  const parent = ui.hover.parentElement.getBoundingClientRect();
  let x = screen.x + pad;
  let y = screen.y + pad;
  if (x + rect.width > parent.width) x = screen.x - rect.width - pad;
  if (y + rect.height > parent.height) y = screen.y - rect.height - pad;
  ui.hover.style.left = `${Math.max(0, x)}px`;
  ui.hover.style.top = `${Math.max(0, y)}px`;
}

const RUNGS = [
  ['iff', 'IFF'], ['esm', 'ESM'], ['hail', 'HAIL'],
  ['illuminate', 'ILLUM'], ['visual', 'VIS'], ['investigate', 'VBSS'],
];

function rungSummary(c) {
  const done = RUNGS.filter(([id]) => isRungDone(c, id)).map(([, label]) => label);
  return done.length ? `resolved: ${done.join(' ')}` : 'no resolution actions taken';
}

/* --- track data panel: the selected contact ------------------------ */

function renderTrackData() {
  const c = state.ui.selectedContactId ? state.contacts.get(state.ui.selectedContactId) : null;
  if (!c || !c.detected) {
    ui.trackData.innerHTML = '<div class="readout-empty">No track selected. Click a contact on the scope, or Tab to cycle.</div>';
    return;
  }
  const r = range(state.ownship.pos, c.pos);
  const b = bearing(state.ownship.pos, c.pos);
  const closure = closureRate(state.ownship, c);
  const tcpa = closure > 0.1 ? (r / closure) * 60 : null;

  ui.trackData.innerHTML = `
    <div class="readout-name">${escapeHtml(displayedName(c, c.confidence))}</div>
    <div class="readout-class cls-${c.displayedClass}">${escapeHtml(displayedLabel(c, c.confidence, c.apparent))}</div>
    <dl class="readout-grid">
      <dt>BRG</dt><dd>${String(Math.round(b)).padStart(3, '0')}°</dd>
      <dt>RNG</dt><dd>${r.toFixed(1)} nm</dd>
      <dt>CRS</dt><dd>${String(Math.round(c.course)).padStart(3, '0')}°</dd>
      <dt>SPD</dt><dd>${Math.round(c.speed)} kts</dd>
      ${c.domain === 'air' ? `<dt>ALT</dt><dd>${Math.round(c.alt).toLocaleString()} ft</dd>` : '<dt></dt><dd></dd>'}
      <dt>CLS</dt><dd>${closure >= 0 ? '+' : ''}${Math.round(closure)} kts</dd>
      <dt>TCPA</dt><dd>${tcpa != null && tcpa < 999 ? `${Math.round(tcpa)} min` : '—'}</dd>
      <dt>DOM</dt><dd>${c.domain}</dd>
    </dl>
    <div class="confidence-bar ${c.confidence >= 75 ? 'is-confirmed' : ''}"
         title="${c.confidence}% — 75% is the confirmation threshold">
      <span style="width:${c.confidence}%"></span></div>
    <div id="resolution-ladder">${RUNGS.map(([id, label]) => {
      const running = c.resolution.pending?.some((p) => p.action === id);
      const done = isRungDone(c, id);
      return `<span class="rung ${done ? 'is-done' : ''} ${running ? 'is-running' : ''}">${label}</span>`;
    }).join('')}</div>
  `;
}

/* --- scope chrome and keyboard ------------------------------------- */

function wireScopeControls(scope) {
  const controls = document.getElementById('scope-controls');
  controls.replaceChildren(...RANGE_RINGS.map((nm) => {
    const b = document.createElement('button');
    b.textContent = `${nm}`;
    b.title = `${nm} nm range scale`;
    b.addEventListener('click', () => scope.setZoom(nm));
    b.dataset.zoom = nm;
    return b;
  }));
  const orient = document.createElement('button');
  orient.id = 'btn-orient';
  orient.textContent = 'N-UP';
  orient.title = 'Toggle north-up / head-up';
  orient.addEventListener('click', () => {
    orient.textContent = scope.toggleOrientation() === 'north-up' ? 'N-UP' : 'H-UP';
  });
  controls.appendChild(orient);

  const motion = document.createElement('button');
  motion.textContent = reducedMotion ? 'MOTION OFF' : 'MOTION ON';
  motion.title = 'Phosphor bloom, sweep and jitter';
  motion.addEventListener('click', () => {
    reducedMotion = !reducedMotion;
    localStorage.setItem('aegis.reducedMotion', String(reducedMotion));
    document.body.classList.toggle('reduced-motion', reducedMotion);
    scope.setReducedMotion(reducedMotion);
    motion.textContent = reducedMotion ? 'MOTION OFF' : 'MOTION ON';
  });
  controls.appendChild(motion);

  const audio = document.createElement('button');
  audio.textContent = 'SOUND ON';
  audio.addEventListener('click', () => {
    sound.setEnabled(!sound.enabled);
    audio.textContent = sound.enabled ? 'SOUND ON' : 'SOUND OFF';
    if (sound.enabled) sound.startHum();
  });
  controls.appendChild(audio);

  // Keep the zoom buttons showing the live scale.
  setInterval(() => {
    for (const b of controls.querySelectorAll('[data-zoom]')) {
      b.classList.toggle('is-on', Number(b.dataset.zoom) === state?.ui.zoom);
    }
  }, 200);
}

let lastTickSecond = -1;
function wireSound(bus) {
  bus.on('contact:detected', () => sound.play('contactAcquired'));
  bus.on('contact:classified', () => sound.play('trackResolved'));
  bus.on('weapon:launched', () => sound.play('missileAway'));
  bus.on('weapon:inbound', () => sound.play('inbound'));
  bus.on('weapon:aborted', () => sound.play('weaponAborted'));
  bus.on('damage:taken', () => {
    sound.play('damage');
    const el = document.getElementById('zone-scope');
    el.classList.add('is-jittering');
    setTimeout(() => el.classList.remove('is-jittering'), 600);
  });
  bus.on('dialogue:queued', ({ nodeId }) => {
    const node = currentMission.nodes.find((n) => n.id === nodeId);
    const idx = Object.keys(currentMission.speakers).indexOf(node?.speaker ?? '');
    sound.play('dialogue', Math.max(0, idx));
  });
  bus.on('contact:displayChanged', ({ to }) => {
    if (to === 'declared-hostile' || to === 'confirmed-hostile') sound.play('hostileDeclared');
  });
}

/** The accelerating choice-timer tick, driven off the render loop. */
function tickSound() {
  if (!state?.dialogue.active?.isChoice) { lastTickSecond = -1; return; }
  const rem = state.dialogue.timerRemaining;
  if (!Number.isFinite(rem)) return;
  const urgent = rem <= 5;
  const period = urgent ? 0.33 : 1;
  const slot = Math.floor(rem / period);
  if (slot !== lastTickSecond) { lastTickSecond = slot; sound.play('timerTick', urgent); }
}
setInterval(tickSound, 60);

/* --- keyboard ------------------------------------------------------ */

window.addEventListener('keydown', (ev) => {
  if (!state || state.phase !== 'playing' || !screens.playing.classList.contains('is-active')) return;
  if (ev.target.tagName === 'INPUT' || ev.metaKey || ev.ctrlKey || ev.altKey) return;

  sound.resume();

  // Number keys answer the active choice node first.
  if (ui.dialogue.handleKey(ev.key)) { ev.preventDefault(); return; }

  const key = ev.key.toLowerCase();

  if (ev.code === 'Space') { ev.preventDefault();
    bus.intent(state.clock.paused ? 'clock:resume' : 'clock:pause', {}); return; }
  if (['1', '2', '3', '4'].includes(ev.key)) { ev.preventDefault();
    bus.intent('clock:setCompression', { compression: COMPRESSION_STEPS[Number(ev.key) - 1] }); return; }
  if (ev.key === 'Escape') { bus.intent('order:deselect', {}); ui.scope.setPlotting(false); return; }
  if (ev.key === 'Tab') { ev.preventDefault(); cycleContact(ev.shiftKey ? -1 : 1); return; }

  const verb = ORDER_KEYS[key];
  if (!verb) return;
  ev.preventDefault();
  if (verb === 'plot') { ui.scope.setPlotting(!ui.scope.plotting); return; }
  const id = state.ui.selectedContactId;
  if (!id) return;
  bus.intent(`order:${verb}`, { id });
});

function cycleContact(dir) {
  const list = [...state.contacts.values()]
    .filter((c) => c.detected && c.alive && c.active)
    .sort((a, b) => range(state.ownship.pos, a.pos) - range(state.ownship.pos, b.pos));
  if (!list.length) return;
  const i = list.findIndex((c) => c.id === state.ui.selectedContactId);
  const next = list[(i + dir + list.length + (i < 0 ? 1 : 0)) % list.length];
  bus.intent('order:select', { id: next.id });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

boot();
