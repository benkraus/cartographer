import path from "node:path";

import { ensureDir, writeJsonFile } from "../utils/fs.js";
import { roleSlug } from "../utils/role.js";

export interface InitializeRunInput {
  output_root: string;
  role: string;
  label: string;
  now?: Date;
}

export interface RunContext {
  run_id: string;
  role: string;
  label: string;
  started_at: string;
  run_root: string;
  artifacts_dir: string;
  packets_dir: string;
  logs_dir: string;
}

interface RunMetadata {
  run_id: string;
  role: string;
  label: string;
  started_at: string;
}

export async function initializeRun(input: InitializeRunInput): Promise<RunContext> {
  const now = input.now ?? new Date();
  const runId = createRunId(input.role, input.label, now);

  const runRoot = path.join(input.output_root, "runs", runId);
  const artifactsDir = path.join(runRoot, "artifacts");
  const packetsDir = path.join(runRoot, "packets");
  const logsDir = path.join(runRoot, "logs");

  await Promise.all([ensureDir(artifactsDir), ensureDir(packetsDir), ensureDir(logsDir)]);

  const metadata: RunMetadata = {
    run_id: runId,
    role: input.role,
    label: input.label,
    started_at: now.toISOString(),
  };

  await writeJsonFile(path.join(runRoot, "run.json"), metadata);

  return {
    run_id: runId,
    role: input.role,
    label: input.label,
    started_at: metadata.started_at,
    run_root: runRoot,
    artifacts_dir: artifactsDir,
    packets_dir: packetsDir,
    logs_dir: logsDir,
  };
}

export function createRunId(role: string, label: string, now = new Date()): string {
  return `${formatUtcStamp(now)}-${roleSlug(role)}-${slugify(label)}`;
}

function formatUtcStamp(value: Date): string {
  const year = value.getUTCFullYear();
  const month = `${value.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${value.getUTCDate()}`.padStart(2, "0");
  const hour = `${value.getUTCHours()}`.padStart(2, "0");
  const minute = `${value.getUTCMinutes()}`.padStart(2, "0");
  const second = `${value.getUTCSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}T${hour}${minute}${second}Z`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
