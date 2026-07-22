import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalStringify } from "@kineweave/project-format";
import type { JsonValue } from "@kineweave/protocol";

const encoder = new TextEncoder();

export function hashBytes(value: Uint8Array): string {
  return `sha256:${bytesToHex(sha256(value))}`;
}

export function hashUtf8(value: string): string {
  return hashBytes(encoder.encode(value));
}

export function hashJson(value: JsonValue): string {
  return hashUtf8(
    canonicalStringify(value, { indent: 0, trailingNewline: false })
  );
}
