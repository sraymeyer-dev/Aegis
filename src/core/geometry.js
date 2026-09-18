/**
 * geometry.js — the only place that converts between headings and vectors.
 *
 * Convention, fixed everywhere: positions are {x, y} in nautical miles,
 * +y = north, +x = east. Course and bearing are degrees TRUE, 0 = north,
 * increasing clockwise, so 090 = east.
 *
 * Nothing here converts units. Speeds go in as knots and come out as knots;
 * the single kts -> nm/s conversion lives at the one call site in contact.js.
 */

export const DEG = Math.PI / 180;

/** Unit vector for a course in degrees true. */
export function courseVector(courseDeg) {
  const r = courseDeg * DEG;
  return { x: Math.sin(r), y: Math.cos(r) };
}

/** Bearing in degrees true from a to b, normalised to [0,360). */
export function bearing(a, b) {
  const deg = Math.atan2(b.x - a.x, b.y - a.y) / DEG;
  return (deg + 360) % 360;
}

/** Great-circle is overkill at strait scale; flat-earth in nm is the model. */
export function range(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function rangeSq(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

export function normaliseDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Shortest signed turn from a to b, in degrees, within [-180, 180]. */
export function deltaDeg(fromDeg, toDeg) {
  let d = normaliseDeg(toDeg - fromDeg);
  if (d > 180) d -= 360;
  return d;
}

/** Turn `from` toward `to` by at most maxRate degrees. */
export function turnToward(fromDeg, toDeg, maxDeg) {
  const d = deltaDeg(fromDeg, toDeg);
  if (Math.abs(d) <= maxDeg) return normaliseDeg(toDeg);
  return normaliseDeg(fromDeg + Math.sign(d) * maxDeg);
}

/** Closure rate in knots: positive means the two are closing. */
export function closureRate(a, b) {
  const r = range(a.pos, b.pos);
  if (r === 0) return 0;
  const av = courseVector(a.course);
  const bv = courseVector(b.course);
  const rel = {
    x: bv.x * b.speed - av.x * a.speed,
    y: bv.y * b.speed - av.y * a.speed,
  };
  const unit = { x: (b.pos.x - a.pos.x) / r, y: (b.pos.y - a.pos.y) / r };
  return -(rel.x * unit.x + rel.y * unit.y);
}

/** Position after travelling `nm` along `courseDeg` from `pos`. */
export function advance(pos, courseDeg, nm) {
  const v = courseVector(courseDeg);
  return { x: pos.x + v.x * nm, y: pos.y + v.y * nm };
}
