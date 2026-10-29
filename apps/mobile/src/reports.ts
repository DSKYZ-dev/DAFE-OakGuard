/**
 * Self-contained report export — native Capacitor path first.
 *
 * Previous version relied on <a download> + navigator.share, which silently
 * do nothing in many Android WebViews (the "saved to Downloads" toast lied).
 * Now: Capacitor Filesystem writes a REAL file to Documents, then the
 * Capacitor Share plugin opens the native Android share sheet with that
 * actual file attached — Gmail/Drive/Discord all receive a genuine .html.
 * Falls back to web share/download only when not running as a native app.
 */

export interface ReportOpts {
  subject: string;
  filename: string;
  /** Complete self-contained HTML document (inline CSS, no external refs). */
  html: string;
  /** Plain-text summary for share previews. */
  text: string;
  onDone?: (message: string) => void;
}

async function shareNative(o: ReportOpts): Promise<boolean> {
  try {
    const cap = (window as any).Capacitor;
    if (!cap?.isNativePlatform?.()) return false;
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');

    // Write the report as a real file in the app's Documents directory.
    const fname = o.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    await Filesystem.writeFile({
      path: fname,
      data: o.html,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });

    // Read it back as a URI and hand it to the native share sheet.
    const meta = await Filesystem.getUri({ path: fname, directory: Directory.Documents });
    await Share.share({
      title: o.subject,
      text: o.text,
      url: meta.uri,
      dialogTitle: o.subject,
    });
    o.onDone?.(`Report saved & shared (${fname})`);
    return true;
  } catch (e: any) {
    // User cancelling the share sheet is not a failure worth a toast-storm over.
    if (String(e?.message || e).toLowerCase().includes('cancel')) {
      o.onDone?.('Share cancelled — report still saved in Documents');
      return true;
    }
    return false;
  }
}

function webFallback(o: ReportOpts): void {
  const nav = navigator as any;
  // WebView/PWA path — try the share sheet, then a download.
  try {
    if (nav.share) {
      nav.share({ title: o.subject, text: o.text })
        .then(() => o.onDone?.('Shared'))
        .catch(() => downloadWeb(o));
      return;
    }
  } catch { /* fall through */ }
  downloadWeb(o);
}

function downloadWeb(o: ReportOpts): void {
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
    o.onDone?.(`Saved ${o.filename} via download`);
  } catch {
    o.onDone?.('Could not export report');
  }
}

export async function submitReport(o: ReportOpts): Promise<void> {
  const nativeOk = await shareNative(o);
  if (!nativeOk) webFallback(o);
}