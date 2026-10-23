/** Stable unsigned 32-bit hash; used for placement, never for security. */
export function hash32(text: string, seed = 0): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

export function random(seed: number): () => number {
  if (!Number.isSafeInteger(seed)) throw new Error("Seed must be a safe integer");
  let cursor = seed >>> 0;
  return () => hash32(String(cursor++), seed) / 0x100000000;
}
