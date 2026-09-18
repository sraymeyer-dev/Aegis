/**
 * portraits.js — six inline SVG portraits.
 *
 * The entire art budget is these plus one ship silhouette. A monochrome vector
 * aesthetic is the one direction a small team executes to a high standard
 * without an artist, because it is defined by rules rather than by assets.
 * Inline rather than files so the game runs from file:// with no fetches.
 */

const wrap = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"
        stroke-linecap="square" aria-hidden="true">${body}</svg>`;

export const PORTRAITS = {
  // TAO: headset, leaning in. Carries tactical recommendation.
  tao: wrap(`<path d="M7 20v-3a5 5 0 0 1 10 0v3"/><circle cx="12" cy="8" r="3.2"/>
             <path d="M6 9V7.5A6 6 0 0 1 18 7.5V9"/><path d="M6 9v2.5M18 9v2.5"/>
             <path d="M18 11.5h-2v2"/>`),
  // CIC watch: face lit from below by a console.
  cic: wrap(`<path d="M7 20v-3a5 5 0 0 1 10 0v3"/><circle cx="12" cy="8" r="3.2"/>
             <path d="M4 20h16"/><path d="M9 16.5h6"/>`),
  // XO: cover and collar device. Procedure and doubt.
  xo: wrap(`<path d="M7 20v-3a5 5 0 0 1 10 0v3"/><circle cx="12" cy="8.5" r="3"/>
            <path d="M6.5 5.5h11l-1 1.6h-9z"/><path d="M8 5.5 12 3l4 2.5"/>
            <path d="M9 18.5h1.5M13.5 18.5H15"/>`),
  // ESM watch: headphones over a waterfall display.
  esm: wrap(`<path d="M7 20v-3a5 5 0 0 1 10 0v3"/><circle cx="12" cy="8.5" r="3"/>
             <path d="M5.5 10V8a6.5 6.5 0 0 1 13 0v2"/>
             <rect x="4" y="10" width="2.5" height="4"/><rect x="17.5" y="10" width="2.5" height="4"/>`),
  // Fleet command: a device, not a person. Orders and consequence.
  fleet: wrap(`<rect x="3.5" y="5" width="17" height="12"/><path d="M8 20h8M12 17v3"/>
               <path d="M6.5 8.5h11M6.5 11h7M6.5 13.5h9"/>`),
  // External: the other side of the ambiguity. A hull on an unknown bearing.
  external: wrap(`<path d="M2.5 15.5h19l-2 4h-15z"/><path d="M6 15.5V11h9l2 4.5"/>
                  <path d="M9 11V8h3v3"/><path d="M12 3v5"/>`),
};

export const PORTRAIT_KEYS = Object.keys(PORTRAITS);
