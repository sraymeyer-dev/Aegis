/**
 * debrief.js — the end screen. Three stacked panels.
 *
 *   1. the outcome card    the authored narrative payoff
 *   2. the metrics table   with the two teaching metrics emphasised
 *   3. the track log       the Aegis data recorder
 *
 * The track log is the most important of the three and the one most likely to
 * be cut for schedule. It should not be. It is the mechanism that converts an
 * outcome into a lesson, and it is cheap: the data is already recorded for the
 * metrics.
 *
 * This is one of the three sanctioned places that may read contact.truth --
 * and only here, after the mission has ended.
 */

import { renderMarkdown } from './markdown.js';
import { ZONE_ORDER, DAMAGE_ZONES, WEAPONS } from '../data/constants.js';

export function renderDebrief(root, state, { onReplay, onSelect }) {
  const e = state.ended ?? { rating: 'F', title: 'Mission Ended', debrief: '' };
  const m = state.metrics;

  root.innerHTML = `
    <div class="sheet"><div class="sheet-inner">
      <div class="title-block">
        <h1>DEBRIEF</h1>
        <div class="sub">${escapeHtml(state.mission.meta.title)} &middot; ${escapeHtml(state.mission.meta.subtitle ?? '')}</div>
      </div>

      <div class="rating-card">
        <div class="rating-letter rating-${e.rating}">${e.rating === 'INQUIRY' ? 'INQUIRY' : e.rating}</div>
        <div><h2>${escapeHtml(e.title)}</h2>
          <div class="prose">${renderMarkdown(e.debrief)}</div></div>
      </div>

      <div class="panel">
        <h3>Performance</h3>
        <div class="panel-body"><table class="metrics">${metricsRows(state, m)}</table></div>
      </div>

      <div class="panel">
        <h3>Track log — Aegis data recorder</h3>
        <div class="panel-body">
          <p class="u-dim" style="font-size:var(--fs-xs);margin:0 0 9px">
            What every contact actually was, what this ship believed it to be at each stage,
            and what was done to it.</p>
          ${trackLogTable(state)}
        </div>
      </div>

      <div class="actions">
        <button class="primary" id="btn-replay">Run it again</button>
        <button id="btn-select">Mission select</button>
      </div>
    </div></div>
  `;

  root.querySelector('#btn-replay').addEventListener('click', onReplay);
  root.querySelector('#btn-select').addEventListener('click', onSelect);
}

function metricsRows(state, m) {
  const meanClassify = m.classifyCount > 0 ? `${Math.round(m.classifyTimeSum / m.classifyCount)} s` : '—';
  const rounds = Object.entries(m.roundsExpended)
    .map(([k, v]) => `${WEAPONS[k]?.label ?? k} ${v}`).join(', ') || 'none';
  const damage = ZONE_ORDER.filter((z) => m.damageByZone[z])
    .map((z) => `${DAMAGE_ZONES[z].label.split(' ')[0]} ${Math.round(m.damageByZone[z])}`).join(', ') || 'none';
  const objs = `${m.objectivesCompleted} complete / ${m.objectivesFailed} failed`;

  const row = (label, value, cls = '') => `<tr class="${cls}"><td>${label}</td><td>${value}</td></tr>`;

  return [
    // The two metrics that teach the game, surfaced first and emphasised even
    // in missions where they do not affect the rating.
    row('Contacts engaged below 75% confidence', m.engagedBelowConfirmed,
      `is-teaching${m.engagedBelowConfirmed > 0 ? ' is-bad' : ''}`),
    row('Mean time to classify', meanClassify, 'is-teaching'),

    row('Neutrals destroyed', m.neutralsDestroyed, m.neutralsDestroyed > 0 ? 'is-bad' : ''),
    row('Friendlies destroyed', m.friendliesDestroyed, m.friendliesDestroyed > 0 ? 'is-bad' : ''),
    row('Hostiles destroyed', m.hostilesDestroyed),
    row('Hostiles that escaped', m.hostilesEscaped),
    row('Rounds expended', rounds),
    row('Shots fired / hit', `${m.shotsFired} / ${m.shotsHit}`),
    row('Weapons aborted in flight', m.shotsAborted ?? 0),
    row('Damage taken', damage),
    row('Resolution actions taken', m.resolutionActions),
    row('Hostile declarations (below 75%)', `${m.declarations ?? 0} (${m.declarationsBelowConfirmed ?? 0})`,
      (m.declarationsBelowConfirmed ?? 0) > 0 ? 'is-bad' : ''),
    row('Choice nodes answered / timed out', `${m.choiceNodesAnswered} / ${m.choiceNodesTimedOut}`),
    row('Crew traffic dropped (watch saturated)', m.nodesDropped ?? 0),
    row('Peak dialogue queue depth', m.queueDepthPeak ?? 0),
    row('Objectives', objs),
  ].join('');
}

function trackLogTable(state) {
  const rows = state.trackLog.map((entry) => {
    if (entry.event === 'decision') {
      return `<tr class="is-decision">
        <td>${fmtTime(entry.t)}</td><td colspan="4">${escapeHtml(entry.detail)}</td></tr>`;
    }
    const c = state.contacts.get(entry.contactId);
    // truth is read here and only here in the UI, after the mission has ended.
    const actual = entry.actualType
      ? `${entry.actualAllegiance} · ${entry.actualType}`
      : '—';
    const believed = entry.believedClass === 'unknown'
      ? 'unknown'
      : `${entry.believedClass.replace('-', ' ')} · ${entry.believedType}`;
    const mismatch = entry.actualAllegiance
      && entry.believedClass !== 'unknown'
      && !entry.believedClass.includes(entry.actualAllegiance);
    return `<tr class="${mismatch ? 'mismatch' : ''}">
      <td>${fmtTime(entry.t)}</td>
      <td>${escapeHtml(entry.trackNumber ? `T${entry.trackNumber}` : '—')}</td>
      <td>${escapeHtml(entry.event)} — ${escapeHtml(entry.detail)}</td>
      <td class="believed">${escapeHtml(believed)} ${entry.confidence != null ? `(${entry.confidence}%)` : ''}</td>
      <td class="actual">${escapeHtml(actual)}</td>
    </tr>`;
  }).join('');

  return `<table class="tracklog">
    <thead><tr><th>Time</th><th>Track</th><th>Event</th><th>Believed</th><th>Actually was</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="u-dim">no entries</td></tr>'}</tbody>
  </table>`;
}

function fmtTime(t) {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
