import fs from "node:fs/promises";
import path from "node:path";

import type { Page } from "playwright";

import { parseUiStatePacket, type UIStatePacket } from "../contracts/state-packet.js";
import type { RunContext } from "../run/initialize-run.js";
import { ensureDir, toRelativePosix } from "../utils/fs.js";
import { hashFile, hashString } from "../utils/hash.js";
import { computeDifferenceHashFromPng } from "../utils/image-hash.js";
import { discoverInteractiveElements } from "./discovery.js";
import { createNodeId, normalizeDomForHash, normalizeRouteTemplate } from "./fingerprint.js";
import { extractTablesOrLists } from "./table-detection.js";

export interface CaptureCurrentStateInput {
  page: Page;
  run: RunContext;
  role: string;
  capture_id: string;
  state_type?: UIStatePacket["node"]["state_type"];
  parent_node_id?: string;
}

export async function captureCurrentState(input: CaptureCurrentStateInput): Promise<UIStatePacket> {
  await waitForStableUi(input.page);

  const viewportSize = input.page.viewportSize();
  const viewportWidth = viewportSize?.width ?? 1280;
  const viewportHeight = viewportSize?.height ?? 720;

  const captureDirName = sanitizeCaptureId(input.capture_id);
  const artifactDir = path.join(input.run.artifacts_dir, captureDirName);
  await ensureDir(artifactDir);

  const fullPath = path.join(artifactDir, "full.png");
  const viewportPath = path.join(artifactDir, "viewport.png");
  const htmlPath = path.join(artifactDir, "snapshot.html");
  const a11yPath = path.join(artifactDir, "a11y.txt");

  await input.page.screenshot({ path: fullPath, fullPage: true });
  await input.page.screenshot({ path: viewportPath, fullPage: false });

  const htmlSnapshot = await input.page.content();
  await fs.writeFile(htmlPath, htmlSnapshot, "utf8");

  const a11yTreeText = await input.page
    .locator("body")
    .ariaSnapshot()
    .catch(() => "");
  await fs.writeFile(a11yPath, a11yTreeText, "utf8");

  const visibleTextSample = await extractVisibleTextSample(input.page, 140);
  const interactiveElements = await discoverInteractiveElements(input.page);
  const titleCandidates = await getTitleCandidates(input.page);
  const tablesOrLists = await extractTablesOrLists(input.page);

  const routeTemplate = normalizeRouteTemplate(input.page.url());
  const domHash = hashString(normalizeDomForHash(htmlSnapshot));
  const a11yHash = hashString(a11yTreeText);
  const phashFull = await computeDifferenceHashFromPng(fullPath);
  const phashViewport = await computeDifferenceHashFromPng(viewportPath);

  const stateType = input.state_type ?? "screen";
  const nodeId = createNodeId({
    state_type: stateType,
    route_template: routeTemplate,
    a11y_hash: a11yHash,
    phash_full: phashFull,
  });

  const fullSha = await hashFile(fullPath);
  const viewportSha = await hashFile(viewportPath);
  const htmlSha = hashString(htmlSnapshot);
  const a11ySha = hashString(a11yTreeText);

  const node = {
    node_id: nodeId,
    state_type: stateType,
    url: input.page.url(),
    route_template: routeTemplate,
    title_candidates: titleCandidates,
    fingerprint: {
      dom_hash: domHash,
      a11y_hash: a11yHash,
      phash_full: phashFull,
      phash_viewport: phashViewport,
    },
  };
  if (input.parent_node_id) {
    Object.assign(node, {
      parent_node_id: input.parent_node_id,
    });
  }

  const packetInput = {
    packet_version: "1.0",
    capture: {
      run_id: input.run.run_id,
      run_label: input.run.label,
      captured_at: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      role: input.role,
      viewport: {
        width: viewportWidth,
        height: viewportHeight,
        device_scale_factor: 1,
      },
    },
    node,
    artifacts: [
      {
        artifact_id: "art_full",
        kind: "screenshot_full",
        mime_type: "image/png",
        path: toRelativePosix(fullPath),
        sha256: fullSha,
      },
      {
        artifact_id: "art_viewport",
        kind: "screenshot_viewport",
        mime_type: "image/png",
        path: toRelativePosix(viewportPath),
        sha256: viewportSha,
        width: viewportWidth,
        height: viewportHeight,
      },
      {
        artifact_id: "art_html",
        kind: "html_snapshot",
        mime_type: "text/html",
        path: toRelativePosix(htmlPath),
        sha256: htmlSha,
      },
      {
        artifact_id: "art_a11y",
        kind: "a11y_snapshot",
        mime_type: "text/plain",
        path: toRelativePosix(a11yPath),
        sha256: a11ySha,
      },
    ],
    ui: {
      visible_text_sample: visibleTextSample,
      a11y_tree_text: truncate(a11yTreeText, 14000),
      interactive_elements: interactiveElements,
    },
  };

  if (tablesOrLists.length > 0) {
    Object.assign(packetInput.ui, {
      tables_or_lists: tablesOrLists,
    });
  }

  return parseUiStatePacket(packetInput);
}

export async function waitForStableUi(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
  await page.locator("body").first().waitFor({ state: "visible", timeout: 6_000 });
  await page.waitForTimeout(300);
}

async function extractVisibleTextSample(page: Page, maxLines: number): Promise<string[]> {
  const text = await page.evaluate(() => document.body?.innerText ?? "");
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}

async function getTitleCandidates(page: Page): Promise<string[]> {
  const [pageTitle, headingCandidates] = await Promise.all([
    page.title(),
    page.$$eval("h1, h2, [role='heading']", (nodes) =>
      nodes
        .map((node) => (node.textContent ?? "").trim())
        .filter((value) => value.length > 0)
        .slice(0, 8),
    ),
  ]);

  const candidates = [pageTitle, ...headingCandidates].filter((value) => value.length > 0);
  return Array.from(new Set(candidates)).slice(0, 10);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...<truncated>`;
}

function sanitizeCaptureId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
