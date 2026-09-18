/**
 * scope.js — the PPI renderer and hit-testing.
 *
 * THE RENDER LOOP READS STATE AND NEVER WRITES IT. Everything this module
 * does in response to input is emitted as an intent on the bus. The one
 * exception is state.ui, which is view state and lives in the same object
 * deliberately -- and even that is written through intents, not here.
 *
 * The renderer only ever reads displayedClass, confidence and apparent.
 * It has no access to truth and must never acquire any.
 */

import {
  RANGE_RINGS, SWEEP_PERIOD_SECONDS, BLOOM_DECAY_SECONDS, CONFIDENCE_CONFIRMED,
} from '../data/constants.js';
import { range, bearing, courseVector, advance, normaliseDeg } from '../core/geometry.js';
import { displayedLabel, displayedName } from '../sim/sensors.js';

const PALETTE = {
  bg: '#050b06', dim: '#0d2712', mid: '#1f7a3a',
  bright: '#44e06a', hot: '#b8ffcf',
  amber: '#ffb02e', amberHot: '#ffd88a', red: '#ff4a3d',
};

/** Colour for a displayedClass. Amber is reserved and means something. */
function classColour(displayedClass) {
  switch (displayedClass) {
    case 'confirmed-friendly':
    case 'probable-friendly':  return PALETTE.hot;
    case 'confirmed-hostile':
    case 'probable-hostile':
    case 'declared-hostile':   return PALETTE.amber;
    case 'confirmed-neutral':
    case 'probable-neutral':   return PALETTE.bright;
    default:                   return PALETTE.mid;
  }
}

function isSolid(displayedClass) {
  return displayedClass.startsWith('confirmed') || displayedClass === 'declared-hostile';
}

export function createScope(canvas, state, bus) {
  const ctx = canvas.getContext('2d');
  /** Per-contact bloom levels: cosmetic only, never read by the sim. */
  const bloom = new Map();
  let lastSweep = 0;
  let dpr = 1;
  let view = { cx: 0, cy: 0, pxPerNm: 10 };
  let hoverPos = null;
  let plotting = false;
  let reducedMotion = false;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  /* --- coordinate transforms ---------------------------------------- */

  function viewport() {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    // Zoom is a VIEW property, never a sim property. Sensor range is
    // independent of what the player happens to be looking at.
    const pxPerNm = (Math.min(rect.width, rect.height) / 2 - 18) / state.ui.zoom;
    view = { cx, cy, pxPerNm, width: rect.width, height: rect.height };
    return view;
  }

  /** Rotation applied for head-up. North-up is the default because it makes
   *  authored bearings in mission files match what the player sees. */
  function headingOffset() {
    return state.ui.orientation === 'head-up' ? -state.ownship.course : 0;
  }

  function worldToScreen(pos) {
    const { cx, cy, pxPerNm } = view;
    const dx = pos.x - state.ownship.pos.x;
    const dy = pos.y - state.ownship.pos.y;
    const rot = headingOffset() * Math.PI / 180;
    const rx = dx * Math.cos(rot) - dy * Math.sin(rot);
    const ry = dx * Math.sin(rot) + dy * Math.cos(rot);
    return { x: cx + rx * pxPerNm, y: cy - ry * pxPerNm };
  }

  function screenToWorld(px, py) {
    const { cx, cy, pxPerNm } = view;
    const rx = (px - cx) / pxPerNm;
    const ry = -(py - cy) / pxPerNm;
    const rot = -headingOffset() * Math.PI / 180;
    const dx = rx * Math.cos(rot) - ry * Math.sin(rot);
    const dy = rx * Math.sin(rot) + ry * Math.cos(rot);
    return { x: state.ownship.pos.x + dx, y: state.ownship.pos.y + dy };
  }

  /* --- drawing ------------------------------------------------------ */

  function render(dt) {
    const v = viewport();
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(0, 0, v.width, v.height);

    drawRings(v);
    drawBearingScale(v);
    drawOwnshipTrack(v);
    updateBloom(dt);
    if (!reducedMotion) drawSweep(v);
    drawFocusAreas(v);
    drawProjectiles(v);
    drawContacts(v);
    drawOwnship(v);
  }

  function drawRings(v) {
    const { cx, cy, pxPerNm } = v;
    ctx.save();
    ctx.strokeStyle = PALETTE.dim;
    ctx.fillStyle = PALETTE.dim;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';

    for (const nm of RANGE_RINGS) {
      if (nm > state.ui.zoom * 1.05) continue;
      const r = nm * pxPerNm;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${nm}`, cx + 3, cy - r + 11);
    }
    // Cardinal spokes every 30 degrees.
    for (let deg = 0; deg < 360; deg += 30) {
      const a = (deg + headingOffset()) * Math.PI / 180;
      const outer = Math.min(v.width, v.height) / 2 - 16;
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a) * 18, cy - Math.cos(a) * 18);
      ctx.lineTo(cx + Math.sin(a) * outer, cy - Math.cos(a) * outer);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawBearingScale(v) {
    const { cx, cy } = v;
    const r = Math.min(v.width, v.height) / 2 - 9;
    ctx.save();
    ctx.fillStyle = PALETTE.mid;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 30) {
      const a = (deg + headingOffset()) * Math.PI / 180;
      ctx.fillText(String(deg).padStart(3, '0'), cx + Math.sin(a) * r, cy - Math.cos(a) * r);
    }
    ctx.restore();
  }

  /**
   * The forward projection is what makes positioning legible. Without it,
   * plotting a course is guesswork and the geometry constraints in missions
   * become unfair.
   */
  function drawOwnshipTrack(v) {
    const own = state.ownship;
    ctx.save();

    // Plotted waypoints and the legs between them.
    if (own.waypoints.length) {
      ctx.strokeStyle = PALETTE.mid;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      let from = worldToScreen(own.pos);
      ctx.moveTo(from.x, from.y);
      for (const wp of own.waypoints) {
        const p = worldToScreen(wp);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      for (const wp of own.waypoints) {
        const p = worldToScreen(wp);
        ctx.strokeStyle = PALETTE.bright;
        ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
      }
    }

    // Dashed forward projection at +5 and +10 minutes.
    ctx.strokeStyle = PALETTE.dim;
    ctx.setLineDash([2, 5]);
    const tenMin = advance(own.pos, own.course, own.speed * (10 / 60));
    const a = worldToScreen(own.pos);
    const b = worldToScreen(tenMin);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = PALETTE.dim;
    ctx.font = '9px ui-monospace, monospace';
    for (const mins of [5, 10]) {
      const p = worldToScreen(advance(own.pos, own.course, own.speed * (mins / 60)));
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
      ctx.fillText(`+${mins}`, p.x + 5, p.y - 3);
    }
    ctx.restore();
  }

  /**
   * SPY-1 is a phased array and does not mechanically sweep. The sweep is the
   * visual grammar of the genre and removing it makes the scope look dead.
   * It is cosmetic: it never gates detection.
   */
  function drawSweep(v) {
    const { cx, cy } = v;
    const outer = Math.min(v.width, v.height) / 2 - 16;
    const phase = (state.clock.t % SWEEP_PERIOD_SECONDS) / SWEEP_PERIOD_SECONDS;
    const a = (phase * 360 + headingOffset()) * Math.PI / 180;

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outer);
    grad.addColorStop(0, 'rgba(68,224,106,0.14)');
    grad.addColorStop(1, 'rgba(68,224,106,0)');
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outer, a - Math.PI / 2 - 0.42, a - Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(184,255,207,0.32)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(a) * outer, cy - Math.cos(a) * outer);
    ctx.stroke();
    ctx.restore();
    lastSweep = phase;
  }

  /** Contacts bloom as the sweep passes and decay over ~800 ms. The cheapest
   *  source of aliveness in the whole build. */
  function updateBloom(dt) {
    const phase = (state.clock.t % SWEEP_PERIOD_SECONDS) / SWEEP_PERIOD_SECONDS;
    const sweepDeg = normaliseDeg(phase * 360);
    for (const c of state.contacts.values()) {
      if (!c.detected || !c.alive || !c.active) { bloom.delete(c.id); continue; }
      const b = bearing(state.ownship.pos, c.pos);
      const delta = Math.abs(((b - sweepDeg + 540) % 360) - 180);
      const current = bloom.get(c.id) ?? 0;
      if (delta < 6) bloom.set(c.id, 1);
      else bloom.set(c.id, Math.max(0, current - dt / BLOOM_DECAY_SECONDS));
    }
  }

  function drawFocusAreas(v) {
    for (const f of state.dialogue.focus) {
      if (f.kind !== 'area') continue;
      const p = worldToScreen(f.pos);
      ctx.save();
      ctx.strokeStyle = PALETTE.amber;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, f.nm * v.pxPerNm, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function focusedIds() {
    return new Set(state.dialogue.focus.filter((f) => f.kind === 'contact').map((f) => f.id));
  }

  function drawContacts(v) {
    const focus = focusedIds();
    const dimOthers = focus.size > 0;

    for (const c of state.contacts.values()) {
      if (!c.detected || !c.alive || !c.active) continue;
      const p = worldToScreen(c.pos);
      if (p.x < -40 || p.y < -40 || p.x > v.width + 40 || p.y > v.height + 40) continue;

      const isFocused = focus.has(c.id);
      const isSelected = state.ui.selectedContactId === c.id;
      const alpha = dimOthers && !isFocused && !isSelected ? 0.28 : 1;

      ctx.save();
      ctx.globalAlpha = alpha;
      drawSymbol(c, p, isSelected);
      if (isFocused) drawBracket(p, c);
      ctx.restore();
    }
  }

  function drawProjectiles(v) {
    for (const p of state.projectiles) {
      if (!p.alive) continue;
      const s = worldToScreen(p.pos);
      ctx.save();
      ctx.strokeStyle = p.shooterId === 'ownship' ? PALETTE.hot : PALETTE.red;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      const tail = worldToScreen(advance(p.pos, normaliseDeg(p.course + 180), 1.2));
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(tail.x, tail.y); ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Simplified NTDS symbology. Note the design point: a hostile diamond is one
   * that has been DECLARED hostile by the player or by the crew, never one
   * that spawned that way.
   */
  function drawSymbol(c, p, isSelected) {
    const colour = classColour(c.displayedClass);
    const solid = isSolid(c.displayedClass);
    const b = bloom.get(c.id) ?? 0;
    const size = 7;

    ctx.strokeStyle = isSelected ? PALETTE.hot : colour;
    ctx.fillStyle = colour;
    ctx.lineWidth = isSelected ? 2 : 1.4;

    // Phosphor bloom: brighten toward --phos-hot as the sweep passes.
    if (b > 0.02 && !reducedMotion) {
      ctx.shadowColor = colour;
      ctx.shadowBlur = 10 * b;
    }
    // Unknown contacts pulse, so an unresolved track is visibly unresolved.
    if (c.displayedClass === 'unknown' && !reducedMotion) {
      ctx.globalAlpha *= 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(state.clock.t * 3.1));
    }

    ctx.beginPath();
    switch (symbolShape(c)) {
      case 'chevron':            // air
        ctx.moveTo(p.x - size, p.y + size * 0.6);
        ctx.lineTo(p.x, p.y - size * 0.75);
        ctx.lineTo(p.x + size, p.y + size * 0.6);
        break;
      case 'semicircle-down':    // friendly surface
        ctx.arc(p.x, p.y, size, Math.PI, 0);
        ctx.closePath();
        break;
      case 'semicircle-up':      // subsurface
        ctx.arc(p.x, p.y, size, 0, Math.PI);
        ctx.closePath();
        break;
      case 'square':             // neutral / civilian
        ctx.rect(p.x - size * 0.8, p.y - size * 0.8, size * 1.6, size * 1.6);
        break;
      default:                   // diamond: unknown or declared hostile
        ctx.moveTo(p.x, p.y - size);
        ctx.lineTo(p.x + size, p.y);
        ctx.lineTo(p.x, p.y + size);
        ctx.lineTo(p.x - size, p.y);
        ctx.closePath();
    }
    if (c.domain === 'subsurface') ctx.setLineDash([2, 2]);
    if (solid) ctx.fill(); else ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Course vector: length proportional to speed, one minute of travel.
    if (c.speed > 0.5) {
      const tip = worldToScreen(advance(c.pos, c.course, Math.max(0.6, c.speed / 60)));
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Track number, always; the name only once the ladder has been climbed.
    ctx.fillStyle = isSelected ? PALETTE.hot : colour;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(displayedName(c, c.confidence), p.x + size + 4, p.y - 3);
    if (c.declaredHostile) {
      ctx.fillStyle = PALETTE.amber;
      ctx.fillText('HOSTILE', p.x + size + 4, p.y + 8);
    }
  }

  function symbolShape(c) {
    if (c.domain === 'air') return 'chevron';
    if (c.domain === 'subsurface') return 'semicircle-up';
    if (c.declaredHostile) return 'diamond';
    switch (c.displayedClass) {
      case 'confirmed-friendly':
      case 'probable-friendly': return 'semicircle-down';
      case 'confirmed-neutral':
      case 'probable-neutral':  return 'square';
      case 'confirmed-hostile':
      case 'probable-hostile':  return 'diamond';
      default:                  return 'diamond';
    }
  }

  /**
   * Focus brackets. This is the mechanism that makes a 15-second timer fair:
   * the player is not hunting the scope for what the TAO is talking about,
   * they are reading data that has been placed in front of them.
   */
  function drawBracket(p, c) {
    const s = 15;
    ctx.save();
    ctx.strokeStyle = PALETTE.amber;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(p.x + sx * s, p.y + sy * s - sy * 5);
      ctx.lineTo(p.x + sx * s, p.y + sy * s);
      ctx.lineTo(p.x + sx * s - sx * 5, p.y + sy * s);
      ctx.stroke();
    }
    // Pinned readout: the evidence arrives with the decision.
    const r = range(state.ownship.pos, c.pos);
    const b = bearing(state.ownship.pos, c.pos);
    ctx.fillStyle = PALETTE.amberHot;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${String(Math.round(b)).padStart(3, '0')}° / ${r.toFixed(1)} nm`, p.x + s + 4, p.y + s);
    ctx.fillText(`${Math.round(c.speed)} kts · ${c.confidence}%`, p.x + s + 4, p.y + s + 10);
    ctx.restore();
  }

  function drawOwnship(v) {
    const { cx, cy } = v;
    const rot = (state.ownship.course + headingOffset()) * Math.PI / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.strokeStyle = PALETTE.hot;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(5, 7); ctx.lineTo(0, 4); ctx.lineTo(-5, 7);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // The blinded quadrant when the SPY-1 face is gone: the player must be
    // able to see what they have lost.
    if (!state.ownship.systems.radar && state.ownship.blindQuadrant !== null) {
      const start = (state.ownship.blindQuadrant + headingOffset() - 90) * Math.PI / 180;
      const outer = Math.min(v.width, v.height) / 2 - 16;
      ctx.save();
      ctx.fillStyle = 'rgba(255,74,61,0.09)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, outer, start, start + Math.PI / 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /* --- hit testing and input ---------------------------------------- */

  function contactAt(px, py, tolerance = 14) {
    let best = null;
    let bestDist = tolerance;
    for (const c of state.contacts.values()) {
      if (!c.detected || !c.alive || !c.active) continue;
      const p = worldToScreen(c.pos);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }

  function localPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  canvas.addEventListener('mousemove', (ev) => {
    const p = localPoint(ev);
    hoverPos = p;
    const c = contactAt(p.x, p.y);
    state.ui.hoveredId = c?.id ?? null;   // view state only; the sim never reads it
  });
  canvas.addEventListener('mouseleave', () => { hoverPos = null; state.ui.hoveredId = null; });

  canvas.addEventListener('click', (ev) => {
    const p = localPoint(ev);
    const c = contactAt(p.x, p.y);
    if (c) {
      // Selection emits an intent. It does NOT call into dialogue.js.
      bus.intent('order:select', { id: c.id });
      return;
    }
    if (plotting) {
      const world = screenToWorld(p.x, p.y);
      bus.intent('order:setCourse', { waypoint: world, append: ev.shiftKey });
      if (!ev.shiftKey) plotting = false;
      canvas.classList.toggle('is-plotting', plotting);
      return;
    }
    bus.intent('order:deselect', {});
  });

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const i = RANGE_RINGS.indexOf(state.ui.zoom);
    const next = ev.deltaY > 0 ? Math.min(RANGE_RINGS.length - 1, i + 1) : Math.max(0, i - 1);
    state.ui.zoom = RANGE_RINGS[next];
  }, { passive: false });

  return {
    render,
    resize,
    hoverInfo() {
      if (!hoverPos || !state.ui.hoveredId) return null;
      const c = state.contacts.get(state.ui.hoveredId);
      if (!c) return null;
      return { contact: c, screen: hoverPos };
    },
    setPlotting(on) { plotting = on; canvas.classList.toggle('is-plotting', on); },
    get plotting() { return plotting; },
    setZoom(nm) { if (RANGE_RINGS.includes(nm)) state.ui.zoom = nm; },
    toggleOrientation() {
      state.ui.orientation = state.ui.orientation === 'north-up' ? 'head-up' : 'north-up';
      return state.ui.orientation;
    },
    setReducedMotion(on) { reducedMotion = on; },
    worldToScreen,
    screenToWorld,
    contactAt,
    destroy() { ro.disconnect(); },
  };
}

export { classColour, PALETTE };
