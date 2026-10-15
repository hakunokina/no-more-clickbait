import type { TimelineCard, TimelineDoc, VerificationResult } from "@nmc/core";

/**
 * TEMPORARY stand-in for packages/timeline-renderer (`renderTimeline`),
 * which is being built separately: a plain, script-free page listing the
 * selection so the reading window works end to end today. Replaced by
 * `renderTimeline(toTimelineDoc(...))` once the renderer lands.
 *
 * Feed content is untrusted: every value is HTML-escaped, only https
 * links are emitted, and the page's CSP allows no script at all.
 */

export const TIMELINE_CSP =
  "default-src 'none'; img-src https://pbs.twimg.com; media-src https://video.twimg.com; " +
  "style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function safeHttpsUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const BADGES: Record<VerificationResult["status"], string> = {
  verified: "✓ Doğrulandı",
  false_or_disputed: "⚠ Kaynaklarla çelişiyor",
  unverifiable: "? Doğrulanamadı",
};

function renderCard({ post, verification }: TimelineCard, index: number, total: number): string {
  const href = safeHttpsUrl(post.url);
  const lang = post.lang && /^[A-Za-z-]{2,12}$/.test(post.lang) ? post.lang : "und";
  const author = post.authorName
    ? `${escapeHtml(post.authorName)} <span class="muted">@${escapeHtml(post.authorHandle)}</span>`
    : `@${escapeHtml(post.authorHandle)}`;
  const media = post.media.length > 0 ? `<p class="muted">${post.media.length} medya</p>` : "";
  const quote = post.quoted
    ? `<blockquote>↳ @${escapeHtml(post.quoted.authorHandle)}: ${escapeHtml(post.quoted.text)}</blockquote>`
    : "";
  const badge = verification
    ? `<p class="badge badge--${verification.status}">${BADGES[verification.status]} — ${escapeHtml(verification.summary)}</p>`
    : "";
  return `<article tabindex="0" aria-posinset="${index + 1}" aria-setsize="${total}">
  <h2>${author}</h2>
  ${post.repostedBy ? `<p class="muted">@${escapeHtml(post.repostedBy)} yeniden paylaştı</p>` : ""}
  <p class="text" lang="${lang}">${escapeHtml(post.text)}</p>
  ${quote}${media}${badge}
  ${href ? `<p><a href="${escapeHtml(href)}">X'te aç</a></p>` : ""}
</article>`;
}

export function renderPlaceholderTimeline(doc: TimelineDoc): string {
  const total = doc.cards.length;
  const cards = doc.cards.map((card, index) => renderCard(card, index, total)).join("\n");
  const scanned = doc.funnel?.scanned ?? 0;
  const header =
    total === 0
      ? "<p>Bugün okumaya değer bir gönderi çıkmadı. Bu da bir sonuç.</p>"
      : `<p class="muted">${total} gönderi · ${scanned} gönderiden seçildi · okuma değerine göre sıralı</p>`;
  const capturedAt = doc.header.capturedAt ?? doc.header.generatedAt;
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="${TIMELINE_CSP}" />
<title>No More Clickbait — akış</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --text: #0f1419; --muted: #536471; --border: #d5dde2; --accent: #0b57d0; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e1116; --text: #e7e9ea; --muted: #9aa5b1; --border: #2f3640; --accent: #8ab4f8; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 16px; }
  @media (max-width: 480px) { main { padding: 12px; } }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  article { border-top: 1px solid var(--border); padding: 12px 0; overflow-wrap: anywhere; }
  article h2 { font-size: 15px; margin: 0 0 4px; }
  .text { white-space: pre-wrap; margin: 0 0 8px; }
  .muted { color: var(--muted); font-size: 14px; font-weight: normal; margin: 0 0 4px; }
  blockquote { margin: 0 0 8px; padding-left: 12px; border-left: 3px solid var(--border); }
  .badge { font-size: 14px; margin: 0 0 8px; }
  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  footer { border-top: 1px solid var(--border); padding: 16px 0; }
</style>
</head>
<body>
<main>
<h1>Akış — ${escapeHtml(capturedAt.slice(0, 10))}</h1>
${header}
<div role="feed" aria-label="Akış, ${total} gönderi">
${cards}
</div>
<footer><p><strong>Bitti.</strong> ${doc.funnel?.mediaOnly ?? 0} yalnız-medya gönderi yargılanmadı.</p></footer>
</main>
</body>
</html>
`;
}
