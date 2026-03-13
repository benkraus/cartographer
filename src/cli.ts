#!/usr/bin/env node

import path from "node:path";

import { Command } from "commander";

import { generateStubAnalysis } from "./analyzer/stub-analyzer.js";
import { defaultStorageStatePathForRole } from "./auth/paths.js";
import { saveRoleStorageState, type SaveStorageStateInput } from "./auth/save-storage-state.js";
import { loadConfig } from "./config.js";
import { parseUiStatePacket } from "./contracts/state-packet.js";
import { buildActionCandidates } from "./explorer/action-candidates.js";
import { captureSeedState } from "./explorer/capture-seed-state.js";
import { runSafeBfsExplorer } from "./explorer/safe-bfs-explorer.js";
import { initializeRun } from "./run/initialize-run.js";
import { loadRunById } from "./run/load-run.js";
import { loadMatrixPlan } from "./run/matrix-plan.js";
import { FileStateStore } from "./store/file-state-store.js";
import { ensureDir, fileExists, readJsonFile, toRelativePosix, writeJsonFile } from "./utils/fs.js";
import { roleEnvToken } from "./utils/role.js";

const program = new Command();
program.name("cartographer").description("Authenticated web app cartography CLI");
program.showHelpAfterError();

program
  .command("auth-save-state")
  .description("Log in and save Playwright storageState for a role")
  .requiredOption("--role <role>", "Role name for this auth profile")
  .requiredOption("--login-url <url>", "Login URL to open")
  .option("--out <path>", "Output storageState JSON path")
  .option("--manual", "Manual login mode (complete login yourself)")
  .option("--headed", "Run browser in headed mode")
  .option("--timeout-ms <ms>", "Login timeout in milliseconds", parsePositiveInt, 120000)
  .option("--post-login-url <pattern>", "URL pattern/glob that indicates successful login")
  .option("--post-login-selector <selector>", "Visible selector that indicates successful login")
  .option("--username-env <env>", "Environment variable holding username")
  .option("--password-env <env>", "Environment variable holding password")
  .option("--username-selector <selector>", "Username input selector", "input[type='email'], input[name='email'], input[name='username']")
  .option("--password-selector <selector>", "Password input selector", "input[type='password']")
  .option("--submit-selector <selector>", "Submit button selector", "button[type='submit']")
  .option("--submit-enter", "Submit form by pressing Enter in password input")
  .action(
    async (options: {
      role: string;
      loginUrl: string;
      out?: string;
      manual?: boolean;
      headed?: boolean;
      timeoutMs: number;
      postLoginUrl?: string;
      postLoginSelector?: string;
      usernameEnv?: string;
      passwordEnv?: string;
      usernameSelector: string;
      passwordSelector: string;
      submitSelector: string;
      submitEnter?: boolean;
    }) => {
      const config = loadConfig();
      const storageStatePath = options.out
        ? path.resolve(process.cwd(), options.out)
        : defaultStorageStatePathForRole(config.storage_state_dir, options.role);

      await ensureDir(path.dirname(storageStatePath));

      const manualMode = Boolean(options.manual);
      let usernameEnvName: string | undefined;
      let passwordEnvName: string | undefined;

      const input: SaveStorageStateInput = {
        role: options.role,
        login_url: options.loginUrl,
        storage_state_path: storageStatePath,
        headless: !options.headed,
        timeout_ms: options.timeoutMs,
        viewport: config.default_viewport,
        mode: manualMode ? "manual" : "scripted",
      };
      if (options.postLoginUrl) {
        input.post_login_url_pattern = options.postLoginUrl;
      }
      if (options.postLoginSelector) {
        input.post_login_selector = options.postLoginSelector;
      }

      if (!manualMode) {
        const username = resolveCredentialValue(options.role, "USERNAME", options.usernameEnv);
        const password = resolveCredentialValue(options.role, "PASSWORD", options.passwordEnv);
        usernameEnvName = username.env_name;
        passwordEnvName = password.env_name;

        Object.assign(input, {
          scripted: {
            username: username.value,
            password: password.value,
            username_selector: options.usernameSelector,
            password_selector: options.passwordSelector,
            submit_selector: options.submitSelector,
            submit_with_enter: Boolean(options.submitEnter),
          },
        });
      }

      const result = await saveRoleStorageState(input);

      const metadataPath = `${storageStatePath}.meta.json`;
      const metadata = {
        role: options.role,
        mode: result.mode,
        captured_at: result.captured_at,
        login_url: options.loginUrl,
        final_url: result.final_url,
        storage_state_path: toRelativePosix(storageStatePath),
        post_login_url_pattern: options.postLoginUrl,
        post_login_selector: options.postLoginSelector,
        scripted: manualMode
          ? undefined
          : {
              username_env: usernameEnvName,
              password_env: passwordEnvName,
              username_selector: options.usernameSelector,
              password_selector: options.passwordSelector,
              submit_selector: options.submitSelector,
              submit_with_enter: Boolean(options.submitEnter),
            },
      };
      await writeJsonFile(metadataPath, metadata);

      console.log(`Role: ${options.role}`);
      console.log(`Mode: ${result.mode}`);
      console.log(`Storage state: ${toRelativePosix(storageStatePath)}`);
      console.log(`Metadata: ${toRelativePosix(metadataPath)}`);
      console.log(`Final URL: ${result.final_url}`);
    },
  );

program
  .command("init-run")
  .description("Create a new run directory with deterministic run metadata")
  .requiredOption("--role <role>", "Role name for this run")
  .option("--label <label>", "Label for this run", "seed")
  .action(async (options: { role: string; label: string }) => {
    const config = loadConfig();
    const run = await initializeRun({
      output_root: config.output_root,
      role: options.role,
      label: options.label,
    });

    console.log(`Initialized run: ${run.run_id}`);
    console.log(`Run root: ${toRelativePosix(run.run_root)}`);
  });

program
  .command("crawl-seed")
  .description("Capture a seed/root state packet for one role")
  .requiredOption("--role <role>", "Role name for this run")
  .requiredOption("--start-url <url>", "Initial URL to visit")
  .option("--label <label>", "Run label", "seed")
  .option("--storage-state <path>", "Path to Playwright storageState file")
  .option("--headed", "Run the browser in headed mode")
  .option("--allow-mutating", "Allow mutating actions in generated action candidates")
  .option("--allow-dangerous", "Allow dangerous actions in generated action candidates")
  .option("--allow-action <pattern>", "Regex pattern to allow action label (repeatable)", collectString, [])
  .option("--deny-action <pattern>", "Regex pattern to deny action label (repeatable)", collectString, [])
  .action(
    async (options: {
      role: string;
      startUrl: string;
      label: string;
      storageState?: string;
      headed?: boolean;
      allowMutating?: boolean;
      allowDangerous?: boolean;
      allowAction: string[];
      denyAction: string[];
    }) => {
      const config = loadConfig();
      const run = await initializeRun({
        output_root: config.output_root,
        role: options.role,
        label: options.label,
      });

      const resolvedStorageStatePath = await resolveStorageStatePathForRole(
        options.storageState,
        options.role,
        config.storage_state_dir,
      );

      const captureInput = {
        run,
        role: options.role,
        start_url: options.startUrl,
        headless: !options.headed,
        viewport: config.default_viewport,
      };
      if (resolvedStorageStatePath) {
        Object.assign(captureInput, { storage_state_path: resolvedStorageStatePath });
      }

      const packet = await captureSeedState(captureInput);

      const packetPath = path.join(run.packets_dir, `${packet.node.node_id}.packet.json`);
      await writeJsonFile(packetPath, packet);

      const actionPolicy = {
        allow_mutating: Boolean(options.allowMutating),
        allow_dangerous: Boolean(options.allowDangerous),
        allow_label_patterns: options.allowAction,
        deny_label_patterns: options.denyAction,
      };
      const actionCandidates = buildActionCandidates(packet.ui.interactive_elements, actionPolicy);
      const actionsPath = path.join(run.packets_dir, `${packet.node.node_id}.actions.json`);
      await writeJsonFile(actionsPath, {
        node_id: packet.node.node_id,
        generated_at: new Date().toISOString(),
        policy: actionPolicy,
        counts: {
          total: actionCandidates.length,
          executable: actionCandidates.filter((candidate) => candidate.executable).length,
          blocked: actionCandidates.filter((candidate) => !candidate.executable).length,
        },
        candidates: actionCandidates,
      });

      const store = await FileStateStore.open(config.state_store_path);
      const upsertResult = await store.upsertNodeFromPacket(packet, packetPath);

      console.log(`Run: ${run.run_id}`);
      console.log(`Node: ${upsertResult.node.node_id} (${upsertResult.is_new ? "new" : "existing"})`);
      console.log(`Packet: ${toRelativePosix(packetPath)}`);
      console.log(`Actions: ${toRelativePosix(actionsPath)}`);
      console.log(`Action candidates: ${actionCandidates.length}`);
      console.log(`Executable actions: ${actionCandidates.filter((candidate) => candidate.executable).length}`);
      if (resolvedStorageStatePath) {
        console.log(`Storage state: ${toRelativePosix(resolvedStorageStatePath)}`);
      }
      console.log(`Store: ${toRelativePosix(config.state_store_path)}`);
    },
  );

program
  .command("crawl-safe")
  .description("Run safe BFS exploration with edge recording")
  .requiredOption("--role <role>", "Role name for this run")
  .requiredOption("--start-url <url>", "Initial URL to visit")
  .option("--label <label>", "Run label", "safe-bfs")
  .option("--resume-run <runId>", "Resume an existing run id (uses checkpoint when available)")
  .option("--storage-state <path>", "Path to Playwright storageState file")
  .option("--headed", "Run the browser in headed mode")
  .option("--max-states <n>", "Maximum nodes to explore", parsePositiveInt, 30)
  .option("--max-actions-per-state <n>", "Maximum executable actions per state", parsePositiveInt, 20)
  .option("--max-overlay-actions <n>", "Maximum executable actions per overlay", parsePositiveInt, 8)
  .option("--overlay-depth <n>", "Maximum overlay recursion depth", parsePositiveInt, 2)
  .option("--max-depth <n>", "Maximum BFS depth", parsePositiveInt, 6)
  .option("--max-queue-size <n>", "Maximum queued screen states", parsePositiveInt, 200)
  .option("--max-runtime-minutes <n>", "Maximum runtime in minutes", parsePositiveNumber, 30)
  .option("--row-sample-size <n>", "Rows to sample per detected list/table", parsePositiveInt, 3)
  .option("--disable-empty-state-probe", "Disable no-results search probe")
  .option("--disable-pagination-probe", "Disable pagination probe prioritization")
  .option("--allow-mutating", "Allow mutating actions")
  .option("--allow-dangerous", "Allow dangerous actions")
  .option("--allow-action <pattern>", "Regex pattern to allow action label (repeatable)", collectString, [])
  .option("--deny-action <pattern>", "Regex pattern to deny action label (repeatable)", collectString, [])
  .action(
    async (options: {
      role: string;
      startUrl: string;
      label: string;
      resumeRun?: string;
      storageState?: string;
      headed?: boolean;
      maxStates: number;
      maxActionsPerState: number;
      maxOverlayActions: number;
      overlayDepth: number;
      maxDepth: number;
      maxQueueSize: number;
      maxRuntimeMinutes: number;
      rowSampleSize: number;
      disableEmptyStateProbe?: boolean;
      disablePaginationProbe?: boolean;
      allowMutating?: boolean;
      allowDangerous?: boolean;
      allowAction: string[];
      denyAction: string[];
    }) => {
      const config = loadConfig();
      const run = options.resumeRun
        ? await loadRunById(config.output_root, options.resumeRun)
        : await initializeRun({
            output_root: config.output_root,
            role: options.role,
            label: options.label,
          });

      if (options.resumeRun && run.role !== options.role) {
        throw new Error(
          `Resume run role mismatch: run ${options.resumeRun} is '${run.role}' but '--role' is '${options.role}'.`,
        );
      }

      const resolvedStorageStatePath = await resolveStorageStatePathForRole(
        options.storageState,
        run.role,
        config.storage_state_dir,
      );

      const store = await FileStateStore.open(config.state_store_path);
      const actionPolicy = {
        allow_mutating: Boolean(options.allowMutating),
        allow_dangerous: Boolean(options.allowDangerous),
        allow_label_patterns: options.allowAction,
        deny_label_patterns: options.denyAction,
      };

      const explorerInput = {
        run,
        role: run.role,
        start_url: options.startUrl,
        headless: !options.headed,
        viewport: config.default_viewport,
        max_states: options.maxStates,
        max_actions_per_state: options.maxActionsPerState,
        max_overlay_actions: options.maxOverlayActions,
        max_overlay_depth: options.overlayDepth,
        max_depth: options.maxDepth,
        max_queue_size: options.maxQueueSize,
        max_runtime_ms: Math.floor(options.maxRuntimeMinutes * 60_000),
        list_row_sample_size: options.rowSampleSize,
        enable_list_empty_state_probe: !options.disableEmptyStateProbe,
        enable_list_pagination_probe: !options.disablePaginationProbe,
        resume_from_checkpoint: Boolean(options.resumeRun),
        action_policy: actionPolicy,
        store,
      };
      if (resolvedStorageStatePath) {
        Object.assign(explorerInput, {
          storage_state_path: resolvedStorageStatePath,
        });
      }

      const result = await runSafeBfsExplorer(explorerInput);

      console.log(`Run: ${result.run_id}`);
      console.log(`Root node: ${result.root_node_id}`);
      console.log(`Explored nodes: ${result.explored_nodes}`);
      console.log(`Discovered nodes: ${result.discovered_nodes}`);
      console.log(`Actions considered: ${result.actions_considered}`);
      console.log(`Actions executed: ${result.actions_executed}`);
      console.log(`Actions blocked: ${result.actions_blocked}`);
      console.log(`No-transition actions: ${result.actions_no_transition}`);
      console.log(`Edges inserted: ${result.edges_inserted}`);
      console.log(`Packets written: ${result.packets_written}`);
      console.log(`Overlays explored: ${result.overlays_explored}`);
      console.log(`List probes attempted: ${result.list_probes_attempted}`);
      console.log(`Blocked-state artifacts: ${result.blocked_state_artifacts}`);
      console.log(`Resumed from checkpoint: ${result.resumed_from_checkpoint}`);
      if (resolvedStorageStatePath) {
        console.log(`Storage state: ${toRelativePosix(resolvedStorageStatePath)}`);
      }
      console.log(`Checkpoint: ${toRelativePosix(result.checkpoint_path)}`);
      console.log(`Summary: ${toRelativePosix(result.summary_path)}`);
      console.log(`Store: ${toRelativePosix(config.state_store_path)}`);
    },
  );

program
  .command("crawl-matrix")
  .description("Run safe crawler across a role/config matrix plan")
  .requiredOption("--file <path>", "Path to matrix plan JSON")
  .option("--headed", "Force headed mode for every matrix entry")
  .option("--continue-on-error", "Continue after entry failures")
  .option("--limit <n>", "Maximum matrix entries to execute", parsePositiveInt)
  .action(
    async (options: {
      file: string;
      headed?: boolean;
      continueOnError?: boolean;
      limit?: number;
    }) => {
      const config = loadConfig();
      const matrix = await loadMatrixPlan(options.file);
      const store = await FileStateStore.open(config.state_store_path);

      const runEntries = typeof options.limit === "number" ? matrix.plan.entries.slice(0, options.limit) : matrix.plan.entries;
      const reportEntries: Array<{
        index: number;
        role: string;
        start_url: string;
        run_id?: string;
        status: "success" | "failed";
        error?: string;
        summary_path?: string;
      }> = [];

      for (let index = 0; index < runEntries.length; index += 1) {
        const entry = runEntries[index];
        if (!entry) {
          continue;
        }

        try {
          const run = await initializeRun({
            output_root: config.output_root,
            role: entry.role,
            label: buildMatrixRunLabel(matrix.plan.default_label ?? "safe-bfs", entry.label, entry.config_label, index),
          });

          const explicitStorageState = entry.storage_state_path
            ? resolveMatrixRelativePath(entry.storage_state_path, matrix.directory)
            : undefined;
          const resolvedStorageStatePath = await resolveStorageStatePathForRole(
            explicitStorageState,
            entry.role,
            config.storage_state_dir,
          );

          const mergedLimits = mergeMatrixLimits(matrix.plan.defaults?.limits, entry.limits);
          const mergedPolicy = mergeMatrixPolicy(matrix.plan.defaults?.policy, entry.policy);
          const mergedProbes = mergeMatrixProbes(matrix.plan.defaults?.probes, entry.probes);

          const explorerInput = {
            run,
            role: entry.role,
            start_url: entry.start_url,
            headless: !(options.headed ?? matrix.plan.defaults?.headed ?? false),
            viewport: config.default_viewport,
            max_states: mergedLimits.max_states,
            max_actions_per_state: mergedLimits.max_actions_per_state,
            max_overlay_actions: mergedLimits.max_overlay_actions,
            max_overlay_depth: mergedLimits.max_overlay_depth,
            max_depth: mergedLimits.max_depth,
            max_queue_size: mergedLimits.max_queue_size,
            max_runtime_ms: Math.floor(mergedLimits.max_runtime_minutes * 60_000),
            list_row_sample_size: mergedLimits.list_row_sample_size,
            enable_list_empty_state_probe: mergedProbes.enable_list_empty_state_probe,
            enable_list_pagination_probe: mergedProbes.enable_list_pagination_probe,
            resume_from_checkpoint: Boolean(matrix.plan.defaults?.resume_from_checkpoint),
            action_policy: mergedPolicy,
            store,
          };
          if (resolvedStorageStatePath) {
            Object.assign(explorerInput, {
              storage_state_path: resolvedStorageStatePath,
            });
          }

          const result = await runSafeBfsExplorer(explorerInput);
          reportEntries.push({
            index,
            role: entry.role,
            start_url: entry.start_url,
            run_id: result.run_id,
            status: "success",
            summary_path: toRelativePosix(result.summary_path),
          });

          console.log(
            `[${index + 1}/${runEntries.length}] ${entry.role} ${entry.config_label ? `(${entry.config_label})` : ""} -> ${result.run_id}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reportEntries.push({
            index,
            role: entry.role,
            start_url: entry.start_url,
            status: "failed",
            error: message,
          });

          console.error(`[${index + 1}/${runEntries.length}] ${entry.role} failed: ${message}`);
          if (!options.continueOnError) {
            throw error;
          }
        }
      }

      const reportDir = path.join(config.output_root, "matrix");
      await ensureDir(reportDir);
      const reportPath = path.join(reportDir, `matrix-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      await writeJsonFile(reportPath, {
        generated_at: new Date().toISOString(),
        matrix_file: toRelativePosix(matrix.absolute_path),
        total_entries: runEntries.length,
        successful_entries: reportEntries.filter((entry) => entry.status === "success").length,
        failed_entries: reportEntries.filter((entry) => entry.status === "failed").length,
        entries: reportEntries,
      });

      console.log(`Matrix entries: ${runEntries.length}`);
      console.log(`Successes: ${reportEntries.filter((entry) => entry.status === "success").length}`);
      console.log(`Failures: ${reportEntries.filter((entry) => entry.status === "failed").length}`);
      console.log(`Report: ${toRelativePosix(reportPath)}`);
    },
  );

program
  .command("store-status")
  .description("Print state store counts")
  .action(async () => {
    const config = loadConfig();
    const store = await FileStateStore.open(config.state_store_path);
    const summary = store.getSummary();

    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("analyze-stub")
  .description("Generate a schema-valid stub analysis from a state packet")
  .requiredOption("--packet <path>", "Path to state packet JSON")
  .option("--out <path>", "Output path for analysis JSON")
  .action(async (options: { packet: string; out?: string }) => {
    const packetPath = path.resolve(process.cwd(), options.packet);
    const packet = parseUiStatePacket(await readJsonFile(packetPath));
    const analysis = generateStubAnalysis(packet);

    const outputPath = options.out
      ? path.resolve(process.cwd(), options.out)
      : path.join(path.dirname(packetPath), `${packet.node.node_id}.analysis.stub.json`);

    await writeJsonFile(outputPath, analysis);

    console.log(`Packet: ${toRelativePosix(packetPath)}`);
    console.log(`Analysis: ${toRelativePosix(outputPath)}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

function collectString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function parsePositiveNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number, received: ${value}`);
  }
  return parsed;
}

function buildMatrixRunLabel(baseLabel: string, label: string | undefined, configLabel: string | undefined, index: number): string {
  if (label && label.trim().length > 0) {
    return label;
  }

  if (configLabel && configLabel.trim().length > 0) {
    return `${baseLabel}-${slugifyLabel(configLabel)}`;
  }

  return `${baseLabel}-entry-${String(index + 1).padStart(2, "0")}`;
}

function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function resolveMatrixRelativePath(filePath: string, matrixDir: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(matrixDir, filePath);
}

type MatrixLimitsInput = {
  max_states?: number | undefined;
  max_actions_per_state?: number | undefined;
  max_overlay_actions?: number | undefined;
  max_overlay_depth?: number | undefined;
  max_depth?: number | undefined;
  max_queue_size?: number | undefined;
  max_runtime_minutes?: number | undefined;
  list_row_sample_size?: number | undefined;
};

type MatrixPolicyInput = {
  allow_mutating?: boolean | undefined;
  allow_dangerous?: boolean | undefined;
  allow_label_patterns?: string[] | undefined;
  deny_label_patterns?: string[] | undefined;
};

type MatrixProbesInput = {
  enable_list_empty_state_probe?: boolean | undefined;
  enable_list_pagination_probe?: boolean | undefined;
};

function mergeMatrixLimits(
  defaults: MatrixLimitsInput | undefined,
  override: MatrixLimitsInput | undefined,
): {
  max_states: number;
  max_actions_per_state: number;
  max_overlay_actions: number;
  max_overlay_depth: number;
  max_depth: number;
  max_queue_size: number;
  max_runtime_minutes: number;
  list_row_sample_size: number;
} {
  return {
    max_states: override?.max_states ?? defaults?.max_states ?? 30,
    max_actions_per_state: override?.max_actions_per_state ?? defaults?.max_actions_per_state ?? 20,
    max_overlay_actions: override?.max_overlay_actions ?? defaults?.max_overlay_actions ?? 8,
    max_overlay_depth: override?.max_overlay_depth ?? defaults?.max_overlay_depth ?? 2,
    max_depth: override?.max_depth ?? defaults?.max_depth ?? 6,
    max_queue_size: override?.max_queue_size ?? defaults?.max_queue_size ?? 200,
    max_runtime_minutes: override?.max_runtime_minutes ?? defaults?.max_runtime_minutes ?? 30,
    list_row_sample_size: override?.list_row_sample_size ?? defaults?.list_row_sample_size ?? 3,
  };
}

function mergeMatrixPolicy(
  defaults: MatrixPolicyInput | undefined,
  override: MatrixPolicyInput | undefined,
): {
  allow_mutating: boolean;
  allow_dangerous: boolean;
  allow_label_patterns: string[];
  deny_label_patterns: string[];
} {
  return {
    allow_mutating: override?.allow_mutating ?? defaults?.allow_mutating ?? false,
    allow_dangerous: override?.allow_dangerous ?? defaults?.allow_dangerous ?? false,
    allow_label_patterns: override?.allow_label_patterns ?? defaults?.allow_label_patterns ?? [],
    deny_label_patterns: override?.deny_label_patterns ?? defaults?.deny_label_patterns ?? [],
  };
}

function mergeMatrixProbes(
  defaults: MatrixProbesInput | undefined,
  override: MatrixProbesInput | undefined,
): {
  enable_list_empty_state_probe: boolean;
  enable_list_pagination_probe: boolean;
} {
  return {
    enable_list_empty_state_probe:
      override?.enable_list_empty_state_probe ?? defaults?.enable_list_empty_state_probe ?? true,
    enable_list_pagination_probe:
      override?.enable_list_pagination_probe ?? defaults?.enable_list_pagination_probe ?? true,
  };
}

async function resolveStorageStatePathForRole(
  explicitStorageStateOption: string | undefined,
  role: string,
  storageStateDir: string,
): Promise<string | undefined> {
  if (explicitStorageStateOption) {
    const explicitStorageStatePath = path.resolve(process.cwd(), explicitStorageStateOption);
    if (!(await fileExists(explicitStorageStatePath))) {
      throw new Error(`Storage state file not found: ${explicitStorageStatePath}`);
    }
    return explicitStorageStatePath;
  }

  const defaultStorageStatePath = defaultStorageStatePathForRole(storageStateDir, role);
  if (await fileExists(defaultStorageStatePath)) {
    return defaultStorageStatePath;
  }

  return undefined;
}

function resolveCredentialValue(
  role: string,
  suffix: "USERNAME" | "PASSWORD",
  explicitEnvName?: string,
): { value: string; env_name: string } {
  const roleToken = roleEnvToken(role);
  const candidates = explicitEnvName
    ? [explicitEnvName]
    : [
        `CARTOGRAPHER_${roleToken}_${suffix}`,
        `CARTOGRAPHER_${suffix}`,
      ];

  for (const envName of candidates) {
    const envValue = process.env[envName];
    if (envValue && envValue.length > 0) {
      return {
        value: envValue,
        env_name: envName,
      };
    }
  }

  throw new Error(
    `Missing ${suffix.toLowerCase()} credential for role '${role}'. Set one of: ${candidates.join(", ")}, or pass --${suffix.toLowerCase()}-env.`,
  );
}
