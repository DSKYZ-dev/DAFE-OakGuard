/**
 * Self-contained report export — zero host dependency.
 *
 * Generates a full standalone HTML document and hands it to the user via the
 * native share sheet (Android → Gmail/Drive/etc.) or a browser download. This
 * replaces the old `mailto:` + blob-URL approach, which produced a dead
 * localhost link that showed nothing.
 */

export interface ReportOpts {
  subject: string;
  filename: string;
  /** Complete self-contained HTML document (inline CSS, no external refs). */
  html: string;
  /** Plain-text summary for share previews / fallback mail body. */
  text: string;
  onDone?: (message: string) => void;
}

function downloadHtml(o: ReportOpts): void {
  try {
    const blob = new Blob([o.html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = o.filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    o.onDone?.(`Saved ${o.filename} — check your Downloads / Files`);
  } catch {
    o.onDone?.('Could not export report');
  }
}

export function submitReport(o: ReportOpts): void {
  const nav = navigator as any;
  const file = typeof File !== 'undefined' ? new File([o.html], o.filename, { type: 'text/html' }) : null;

  // 1) Native share with the HTML file itself — fully self-contained.
  if (nav.share && nav.canShare && file) {
    try {
      if (nav.canShare({ files: [file] })) {
        nav.share({ title: o.subject, text: o.text, files: [file] })
          .then(() => o.onDone?.(`Report shared (${o.filename})`))
          .catch(() => downloadHtml(o));
        return;
      }
    } catch {
      /* fall through to download */
    }
  }

  // 2) Text share (no file support).
  if (nav.share) {
    nav.share({ title: o.subject, text: o.text }).catch(() => downloadHtml(o));
    return;
  }

  // 3) Download fallback.
  downloadHtml(o);
}