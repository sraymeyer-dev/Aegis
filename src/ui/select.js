/**
 * select.js — mission select and the briefing screen.
 *
 * Reads the manifest. The engine ships zero hardcoded content: the campaign in
 * the repo is just the files that happen to be in /missions.
 */

import { renderMarkdown } from './markdown.js';

export function renderSelect(root, entries, { onPick, error }) {
  if (error) {
    root.innerHTML = `<div class="sheet"><div class="sheet-inner">
      <div class="title-block"><h1>AEGIS</h1><div class="sub">Horizon Command</div></div>
      <div id="error-panel">${escapeHtml(error)}</div>
    </div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="sheet"><div class="sheet-inner">
      <div class="title-block">
        <h1>AEGIS &middot; HORIZON COMMAND</h1>
        <div class="sub">You never see the ocean. You see symbols, and you decide what they are.</div>
      </div>
      <div class="u-label" style="margin-bottom:10px">Select mission</div>
      <div class="mission-list">
        ${entries.map((e, i) => `
          <button class="mission-card" data-file="${escapeHtml(e.file)}">
            <span class="idx">${String(i + 1).padStart(2, '0')}</span>
            <span><span class="name">${escapeHtml(e.title)}</span><br>
              <span class="sub">${escapeHtml(e.subtitle ?? '')}</span></span>
            <span class="diff" title="Difficulty ${e.difficulty} of 5">${'▰'.repeat(e.difficulty)}${'▱'.repeat(5 - e.difficulty)}</span>
          </button>`).join('')}
      </div>
      ${entries.length === 0 ? '<p class="u-dim">No missions found. Add a JSON file to /missions and run <code>npm run missions</code>.</p>' : ''}
    </div></div>
  `;

  for (const card of root.querySelectorAll('.mission-card')) {
    card.addEventListener('click', () => onPick(card.dataset.file));
  }
}

export function renderBriefing(root, mission, { onStart, onBack }) {
  const { meta } = mission;
  root.innerHTML = `
    <div class="sheet"><div class="sheet-inner">
      <div class="title-block">
        <h1>${escapeHtml(meta.title)}</h1>
        <div class="sub">${escapeHtml(meta.subtitle ?? '')}</div>
      </div>
      <div class="prose">${renderMarkdown(meta.briefing)}</div>
      <div class="panel" style="margin-top:26px">
        <h3>Standing orders</h3>
        <div class="panel-body prose" style="font-size:var(--fs-sm)">
          <p><strong>Identify before you commit.</strong> Every contact is on the scope from the
          moment it enters sensor range. What costs you is finding out what it is: interrogate,
          fingerprint, hail, illuminate, close to visual. A contact is never revealed by
          proximity — it is resolved by procedure.</p>
          <p><strong>Not everything that answers is telling the truth.</strong> A squawk, a
          profile and an emitter can all be wrong together, and confidence will climb anyway.
          Only your own eyes settle it.</p>
          <p><strong>Doing nothing is an order.</strong> Timed decisions resolve themselves if
          you let them, and the option they resolve to is usually the passive one.</p>
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="btn-start">Take the watch</button>
        <button id="btn-back">Back</button>
      </div>
    </div></div>
  `;
  root.querySelector('#btn-start').addEventListener('click', onStart);
  root.querySelector('#btn-back').addEventListener('click', onBack);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
