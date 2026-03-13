import path from "node:path";

import { z } from "zod";

import { readJsonFile } from "../utils/fs.js";

const actionPolicyOverrideSchema = z
  .object({
    allow_mutating: z.boolean().optional(),
    allow_dangerous: z.boolean().optional(),
    allow_label_patterns: z.array(z.string()).optional(),
    deny_label_patterns: z.array(z.string()).optional(),
  })
  .partial();

const limitsOverrideSchema = z
  .object({
    max_states: z.number().int().positive().optional(),
    max_actions_per_state: z.number().int().positive().optional(),
    max_overlay_actions: z.number().int().positive().optional(),
    max_overlay_depth: z.number().int().positive().optional(),
    max_depth: z.number().int().positive().optional(),
    max_queue_size: z.number().int().positive().optional(),
    max_runtime_minutes: z.number().positive().optional(),
    list_row_sample_size: z.number().int().positive().optional(),
  })
  .partial();

const probesOverrideSchema = z
  .object({
    enable_list_empty_state_probe: z.boolean().optional(),
    enable_list_pagination_probe: z.boolean().optional(),
  })
  .partial();

const matrixEntrySchema = z.object({
  role: z.string().min(1),
  start_url: z.string().min(1),
  label: z.string().optional(),
  config_label: z.string().optional(),
  storage_state_path: z.string().optional(),
  limits: limitsOverrideSchema.optional(),
  policy: actionPolicyOverrideSchema.optional(),
  probes: probesOverrideSchema.optional(),
});

const matrixPlanSchema = z.object({
  matrix_version: z.literal("1.0").optional(),
  default_label: z.string().optional(),
  defaults: z
    .object({
      limits: limitsOverrideSchema.optional(),
      policy: actionPolicyOverrideSchema.optional(),
      probes: probesOverrideSchema.optional(),
      headed: z.boolean().optional(),
      resume_from_checkpoint: z.boolean().optional(),
    })
    .optional(),
  entries: z.array(matrixEntrySchema).min(1),
});

export type MatrixPlan = z.infer<typeof matrixPlanSchema>;

export async function loadMatrixPlan(filePath: string): Promise<{ plan: MatrixPlan; absolute_path: string; directory: string }> {
  const absolutePath = path.resolve(process.cwd(), filePath);
  const raw = await readJsonFile(absolutePath);
  const plan = matrixPlanSchema.parse(raw);

  return {
    plan,
    absolute_path: absolutePath,
    directory: path.dirname(absolutePath),
  };
}
