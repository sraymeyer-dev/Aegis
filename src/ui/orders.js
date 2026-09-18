/**
 * orders.js — the order rail.
 *
 * BUILD ONCE, UPDATE IN PLACE.
 *
 * This module used to call replaceChildren() on every animation frame, which
 * destroyed and recreated every button roughly sixty times a second. A button
 * pressed by a human does not survive that: the element you moused down on is
 * gone before you release, so no click event is ever delivered and the order
 * is silently lost. It felt intermittent, because a fast enough click lands
 * inside a single frame.
 *
 * The rule the rest of the UI already followed: create DOM once, then mutate
 * only disabled / class / textContent on render. hud.js, profile.js and the
 * scope controls were all doing this, which is exactly why those buttons
 * worked and these did not. tests assert element identity is stable.
 *
 * It NEVER applies effects directly; it emits intents on the bus, which the
 * loop drains at the top of the next tick. A click during a paused game
 * therefore behaves identically to a click during 8x compression.
 */

import { LADDER, ROE_LABEL, ABORT_WINDOW_SECONDS } from '../data/constants.js';
import { checkRoe, selectWeapon } from '../sim/weapons.js';
import { range } from '../core/geometry.js';
import { LADDER_HELP, WEAPON_HELP, NAV_HELP } from './help-text.js';

/** Single-letter shortcuts for every rail verb. */
export const ORDER_KEYS = {
  h: 'hail', i: 'iff', e: 'esm', l: 'illuminate', v: 'investigate',
  d: 'declare', f: 'engage', c: 'plot',
};

const SENSOR_VERBS = [
  { id: 'iff', label: 'IFF', key: 'I' },
  { id: 'esm', label: 'ESM', key: 'E' },
  { id: 'hail', label: 'Hail', key: 'H' },
  { id: 'illuminate', label: 'Illuminate', key: 'L', danger: true },
  { id: 'investigate', label: 'Helo/VBSS', key: 'V' },
];

/** Below the surface the same verbs mean different things. */
const SUB_LABEL = { illuminate: 'Active ping', investigate: 'Helo prosecute', hail: 'Gertrude' };

const SPEEDS = [0, 12, 18, 24, 30];

export function createOrders(root, state, bus, { onPlotToggle, tips } = {}) {
  root.innerHTML = `
    <div id="order-target" class="u-dim">No contact selected</div>
    <div class="order-group"><span class="u-label">Sensors</span><span id="rail-sensors"></span></div>
    <div class="order-group"><span class="u-label">Weapons</span><span id="rail-weapons"></span></div>
    <div class="order-group"><span class="u-label">Nav</span><span id="rail-nav"></span></div>
    <div class="order-group"><span class="u-label">In flight</span><span id="inflight-rail"></span></div>
    <div id="order-feedback" role="status" aria-live="polite"></div>
  `;
  const elTarget = root.querySelector('#order-target');
  const elFlight = root.querySelector('#inflight-rail');
  const elFeedback = root.querySelector('#order-feedback');

  let feedback = '';
  let feedbackUntil = 0;
  bus.on('order:rejected', ({ reason }) => {
    feedback = reason;
    feedbackUntil = performance.now() + 4500;
  });

  const selected = () => {
    const id = state.ui.selectedContactId;
    return id ? state.contacts.get(id) ?? null : null;
  };

  /* --- build the rail ONCE ---------------------------------------- */

  function makeButton(parent, { label, key, danger, onClick, tip }) {
    const b = document.createElement('button');
    b.className = `order-btn${danger ? ' is-danger' : ''}`;
    const text = document.createElement('span');
    text.className = 'btn-text';
    text.textContent = label;
    b.appendChild(text);
    if (key) {
      const k = document.createElement('span');
      k.className = 'key';
      k.setAttribute('aria-hidden', 'true');   // decoration, not part of the name
      k.textContent = key;
      b.appendChild(k);
    }
    const bar = document.createElement('span');
    bar.className = 'cool';
    b.appendChild(bar);

    b.addEventListener('click', onClick);
    if (tips && tip) tips.bind(b, tip);
    parent.appendChild(b);
    return { el: b, text, bar };
  }

  const sensorBtns = {};
  const railSensors = root.querySelector('#rail-sensors');
  for (const v of SENSOR_VERBS) {
    sensorBtns[v.id] = makeButton(railSensors, {
      label: v.label, key: v.key, danger: v.danger,
      onClick: () => {
        const c = selected();
        if (c) bus.intent(`order:${v.id}`, { id: c.id });
      },
      tip: () => sensorTip(v),
    });
  }

  const railWeapons = root.querySelector('#rail-weapons');
  const declareBtn = makeButton(railWeapons, {
    label: 'Declare hostile', key: 'D', danger: true,
    onClick: () => { const c = selected(); if (c) bus.intent('order:declare', { id: c.id }); },
    tip: () => declareTip(),
  });
  const engageBtn = makeButton(railWeapons, {
    label: 'Engage', key: 'F', danger: true,
    onClick: () => { const c = selected(); if (c) bus.intent('order:engage', { id: c.id }); },
    tip: () => engageTip(),
  });

  const railNav = root.querySelector('#rail-nav');
  const plotBtn = makeButton(railNav, {
    label: 'Plot course', key: 'C',
    onClick: () => onPlotToggle?.(),
    tip: () => ({ ...NAV_HELP.plot }),
  });
  const clearBtn = makeButton(railNav, {
    label: 'Clear track',
    onClick: () => bus.intent('order:setCourse', { waypoints: [] }),
    tip: () => ({
      ...NAV_HELP.clear,
      reason: state.ownship.waypoints.length === 0 ? NAV_HELP.clear.reasonEmpty : null,
    }),
  });
  const speedBtns = SPEEDS.map((kts) => makeButton(railNav, {
    label: String(kts),
    onClick: () => bus.intent('order:setSpeed', { speed: kts }),
    tip: () => ({
      ...NAV_HELP.speed,
      title: `ORDER ${kts} KNOTS`,
      cost: state.ownship.systems.propulsion
        ? `Currently ordered: ${Math.round(state.ownship.orderedSpeed)} kts · making ${Math.round(state.ownship.speed)} kts`
        : 'Engineering is out — capped at 12 knots regardless of what you order.',
    }),
  }));

  /* --- update in place -------------------------------------------- */

  function setDisabled(btn, disabled) {
    if (btn.el.disabled !== disabled) btn.el.disabled = disabled;
    // Refresh unconditionally: the reason a control is unavailable changes
    // while the control stays unavailable. tooltip.js no-ops unless the text
    // actually moved, so this costs a string compare per button per frame.
    if (tips) tips.refresh(btn.el);
  }
  const setText = (btn, s) => { if (btn.text.textContent !== s) btn.text.textContent = s; };
  const setClass = (btn, cls, on) => btn.el.classList.toggle(cls, on);
  const setBar = (btn, frac) => {
    const w = frac == null ? '' : `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    if (btn.bar.style.width !== w) btn.bar.style.width = w;
  };

  function render() {
    const c = selected();
    const sub = c?.domain === 'subsurface';

    elTarget.innerHTML = c
      ? `Target <b>${c.trackNumber ? `TRACK ${c.trackNumber}` : c.id}</b> &middot; ${c.confidence}% &middot; ${ROE_LABEL[state.roe]}`
      : `No contact selected &middot; ${ROE_LABEL[state.roe]}`;

    for (const v of SENSOR_VERBS) {
      const btn = sensorBtns[v.id];
      const pending = c?.resolution.pending.find((p) => p.action === v.id);
      const done = c ? isRungDone(c, v.id) : false;
      const na = sub && v.id === 'iff';
      setText(btn, (sub && SUB_LABEL[v.id]) || v.label);
      setDisabled(btn, !c || !c.detected || !c.alive || done || !!pending || na);
      setClass(btn, 'is-running', !!pending);
      setClass(btn, 'is-done', done);
      setBar(btn, pending ? 1 - pending.remaining / pending.total : null);
    }

    const roe = c ? checkRoe(state, c) : { allowed: false, reason: 'No contact selected.' };
    const weapon = c ? selectWeapon(state, c) : null;
    const cooling = weapon ? (state.ownship.weaponCooldowns[weapon.id] ?? 0) : 0;

    setText(declareBtn, c?.declaredHostile ? 'Undeclare' : 'Declare hostile');
    setDisabled(declareBtn, !c || c.confidence < 40);
    setClass(declareBtn, 'is-armed', !!c?.declaredHostile);

    setText(engageBtn, weapon ? `Engage — ${weapon.label}` : 'Engage');
    setDisabled(engageBtn, !c || !roe.allowed || !weapon || cooling > 0);
    setClass(engageBtn, 'is-running', cooling > 0);
    setBar(engageBtn, weapon && cooling > 0 ? 1 - cooling / (weapon.cooldown ?? 3) : null);

    setClass(plotBtn, 'is-armed', !!state.ui.plotting);
    setDisabled(clearBtn, state.ownship.waypoints.length === 0);
    SPEEDS.forEach((kts, i) =>
      setClass(speedBtns[i], 'is-armed', Math.round(state.ownship.orderedSpeed) === kts));

    renderInFlight();
    elFeedback.textContent = performance.now() < feedbackUntil ? feedback : '';
  }

  /* In-flight chips are the one list whose membership genuinely changes, so
     it is keyed by projectile id and only reconciled when the set differs. */
  const chips = new Map();
  function renderInFlight() {
    const live = state.projectiles.filter((p) => p.alive && p.shooterId === 'ownship');
    const ids = new Set(live.map((p) => p.id));

    for (const [id, chip] of chips) {
      if (!ids.has(id)) { chip.el.remove(); chips.delete(id); }
    }
    for (const p of live) {
      let chip = chips.get(p.id);
      if (!chip) {
        const el = document.createElement('button');
        el.className = 'inflight-chip';
        el.addEventListener('click', () => bus.intent('order:abort', { projectileId: p.id }));
        if (tips) tips.bind(el, () => ({ ...WEAPON_HELP.abort }));
        elFlight.appendChild(el);
        chip = { el };
        chips.set(p.id, chip);
      }
      const elapsed = state.clock.t - p.launchedAt;
      const abortable = p.abortable && elapsed <= ABORT_WINDOW_SECONDS;
      const label = abortable
        ? `ABORT ${p.name} (${Math.ceil(ABORT_WINDOW_SECONDS - elapsed)}s)`
        : `${p.name} — no abort`;
      if (chip.el.textContent !== label) chip.el.textContent = label;
      chip.el.disabled = !abortable;
      chip.el.classList.toggle('is-abortable', abortable);
    }
    elFlight.classList.toggle('is-empty', live.length === 0);
  }

  /* --- tooltip specs, re-read live on every hover ------------------ */

  function sensorTip(v) {
    const c = selected();
    const sub = c?.domain === 'subsurface';
    const help = LADDER_HELP[v.id];
    const spec = {
      title: (sub && help.subsurfaceTitle) || help.title,
      body: (sub && help.subsurfaceBody) || help.body,
      cost: help.cost,
      risk: help.risk,
      key: help.key,
    };
    if (!c) spec.reason = 'No contact selected. Click a track on the scope, or press Tab.';
    else if (!c.detected) spec.reason = 'That contact is not on the scope.';
    else if (!c.alive) spec.reason = 'That contact is gone.';
    else if (sub && help.notApplicable?.subsurface) spec.reason = help.notApplicable.subsurface;
    else if (isRungDone(c, v.id)) spec.reason = 'Already done for this contact. It cannot tell you anything new.';
    else {
      const pending = c.resolution.pending.find((p) => p.action === v.id);
      if (pending) spec.reason = `Running — ${pending.remaining.toFixed(1)}s remaining.`;
    }
    return spec;
  }

  function declareTip() {
    const c = selected();
    const spec = { ...WEAPON_HELP.declare };
    if (c?.declaredHostile) {
      spec.title = 'WITHDRAW HOSTILE DECLARATION';
      spec.body = 'Remove the hostile declaration from this track. The symbol returns to what the '
                + 'evidence actually supports.\n\nThe original declaration stays in the recorder.';
    }
    if (!c) spec.reason = 'No contact selected. Click a track on the scope, or press Tab.';
    else if (c.confidence < 40) spec.reason = `${WEAPON_HELP.declare.reasonUnknown} (${c.confidence}% of 40% needed)`;
    return spec;
  }

  function engageTip() {
    const c = selected();
    const spec = { ...WEAPON_HELP.engage };
    if (!c) { spec.reason = 'No contact selected. Click a track on the scope, or press Tab.'; return spec; }

    const roe = checkRoe(state, c);
    const weapon = selectWeapon(state, c);
    const r = range(state.ownship.pos, c.pos);

    if (weapon) {
      const cooling = state.ownship.weaponCooldowns[weapon.id] ?? 0;
      spec.cost = `${weapon.label} · target at ${r.toFixed(1)} nm of ${weapon.range} nm reach`
                + ` · ${Math.round((weapon.pk?.[c.domain] ?? 0.5) * 100)}% kill probability`;
      if (cooling > 0) spec.reason = `${weapon.label} is reloading — ${cooling.toFixed(1)}s.`;
    }
    if (!roe.allowed) spec.reason = roe.reason;
    else if (!weapon) {
      spec.reason = `Nothing in the magazine reaches a ${c.domain} contact at ${r.toFixed(1)} nm.`;
    }
    return spec;
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
