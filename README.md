# AEGIS · Horizon Command

You are the commanding officer of a Ticonderoga-class guided missile cruiser,
fighting a war you experience entirely through a phosphor-green radar repeater,
a damage-control silhouette, and the voices of your crew.

You never see the ocean. You see symbols, and you decide what they are.

**Your opponent is ambiguity, not the enemy.** The sensor data is complete and
uninterpreted. The crew supplies interpretation, and the crew is fallible,
biased, and occasionally certain about the wrong thing. Every contact carries
a `truth` that is never rendered and a `displayedClass` that is derived from
what you have actually done to resolve it. The gap between those two fields is
where the game lives.

The verb is not *aim*. It is *adjudicate*.

## Running it

No build step, no bundler, no dependencies.

```sh
npm run serve       # then open the printed URL
```

A static server is needed only because browsers refuse module and fetch
requests from `file://`. Any static host will do; there is nothing to compile
and the game makes no network requests of its own.

```sh
npm test            # 70 unit tests: sim, narrative, validator
npm run validate    # validate every mission against the schema
npm run missions    # regenerate missions/manifest.json after adding a file
npm run ci          # validate + test + outcome regression
node tools/smoke.js   # drive the real game in Chromium, 31 checks
npm run deploy:check  # stage what the host will serve, then play it
```

## Deploying

It is a static site with no build step, so any static host works. `vercel.json`
configures Vercel for zero build, serving the repo root, with
`Cache-Control: max-age=0, must-revalidate` on everything — there is no
bundler, so no filename is content-hashed, and any longer cache would serve a
stale `src/*.js` against a fresh `index.html` after a redeploy.

`.vercelignore` keeps `tools/`, `tests/` and `CLAUDE.md` out of the
deployment; nothing at runtime references them.

```sh
npm run deploy:check   # stage per .vercelignore, then boot all four missions
                       # on the production code path (non-localhost hostname,
                       # so main.js's DEV flag is false and no debug handle
                       # is exposed)
```

## How it plays

Four beats, run continuously on several contacts at once:

| Beat | Cost |
| --- | --- |
| **Assess** — hover a track, read bearing, range, course, speed, closure | free and instant |
| **Resolve** — IFF, ESM, hail, illuminate, close to visual, send the helo | time, and sometimes provocation |
| **Commit** — engage, declare, shadow, ignore | irreversible |
| **Consequence** — the crew reacts, flags set, the picture changes | — |

Three resources are in tension at all times:

- **Time.** Inbounds close. Scripted timers fire whether you are ready or not.
- **Attention.** One dialogue node is actionable at a time and the queue backs
  up. A choice node that times out picks its default — usually the passive
  option, which is sometimes exactly wrong.
- **Magazines.** They do not regenerate.

### The resolution ladder

A contact is never revealed by proximity. It is *resolved* by procedure.

| Action | Time | Confidence | Authority | Risk |
| --- | --- | --- | --- | --- |
| Passive track | automatic | +1/s to 25 | 1 | none |
| IFF interrogation | 3 s | +30 squawking, +5 silent | 2 | none |
| Radio hail | 15 s | +25 | 2 | none |
| ESM fingerprint | 8 s | +35 if emitting | 3 | none |
| Illuminate (fire control) | 2 s | +40 | — | hostiles may fire, neutrals may flee |
| Visual (inside 5 nm) | — | to 100 | 5 | short-range weapons |
| Helo / VBSS | 120 s | to 100 | 5 | the aircraft is committed elsewhere |

**Authority is what matters.** A contact can carry a `deception` block — a
false IFF squawk, a civilian profile on a hostile hull, a friendly emitter on
a captured vessel — and every rung below authority 5 will believe it. The
ladder does not get less certain as you climb it. It gets *more* certain, and
more wrong. Only your own eyes, or a helicopter, settle it.

Mission 04 is built entirely around this: work the full ladder on `PGM
SEVENTEEN` and the console reads **100% confirmed friendly**. She is hostile.

### Rules of engagement

ROE is a hard gate on the order rail, not advice.

- **WEAPONS TIGHT** — requires a confirmed hostile (75%+) or explicit
  authorisation from a dialogue node.
- **WEAPONS FREE** — any *declared* hostile may be engaged. A hostile symbol is
  one you or your crew declared, never one that spawned that way.
- **SELF-DEFENCE ONLY** — only against a contact that has committed a hostile act.

Every refusal states its reason. An option greyed out for a reason the player
cannot see reads as a bug, not as a rule.

### Controls

Mouse first. Click a track to select, scroll to zoom, `C` then click to plot a
course (shift-click appends).

| Key | |
| --- | --- |
| `I` `E` `H` `L` `V` | IFF · ESM · Hail · Illuminate · Helo |
| `D` `F` | Declare hostile · Engage |
| `1`–`4` | time compression (also picks dialogue options when one is open) |
| `Space` | pause — which does **not** block orders |
| `Tab` / `Esc` | cycle contacts / deselect |

Every control explains itself on hover: what it does, what it costs in time,
what it risks, and — when it is unavailable — exactly why, with the live
numbers. **TIPS** in the scope controls turns those panels off; the setting
persists. The refusal reason survives with them off, as a native tooltip and
on the control's accessible name, because that part is information rather than
decoration.

## Writing a mission

A mission is one JSON file. Drop it in `/missions/`, run `npm run missions`,
and it appears. **The engine ships zero hardcoded content** — the campaign in
this repo is just the four files that happen to be there.

```
{ "schemaVersion": 1, "meta": {...}, "ownship": {...}, "contacts": [...],
  "speakers": {...}, "nodes": [...], "objectives": [...], "outcomes": [...] }
```

Dialogue is **not a branching tree**. It is a flag store plus a
trigger-evaluated node pool — a rules engine over game state. Fourteen
predicates, three combinators, all JSON:

```json
"trigger": { "all": [
  { "timeAfter": 180 },
  { "flag": "hailed_tanker", "is": true },
  { "contactWithin": { "id": "c_tanker", "nm": 20 } } ] }
```

`validate-mission.js` runs on load in dev and in CI. It errors on broken
references, unpaired timers, fall-through outcome lists, authored runtime
fields, and truth leaking into prose. It *warns* — never errors — on the three
coupling rules, because an author should be able to break them deliberately
and never by accident:

1. a choice node with no `focus` list
2. a choice node where no option has a `requires` clause
3. a contact that can change the outcome but is never spoken about

### The two rules that make it a game

**Every choice node must be answerable only with information that is on the
scope.** A node answerable from its own text trains the player to stop looking
at the radar, and once they stop they do not start again. Strip a node down to
"Orders, Captain?" — if the choice becomes arbitrary, the prose was carrying
the answer and the node needs a `requires` clause or a working `focus` list.

**Every contact that matters must be spoken about.** A threat that appears and
is never mentioned will be missed, and the player will correctly read that as
the game being unfair rather than themselves being inattentive.

## The campaign

| | Mission | Shape |
| --- | --- | --- |
| 01 | **Strait Transit** | Escort. A small craft with a civilian profile, and an airliner on a published departure. |
| 02 | **Shadow Play** | ASW. Two submerged contacts, indistinguishable on passive, and one helicopter. You cannot eyeball a submarine. |
| 03 | **Red Sea Gauntlet** | Air defence. Weapons free from the first minute, eight missiles, and more inbound than that. |
| 04 | **Black Lantern** | Strike. A launch basket you have to hold, and a captured patrol boat squawking a coalition code. |

## Architecture

Vanilla ES modules. Canvas 2D for the scope, SVG for the ship silhouette, DOM
for everything else. No framework: the state model is one object mutated by a
tick function, and a reconciliation layer between the sim and the screen would
buy nothing and fight the 10 Hz tick.

```
src/core/    state.js loop.js bus.js rng.js geometry.js
src/sim/     contact.js sensors.js weapons.js damage.js objectives.js
src/narrative/ triggers.js dialogue.js effects.js
src/ui/      scope.js profile.js orders.js dialogue-ui.js hud.js debrief.js select.js
src/data/    mission-loader.js validate-mission.js constants.js
tools/       build-manifest.js headless-sim.js regression.js smoke.js serve.js
```

The tick order is fixed and never varies: drain intents, clock, contacts,
projectiles, sensors, dialogue triggers, dialogue timers, effects, objectives,
end conditions. The render loop runs on `requestAnimationFrame` and **only
reads state** — which is what makes the headless harness possible, and is
asserted by the browser smoke test across twenty animation frames.

All randomness goes through a seeded PRNG. Same mission plus same inputs gives
byte-identical output, which is what lets `tools/regression.js` pin every
mission's authored outcomes in CI.

### Rules for anyone — human or model — working in `/src`

1. `truth.allegiance` never reaches the renderer. Only `displayedClass`,
   `apparent` and `confidence` do. `readTruth()` throws outside the three
   sanctioned call sites.
2. The render loop reads state and never writes it.
3. No `Math.random()` in `/src/sim/`. Use `rng.js`. There is a test for this.
4. UI emits intents on the bus; it never calls sim functions directly.
   Selecting a contact emits `order:select` — it does not call into
   `dialogue.js`.
5. The parsed mission object is immutable after load. All mutation is on
   `GameState`.
6. Units are nm, degrees true, knots, feet, seconds. No conversions hidden
   inside functions.
7. No content in `/src/`. If it would differ between missions, it belongs in
   JSON.
8. Never put tactical data in a node's `text` that the scope already shows.
   Bearing, range, course and speed belong in the focus brackets and the track
   readout. A crew member states what they *think*, not what the instruments
   say.

## Deliberately not in v1

No 3D, no ocean surface, no free camera, no ship-handling physics beyond
heading and speed, no campaign persistence, no multiplayer, no procedural
generation. Every one of these is a real game. None of them is this one.
