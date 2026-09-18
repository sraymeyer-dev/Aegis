/**
 * constants.js — weapon tables, sensor defaults, symbology, the resolution ladder.
 *
 * UNITS, everywhere, no exceptions:
 *   distance = nautical miles (nm)
 *   bearing/course = degrees true (0 = north = +y, 90 = east = +x)
 *   speed = knots (kts)
 *   altitude = feet (ft)
 *   time = seconds (s)
 *
 * No unit conversion is hidden inside a function. The only conversion in the
 * codebase is KTS_TO_NM_PER_SEC below, and it is applied at one call site.
 */

export const KTS_TO_NM_PER_SEC = 1 / 3600;

export const TICK_HZ = 10;
export const TICK_DT = 1 / TICK_HZ;

/** Time compression steps selectable by the player (keys 1-4). */
export const COMPRESSION_STEPS = [1, 2, 4, 8];

/** Compression auto-drops to 1x on any of these. Fairness contract. */
export const AUTO_DROP_REASONS = [
  'choice-node',
  'weapons-release',
  'contact-inside-10nm',
  'damage-event',
];

export const DOMAINS = ['surface', 'air', 'subsurface', 'missile'];
export const ALLEGIANCES = ['friendly', 'neutral', 'hostile'];
export const ROE_LEVELS = ['tight', 'free', 'selfDefense'];

export const ROE_LABEL = {
  tight: 'WEAPONS TIGHT',
  free: 'WEAPONS FREE',
  selfDefense: 'SELF-DEFENSE ONLY',
};

/* ------------------------------------------------------------------ *
 * Sensors
 * ------------------------------------------------------------------ */

export const SENSOR_DEFAULTS = {
  radarRange: 120,     // nm, air contacts
  surfaceRange: 25,    // nm, surface contacts (radar horizon)
  sonarRangePassive: 8,
  sonarRangeActive: 15,
  esmRange: 140,
  visualRange: 5,
};

/**
 * The resolution ladder. Each rung costs time, some carry risk, and each
 * supplies evidence at a given AUTHORITY. Deception defeats every rung below
 * authority 5 — which is the whole point: the ladder can converge confidently
 * on the wrong answer.
 */
export const LADDER = {
  passive:     { seconds: 0,   confidence: 25, authority: 1, cap: 25 },
  iff:         { seconds: 3,   confidence: 30, silentConfidence: 5, authority: 2 },
  hail:        { seconds: 15,  confidence: 25, authority: 2 },
  esm:         { seconds: 8,   confidence: 35, authority: 3 },
  illuminate:  { seconds: 2,   confidence: 40, authority: 3 },
  visual:      { seconds: 0,   confidence: 100, authority: 5 },
  investigate: { seconds: 120, confidence: 100, authority: 5 },
};

/** Passive track accrues +1 confidence per second, capped at 25. */
export const PASSIVE_GAIN_PER_SEC = 1;

export const CONFIDENCE_UNKNOWN = 40;   // below this: unknown
export const CONFIDENCE_CONFIRMED = 75; // at or above this: confirmed

/* ------------------------------------------------------------------ *
 * Weapons
 * ------------------------------------------------------------------ */

export const WEAPONS = {
  sm2: {
    id: 'sm2', label: 'SM-2', magazine: 'sm2',
    range: 90, speed: 900, domains: ['air', 'missile'],
    pk: { air: 0.85, missile: 0.6 }, cooldown: 3,
    vls: true, flightVisible: true,
  },
  harpoon: {
    id: 'harpoon', label: 'Harpoon', magazine: 'harpoon',
    range: 70, speed: 480, domains: ['surface'],
    pk: { surface: 0.7 }, cooldown: 4,
    vls: false, flightVisible: true,
  },
  tomahawk: {
    id: 'tomahawk', label: 'Tomahawk', magazine: 'tomahawk',
    range: 900, speed: 480, domains: ['land'],
    pk: { land: 1.0 }, cooldown: 6,
    vls: true, flightVisible: true, scripted: true,
  },
  gun: {
    id: 'gun', label: '5-inch gun', magazine: 'gun',
    range: 13, speed: null, domains: ['surface', 'land'],
    pk: { surface: 0.35, land: 0.35 }, cooldown: 8,
    rounds: 10, instant: true, flightVisible: false,
  },
  asroc: {
    id: 'asroc', label: 'ASROC', magazine: 'asroc',
    range: 12, speed: 45, domains: ['subsurface'],
    pk: { subsurface: 0.6 }, cooldown: 5,
    vls: true, flightVisible: true,
  },
  ciws: {
    id: 'ciws', label: 'CIWS', magazine: null,
    range: 1.5, speed: null, domains: ['missile'],
    pk: { missile: 0.5 },
    automatic: true, instant: true, flightVisible: false,
  },
};

/** Player-launched weapons may be self-destructed this long after launch. */
export const ABORT_WINDOW_SECONDS = 20;

export const MAGAZINE_DEFAULTS = { sm2: 40, harpoon: 8, tomahawk: 0, asroc: 6, gun: 400 };

/* ------------------------------------------------------------------ *
 * Ship integrity
 * ------------------------------------------------------------------ */

export const DAMAGE_ZONES = {
  bridge:      { id: 'bridge',      label: 'BRIDGE / SUPERSTRUCTURE', hp: 100, disables: 'command' },
  vlsForward:  { id: 'vlsForward',  label: 'FORWARD VLS',             hp: 120, disables: 'magForward' },
  vlsAft:      { id: 'vlsAft',      label: 'AFT VLS',                 hp: 120, disables: 'magAft' },
  spy:         { id: 'spy',         label: 'SPY-1 ARRAY FACE',        hp: 80,  disables: 'radar' },
  engineering: { id: 'engineering', label: 'ENGINEERING',             hp: 150, disables: 'propulsion' },
  hull:        { id: 'hull',        label: 'HULL / WATERLINE',        hp: 200, disables: 'buoyancy' },
};

export const ZONE_ORDER = ['bridge', 'vlsForward', 'vlsAft', 'spy', 'engineering', 'hull'];

export const DAMAGE_CONTROL_HP_PER_SEC = 2;
export const CRIPPLED_THRESHOLD = 0.4;   // below 40% total integrity
export const CRIPPLED_MAX_SPEED = 12;    // kts, when engineering is out

/* ------------------------------------------------------------------ *
 * Symbology — simplified NTDS
 * ------------------------------------------------------------------ */

export const SYMBOL = {
  friendly:  { shape: 'semicircle-down', fill: 'solid' },
  unknown:   { shape: 'diamond',         fill: 'hollow-pulse' },
  hostile:   { shape: 'diamond',         fill: 'solid-amber' },
  neutral:   { shape: 'square',          fill: 'hollow' },
  subsurface:{ shape: 'semicircle-up',   fill: 'solid-dashed' },
  air:       { shape: 'chevron',         fill: 'inherit' },
  missile:   { shape: 'track',           fill: 'solid-amber' },
};

export const RANGE_RINGS = [10, 20, 40, 80];

export const SWEEP_PERIOD_SECONDS = 4;
export const BLOOM_DECAY_SECONDS = 0.8;

export const DEFAULT_HP = { surface: 120, air: 40, subsurface: 90, missile: 1 };

/** Behaviours are deliberately dumb. A contact running real tactical AI would
 *  make missions unauthorable, because the author could not predict the scenario. */
export const BEHAVIOR_KINDS = ['static', 'patrol', 'intercept', 'evade', 'attack'];

export const OBJECTIVE_TYPES = ['destroy', 'protect', 'reach', 'hold', 'identify', 'survive', 'flag'];

export const RATINGS = ['S', 'A', 'B', 'C', 'D', 'F', 'INQUIRY'];
