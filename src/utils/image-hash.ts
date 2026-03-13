import fs from "node:fs/promises";

import { PNG } from "pngjs";

export async function computeDifferenceHashFromPng(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const png = PNG.sync.read(buffer);

  const sampleWidth = 9;
  const sampleHeight = 8;
  const grayscale: number[] = [];

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const sourceX = Math.min(png.width - 1, Math.floor((x * png.width) / sampleWidth));
      const sourceY = Math.min(png.height - 1, Math.floor((y * png.height) / sampleHeight));
      const idx = (sourceY * png.width + sourceX) * 4;

      const r = png.data[idx] ?? 0;
      const g = png.data[idx + 1] ?? 0;
      const b = png.data[idx + 2] ?? 0;

      grayscale.push(0.299 * r + 0.587 * g + 0.114 * b);
    }
  }

  let bits = "";
  for (let y = 0; y < sampleHeight; y += 1) {
    const rowOffset = y * sampleWidth;
    for (let x = 0; x < sampleWidth - 1; x += 1) {
      const left = grayscale[rowOffset + x] ?? 0;
      const right = grayscale[rowOffset + x + 1] ?? 0;
      bits += left > right ? "1" : "0";
    }
  }

  return binaryToHex(bits.padEnd(64, "0"));
}

function binaryToHex(bits: string): string {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    const chunk = bits.slice(i, i + 4);
    const value = Number.parseInt(chunk, 2);
    hex += Number.isFinite(value) ? value.toString(16) : "0";
  }
  return hex;
}
