// ─── Reusable local image asset library (IndexedDB-backed) ────────
// Local-first, single-user persistence for user-uploaded PNG/JPEG images,
// mirroring the localStorage precedent used for user-created indicators
// (see indicators.ts's USER_INDICATORS_KEY), but using IndexedDB since
// base64 image data would blow past localStorage's ~5MB string quota.

export interface AssetRecord {
  name: string;
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  createdAt: number;
}

const DB_NAME = 'dafe_oakscript_assets';
const DB_VERSION = 1;
const STORE_NAME = 'images';

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg']);
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB per file

// Unlike image-cache.ts's decoded bitmaps (pure derived data, safe to
// silently evict) or drawings.ts's manual annotations (ephemeral chart
// markup, safe to auto-trim), a saved asset is user-uploaded CONTENT — the
// user chose a name and expects it to stay until they delete it. So this
// library is capped by REJECTING new saves once full rather than quietly
// deleting someone's image, with a clear error pointing at what to do.
const MAX_LIBRARY_BYTES = 150 * 1024 * 1024; // 150MB total across all assets
const MAX_LIBRARY_COUNT = 200;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getDB(): Promise<IDBDatabase> {
  return openDB();
}

// Decode a File into its bitmap dimensions, verifying it is a genuine,
// well-formed image (not just a file with a spoofed extension/MIME type).
// Prefers createImageBitmap; falls back to Image()+FileReader for
// environments where createImageBitmap is unavailable.
async function decodeImageDimensions(file: File): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const { width, height } = bitmap;
      bitmap.close();
      return { width, height };
    } catch (err) {
      throw new Error(`Failed to decode image: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback: decode via FileReader → data URL → Image()
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to decode image: corrupt or unsupported file'));
    img.src = dataUrl;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export async function listImageAssets(): Promise<AssetRecord[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as AssetRecord[]);
    req.onerror = () => reject(req.error);
  });
}

export async function getImageAsset(name: string): Promise<AssetRecord | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(name);
    req.onsuccess = () => resolve((req.result as AssetRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Diagnostics for the editor's resource-monitor UI. */
export async function getLibraryStats(): Promise<{ count: number; totalBytes: number }> {
  const assets = await listImageAssets();
  let totalBytes = 0;
  for (const a of assets) totalBytes += a.sizeBytes;
  return { count: assets.length, totalBytes };
}

export async function saveImageAsset(name: string, file: File): Promise<AssetRecord> {
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new Error(`Unsupported image type "${file.type}" — only image/png and image/jpeg are allowed`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`Image file too large (${file.size} bytes) — maximum is ${MAX_FILE_BYTES} bytes (5MB)`);
  }

  // Soft library cap: rejects the save (rather than silently deleting an
  // older asset) once the library is full, so a user never loses uploaded
  // content without acting themselves. Re-saving an EXISTING name is a
  // replace, not a net addition, so its own current size is excluded from
  // the projected total.
  const existing = await getImageAsset(name);
  const { count, totalBytes } = await getLibraryStats();
  const projectedCount = existing ? count : count + 1;
  const projectedBytes = totalBytes - (existing?.sizeBytes ?? 0) + file.size;
  if (projectedCount > MAX_LIBRARY_COUNT) {
    throw new Error(`Image library is full (${MAX_LIBRARY_COUNT} images max) — delete an unused image before adding another.`);
  }
  if (projectedBytes > MAX_LIBRARY_BYTES) {
    throw new Error(`Image library storage limit reached (${(MAX_LIBRARY_BYTES / (1024 * 1024)).toFixed(0)}MB max) — delete an unused image before adding another.`);
  }

  // Decode BEFORE writing to IndexedDB: this is the integrity/security
  // boundary that rejects corrupt or MIME-mismatched files early, and
  // captures real pixel dimensions rather than trusting the upload.
  const { width, height } = await decodeImageDimensions(file);
  const dataUrl = await fileToDataUrl(file);

  const record: AssetRecord = {
    name,
    dataUrl,
    mimeType: file.type,
    width,
    height,
    sizeBytes: file.size,
    createdAt: Date.now(),
  };

  const db = await getDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  return record;
}

export async function deleteImageAsset(name: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAllAssetsAsMap(): Promise<Map<string, string>> {
  const assets = await listImageAssets();
  const map = new Map<string, string>();
  for (const asset of assets) {
    map.set(asset.name, asset.dataUrl);
  }
  return map;
}
