import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateMission } from '../src/data/validate-mission.js';

const RAW = readFileSync('missions/01-strait-transit.json', 'utf8');
const load = () => JSON.parse(RAW);
const FILENAME = '01-strait-transit.json';

const check = (m) => validateMission(m, { filename: FILENAME });
const rules = (r) => r.errors.map((e) => e.rule);
const find = (r, rule) => r.errors.find((e) => e.rule === rule);

test('the reference mission validates clean', () => {
  const r = check(load());
  assert.equal(r.errors.length, 0, r.format());
  assert.equal(r.warnings.length, 0, r.format());
});

/**
 * M1 check: corrupting six different fields produces six distinct, specific
 * error messages. Each corruption must name its own rule, its own path, and
 * must not be reported as any of the others.
 */
test('six corrupted fields produce six distinct specific errors', () => {
  const corruptions = [
    {
      label: 'unknown speaker key on a node',
      rule: 'unknownSpeaker',
      apply: (m) => { m.nodes[0].speaker = 'bosun'; },
      pathIncludes: 'n_open',
      messageIncludes: 'bosun',
    },
    {
      label: 'trigger referencing a contact that does not exist',
      rule: 'unknownContact',
      apply: (m) => { m.nodes.find((n) => n.id === 'n_fiac_detect').trigger.contactDetected.id = 'c_ghost'; },
      pathIncludes: 'n_fiac_detect',
      messageIncludes: 'c_ghost',
    },
    {
      label: 'defaultOption naming an option the node does not have',
      rule: 'defaultOption',
      apply: (m) => { m.nodes.find((n) => n.id === 'n_fiac_choice').defaultOption = 'o_nope'; },
      pathIncludes: 'n_fiac_choice',
      messageIncludes: 'o_nope',
    },
    {
      label: 'choice node with a timeout but no default',
      rule: 'timerPair',
      apply: (m) => { delete m.nodes.find((n) => n.id === 'n_air_choice').defaultOption; },
      pathIncludes: 'n_air_choice',
      messageIncludes: 'both timeoutSeconds and defaultOption',
    },
    {
      label: 'outcome list that can fall through',
      rule: 'catchAll',
      apply: (m) => { m.outcomes[m.outcomes.length - 1].condition = { timeAfter: 10 }; },
      pathIncludes: 'outcomes[',
      messageIncludes: 'catch-all',
    },
    {
      label: 'two nodes sharing an id',
      rule: 'duplicateId',
      apply: (m) => { m.nodes[3].id = m.nodes[2].id; },
      pathIncludes: 'nodes[3]',
      messageIncludes: 'duplicate node id',
    },
  ];

  const seen = new Set();
  for (const c of corruptions) {
    const m = load();
    c.apply(m);
    const r = check(m);
    const hit = find(r, c.rule);
    assert.ok(hit, `${c.label}: expected an error with rule "${c.rule}", got ${JSON.stringify(rules(r))}`);
    assert.ok(hit.path.includes(c.pathIncludes),
      `${c.label}: error path "${hit.path}" should name ${c.pathIncludes}`);
    assert.ok(hit.message.includes(c.messageIncludes),
      `${c.label}: message "${hit.message}" should mention ${c.messageIncludes}`);
    const signature = `${hit.rule}|${hit.path}|${hit.message}`;
    assert.ok(!seen.has(signature), `${c.label}: produced a duplicate error message`);
    seen.add(signature);
  }
  assert.equal(seen.size, 6, 'expected six distinct error messages');
});

test('truth never reaches the player through node text', () => {
  const m = load();
  m.nodes.find((n) => n.id === 'n_fiac_detect').text = 'That is a FIAC, Captain.';
  const r = check(m);
  const hit = find(r, 'truthLeak');
  assert.ok(hit, 'naming a deceptive contact’s hidden truth type must be an error');
  assert.match(hit.message, /FIAC/);
});

test('{{truth:...}} interpolation is rejected', () => {
  const m = load();
  m.nodes[0].text = 'She is {{truth:c_fiac_1}}, Captain.';
  const r = check(m);
  assert.ok(find(r, 'truthLeak'));
});

test('runtime fields must not be authored', () => {
  const m = load();
  m.contacts[0].confidence = 100;
  m.contacts[0].displayedClass = 'friendly';
  const r = check(m);
  const hits = r.errors.filter((e) => e.rule === 'authoredRuntimeField');
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.path.endsWith('.confidence')));
  assert.ok(hits.some((h) => h.path.endsWith('.displayedClass')));
});

test('meta.id must match the filename stem', () => {
  const m = load();
  m.meta.id = 'something-else';
  const r = check(m);
  const hit = find(r, 'meta');
  assert.ok(hit);
  assert.match(hit.message, /filename stem/);
});

test('an unknown predicate is named, not silently ignored', () => {
  const m = load();
  m.nodes[0].trigger = { contactIsSpooky: 'c_argo' };
  const r = check(m);
  const hit = find(r, 'unknownPredicate');
  assert.ok(hit);
  assert.match(hit.message, /contactIsSpooky/);
});

test('a flag predicate without its "is" sibling is an error', () => {
  const m = load();
  m.nodes[0].trigger = { flag: 'some_key' };
  const r = check(m);
  assert.ok(r.errors.some((e) => /requires a sibling "is"/.test(e.message)));
});

test('"is" without "flag" is an error, not an unknown predicate', () => {
  const m = load();
  m.nodes[0].trigger = { is: true, timeAfter: 5 };
  const r = check(m);
  assert.ok(r.errors.some((e) => /modifier for the "flag" predicate/.test(e.message)));
});

test('content cannot write engine-owned sys. flags', () => {
  const m = load();
  m.nodes[0].effects = [{ setFlag: { key: 'sys.neutralKilled', value: false } }];
  const r = check(m);
  assert.ok(find(r, 'reservedFlag'));
});

/* --- the three coupling warnings ------------------------------------ */

test('coupling warning: choice node with no focus list', () => {
  const m = load();
  delete m.nodes.find((n) => n.id === 'n_fiac_choice').focus;
  const r = check(m);
  assert.ok(r.warnings.some((w) => w.rule === 'coupling.focus' && w.path.includes('n_fiac_choice')));
  assert.equal(r.errors.length, 0, 'coupling rules are warnings, not errors');
});

test('coupling warning: no option gated by requires', () => {
  const m = load();
  const node = m.nodes.find((n) => n.id === 'n_fiac_choice');
  for (const o of node.options) delete o.requires;
  const r = check(m);
  assert.ok(r.warnings.some((w) => w.rule === 'coupling.requires' && w.path.includes('n_fiac_choice')));
});

test('coupling warning: outcome-relevant contact never spoken about', () => {
  const m = load();
  // Strip every mention of the FIAC from the node pool, but keep it in outcomes.
  m.nodes = m.nodes.filter((n) => !JSON.stringify(n).includes('c_fiac_1'));
  m.outcomes[2].condition = { all: [{ contactDestroyed: { id: 'c_fiac_1' } }] };
  const r = check(m);
  assert.ok(r.warnings.some((w) => w.rule === 'coupling.spoken' && w.message.includes('c_fiac_1')));
});

test('geometry warning when no reach/hold/protect objective exists', () => {
  const m = load();
  m.objectives = m.objectives.map((o) => ({ ...o, optional: true }));
  const r = check(m);
  assert.ok(r.warnings.some((w) => w.rule === 'geometryObjective'));
});
