import path from "node:path";

import { chromium, type BrowserContextOptions, type Locator, type Page } from "playwright";

import type { UIStatePacket } from "../contracts/state-packet.js";
import type { RunContext } from "../run/initialize-run.js";
import type { FileStateStore } from "../store/file-state-store.js";
import { fileExists, readJsonFile, writeJsonFile } from "../utils/fs.js";
import { buildActionCandidates, type ActionCandidate, type ActionPolicy } from "./action-candidates.js";
import { captureCurrentState } from "./capture-state.js";
import { normalizeRouteTemplate } from "./fingerprint.js";

const SUPPORTED_ROLES = new Set([
  "button",
  "link",
  "tab",
  "menuitem",
  "checkbox",
  "radio",
  "combobox",
  "textbox",
  "searchbox",
]);

const PAGINATION_LABEL_PATTERN = /\b(next|prev|previous|page|pagination|older|newer|more)\b/i;
const SEARCH_LABEL_PATTERN = /\b(search|filter|find|lookup)\b/i;

const CHECKPOINT_FILE_NAME = "safe-bfs-checkpoint.json";
const SUMMARY_FILE_NAME = "safe-bfs-summary.json";

interface QueueEntry {
  node_id: string;
  url: string;
  depth: number;
}

interface RunSummary {
  run_id: string;
  role: string;
  start_url: string;
  started_at: string;
  root_node_id: string;
  metrics: {
    explored_nodes: number;
    discovered_nodes: number;
    actions_considered: number;
    actions_executed: number;
    actions_blocked: number;
    actions_no_transition: number;
    edges_inserted: number;
    packets_written: number;
    overlays_explored: number;
    list_probes_attempted: number;
    blocked_state_artifacts: number;
  };
  limits: {
    max_states: number;
    max_actions_per_state: number;
    max_overlay_actions: number;
    max_overlay_depth: number;
    list_row_sample_size: number;
    max_depth: number;
    max_queue_size: number;
    max_runtime_ms: number;
  };
  queue_history: Array<{ node_id: string; url: string; depth: number }>;
  blocked_actions: Array<{ node_id: string; action_label: string; reason: string }>;
}

interface ExplorerRuntime {
  capture_counter: number;
  queue: QueueEntry[];
  enqueued: Set<string>;
  visited: Set<string>;
  discovered: Set<string>;
  summary: RunSummary;
  checkpoint_path: string;
  resumed_from_checkpoint: boolean;
  run_started_ms: number;
  run_deadline_ms: number;
}

interface SafeBfsCheckpoint {
  checkpoint_version: "1.0";
  saved_at: string;
  run_id: string;
  capture_counter: number;
  queue: QueueEntry[];
  visited_node_ids: string[];
  enqueued_node_ids: string[];
  discovered_node_ids: string[];
  summary: RunSummary;
}

export interface SafeBfsExplorerInput {
  run: RunContext;
  role: string;
  start_url: string;
  storage_state_path?: string;
  headless: boolean;
  viewport: {
    width: number;
    height: number;
  };
  max_states: number;
  max_actions_per_state: number;
  max_overlay_actions: number;
  max_overlay_depth: number;
  list_row_sample_size: number;
  max_depth: number;
  max_queue_size: number;
  max_runtime_ms: number;
  enable_list_empty_state_probe: boolean;
  enable_list_pagination_probe: boolean;
  resume_from_checkpoint: boolean;
  action_policy: Partial<ActionPolicy>;
  store: FileStateStore;
}

export interface SafeBfsExplorerResult {
  run_id: string;
  root_node_id: string;
  explored_nodes: number;
  discovered_nodes: number;
  actions_considered: number;
  actions_executed: number;
  actions_blocked: number;
  actions_no_transition: number;
  edges_inserted: number;
  packets_written: number;
  overlays_explored: number;
  list_probes_attempted: number;
  blocked_state_artifacts: number;
  resumed_from_checkpoint: boolean;
  checkpoint_path: string;
  summary_path: string;
}

export async function runSafeBfsExplorer(input: SafeBfsExplorerInput): Promise<SafeBfsExplorerResult> {
  const checkpointPath = path.join(input.run.logs_dir, CHECKPOINT_FILE_NAME);
  const runStartedMs = Date.now();
  const browser = await chromium.launch({ headless: input.headless });
  const runtime: ExplorerRuntime = {
    capture_counter: 0,
    queue: [],
    enqueued: new Set<string>(),
    visited: new Set<string>(),
    discovered: new Set<string>(),
    checkpoint_path: checkpointPath,
    resumed_from_checkpoint: false,
    run_started_ms: runStartedMs,
    run_deadline_ms: runStartedMs + input.max_runtime_ms,
    summary: {
      run_id: input.run.run_id,
      role: input.role,
      start_url: input.start_url,
      started_at: new Date().toISOString(),
      root_node_id: "",
      metrics: {
        explored_nodes: 0,
        discovered_nodes: 0,
        actions_considered: 0,
        actions_executed: 0,
        actions_blocked: 0,
        actions_no_transition: 0,
        edges_inserted: 0,
        packets_written: 0,
        overlays_explored: 0,
        list_probes_attempted: 0,
        blocked_state_artifacts: 0,
      },
      limits: {
        max_states: input.max_states,
        max_actions_per_state: input.max_actions_per_state,
        max_overlay_actions: input.max_overlay_actions,
        max_overlay_depth: input.max_overlay_depth,
        list_row_sample_size: input.list_row_sample_size,
        max_depth: input.max_depth,
        max_queue_size: input.max_queue_size,
        max_runtime_ms: input.max_runtime_ms,
      },
      queue_history: [],
      blocked_actions: [],
    },
  };

  if (input.resume_from_checkpoint) {
    const restoredCheckpoint = await loadCheckpoint(runtime.checkpoint_path, input.run.run_id);
    if (restoredCheckpoint) {
      runtime.capture_counter = restoredCheckpoint.capture_counter;
      runtime.queue = restoredCheckpoint.queue;
      runtime.visited = new Set(restoredCheckpoint.visited_node_ids);
      runtime.enqueued = new Set(restoredCheckpoint.enqueued_node_ids);
      runtime.discovered = new Set(restoredCheckpoint.discovered_node_ids);
      runtime.summary = {
        ...restoredCheckpoint.summary,
        limits: {
          ...restoredCheckpoint.summary.limits,
          max_states: input.max_states,
          max_actions_per_state: input.max_actions_per_state,
          max_overlay_actions: input.max_overlay_actions,
          max_overlay_depth: input.max_overlay_depth,
          list_row_sample_size: input.list_row_sample_size,
          max_depth: input.max_depth,
          max_queue_size: input.max_queue_size,
          max_runtime_ms: input.max_runtime_ms,
        },
      };
      runtime.resumed_from_checkpoint = true;
    }
  }

  try {
    const contextOptions: BrowserContextOptions = {
      viewport: {
        width: input.viewport.width,
        height: input.viewport.height,
      },
    };
    if (input.storage_state_path) {
      contextOptions.storageState = input.storage_state_path;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(input.start_url, { waitUntil: "domcontentloaded" });

    if (runtime.queue.length === 0 || runtime.summary.root_node_id.length === 0) {
      const rootCapture = await captureAndPersistState({
        page,
        run: input.run,
        role: input.role,
        capture_id: nextCaptureId("root", ++runtime.capture_counter),
        store: input.store,
      });
      runtime.summary.metrics.packets_written += 1;
      runtime.summary.root_node_id = rootCapture.stored_node_id;

      registerDiscoveredNode(runtime, rootCapture.stored_node_id);
      enqueueScreenNode(
        runtime,
        rootCapture.stored_node_id,
        rootCapture.packet.node.url,
        0,
        input.max_states,
        input.max_depth,
        input.max_queue_size,
      );
      await saveCheckpoint(runtime);
    }

    while (runtime.queue.length > 0 && runtime.visited.size < input.max_states) {
      if (Date.now() >= runtime.run_deadline_ms) {
        runtime.summary.blocked_actions.push({
          node_id: runtime.summary.root_node_id,
          action_label: "runtime_budget",
          reason: "Stopped because max runtime budget was reached.",
        });
        break;
      }

      const queueEntry = runtime.queue.shift();
      if (!queueEntry) {
        break;
      }
      runtime.enqueued.delete(queueEntry.node_id);
      if (runtime.visited.has(queueEntry.node_id)) {
        continue;
      }

      await ensureOnSourceUrl(page, queueEntry.url);

      const sourceCapture = await captureAndPersistState({
        page,
        run: input.run,
        role: input.role,
        capture_id: nextCaptureId("state", ++runtime.capture_counter),
        store: input.store,
      });
      runtime.summary.metrics.packets_written += 1;

      const sourceNodeId = sourceCapture.stored_node_id;
      runtime.visited.add(sourceNodeId);
      runtime.summary.metrics.explored_nodes = runtime.visited.size;

      const allCandidates = buildActionCandidates(sourceCapture.packet.ui.interactive_elements, input.action_policy);
      const { ordered_candidates, force_capture_action_ids } = prioritizeCandidatesForScreenState(
        sourceCapture.packet,
        allCandidates,
        input.list_row_sample_size,
        input.enable_list_pagination_probe,
      );
      const executableCandidates = ordered_candidates
        .filter((candidate) => candidate.executable)
        .slice(0, input.max_actions_per_state);

      await writeJsonFile(path.join(input.run.packets_dir, `${sourceCapture.capture_id}-${sourceNodeId}.actions.json`), {
        node_id: sourceNodeId,
        generated_at: new Date().toISOString(),
        policy: input.action_policy,
        counts: {
          total: allCandidates.length,
          executable: executableCandidates.length,
          blocked: allCandidates.length - executableCandidates.length,
        },
        candidates: ordered_candidates,
      });

      runtime.summary.metrics.actions_considered += allCandidates.length;
      runtime.summary.metrics.actions_blocked += allCandidates.length - executableCandidates.length;

      for (const blockedCandidate of allCandidates.filter((candidate) => !candidate.executable)) {
        runtime.summary.blocked_actions.push({
          node_id: sourceNodeId,
          action_label: blockedCandidate.action_label,
          reason: blockedCandidate.skip_reason ?? "Policy blocked",
        });
      }

      await runEmptyStateProbeIfEnabled({
        page,
        input,
        runtime,
        source_capture: sourceCapture,
        source_depth: queueEntry.depth,
      });

      for (const candidate of executableCandidates) {
        const baseline = await readTransitionSurface(page);
        const execution = await executeActionCandidate(page, sourceCapture.packet, candidate);
        if (!execution.executed) {
          runtime.summary.metrics.actions_blocked += 1;
          runtime.summary.blocked_actions.push({
            node_id: sourceNodeId,
            action_label: candidate.action_label,
            reason: execution.reason ?? "Execution failed",
          });
          await captureBlockedStateArtifact({
            page,
            run: input.run,
            runtime,
            source_node_id: sourceNodeId,
            action_label: candidate.action_label,
            reason: execution.reason ?? "Execution failed",
          });
          await restoreSourceState(page, sourceCapture.packet);
          continue;
        }

        runtime.summary.metrics.actions_executed += 1;

        const transition = await detectTransition(page, baseline);
        if (!transition.changed && !force_capture_action_ids.has(candidate.action_id)) {
          runtime.summary.metrics.actions_no_transition += 1;
          await restoreSourceState(page, sourceCapture.packet);
          continue;
        }

        const targetCaptureInput: CaptureAndPersistStateInput = {
          page,
          run: input.run,
          role: input.role,
          capture_id: nextCaptureId("edge", ++runtime.capture_counter),
          state_type: transition.changed ? transition.state_type : "screen",
          store: input.store,
        };
        if (transition.changed && transition.state_type !== "screen") {
          targetCaptureInput.parent_node_id = sourceNodeId;
        }

        const targetCapture = await captureAndPersistState(targetCaptureInput);
        runtime.summary.metrics.packets_written += 1;

        await addEdgeAndRegisterTarget({
          input,
          runtime,
          from_node_id: sourceNodeId,
          to_capture: targetCapture,
          action_type: candidate.action_type,
          action_label: candidate.action_label,
          element_id: candidate.element_id,
          risk: candidate.risk,
          source_depth: queueEntry.depth,
        });

        if (targetCapture.packet.node.state_type !== "screen") {
          await exploreOverlayFromScreenSource({
            page,
            input,
            runtime,
            source_capture: sourceCapture,
            source_depth: queueEntry.depth,
            opener_candidate: candidate,
            initial_overlay_capture: targetCapture,
          });
        }

        await restoreSourceState(page, sourceCapture.packet);
      }

      await saveCheckpoint(runtime);
    }

    await context.close();
    await saveCheckpoint(runtime, true);
  } catch (error) {
    await saveCheckpoint(runtime);
    throw error;
  } finally {
    await browser.close();
  }

  const summaryPath = path.join(input.run.logs_dir, SUMMARY_FILE_NAME);
  await writeJsonFile(summaryPath, {
    ...runtime.summary,
    resumed_from_checkpoint: runtime.resumed_from_checkpoint,
    checkpoint_path: runtime.checkpoint_path,
    finished_at: new Date().toISOString(),
  });

  return {
    run_id: input.run.run_id,
    root_node_id: runtime.summary.root_node_id,
    explored_nodes: runtime.summary.metrics.explored_nodes,
    discovered_nodes: runtime.summary.metrics.discovered_nodes,
    actions_considered: runtime.summary.metrics.actions_considered,
    actions_executed: runtime.summary.metrics.actions_executed,
    actions_blocked: runtime.summary.metrics.actions_blocked,
    actions_no_transition: runtime.summary.metrics.actions_no_transition,
    edges_inserted: runtime.summary.metrics.edges_inserted,
    packets_written: runtime.summary.metrics.packets_written,
    overlays_explored: runtime.summary.metrics.overlays_explored,
    list_probes_attempted: runtime.summary.metrics.list_probes_attempted,
    blocked_state_artifacts: runtime.summary.metrics.blocked_state_artifacts,
    resumed_from_checkpoint: runtime.resumed_from_checkpoint,
    checkpoint_path: runtime.checkpoint_path,
    summary_path: summaryPath,
  };
}

interface CaptureAndPersistStateInput {
  page: Page;
  run: RunContext;
  role: string;
  capture_id: string;
  state_type?: UIStatePacket["node"]["state_type"];
  parent_node_id?: string;
  store: FileStateStore;
}

async function captureAndPersistState(input: CaptureAndPersistStateInput): Promise<{
  capture_id: string;
  packet: UIStatePacket;
  stored_node_id: string;
  is_new: boolean;
}> {
  const captureInput = {
    page: input.page,
    run: input.run,
    role: input.role,
    capture_id: input.capture_id,
  };
  if (input.state_type) {
    Object.assign(captureInput, { state_type: input.state_type });
  }
  if (input.parent_node_id) {
    Object.assign(captureInput, { parent_node_id: input.parent_node_id });
  }

  const packet = await captureCurrentState(captureInput);
  const packetPath = path.join(input.run.packets_dir, `${input.capture_id}-${packet.node.node_id}.packet.json`);
  await writeJsonFile(packetPath, packet);

  const upsertResult = await input.store.upsertNodeFromPacket(packet, packetPath);
  return {
    capture_id: input.capture_id,
    packet,
    stored_node_id: upsertResult.node.node_id,
    is_new: upsertResult.is_new,
  };
}

interface AddEdgeAndRegisterTargetInput {
  input: SafeBfsExplorerInput;
  runtime: ExplorerRuntime;
  from_node_id: string;
  to_capture: {
    packet: UIStatePacket;
    stored_node_id: string;
  };
  action_type: string;
  action_label: string;
  element_id?: string;
  risk?: "safe" | "mutating" | "dangerous" | "unknown";
  source_depth: number;
}

async function addEdgeAndRegisterTarget(params: AddEdgeAndRegisterTargetInput): Promise<void> {
  const edgeInput = {
    from_node_id: params.from_node_id,
    to_node_id: params.to_capture.stored_node_id,
    action_type: params.action_type,
    action_label: params.action_label,
  };
  if (params.element_id) {
    Object.assign(edgeInput, { element_id: params.element_id });
  }
  if (params.risk) {
    Object.assign(edgeInput, { risk: params.risk });
  }

  const edgeResult = await params.input.store.addEdge(edgeInput);
  if (edgeResult.inserted) {
    params.runtime.summary.metrics.edges_inserted += 1;
  }

  registerDiscoveredNode(params.runtime, params.to_capture.stored_node_id);
  if (params.to_capture.packet.node.state_type === "screen") {
    enqueueScreenNode(
      params.runtime,
      params.to_capture.stored_node_id,
      params.to_capture.packet.node.url,
      params.source_depth + 1,
      params.input.max_states,
      params.input.max_depth,
      params.input.max_queue_size,
    );
  }
}

function registerDiscoveredNode(runtime: ExplorerRuntime, nodeId: string): void {
  if (!runtime.discovered.has(nodeId)) {
    runtime.discovered.add(nodeId);
    runtime.summary.metrics.discovered_nodes = runtime.discovered.size;
  }
}

function enqueueScreenNode(
  runtime: ExplorerRuntime,
  nodeId: string,
  url: string,
  depth: number,
  maxStates: number,
  maxDepth: number,
  maxQueueSize: number,
): void {
  if (runtime.visited.has(nodeId) || runtime.enqueued.has(nodeId)) {
    return;
  }
  if (depth > maxDepth) {
    runtime.summary.blocked_actions.push({
      node_id: nodeId,
      action_label: "enqueue_depth_limit",
      reason: `Skipped enqueue at depth ${depth}; max depth is ${maxDepth}.`,
    });
    return;
  }
  if (runtime.visited.size + runtime.queue.length >= maxStates) {
    runtime.summary.blocked_actions.push({
      node_id: nodeId,
      action_label: "enqueue_state_limit",
      reason: `Skipped enqueue because max states (${maxStates}) is reached.`,
    });
    return;
  }
  if (runtime.queue.length >= maxQueueSize) {
    runtime.summary.blocked_actions.push({
      node_id: nodeId,
      action_label: "enqueue_queue_limit",
      reason: `Skipped enqueue because max queue size (${maxQueueSize}) is reached.`,
    });
    return;
  }

  runtime.queue.push({
    node_id: nodeId,
    url,
    depth,
  });
  runtime.enqueued.add(nodeId);
  runtime.summary.queue_history.push({
    node_id: nodeId,
    url,
    depth,
  });
}

function prioritizeCandidatesForScreenState(
  packet: UIStatePacket,
  candidates: ActionCandidate[],
  rowSampleSize: number,
  enablePaginationProbe: boolean,
): {
  ordered_candidates: ActionCandidate[];
  force_capture_action_ids: Set<string>;
} {
  const executable = candidates.filter((candidate) => candidate.executable);
  const selectedIds = new Set<string>();
  const prioritized: ActionCandidate[] = [];
  const forceCaptureIds = new Set<string>();

  const hasListLikeContent = Boolean(packet.ui.tables_or_lists && packet.ui.tables_or_lists.length > 0);
  if (hasListLikeContent) {
    const rowCandidates = selectRowSampleCandidates(executable, rowSampleSize);
    for (const candidate of rowCandidates) {
      if (selectedIds.has(candidate.action_id)) {
        continue;
      }
      selectedIds.add(candidate.action_id);
      prioritized.push(candidate);
      forceCaptureIds.add(candidate.action_id);
    }
  }

  if (enablePaginationProbe) {
    const paginationCandidate = executable.find(
      (candidate) => !selectedIds.has(candidate.action_id) && PAGINATION_LABEL_PATTERN.test(candidate.action_label),
    );
    if (paginationCandidate) {
      selectedIds.add(paginationCandidate.action_id);
      prioritized.push(paginationCandidate);
      forceCaptureIds.add(paginationCandidate.action_id);
    }
  }

  for (const candidate of executable) {
    if (selectedIds.has(candidate.action_id)) {
      continue;
    }
    prioritized.push(candidate);
  }

  const blocked = candidates.filter((candidate) => !candidate.executable);
  return {
    ordered_candidates: [...prioritized, ...blocked],
    force_capture_action_ids: forceCaptureIds,
  };
}

function selectRowSampleCandidates(candidates: ActionCandidate[], sampleSize: number): ActionCandidate[] {
  if (sampleSize <= 0) {
    return [];
  }

  const indexed = candidates
    .map((candidate) => ({
      candidate,
      row_index: parseRowIndexFromLocator(candidate.locator),
      row_hint: hasRowHint(candidate.locator),
    }))
    .filter((item) => item.row_hint || item.row_index !== null)
    .sort((a, b) => {
      const aIndex = a.row_index ?? Number.MAX_SAFE_INTEGER;
      const bIndex = b.row_index ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) {
        return aIndex - bIndex;
      }
      return a.candidate.action_label.localeCompare(b.candidate.action_label);
    });

  const selected: ActionCandidate[] = [];
  const seenRows = new Set<number>();

  for (const item of indexed) {
    if (selected.length >= sampleSize) {
      break;
    }

    if (item.row_index !== null) {
      if (seenRows.has(item.row_index)) {
        continue;
      }
      seenRows.add(item.row_index);
    }

    selected.push(item.candidate);
  }

  return selected;
}

function parseRowIndexFromLocator(locator: string): number | null {
  const match = locator.match(/tr:nth-of-type\((\d+)\)/i);
  if (!match || !match[1]) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasRowHint(locator: string): boolean {
  return /\b(tbody|tr|row)\b/i.test(locator);
}

interface EmptyStateProbeInput {
  page: Page;
  input: SafeBfsExplorerInput;
  runtime: ExplorerRuntime;
  source_capture: {
    packet: UIStatePacket;
    stored_node_id: string;
  };
  source_depth: number;
}

async function runEmptyStateProbeIfEnabled(params: EmptyStateProbeInput): Promise<void> {
  if (!params.input.enable_list_empty_state_probe) {
    return;
  }
  if (params.source_capture.packet.node.state_type !== "screen") {
    return;
  }

  const searchElement = findSearchProbeElement(params.source_capture.packet);
  if (!searchElement) {
    return;
  }

  params.runtime.summary.metrics.actions_considered += 1;
  params.runtime.summary.metrics.list_probes_attempted += 1;

  const locator = await resolveLocator(params.page, searchElement);
  if (!locator) {
    params.runtime.summary.metrics.actions_blocked += 1;
    const reason = "Could not resolve search input locator.";
    params.runtime.summary.blocked_actions.push({
      node_id: params.source_capture.stored_node_id,
      action_label: `Probe empty state via \"${searchElement.name}\"`,
      reason,
    });
    await captureBlockedStateArtifact({
      page: params.page,
      run: params.input.run,
      runtime: params.runtime,
      source_node_id: params.source_capture.stored_node_id,
      action_label: `Probe empty state via \"${searchElement.name}\"`,
      reason,
    });
    return;
  }

  const probeToken = `zzz-cartographer-no-results-${Date.now()}`;

  try {
    await locator.waitFor({ state: "visible", timeout: 3_000 });
    await locator.click({ timeout: 3_000 });
    await locator.fill(probeToken, { timeout: 5_000 });
    await locator.press("Enter", { timeout: 2_000 }).catch(() => undefined);
    await params.page.waitForTimeout(600);

    params.runtime.summary.metrics.actions_executed += 1;

    const targetCapture = await captureAndPersistState({
      page: params.page,
      run: params.input.run,
      role: params.input.role,
      capture_id: nextCaptureId("probe", ++params.runtime.capture_counter),
      state_type: "screen",
      store: params.input.store,
    });
    params.runtime.summary.metrics.packets_written += 1;

    await addEdgeAndRegisterTarget({
      input: params.input,
      runtime: params.runtime,
      from_node_id: params.source_capture.stored_node_id,
      to_capture: targetCapture,
      action_type: "fill_submit",
      action_label: `Probe empty state with query \"${probeToken}\"`,
      element_id: searchElement.element_id,
      risk: "safe",
      source_depth: params.source_depth,
    });
  } catch (error) {
    params.runtime.summary.metrics.actions_blocked += 1;
    const reason = error instanceof Error ? error.message : String(error);
    params.runtime.summary.blocked_actions.push({
      node_id: params.source_capture.stored_node_id,
      action_label: `Probe empty state via \"${searchElement.name}\"`,
      reason,
    });
    await captureBlockedStateArtifact({
      page: params.page,
      run: params.input.run,
      runtime: params.runtime,
      source_node_id: params.source_capture.stored_node_id,
      action_label: `Probe empty state via \"${searchElement.name}\"`,
      reason,
    });
  } finally {
    await restoreSourceState(params.page, params.source_capture.packet);
  }
}

function findSearchProbeElement(
  packet: UIStatePacket,
): UIStatePacket["ui"]["interactive_elements"][number] | undefined {
  return packet.ui.interactive_elements.find((element) => {
    if (!element.visible || element.enabled === false) {
      return false;
    }
    if (!(element.role === "textbox" || element.role === "searchbox" || element.role === "combobox")) {
      return false;
    }
    return SEARCH_LABEL_PATTERN.test(element.name);
  });
}

interface OverlayExplorationInput {
  page: Page;
  input: SafeBfsExplorerInput;
  runtime: ExplorerRuntime;
  source_capture: {
    packet: UIStatePacket;
    stored_node_id: string;
  };
  source_depth: number;
  opener_candidate: ActionCandidate;
  initial_overlay_capture: {
    packet: UIStatePacket;
    stored_node_id: string;
  };
}

async function exploreOverlayFromScreenSource(params: OverlayExplorationInput): Promise<void> {
  if (params.input.max_overlay_depth < 1) {
    return;
  }

  const overlayCandidates = buildActionCandidates(
    params.initial_overlay_capture.packet.ui.interactive_elements,
    params.input.action_policy,
  );
  const executable = overlayCandidates.filter((candidate) => candidate.executable).slice(0, params.input.max_overlay_actions);

  params.runtime.summary.metrics.actions_considered += overlayCandidates.length;
  params.runtime.summary.metrics.actions_blocked += overlayCandidates.length - executable.length;
  params.runtime.summary.metrics.overlays_explored += 1;

  for (const blockedCandidate of overlayCandidates.filter((candidate) => !candidate.executable)) {
    params.runtime.summary.blocked_actions.push({
      node_id: params.initial_overlay_capture.stored_node_id,
      action_label: blockedCandidate.action_label,
      reason: blockedCandidate.skip_reason ?? "Overlay policy blocked",
    });
  }

  for (const overlayCandidate of executable) {
    await restoreSourceState(params.page, params.source_capture.packet);

    const sourceBaseline = await readTransitionSurface(params.page);
    const reopenExecution = await executeActionCandidate(params.page, params.source_capture.packet, params.opener_candidate);
    if (!reopenExecution.executed) {
      params.runtime.summary.metrics.actions_blocked += 1;
      const reason = reopenExecution.reason ?? "Failed to reopen overlay";
      params.runtime.summary.blocked_actions.push({
        node_id: params.source_capture.stored_node_id,
        action_label: `Reopen overlay via ${params.opener_candidate.action_label}`,
        reason,
      });
      await captureBlockedStateArtifact({
        page: params.page,
        run: params.input.run,
        runtime: params.runtime,
        source_node_id: params.source_capture.stored_node_id,
        action_label: `Reopen overlay via ${params.opener_candidate.action_label}`,
        reason,
      });
      continue;
    }

    params.runtime.summary.metrics.actions_executed += 1;

    const reopenTransition = await detectTransition(params.page, sourceBaseline);
    if (!reopenTransition.changed) {
      params.runtime.summary.metrics.actions_no_transition += 1;
      continue;
    }

    const reopenedOverlay = await captureAndPersistState({
      page: params.page,
      run: params.input.run,
      role: params.input.role,
      capture_id: nextCaptureId("overlay", ++params.runtime.capture_counter),
      state_type: reopenTransition.state_type,
      parent_node_id: params.source_capture.stored_node_id,
      store: params.input.store,
    });
    params.runtime.summary.metrics.packets_written += 1;

    await addEdgeAndRegisterTarget({
      input: params.input,
      runtime: params.runtime,
      from_node_id: params.source_capture.stored_node_id,
      to_capture: reopenedOverlay,
      action_type: params.opener_candidate.action_type,
      action_label: params.opener_candidate.action_label,
      element_id: params.opener_candidate.element_id,
      risk: params.opener_candidate.risk,
      source_depth: params.source_depth,
    });

    if (reopenedOverlay.packet.node.state_type === "screen") {
      continue;
    }

    const overlayBaseline = await readTransitionSurface(params.page);
    const overlayExecution = await executeActionCandidate(params.page, reopenedOverlay.packet, overlayCandidate);
    if (!overlayExecution.executed) {
      params.runtime.summary.metrics.actions_blocked += 1;
      const reason = overlayExecution.reason ?? "Failed to execute overlay action";
      params.runtime.summary.blocked_actions.push({
        node_id: reopenedOverlay.stored_node_id,
        action_label: overlayCandidate.action_label,
        reason,
      });
      await captureBlockedStateArtifact({
        page: params.page,
        run: params.input.run,
        runtime: params.runtime,
        source_node_id: reopenedOverlay.stored_node_id,
        action_label: overlayCandidate.action_label,
        reason,
      });
      continue;
    }

    params.runtime.summary.metrics.actions_executed += 1;

    const childTransition = await detectTransition(params.page, overlayBaseline);
    if (!childTransition.changed) {
      params.runtime.summary.metrics.actions_no_transition += 1;
      continue;
    }

    const childCaptureInput: CaptureAndPersistStateInput = {
      page: params.page,
      run: params.input.run,
      role: params.input.role,
      capture_id: nextCaptureId("overlay-child", ++params.runtime.capture_counter),
      state_type: childTransition.state_type,
      store: params.input.store,
    };
    if (childTransition.state_type !== "screen") {
      childCaptureInput.parent_node_id = reopenedOverlay.stored_node_id;
    }

    const childCapture = await captureAndPersistState(childCaptureInput);
    params.runtime.summary.metrics.packets_written += 1;

    await addEdgeAndRegisterTarget({
      input: params.input,
      runtime: params.runtime,
      from_node_id: reopenedOverlay.stored_node_id,
      to_capture: childCapture,
      action_type: overlayCandidate.action_type,
      action_label: overlayCandidate.action_label,
      element_id: overlayCandidate.element_id,
      risk: overlayCandidate.risk,
      source_depth: params.source_depth,
    });

    if (childCapture.packet.node.state_type !== "screen" && params.input.max_overlay_depth > 1) {
      await exploreOverlayInlinePath({
        page: params.page,
        input: params.input,
        runtime: params.runtime,
        overlay_capture: childCapture,
        source_depth: params.source_depth,
        depth: 2,
      });
    }
  }
}

interface InlineOverlayPathInput {
  page: Page;
  input: SafeBfsExplorerInput;
  runtime: ExplorerRuntime;
  overlay_capture: {
    packet: UIStatePacket;
    stored_node_id: string;
  };
  source_depth: number;
  depth: number;
}

async function exploreOverlayInlinePath(params: InlineOverlayPathInput): Promise<void> {
  if (params.depth > params.input.max_overlay_depth) {
    return;
  }

  const candidates = buildActionCandidates(params.overlay_capture.packet.ui.interactive_elements, params.input.action_policy);
  const executable = candidates.filter((candidate) => candidate.executable);

  params.runtime.summary.metrics.actions_considered += candidates.length;
  params.runtime.summary.metrics.actions_blocked += candidates.length - executable.length;
  params.runtime.summary.metrics.overlays_explored += 1;

  for (const blockedCandidate of candidates.filter((candidate) => !candidate.executable)) {
    params.runtime.summary.blocked_actions.push({
      node_id: params.overlay_capture.stored_node_id,
      action_label: blockedCandidate.action_label,
      reason: blockedCandidate.skip_reason ?? "Overlay policy blocked",
    });
  }

  const candidate = executable[0];
  if (!candidate) {
    return;
  }

  const baseline = await readTransitionSurface(params.page);
  const execution = await executeActionCandidate(params.page, params.overlay_capture.packet, candidate);
  if (!execution.executed) {
    params.runtime.summary.metrics.actions_blocked += 1;
    const reason = execution.reason ?? "Failed to execute nested overlay action";
    params.runtime.summary.blocked_actions.push({
      node_id: params.overlay_capture.stored_node_id,
      action_label: candidate.action_label,
      reason,
    });
    await captureBlockedStateArtifact({
      page: params.page,
      run: params.input.run,
      runtime: params.runtime,
      source_node_id: params.overlay_capture.stored_node_id,
      action_label: candidate.action_label,
      reason,
    });
    return;
  }

  params.runtime.summary.metrics.actions_executed += 1;

  const transition = await detectTransition(params.page, baseline);
  if (!transition.changed) {
    params.runtime.summary.metrics.actions_no_transition += 1;
    return;
  }

  const targetCaptureInput: CaptureAndPersistStateInput = {
    page: params.page,
    run: params.input.run,
    role: params.input.role,
    capture_id: nextCaptureId("overlay-rec", ++params.runtime.capture_counter),
    state_type: transition.state_type,
    store: params.input.store,
  };
  if (transition.state_type !== "screen") {
    targetCaptureInput.parent_node_id = params.overlay_capture.stored_node_id;
  }

  const targetCapture = await captureAndPersistState(targetCaptureInput);
  params.runtime.summary.metrics.packets_written += 1;

  await addEdgeAndRegisterTarget({
    input: params.input,
    runtime: params.runtime,
    from_node_id: params.overlay_capture.stored_node_id,
    to_capture: targetCapture,
    action_type: candidate.action_type,
    action_label: candidate.action_label,
    element_id: candidate.element_id,
    risk: candidate.risk,
    source_depth: params.source_depth,
  });

  if (targetCapture.packet.node.state_type !== "screen") {
    await exploreOverlayInlinePath({
      ...params,
      overlay_capture: targetCapture,
      depth: params.depth + 1,
    });
  }
}

async function executeActionCandidate(
  page: Page,
  sourcePacket: UIStatePacket,
  candidate: ActionCandidate,
): Promise<{ executed: boolean; reason?: string }> {
  if (candidate.action_type === "type" || candidate.action_type === "submit") {
    return {
      executed: false,
      reason: `Action type '${candidate.action_type}' is disabled in safe BFS mode.`,
    };
  }

  const element = sourcePacket.ui.interactive_elements.find((item) => item.element_id === candidate.element_id);
  if (!element) {
    return {
      executed: false,
      reason: "Element not found in source packet.",
    };
  }
  if (element.enabled === false) {
    return {
      executed: false,
      reason: "Element is disabled.",
    };
  }

  const locator = await resolveLocator(page, element);
  if (!locator) {
    return {
      executed: false,
      reason: "Could not resolve locator.",
    };
  }

  try {
    await locator.waitFor({ state: "visible", timeout: 3_000 });
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);

    if (candidate.action_type === "hover") {
      await locator.hover({ timeout: 5_000 });
    } else {
      await locator.click({ timeout: 5_000 });
    }

    return { executed: true };
  } catch (error) {
    return {
      executed: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveLocator(
  page: Page,
  element: UIStatePacket["ui"]["interactive_elements"][number],
): Promise<Locator | null> {
  if (isSupportedRole(element.role) && element.name !== "(unnamed control)") {
    const roleLocator = page.getByRole(element.role as never, { name: element.name }).first();
    if (await hasAnyMatch(roleLocator)) {
      return roleLocator;
    }
  }

  const cssPath = parseLocatorCssPath(element.locator);
  if (cssPath) {
    const cssLocator = page.locator(cssPath).first();
    if (await hasAnyMatch(cssLocator)) {
      return cssLocator;
    }
  }

  return null;
}

async function hasAnyMatch(locator: Locator): Promise<boolean> {
  try {
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

function isSupportedRole(role: string): boolean {
  return SUPPORTED_ROLES.has(role);
}

function parseLocatorCssPath(locator: string): string | null {
  const match = locator.match(/^locator\('(.*)'\)$/);
  if (!match || !match[1]) {
    return null;
  }
  return match[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

interface TransitionSurface {
  route_template: string;
  has_dialog: boolean;
  has_menu: boolean;
  has_toast: boolean;
}

async function detectTransition(
  page: Page,
  baseline: TransitionSurface,
): Promise<{ changed: boolean; state_type: UIStatePacket["node"]["state_type"] }> {
  const timeoutMs = 3_500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const snapshot = await readTransitionSnapshot(page, baseline);
    if (snapshot.changed) {
      return snapshot;
    }
    await page.waitForTimeout(200);
  }

  return readTransitionSnapshot(page, baseline);
}

async function readTransitionSnapshot(
  page: Page,
  baseline: TransitionSurface,
): Promise<{ changed: boolean; state_type: UIStatePacket["node"]["state_type"] }> {
  const current = await readTransitionSurface(page);

  if (current.route_template !== baseline.route_template) {
    return { changed: true, state_type: "screen" };
  }
  if (!baseline.has_dialog && current.has_dialog) {
    return { changed: true, state_type: "dialog" };
  }
  if (!baseline.has_menu && current.has_menu) {
    return { changed: true, state_type: "menu" };
  }
  if (!baseline.has_toast && current.has_toast) {
    return { changed: true, state_type: "toast" };
  }

  return { changed: false, state_type: "screen" };
}

async function readTransitionSurface(page: Page): Promise<TransitionSurface> {
  return {
    route_template: normalizeRouteTemplate(page.url()),
    has_dialog: await hasVisibleAny(page, ["[role='dialog']", "[aria-modal='true']", ".modal", ".dialog"]),
    has_menu: await hasVisibleAny(page, ["[role='menu']", "[role='listbox']", ".dropdown-menu"]),
    has_toast: await hasVisibleAny(page, ["[role='status']", "[role='alert']", ".toast", ".snackbar"]),
  };
}

async function hasVisibleAny(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    try {
      if (await page.locator(selector).first().isVisible()) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function restoreSourceState(page: Page, sourcePacket: UIStatePacket): Promise<void> {
  await dismissTransientOverlays(page);

  const sourceRoute = sourcePacket.node.route_template;
  if (normalizeRouteTemplate(page.url()) === sourceRoute) {
    return;
  }

  await page.goBack({ waitUntil: "domcontentloaded", timeout: 8_000 }).catch(() => undefined);
  await dismissTransientOverlays(page);

  if (normalizeRouteTemplate(page.url()) !== sourceRoute) {
    await page.goto(sourcePacket.node.url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  }
}

async function dismissTransientOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hasTransient = await hasVisibleAny(page, ["[role='dialog']", "[role='menu']", "[role='listbox']", ".modal", ".dropdown-menu"]);
    if (!hasTransient) {
      return;
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

async function ensureOnSourceUrl(page: Page, sourceUrl: string): Promise<void> {
  if (page.url() === sourceUrl) {
    return;
  }
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
}

function nextCaptureId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(4, "0")}`;
}

async function saveCheckpoint(runtime: ExplorerRuntime, completed = false): Promise<void> {
  const checkpoint: SafeBfsCheckpoint = {
    checkpoint_version: "1.0",
    saved_at: new Date().toISOString(),
    run_id: runtime.summary.run_id,
    capture_counter: runtime.capture_counter,
    queue: runtime.queue,
    visited_node_ids: Array.from(runtime.visited),
    enqueued_node_ids: Array.from(runtime.enqueued),
    discovered_node_ids: Array.from(runtime.discovered),
    summary: runtime.summary,
  };

  await writeJsonFile(runtime.checkpoint_path, {
    ...checkpoint,
    completed,
  });
}

async function loadCheckpoint(checkpointPath: string, runId: string): Promise<SafeBfsCheckpoint | null> {
  if (!(await fileExists(checkpointPath))) {
    return null;
  }

  const raw = await readJsonFile<SafeBfsCheckpoint & { completed?: boolean }>(checkpointPath);
  if (raw.run_id !== runId) {
    return null;
  }
  if (raw.completed) {
    return null;
  }

  return {
    checkpoint_version: raw.checkpoint_version,
    saved_at: raw.saved_at,
    run_id: raw.run_id,
    capture_counter: raw.capture_counter,
    queue: raw.queue,
    visited_node_ids: raw.visited_node_ids,
    enqueued_node_ids: raw.enqueued_node_ids,
    discovered_node_ids: raw.discovered_node_ids,
    summary: raw.summary,
  };
}

interface BlockedStateArtifactInput {
  page: Page;
  run: RunContext;
  runtime: ExplorerRuntime;
  source_node_id: string;
  action_label: string;
  reason: string;
}

async function captureBlockedStateArtifact(input: BlockedStateArtifactInput): Promise<void> {
  try {
    const artifactIndex = input.runtime.summary.metrics.blocked_state_artifacts + 1;
    const artifactId = String(artifactIndex).padStart(4, "0");
    const screenshotPath = path.join(input.run.logs_dir, `blocked-${artifactId}.png`);
    const metadataPath = path.join(input.run.logs_dir, `blocked-${artifactId}.json`);

    await input.page.screenshot({ path: screenshotPath, fullPage: false });
    await writeJsonFile(metadataPath, {
      artifact_id: artifactId,
      captured_at: new Date().toISOString(),
      source_node_id: input.source_node_id,
      action_label: input.action_label,
      reason: input.reason,
      url: input.page.url(),
      route_template: normalizeRouteTemplate(input.page.url()),
      screenshot_path: screenshotPath,
    });

    input.runtime.summary.metrics.blocked_state_artifacts = artifactIndex;
  } catch {
    return;
  }
}
