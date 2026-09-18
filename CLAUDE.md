# AEGIS · Horizon Command — working notes

Read `README.md` first. It carries the design rationale; this file is the
short operational version for anyone editing the repo.

## Before you change anything

```sh
npm run ci          # validate + 70 tests + outcome regression
node tools/smoke.js # 31 checks against the real game in Chromium
```

Both must pass. `npm run ci` is fast; the smoke test takes about a minute.

Before a deploy, also run `npm run deploy:check`. It stages exactly what
`.vercelignore` leaves behind and boots all four missions on the **production**
code path — a non-localhost hostname, so `main.js`'s `DEV` flag is false,
`window.__aegis` is not exposed and mission loading logs-and-skips rather than
throwing. Nothing else in the suite exercises that branch.

Both browser checks need `npm install playwright` first; it is the only thing
in the repo with a dependency.

## The rules that are easy to break in the middle of a long edit

1. **`truth` never reaches the renderer.** `contact.truth` is readable in
   exactly three places: `sensors.js` (to decide what a rung reveals),
   `weapons.js` (to score what was destroyed), and `debrief.js` (after the
   mission ends). `readTruth()` throws anywhere else. Collapsing this makes the
   whole design pointless.
2. **The render loop never writes state.** `tools/smoke.js` asserts this across
   twenty animation frames. If it starts failing, something in `/src/ui/`
   started mutating.
3. **No `Math.random()` under `/src/sim/`.** There is a test. Determinism is
   what makes `tools/regression.js` able to pin mission outcomes.
4. **UI emits intents; it never calls sim functions.** Intents are drained at
   the top of the next tick, which is why a click while paused behaves
   identically to a click at 8× compression.
5. **No content in `/src/`.** No contact names, no dialogue, no mission logic.
   If it would differ between missions, it belongs in JSON.

## Adding a mission

Write `missions/NN-slug.json`, then:

```sh
npm run validate    # errors are contract violations; warnings are coupling rules
npm run missions    # regenerate the manifest
node tools/headless-sim.js missions/NN-slug.json --seconds 4000
```

`meta.id` must equal the filename stem. The last outcome must be
`{"always": true}`. Every choice node needs `timeoutSeconds` and
`defaultOption` together or neither.

Two schema points that are easy to get wrong:

- **`flag` objectives read two ways.** `value: false` is a standing condition
  ("no civilian casualties") that holds from tick zero and fails the moment it
  stops holding. `value: true` is an achievement ("deliver the strike") that is
  pending until it happens. Collapsing these fails the mission on tick one.
- **`auth.release.<contactId>`** is the flag convention for the "explicit
  authorisation from a dialogue node" that WEAPONS TIGHT allows. A node that
  says "batteries release" should set it; otherwise the ROE gate still refuses.

## Mission scale

Missions run **2400–3600 s of sim time**, carried down to roughly ten minutes
of wall clock by time compression. This is a deliberate departure from the
original design document, which specified 8–15 minutes of sim time — at 14
knots that is about 3 nm of ownship travel, which cannot contain a meaningful
geometry objective. Compression is therefore load-bearing rather than a
convenience, and the auto-drop to 1× on a decision is what creates the
"ninety seconds where four things demand a decision at once".

When placing contacts, do the arithmetic. A surface contact is detected at
25 nm; a submarine at 8 nm on passive. A 9-knot boat closing from 12 nm takes
most of an hour.

## Adding a scripted run

`tools/scripts/*.json` entries fire on a condition, not a wall-clock time:

```json
{ "when": { "contactDetected": { "id": "c_fiac_1" } },
  "intent": "order:iff", "payload": { "id": "c_fiac_1" } }
```

`when` takes the same trigger grammar the missions use. `whenNodeActive` is
sugar for answering a specific node. Entries fire once unless `repeat: true`.
After adding one, run `node tools/regression.js --update` and commit the
resulting `tools/expectations.json` so CI pins the new outcome.

A one-shot entry that fires a tick too early is silently lost — gate resolution
actions on `contactDetected`, not only on range.
