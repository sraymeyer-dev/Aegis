/**
 * profile.js — the SVG ship silhouette, six damage zones, system lamps,
 * magazine counts.
 *
 * SVG rather than canvas because the silhouette needs individually
 * addressable damage zones, which are far easier as paths with ids than as
 * hit-tested canvas geometry.
 *
 * Reads ownship.integrity / .systems / .magazines. Holds no state of its own.
 */

import { DAMAGE_ZONES, ZONE_ORDER, WEAPONS } from '../data/constants.js';
import { totalIntegrity } from '../core/state.js';

/** Zone rectangles over a side elevation, in the SVG's 200x46 viewBox. */
const ZONE_GEOMETRY = {
  hull:        { x: 8,   y: 26, w: 184, h: 14, label: 'HULL' },
  vlsForward:  { x: 26,  y: 18, w: 44,  h: 8,  label: 'VLS F' },
  vlsAft:      { x: 132, y: 18, w: 44,  h: 8,  label: 'VLS A' },
  engineering: { x: 100, y: 18, w: 28,  h: 8,  label: 'ENG' },
  bridge:      { x: 74,  y: 8,  w: 40,  h: 10, label: 'BRIDGE' },
  spy:         { x: 76,  y: 2,  w: 16,  h: 6,  label: 'SPY' },
};

const SYSTEM_LABELS = {
  command: 'CMD', magForward: 'MAG-F', magAft: 'MAG-A',
  radar: 'SPY-1', propulsion: 'PROP', buoyancy: 'HULL',
};

export function createProfile(root, state, bus) {
  root.innerHTML = `
    <div class="u-label">SHIP</div>
    <div id="ship-svg-wrap">
      <svg id="ship-svg" viewBox="0 0 200 46" preserveAspectRatio="xMidYMid meet" role="img"
           aria-label="Ship damage silhouette"></svg>
    </div>
    <div id="system-lamps"></div>
    <div id="magazine-counts"></div>
  `;
  const svg = root.querySelector('#ship-svg');
  const lamps = root.querySelector('#system-lamps');
  const mags = root.querySelector('#magazine-counts');
  const NS = 'http://www.w3.org/2000/svg';

  // Deck line, so the silhouette reads as a ship rather than a bar chart.
  const deck = document.createElementNS(NS, 'path');
  deck.setAttribute('d', 'M4 40 L8 26 L192 26 L198 33 L194 41 Z');
  deck.setAttribute('fill', 'none');
  deck.setAttribute('stroke', 'var(--phos-mid)');
  deck.setAttribute('stroke-width', '0.8');
  svg.appendChild(deck);

  const shapes = {};
  for (const zone of ZONE_ORDER) {
    const g = ZONE_GEOMETRY[zone];
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', g.x); rect.setAttribute('y', g.y);
    rect.setAttribute('width', g.w); rect.setAttribute('height', g.h);
    rect.setAttribute('class', 'zone-shape');
    rect.dataset.zone = zone;
    rect.addEventListener('click', () => bus.intent('order:damageControl', { zone }));
    const title = document.createElementNS(NS, 'title');
    title.textContent = `${DAMAGE_ZONES[zone].label} — click to assign damage control`;
    rect.appendChild(title);
    svg.appendChild(rect);

    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', g.x + 2);
    text.setAttribute('y', g.y + g.h - 2);
    text.setAttribute('class', 'zone-label');
    text.textContent = g.label;
    svg.appendChild(text);

    shapes[zone] = rect;
  }

  function render() {
    const o = state.ownship;

    for (const zone of ZONE_ORDER) {
      const frac = Math.max(0, o.integrity[zone]) / o.maxIntegrity[zone];
      const rect = shapes[zone];
      // Fill darkens toward red as the zone is worked over; destroyed is hollow red.
      if (frac <= 0) {
        rect.style.fill = 'rgba(255,74,61,0.13)';
        rect.style.stroke = 'var(--alert-red)';
      } else {
        const g = Math.round(0x27 + (0x7a - 0x27) * frac);
        rect.style.fill = frac > 0.99 ? 'var(--phos-dim)' : `rgba(255,${120 + Math.round(90 * frac)},46,${0.10 + 0.22 * (1 - frac)})`;
        rect.style.stroke = frac < 0.5 ? 'var(--amber)' : 'var(--phos-mid)';
      }
      rect.classList.toggle('dc-assigned', o.damageControlZone === zone);
    }

    lamps.innerHTML = Object.entries(SYSTEM_LABELS).map(([key, label]) =>
      `<span class="lamp ${o.systems[key] ? '' : 'is-down'}">${label}</span>`).join('');

    const shown = Object.values(WEAPONS).filter((w) => w.magazine && (o.magazinesInitial[w.magazine] ?? 0) > 0);
    mags.innerHTML = shown.map((w) => {
      const n = o.magazines[w.magazine] ?? 0;
      return `<span class="mag ${n === 0 ? 'is-empty' : ''}">${w.label} <b>${n}</b></span>`;
    }).join('') || '<span class="mag u-dim">no magazines</span>';
  }

  return { render, integrity: () => totalIntegrity(state.ownship) };
}
