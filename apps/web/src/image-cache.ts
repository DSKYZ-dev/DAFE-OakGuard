// ─── Synchronous-read image decode cache ───────────────────────────
// Render loops (2D canvas + 3D Three.js) run synchronously once per frame,
// but decoding an image (data URI or otherwise) is inherently async. This
// module bridges the gap: resolveImage() always returns synchronously —
// either the already-decoded HTMLImageElement (cache hit) or null (decode
// kicked off in the background, caller skips drawing this frame and
// naturally retries next frame once the render loop comes back around).
//
// Unlike OakScript's per-execution drawing-object caps (interpreter.ts's
// upsertObject/OBJECT_CAPS), this cache is NOT rebuilt fresh each run — it
// lives for the whole tab session, accumulating one entry per distinct
// image source a script or the manual UI has ever drawn. Left unbounded,
// every unique inline data-URI or asset a user tries over a long session
// stays resident as a full decoded bitmap (width*height*4 bytes) forever.
// This is a real memory leak, not a cosmetic one — a handful of large
// images can add up to hundreds of MB. So this cache evicts the least-
// recently-USED entry (not least-recently-inserted) once either budget is
// exceeded, keeping active images resident and reclaiming stale ones.

interface LiveEntry { img: HTMLImageElement; approxBytes: number; lastAccess: number; }
type CacheEntry = LiveEntry | 'loading' | 'error';

const cache = new Map<string, CacheEntry>();

// Insertion-order-independent LRU: every read/write touches this counter
// instead of relying on Map iteration order, so a cache HIT (not just a
// fresh decode) correctly counts as "recently used" and survives eviction.
let accessClock = 0;

// Two independent ceilings — either one triggers eviction. Byte budget is
// the real resource guard (a handful of 2000x2000 images can burn 100MB+);
// the entry-count ceiling is a cheap backstop for many small images that
// would never trip the byte budget but still bloat the Map and GC churn.
const MAX_BYTES = 96 * 1024 * 1024; // ~96MB of decoded bitmap data
const MAX_ENTRIES = 80;

let totalBytes = 0;

function approxImageBytes(img: HTMLImageElement): number {
  // Uncompressed RGBA estimate — a decoded bitmap costs this regardless of
  // the source file's compressed size, which is the number that actually
  // matters for memory pressure.
  return Math.max(1, img.naturalWidth) * Math.max(1, img.naturalHeight) * 4;
}

function evictUntilWithinBudget(): void {
  if (totalBytes <= MAX_BYTES && cache.size <= MAX_ENTRIES) return;
  // Collect live (decoded) entries sorted oldest-accessed-first; 'loading'/
  // 'error' sentinels hold no bitmap data and are never evicted here — a
  // decode already in flight must be allowed to finish, and a remembered
  // failure is cheap to keep (it prevents endlessly retrying a broken URL).
  const live: Array<[string, LiveEntry]> = [];
  for (const [key, entry] of cache) {
    if (entry !== 'loading' && entry !== 'error') live.push([key, entry]);
  }
  live.sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [key, entry] of live) {
    if (totalBytes <= MAX_BYTES && cache.size <= MAX_ENTRIES) break;
    cache.delete(key);
    totalBytes -= entry.approxBytes;
  }
}

let redrawCallback: (() => void) | undefined;

export function setRedrawCallback(fn: () => void): void {
  redrawCallback = fn;
}

export function resolveImage(sourceKey: string): HTMLImageElement | null {
  const entry = cache.get(sourceKey);

  if (entry && entry !== 'loading' && entry !== 'error') {
    entry.lastAccess = ++accessClock;
    return entry.img;
  }
  if (entry === 'loading' || entry === 'error') {
    return null;
  }

  // Cache miss — kick off an async decode and mark as loading immediately
  // so repeated calls (this frame or subsequent frames) don't re-kick-off
  // duplicate decodes while one is already in flight.
  cache.set(sourceKey, 'loading');

  const img = new Image();
  img.onload = () => {
    const approxBytes = approxImageBytes(img);
    cache.set(sourceKey, { img, approxBytes, lastAccess: ++accessClock });
    totalBytes += approxBytes;
    evictUntilWithinBudget();
    if (redrawCallback) {
      redrawCallback();
    }
  };
  img.onerror = () => {
    cache.set(sourceKey, 'error');
  };
  img.src = sourceKey;

  return null;
}

/** Diagnostics for the editor's resource-monitor UI. */
export function getImageCacheStats(): { entries: number; approxBytes: number; loading: number; errors: number } {
  let loading = 0, errors = 0;
  for (const entry of cache.values()) {
    if (entry === 'loading') loading++;
    else if (entry === 'error') errors++;
  }
  return { entries: cache.size, approxBytes: totalBytes, loading, errors };
}

/** Manual full flush (e.g. a "Clean Up" button) — safe at any time since
 * every entry here is purely derived from a source string and will simply
 * re-decode on next use. */
export function clearImageCache(): void {
  cache.clear();
  totalBytes = 0;
}
