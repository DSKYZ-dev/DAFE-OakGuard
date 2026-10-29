// Shared Web Crypto helper — used by OakCartridge (content-integrity hash on
// exported indicator files) and Glass Ledger (the hash chain itself), so the
// hashing primitive lives in exactly one place rather than two near-copies.

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
