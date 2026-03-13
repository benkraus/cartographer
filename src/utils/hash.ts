import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export function shortHash(value: string, length = 12): string {
  return value.slice(0, length);
}

export function hexHammingDistance(left: string, right: string): number {
  const maxLength = Math.max(left.length, right.length);
  const paddedLeft = left.padStart(maxLength, "0");
  const paddedRight = right.padStart(maxLength, "0");

  let distance = 0;
  for (let index = 0; index < maxLength; index += 1) {
    const leftNibble = Number.parseInt(paddedLeft[index] ?? "0", 16);
    const rightNibble = Number.parseInt(paddedRight[index] ?? "0", 16);
    const xor = (leftNibble ^ rightNibble) >>> 0;
    distance += BIT_COUNT_TABLE[xor] ?? 0;
  }

  return distance;
}

const BIT_COUNT_TABLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4] as const;
