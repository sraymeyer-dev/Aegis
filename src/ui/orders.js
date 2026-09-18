/**
 * orders.js — the order rail.
 *
 * Verb buttons, target-required arming, ROE gating, cooldown lockouts.
 * It NEVER applies effects directly; it emits intents on the bus, which the
 * loop drains at the top of the next tick. A click during a paused game
 * therefore behaves identically to a click during 8x compression.
 */

import { LADDER, ROE_LABEL, ABORT_WINDOW_SECONDS } from '../data/constants.js';
import { checkRoe, selectWeapon } from '../sim/weapons.js';
import { range } from '../core/geometry.js';

/** Single-letter shortcuts for every rail verb. */
export const ORDER_KEYS = {
  h: 'hail', i: 'iff', e: 'esm', l: 'illuminate', v: 'investigate',
  d: 'declare', f: 'engage', c: 'plot',
};

const SENSOR_VERBS = [
  { id: 'iff',         label: 'IFF',        key: 'I', rung: 'iff' },
  { id: 'esm',         label: 'ESM',        key: 'E', rung: 'esm' },
  { id: 'hail',        label: 'Hail',       key: 'H', rung: 'hail' },
  { id: 'illuminate',  label: 'Illuminate', key: 'L', rung: 'illuminate', danger: true },
  { id: 'investigate', label: 'Helo/VBSS',  key: 'V', rung: 'investigate' },
];

export function createOrders(root, state, bus, { onPlotToggle } = {}) {
  root.innerHTML = `
    <div id="order-target" class="u-dim">No contact selected</div>
    <div class="order-group"><span class="u-label">Sensors</span><span id="rail-sensors"></span></div>
    <div class="order-group"><span class="u-label">Weapons</span><span id="rail-weapons"></span></div>
    <div class="order-group"><span class="u-label">Nav</span><span id="rail-nav"></span></div>
    <div class="order-group"><span class="u-label">In flight</span><span id="inflight-rail"></span></div>
    <div id="order-feedback" role="status" aria-live="polite"></div>
  `;
  const elTarget = root.querySelector('#order-target');
  const elSensors = root.querySelector('#rail-sensors');
  const elWeapons = root.querySelector('#rail-weapons');
  const elNav = root.querySelector('#rail-nav');
  const elFlight = root.querySelector('#inflight-rail');
  const elFeedback = root.querySelector('#order-feedback');

  let feedback = '';
  let feedbackUntil = 0;

  bus.on('order:rejected', ({ reason }) => {
    feedback = reason;
    feedbackUntil = performance.now() + 4200;
  });

  function button(label, key, opts = {}) {
    const b = document.createElement('button');
    b.className = `order-btn${opts.danger ? ' is-danger' : ''}`;
    b.innerHTML = `${label}${key ? `<span class="key">${key}</span>` : ''}`;
    if (opts.title) b.title = opts.title;
    b.disabled = !!opts.disabled;
    if (opts.running) b.classList.add('is-running');
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    if (opts.progress != null) {
      const bar = document.createElement('span');
      bar.className = 'cool';
      bar.style.width = `${Math.round(opts.progress * 100)}%`;
      b.appendChild(bar);
    }
    return b;
  }

  function selected() {
    const id = state.ui.selectedContactId;
    return id ? state.contacts.get(id) ?? null : null;
  }

  function render() {
    const c = selected();

    elTarget.innerHTML = c
      ? `Target <b>${c.trackNumber ? `TRACK ${c.trackNumber}` : c.id}</b> &middot; ${c.confidence}% &middot; ${ROE_LABEL[state.roe]}`
      : `No contact selected &middot; ${ROE_LABEL[state.roe]}`;

    /* --- sensors: the resolution ladder ---------------------------- */
    elSensors.replaceChildren(...SENSOR_VERBS.map((v) => {
      const rung = LADDER[v.rung];
      const pending = c?.resolution.pending.find((p) => p.action === v.id);
      const done = c ? isRungDone(c, v.id) : false;
      const disabled = !c || !c.detected || !c.alive || done || !!pending;
      return button(v.label, v.key, {
        disabled,
        danger: v.danger,
        running: !!pending,
        progress: pending ? 1 - pending.remaining / pending.total : null,
        title: !c ? 'Select a contact first'
          : done ? 'Already done for this contact'
          : `${rung.seconds}s · +${rung.confidence} confidence${v.danger ? ' · provocative' : ''}`,
        onClick: () => bus.intent(`order:${v.id}`, { id: c.id }),
      });
    }));

    /* --- weapons: ROE is a hard gate, not advice -------------------- */
    const roe = c ? checkRoe(state, c) : { allowed: false, reason: 'no contact selected' };
    const weapon = c ? selectWeapon(state, c) : null;
    const cooling = weapon ? (state.ownship.weaponCooldowns[weapon.id] ?? 0) : 0;

    const declareLabel = c?.declaredHostile ? 'Undeclare' : 'Declare hostile';
    elWeapons.replaceChildren(
      button(declareLabel, 'D', {
        disabled: !c || c.confidence < 40,
        danger: true,
        title: !c ? 'Select a contact first'
          : c.confidence < 40 ? `Contact is unknown (${c.confidence}%) — nothing to declare yet`
          : 'Declares this track hostile. The recorder keeps the confidence you did it at.',
        onClick: () => bus.intent('order:declare', { id: c.id }),
      }),
      button(weapon ? `Engage — ${weapon.label}` : 'Engage', 'F', {
        disabled: !c || !roe.allowed || !weapon || cooling > 0,
        danger: true,
        running: cooling > 0,
        progress: weapon && cooling > 0 ? 1 - cooling / (weapon.cooldown ?? 3) : null,
        title: !c ? 'Select a contact first'
          : !roe.allowed ? roe.reason
          : !weapon ? 'Nothing in the magazine reaches that contact from here'
          : cooling > 0 ? `${weapon.label} reloading (${cooling.toFixed(1)}s)`
          : `Release ${weapon.label} at ${range(state.ownship.pos, c.pos).toFixed(1)} nm`,
        onClick: () => bus.intent('order:engage', { id: c.id }),
      }),
    );

    /* --- nav ------------------------------------------------------- */
    const speedBtn = (kts) => button(`${kts}`, '', {
      disabled: false,
      running: Math.round(state.ownship.orderedSpeed) === kts,
      title: `Order ${kts} knots`,
      onClick: () => bus.intent('order:setSpeed', { speed: kts }),
    });
    elNav.replaceChildren(
      button('Plot course', 'C', {
        title: 'Click the scope to drop a waypoint, shift-click to append',
        onClick: () => onPlotToggle?.(),
      }),
      button('Clear track', '', {
        disabled: state.ownship.waypoints.length === 0,
        onClick: () => bus.intent('order:setCourse', { waypoints: [] }),
      }),
      speedBtn(0), speedBtn(12), speedBtn(18), speedBtn(24), speedBtn(30),
    );

    /* --- weapons in flight: the second beat of dread --------------- */
    const live = state.projectiles.filter((p) => p.alive && p.shooterId === 'ownship');
    elFlight.replaceChildren(...live.map((p) => {
      const elapsed = state.clock.t - p.launchedAt;
      const abortable = p.abortable && elapsed <= ABORT_WINDOW_SECONDS;
      const chip = document.createElement('button');
      chip.className = `inflight-chip${abortable ? ' is-abortable' : ''}`;
      chip.textContent = abortable
        ? `ABORT ${p.name} (${Math.ceil(ABORT_WINDOW_SECONDS - elapsed)}s)`
        : `${p.name} — no abort`;
      chip.disabled = !abortable;
      chip.addEventListener('click', () => bus.intent('order:abort', { projectileId: p.id }));
      return chip;
    }));
    if (!live.length) elFlight.innerHTML = '<span class="u-dim" style="font-size:var(--fs-xs)">—</span>';

    elFeedback.textContent = performance.now() < feedbackUntil ? feedback : '';
  }

  return { render };
}

export function isRungDone(c, action) {
  switch (action) {
    case 'iff': return c.resolution.iff != null;
    case 'esm': return c.resolution.esm;
    case 'hail': return c.resolution.hail;
    case 'illuminate': return c.resolution.illuminated;
    case 'investigate': return c.resolution.investigated;
    case 'visual': return c.resolution.visual;
    default: return false;
  }
}
