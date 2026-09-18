/**
 * markdown.js — a deliberately tiny renderer for the authored markdown in
 * meta.briefing and outcome.debrief.
 *
 * Supports headings, paragraphs, bold, italic, inline code and lists. That is
 * the entire surface the schema promises; a full markdown library would be
 * more code than the sim's sensor model for no gain.
 *
 * Escapes first, then marks up, so authored content can never inject HTML.
 */

export function renderMarkdown(src) {
  const escaped = String(src ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const blocks = escaped.split(/\n{2,}/);
  const out = [];

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    const heading = block.match(/^(#{1,3})\s+(.*)$/s);
    if (heading) {
      const level = Math.min(3, heading[1].length) + 1;   // h1 in source -> h2 on screen
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/m.test(block) && block.split('\n').every((l) => /^[-*]\s+/.test(l.trim()))) {
      const items = block.split('\n').map((l) => `<li>${inline(l.trim().replace(/^[-*]\s+/, ''))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    out.push(`<p>${inline(block).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}

function inline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
