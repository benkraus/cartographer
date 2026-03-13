import path from "node:path";

import type { UIStatePacket } from "../contracts/state-packet.js";
import { ensureDir, fileExists, readJsonFile, toRelativePosix, writeJsonFile } from "../utils/fs.js";
import { hashString, hexHammingDistance, shortHash } from "../utils/hash.js";

const PHASH_HAMMING_THRESHOLD = 10;

export interface StoredNode {
  node_id: string;
  state_type: UIStatePacket["node"]["state_type"];
  route_template: string;
  title_candidates: string[];
  url_samples: string[];
  fingerprint: UIStatePacket["node"]["fingerprint"];
  role_observed: string[];
  captured_runs: string[];
  packet_paths: string[];
  first_seen_at: string;
  last_seen_at: string;
}

export interface StoredEdge {
  from_node_id: string;
  to_node_id: string;
  action_type: string;
  action_label: string;
  first_seen_at: string;
  element_id?: string;
  risk?: "safe" | "mutating" | "dangerous" | "unknown";
}

interface PersistedStore {
  schema_version: "1.1";
  nodes: Record<string, StoredNode>;
  edges: StoredEdge[];
  route_a11y_index: Record<string, string>;
  route_phash_index: Record<string, string>;
  route_nodes_index: Record<string, string[]>;
  edge_index: Record<string, true>;
}

interface LegacyPersistedStore {
  schema_version?: string;
  nodes?: Record<string, StoredNode>;
  edges?: StoredEdge[];
  route_a11y_index?: Record<string, string>;
  route_phash_index?: Record<string, string>;
  route_nodes_index?: Record<string, string[]>;
  edge_index?: Record<string, true>;
}

interface UpsertNodeResult {
  node: StoredNode;
  is_new: boolean;
}

export class FileStateStore {
  private constructor(
    private readonly storePath: string,
    private readonly data: PersistedStore,
  ) {}

  static async open(storePath: string): Promise<FileStateStore> {
    await ensureDir(path.dirname(storePath));

    if (!(await fileExists(storePath))) {
      const initialStore = createEmptyStore();
      await writeJsonFile(storePath, initialStore);
      return new FileStateStore(storePath, initialStore);
    }

    const existingStore = await readJsonFile<LegacyPersistedStore>(storePath);
    const migratedStore = migrateStore(existingStore);
    return new FileStateStore(storePath, migratedStore);
  }

  async upsertNodeFromPacket(packet: UIStatePacket, packetPath: string): Promise<UpsertNodeResult> {
    const routeA11yKey = `${packet.node.route_template}|${packet.node.fingerprint.a11y_hash}`;
    const routePhashKey = `${packet.node.route_template}|${shortHash(packet.node.fingerprint.phash_full, 20)}`;
    const routeNodes = this.data.route_nodes_index[packet.node.route_template] ?? [];

    const phashNearMatchId = findClosestPhashNodeId(routeNodes, packet, this.data.nodes);
    const existingNodeId =
      this.data.route_a11y_index[routeA11yKey] ?? this.data.route_phash_index[routePhashKey] ?? phashNearMatchId;
    const packetPathRelative = toRelativePosix(packetPath);

    if (existingNodeId && this.data.nodes[existingNodeId]) {
      const existingNode = this.data.nodes[existingNodeId];
      existingNode.last_seen_at = packet.capture.captured_at;
      existingNode.title_candidates = mergeUnique(existingNode.title_candidates, packet.node.title_candidates ?? []);
      existingNode.url_samples = mergeUnique(existingNode.url_samples, [packet.node.url]);
      existingNode.role_observed = mergeUnique(existingNode.role_observed, [packet.capture.role]);
      existingNode.captured_runs = mergeUnique(existingNode.captured_runs, [packet.capture.run_id]);
      existingNode.packet_paths = mergeUnique(existingNode.packet_paths, [packetPathRelative]);
      existingNode.fingerprint = packet.node.fingerprint;

      this.data.route_a11y_index[routeA11yKey] = existingNodeId;
      this.data.route_phash_index[routePhashKey] = existingNodeId;
      this.data.route_nodes_index[packet.node.route_template] = mergeUnique(routeNodes, [existingNodeId]);

      await this.save();
      return { node: existingNode, is_new: false };
    }

    const now = packet.capture.captured_at;
    const nodeId = packet.node.node_id;
    const newNode: StoredNode = {
      node_id: nodeId,
      state_type: packet.node.state_type,
      route_template: packet.node.route_template,
      title_candidates: packet.node.title_candidates ?? [],
      url_samples: [packet.node.url],
      fingerprint: packet.node.fingerprint,
      role_observed: [packet.capture.role],
      captured_runs: [packet.capture.run_id],
      packet_paths: [packetPathRelative],
      first_seen_at: now,
      last_seen_at: now,
    };

    this.data.nodes[nodeId] = newNode;
    this.data.route_a11y_index[routeA11yKey] = nodeId;
    this.data.route_phash_index[routePhashKey] = nodeId;
    this.data.route_nodes_index[packet.node.route_template] = mergeUnique(routeNodes, [nodeId]);

    await this.save();
    return { node: newNode, is_new: true };
  }

  async addEdge(edge: Omit<StoredEdge, "first_seen_at">): Promise<{ inserted: boolean }> {
    const edgeKey = hashString(
      [edge.from_node_id, edge.to_node_id, edge.action_type, edge.action_label, edge.element_id ?? ""].join("|"),
    );

    if (this.data.edge_index[edgeKey]) {
      return { inserted: false };
    }

    const storedEdge: StoredEdge = {
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      action_type: edge.action_type,
      action_label: edge.action_label,
      first_seen_at: new Date().toISOString(),
    };
    if (edge.element_id) {
      storedEdge.element_id = edge.element_id;
    }
    if (edge.risk) {
      storedEdge.risk = edge.risk;
    }

    this.data.edges.push(storedEdge);
    this.data.edge_index[edgeKey] = true;

    await this.save();
    return { inserted: true };
  }

  getSummary(): {
    node_count: number;
    edge_count: number;
    state_type_breakdown: Record<string, number>;
  } {
    const stateTypeBreakdown: Record<string, number> = {};

    for (const node of Object.values(this.data.nodes)) {
      stateTypeBreakdown[node.state_type] = (stateTypeBreakdown[node.state_type] ?? 0) + 1;
    }

    return {
      node_count: Object.keys(this.data.nodes).length,
      edge_count: this.data.edges.length,
      state_type_breakdown: stateTypeBreakdown,
    };
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.storePath, this.data);
  }
}

function createEmptyStore(): PersistedStore {
  return {
    schema_version: "1.1",
    nodes: {},
    edges: [],
    route_a11y_index: {},
    route_phash_index: {},
    route_nodes_index: {},
    edge_index: {},
  };
}

function migrateStore(raw: LegacyPersistedStore): PersistedStore {
  const store: PersistedStore = {
    schema_version: "1.1",
    nodes: raw.nodes ?? {},
    edges: raw.edges ?? [],
    route_a11y_index: raw.route_a11y_index ?? {},
    route_phash_index: raw.route_phash_index ?? {},
    route_nodes_index: raw.route_nodes_index ?? {},
    edge_index: raw.edge_index ?? {},
  };

  for (const [nodeId, node] of Object.entries(store.nodes)) {
    const route = node.route_template;
    store.route_nodes_index[route] = mergeUnique(store.route_nodes_index[route] ?? [], [nodeId]);

    const a11yKey = `${route}|${node.fingerprint.a11y_hash}`;
    const phashKey = `${route}|${shortHash(node.fingerprint.phash_full, 20)}`;
    if (!store.route_a11y_index[a11yKey]) {
      store.route_a11y_index[a11yKey] = nodeId;
    }
    if (!store.route_phash_index[phashKey]) {
      store.route_phash_index[phashKey] = nodeId;
    }
  }

  return store;
}

function findClosestPhashNodeId(
  candidateNodeIds: string[],
  packet: UIStatePacket,
  nodes: Record<string, StoredNode>,
): string | undefined {
  let bestNodeId: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidateNodeId of candidateNodeIds) {
    const candidateNode = nodes[candidateNodeId];
    if (!candidateNode) {
      continue;
    }
    if (candidateNode.state_type !== packet.node.state_type) {
      continue;
    }

    const distance = hexHammingDistance(candidateNode.fingerprint.phash_full, packet.node.fingerprint.phash_full);
    if (distance <= PHASH_HAMMING_THRESHOLD && distance < bestDistance) {
      bestDistance = distance;
      bestNodeId = candidateNodeId;
    }
  }

  return bestNodeId;
}

function mergeUnique(current: string[], incoming: string[]): string[] {
  return Array.from(new Set([...current, ...incoming]));
}
