import { hashString, shortHash } from "../utils/hash.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HEX_PATTERN = /^[0-9a-f]{8,}$/i;
const NUMERIC_PATTERN = /^\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeRouteTemplate(rawUrl: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  const normalizedPath = parsedUrl.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (NUMERIC_PATTERN.test(segment) || UUID_PATTERN.test(segment) || LONG_HEX_PATTERN.test(segment)) {
        return "{id}";
      }
      if (DATE_PATTERN.test(segment)) {
        return "{date}";
      }
      return segment;
    })
    .join("/");

  const queryKeys = Array.from(new Set(parsedUrl.searchParams.keys())).sort();
  const queryTemplate = queryKeys.length > 0 ? `?${queryKeys.map((key) => `${key}={value}`).join("&")}` : "";

  return `/${normalizedPath}${queryTemplate}`;
}

export function normalizeDomForHash(html: string): string {
  return html
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "{date}")
    .replace(/\b\d+\b/g, "{num}")
    .replace(/[0-9a-f]{8,}/gi, "{hex}")
    .replace(/\s+/g, " ")
    .trim();
}

export function createNodeId(input: {
  state_type: string;
  route_template: string;
  a11y_hash: string;
  phash_full: string;
}): string {
  const fingerprintMaterial = [
    input.state_type,
    input.route_template,
    shortHash(input.a11y_hash, 16),
    shortHash(input.phash_full, 16),
  ].join("|");

  return shortHash(hashString(fingerprintMaterial), 12);
}
