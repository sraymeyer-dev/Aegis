/**
 * help-text.js — what every control does, in the player's language.
 *
 * This is UI chrome copy, not mission content: it is identical in every
 * mission and describes the engine's own verbs, so it does not fall under the
 * "no content in /src/" rule. Mission-specific text still lives in JSON.
 *
 * Each entry is:
 *   title   the control's name
 *   body    what it does, and what it is FOR
 *   cost    time it takes, or what it spends
 *   risk    what it may provoke -- omitted when it provokes nothing
 *   key     keyboard shortcut
 *
 * Kept in one file so the tooltip and the disabled-state reason never drift
 * apart from each other.
 */

export const LADDER_HELP = {
  iff: {
    title: 'IFF INTERROGATION',
    body: 'Challenge the contact’s transponder. A military set replies with an allegiance; '
        + 'a civilian set replies that it is civilian; a contact with no set, or one choosing not '
        + 'to answer, says nothing at all.\n\n'
        + 'Silence is information, but it is weaker information than most people assume — '
        + 'plenty of harmless traffic carries no transponder.',
    cost: '3 seconds · +30 confidence if it answers, +5 if it does not',
    key: 'I',
    notApplicable: { subsurface: 'A submerged contact cannot be interrogated. There is no transponder under water.' },
  },
  esm: {
    title: 'ESM — EMITTER FINGERPRINT',
    body: 'Listen to what the contact is radiating and match it against the library. A radar set '
        + 'is a fingerprint: it tells you whose equipment this is.\n\n'
        + 'It cannot tell you who is operating that equipment, which matters more often than it sounds.',
    cost: '8 seconds · +35 confidence, but only if the contact is actually emitting',
    key: 'E',
  },
  hail: {
    title: 'RADIO HAIL',
    body: 'Call the contact bridge-to-bridge on all channels and ask who they are.\n\n'
        + 'You learn what they choose to tell you. An honest contact answers honestly, a liar '
        + 'answers in the voice it has chosen, and a hostile usually says nothing.',
    cost: '15 seconds — the slowest rung short of committing an aircraft',
    key: 'H',
    subsurfaceTitle: 'GERTRUDE — UNDERWATER TELEPHONE',
  },
  illuminate: {
    title: 'ILLUMINATE — FIRE CONTROL RADAR',
    body: 'Lock the contact up with the targeting radar. It is the largest single jump in '
        + 'confidence available without closing the range.\n\n'
        + 'It is also unambiguous. Everyone on that contact knows they have been locked, and they '
        + 'know what it means.',
    cost: '2 seconds · +40 confidence',
    risk: 'A hostile may take it as the opening move and fire. A neutral may panic, run, or file '
        + 'a complaint that outlives your command.',
    key: 'L',
    subsurfaceTitle: 'ACTIVE SONAR — PROSECUTE',
    subsurfaceBody: 'Go active. Extends the underwater picture from 8 nm to 15 nm for ninety seconds.\n\n'
        + 'Every boat in the basin hears you do it, learns exactly where you are, and learns that '
        + 'you are looking for something.',
  },
  investigate: {
    title: 'HELO / VBSS — CLOSE INVESTIGATION',
    body: 'Put the aircraft over the contact and look at it with human eyes.\n\n'
        + 'This is the only order that defeats deception outright. A false transponder, a civilian '
        + 'profile on a warship, a stolen emitter — none of it survives somebody reading a hull '
        + 'number off the side.',
    cost: '120 seconds, and the aircraft is committed for all of it',
    risk: 'You have one helicopter. Wherever you send it is somewhere it is not.',
    key: 'V',
    subsurfaceTitle: 'HELO PROSECUTION — DIPPING SONAR',
  },
};

export const WEAPON_HELP = {
  declare: {
    title: 'DECLARE HOSTILE',
    body: 'Enter this track in the log as hostile. The symbol turns to a solid amber diamond for '
        + 'everyone watching the scope.\n\n'
        + 'A hostile diamond is one somebody declared. Nothing on this ship spawns hostile, and the '
        + 'recorder keeps the confidence you were at when you said so.',
    cost: 'Under WEAPONS FREE this is what makes a contact engageable.',
    risk: 'Declaring below 75% is recorded separately in the debrief. It is the number a board '
        + 'would ask about first.',
    key: 'D',
    reasonUnknown: 'Contact is still unknown. There is nothing to declare yet — work the ladder first.',
  },
  engage: {
    title: 'WEAPONS RELEASE',
    body: 'Release on the selected contact with the best weapon that reaches it from here.\n\n'
        + 'Missiles can be aborted for twenty seconds after launch. Gun and CIWS cannot be recalled '
        + 'at all.',
    risk: 'Irreversible in every way that matters. The debrief records the confidence you fired at.',
    key: 'F',
  },
  abort: {
    title: 'ABORT WEAPON',
    body: 'Self-destruct a missile still in flight.\n\n'
        + 'The window is twenty seconds from launch. After that it is going to arrive whatever '
        + 'anyone in this room now believes.',
  },
};

export const NAV_HELP = {
  plot: {
    title: 'PLOT COURSE',
    body: 'Arms the scope for course plotting. Click anywhere on the scope to drop a waypoint; '
        + 'shift-click to append another and build a track.\n\n'
        + 'The dashed line ahead of ownship shows where you will be in five and ten minutes. That '
        + 'projection is the only honest way to judge whether you can be somewhere in time.',
    cost: 'Free. Ownship turns at about 3° per second and changes speed slowly.',
    key: 'C',
  },
  clear: {
    title: 'CLEAR TRACK',
    body: 'Discard all plotted waypoints. Ownship holds its present heading.',
    reasonEmpty: 'No waypoints plotted — there is nothing to clear.',
  },
  speed: {
    title: 'ORDER SPEED',
    body: 'Order a speed in knots. A cruiser accelerates at roughly half a knot per second, so this '
        + 'is a request rather than a switch.\n\n'
        + 'Speed is how you buy geometry: closing a gap, holding a screening station, or staying '
        + 'inside a box you were told to stay inside.',
    risk: 'Losing engineering caps you at 12 knots for the rest of the mission.',
  },
};

export const CLOCK_HELP = {
  compression: {
    title: 'TIME COMPRESSION',
    body: 'Run the simulation faster than real time. Missions cover forty minutes to an hour of '
        + 'sim time, and compression is how you get through the quiet stretches.\n\n'
        + 'It drops back to 1× on its own for a decision, a weapons release, a contact crossing '
        + 'inside 10 nm, or damage. You are never fast-forwarded past something that matters.',
    risk: 'The quiet stretches are also when a contact you stopped watching becomes the one that '
        + 'matters. Compression is a gamble you are choosing to take.',
    key: '1 – 4',
  },
  pause: {
    title: 'PAUSE',
    body: 'Freeze the clock.\n\n'
        + 'Pause does not block orders. You can select contacts, work the ladder and plot a course '
        + 'while paused, and everything you queue is applied on the next tick. This is deliberate: '
        + 'a pausable picture is how the decision-making is actually taught, and blocking input '
        + 'while paused would only punish people who read slowly.',
    key: 'Space',
  },
};

export const SCOPE_HELP = {
  zoom: {
    title: 'RANGE SCALE',
    body: 'Set the outer range ring, in nautical miles.\n\n'
        + 'Zoom is a property of the display and nothing else. What the ship can detect does not '
        + 'change with what you are looking at.',
    cost: 'Scroll wheel over the scope does the same thing.',
  },
  orientation: {
    title: 'NORTH-UP / HEAD-UP',
    body: 'North-up keeps north at the top of the scope. Head-up rotates the picture so ownship’s '
        + 'heading is always up.\n\n'
        + 'North-up is the default because bearings then match what the crew and the briefing say.',
  },
  motion: {
    title: 'MOTION EFFECTS',
    body: 'Phosphor bloom as the sweep passes, the pulsing of unresolved contacts, and the screen '
        + 'jitter on a hit.\n\n'
        + 'Turning this off removes all of it and halves the scanlines. Nothing about the '
        + 'simulation changes — the sweep was always cosmetic.',
  },
  sound: {
    title: 'SOUND',
    body: 'Scope hum, contact and classification cues, launch and damage, a chime per speaker, and '
        + 'the choice timer tick that accelerates in the last five seconds.\n\n'
        + 'The timer tick is the one worth keeping. It is the difference between seeing a countdown '
        + 'and feeling one.',
  },
  tips: {
    title: 'TOOLTIPS',
    body: 'These panels. Turning them off leaves the interface clean.\n\n'
        + 'The reason a control is unavailable is kept either way — that is information you need, '
        + 'not decoration.',
  },
};

export const PROFILE_HELP = {
  zone: {
    title: 'DAMAGE CONTROL',
    body: 'Send the damage-control party to this zone. They repair 2 HP per second and they can only '
        + 'be in one place at a time.\n\n'
        + 'They restore plating. They do not restore a destroyed system: a SPY-1 face that is gone '
        + 'is gone for the rest of the mission.',
    reasonDestroyed: 'This zone is destroyed. Parties cannot bring the system back.',
    reasonFull: 'This zone is undamaged.',
  },
};

/** What each zone costs you when it is lost. */
export const ZONE_CONSEQUENCE = {
  bridge: 'Bridge lost: degraded orders and crew casualties.',
  vlsForward: 'Forward VLS lost: forward magazine cells unavailable.',
  vlsAft: 'Aft VLS lost: aft magazine cells unavailable.',
  spy: 'SPY-1 face lost: radar range halved and one bearing quadrant blind.',
  engineering: 'Engineering lost: maximum speed drops to 12 knots.',
  hull: 'Hull breached: flooding. At zero the ship is lost.',
};
