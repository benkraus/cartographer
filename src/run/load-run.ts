import path from "node:path";

import type { RunContext } from "./initialize-run.js";
import { fileExists, readJsonFile } from "../utils/fs.js";

interface RunMetadata {
  run_id: string;
  role: string;
  label: string;
  started_at: string;
}

export async function loadRunById(outputRoot: string, runId: string): Promise<RunContext> {
  const runRoot = path.join(outputRoot, "runs", runId);
  const metadataPath = path.join(runRoot, "run.json");

  if (!(await fileExists(metadataPath))) {
    throw new Error(`Run metadata not found: ${metadataPath}`);
  }

  const metadata = await readJsonFile<RunMetadata>(metadataPath);
  if (metadata.run_id !== runId) {
    throw new Error(`Run metadata mismatch: expected ${runId}, received ${metadata.run_id}`);
  }

  return {
    run_id: metadata.run_id,
    role: metadata.role,
    label: metadata.label,
    started_at: metadata.started_at,
    run_root: runRoot,
    artifacts_dir: path.join(runRoot, "artifacts"),
    packets_dir: path.join(runRoot, "packets"),
    logs_dir: path.join(runRoot, "logs"),
  };
}
