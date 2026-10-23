import { compressToEncodedURIComponent } from "lz-string";
import type { Design } from "../../engine/types";
import { designSchema, newId } from "./schemas";

export const SHARE_COMPRESSED_LIMIT = 8 * 1024;
export const SHARE_DECOMPRESSED_LIMIT = 64 * 1024;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
const bytes = (text: string) => new TextEncoder().encode(text).length;

// lz-string's URI bitstream, decoded incrementally so output is bounded before joining.
function decompressBounded(input: string): string {
  let offset = 0;
  let bit = 32;
  let value = alphabet.indexOf(input[0]);
  function read(width: number) {
    let result = 0;
    for (let power = 0; power < width; power++) {
      if (offset > input.length) throw new Error("Truncated share link");
      if (value & bit) result += 2 ** power;
      bit >>= 1;
      if (!bit) { bit = 32; value = alphabet.indexOf(input[++offset]); }
    }
    return result;
  }
  const dictionary: string[] = ["", "", ""];
  const first = read(2);
  if (first === 2) return "";
  if (first !== 0 && first !== 1) throw new Error("Invalid share link");
  let previous = String.fromCharCode(read(first === 0 ? 8 : 16));
  dictionary[3] = previous;
  const output = [previous];
  let length = 1;
  let width = 3;
  let remaining = 4;
  function grow() { if (--remaining === 0) { remaining = 2 ** width; width++; } }
  while (offset <= input.length) {
    let code = read(width);
    if (code === 2) {
      const result = output.join("");
      if (bytes(result) > SHARE_DECOMPRESSED_LIMIT) throw new Error("Share link exceeds 64 KB; use export.");
      return result;
    }
    if (code === 0 || code === 1) {
      dictionary.push(String.fromCharCode(read(code === 0 ? 8 : 16)));
      code = dictionary.length - 1;
      grow();
    }
    const entry = dictionary[code] ?? (code === dictionary.length ? previous + previous[0] : undefined);
    if (entry === undefined) throw new Error("Invalid share link");
    length += entry.length;
    if (length > SHARE_DECOMPRESSED_LIMIT) throw new Error("Share link exceeds 64 KB; use export.");
    output.push(entry);
    dictionary.push(previous + entry[0]);
    grow();
    previous = entry;
  }
  throw new Error("Truncated share link");
}

export function encodeShareLink(design: Design): string | null {
  try {
    const json = JSON.stringify(designSchema.parse(design));
    if (bytes(json) > SHARE_DECOMPRESSED_LIMIT) return null;
    const compressed = compressToEncodedURIComponent(json);
    return compressed.length <= SHARE_COMPRESSED_LIMIT ? `#d=${compressed}` : null;
  } catch { return null; }
}

export function decodeShareLink(hash: string): Design | { error: string } {
  try {
    if (!hash.startsWith("#d=")) throw new Error("Malformed share link");
    const payload = hash.slice(3);
    if (!payload.length || payload.length > SHARE_COMPRESSED_LIMIT || !/^[A-Za-z0-9+\-$]+$/.test(payload)) throw new Error("Invalid or oversized share link; use export.");
    const parsed = JSON.parse(decompressBounded(payload));
    // A link is an unsaved new draft; callers decide when to persist it.
    return { ...designSchema.parse(parsed), id: newId() };
  } catch (error) { return { error: error instanceof Error ? error.message : "Malformed share link" }; }
}
