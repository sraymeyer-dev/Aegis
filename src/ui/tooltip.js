/**
 * tooltip.js — one floating panel, shared by every control.
 *
 * Controls describe themselves by calling `tips.bind(el, () => spec)`. The
 * getter is re-read on every hover, so a live value (a cooldown, a refusal
 * reason, a range) is always current without the control having to push
 * updates.
 *
 * WHEN TOOLTIPS ARE OFF, the "why is this unavailable" line survives as a
 * native title attribute. The explanation is decoration; the refusal reason is
 * not. An option greyed out for a reason the player cannot see reads as a bug,
 * which is the one failure this whole interface is built to avoid.
 */

const STORAGE_KEY = 'aegis.tooltips';
const SHOW_DELAY_MS = 260;
const EDGE_PAD = 10;

export function createTooltips(root = document.body) {
  const el = document.createElement('div');
  el.id = 'tooltip';
  el.className = 'u-hide';
  el.setAttribute('role', 'tooltip');
  root.appendChild(el);

  let enabled = readStored();
  let timer = null;
  let current = null;

  function readStored() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === 'true';
    } catch { return true; }
  }

  function hide() {
    clearTimeout(timer);
    timer = null;
    current = null;
    el.classList.add('u-hide');
  }

  function render(spec) {
    const parts = [];
    if (spec.title) parts.push(`<div class="tip-title">${esc(spec.title)}</div>`);
    if (spec.key) parts.push(`<div class="tip-key">KEY <b>${esc(spec.key)}</b></div>`);
    if (spec.body) parts.push(`<div class="tip-body">${esc(spec.body).replace(/\n/g, '<br>')}</div>`);
    if (spec.cost) parts.push(`<div class="tip-line tip-cost">${esc(spec.cost)}</div>`);
    if (spec.risk) parts.push(`<div class="tip-line tip-risk">${esc(spec.risk)}</div>`);
    if (spec.reason) parts.push(`<div class="tip-line tip-reason">UNAVAILABLE — ${esc(spec.reason)}</div>`);
    el.innerHTML = parts.join('');
  }

  function place(anchor) {
    el.classList.remove('u-hide');
    const a = anchor.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer above the control; fall back below when there is no room.
    let top = a.top - t.height - 8;
    if (top < EDGE_PAD) top = Math.min(a.bottom + 8, vh - t.height - EDGE_PAD);

    let left = a.left + a.width / 2 - t.width / 2;
    left = Math.max(EDGE_PAD, Math.min(left, vw - t.width - EDGE_PAD));

    el.style.top = `${Math.max(EDGE_PAD, top)}px`;
    el.style.left = `${left}px`;
  }

  function show(anchor, getSpec) {
    const spec = typeof getSpec === 'function' ? getSpec() : getSpec;
    if (!spec || (!spec.title && !spec.body && !spec.reason)) return;
    current = anchor;
    render(spec);
    place(anchor);
  }

  /**
   * Bind a control to its explanation.
   * @param {Element} anchor
   * @param {() => object|object} getSpec re-read on every hover
   */
  function bind(anchor, getSpec) {
    const enter = () => {
      if (!enabled) return;
      clearTimeout(timer);
      timer = setTimeout(() => show(anchor, getSpec), SHOW_DELAY_MS);
    };
    const leave = () => { if (current === anchor || timer) hide(); };

    anchor.addEventListener('mouseenter', enter);
    anchor.addEventListener('mouseleave', leave);
    // Keyboard users get the same explanation on focus, with no delay.
    anchor.addEventListener('focus', () => { if (enabled) show(anchor, getSpec); });
    anchor.addEventListener('blur', leave);
    // A click means the player has decided; the panel is in the way after that.
    anchor.addEventListener('mousedown', hide);

    anchor.__tipSpec = getSpec;
    syncAccessible(anchor);
    return () => {
      anchor.removeEventListener('mouseenter', enter);
      anchor.removeEventListener('mouseleave', leave);
    };
  }

  /**
   * Keep a control's non-visual explanation in step with the setting.
   *
   * Two separate concerns, deliberately not collapsed:
   *
   *   aria-label   ALWAYS carries the refusal reason on a disabled control,
   *                whatever the tooltip setting. A screen reader user must not
   *                have to discover that a button is dead by trying it, and
   *                the reason is functional information, not decoration.
   *
   *   title        only when tooltips are OFF. With them on it is removed, so
   *                the native tooltip does not surface a second later on top
   *                of the panel that already answered the question.
   */
  function syncAccessible(anchor) {
    const getSpec = anchor.__tipSpec;
    if (!getSpec) return;
    let spec;
    try { spec = typeof getSpec === 'function' ? getSpec() : getSpec; } catch { return; }

    const reason = spec?.reason ?? null;
    const dead = anchor.disabled === true || anchor.getAttribute('aria-disabled') === 'true';

    // A control can stay disabled while the REASON it is disabled changes --
    // select a contact and "no contact selected" becomes "not classified yet".
    // Callers therefore refresh every frame, so this bails out unless the
    // string actually moved. Without the guard it would be a DOM write per
    // control per frame, which is the churn that broke clicking in the first
    // place.
    const signature = `${dead}|${reason ?? ''}|${enabled}`;
    if (anchor.__tipSig === signature) return;
    anchor.__tipSig = signature;

    if (reason && dead) {
      // Prefer the control's own label element: the keyboard-shortcut badge
      // is decoration and must not be read out as part of the name.
      const source = anchor.querySelector?.('.btn-text') ?? anchor;
      const label = (source.textContent ?? '').replace(/\s+/g, ' ').trim();
      anchor.setAttribute('aria-label', label ? `${label}. Unavailable: ${reason}` : `Unavailable: ${reason}`);
    } else {
      anchor.removeAttribute('aria-label');
    }

    if (!enabled && reason) anchor.title = reason;
    else anchor.removeAttribute('title');
  }

  /** Re-read every bound control. Cheap: called only on toggle. */
  function syncAll() {
    for (const node of root.querySelectorAll('*')) {
      if (node.__tipSpec) syncAccessible(node);
    }
  }

  return {
    bind,
    hide,
    /** Called by a control whose disabled state or reason just changed. */
    refresh(anchor) { syncAccessible(anchor); },
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = on;
      try { localStorage.setItem(STORAGE_KEY, String(on)); } catch { /* private mode */ }
      if (!on) hide();
      syncAll();
    },
    toggle() { this.setEnabled(!enabled); return enabled; },
  };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
