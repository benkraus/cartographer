import { z } from "zod";

const stateTypeSchema = z.enum(["screen", "modal", "dialog", "menu", "drawer", "toast", "popover"]);
const riskSchema = z.enum(["safe", "mutating", "dangerous", "unknown"]);

const evidenceSchema = z.object({
  artifact_ids: z.array(z.string()),
  element_ids: z.array(z.string()),
  exact_text: z.array(z.string()),
  notes: z.string().optional(),
});

const featureSchema = z.object({
  feature_id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum([
    "navigation",
    "view_data",
    "search_filter",
    "create",
    "edit",
    "delete",
    "export",
    "settings",
    "workflow",
    "security_permissions",
    "integration",
    "other",
  ]),
  capability: z.enum(["read", "write", "update", "remove", "execute", "configure", "unknown"]),
  risk: riskSchema,
  confidence: z.enum(["high", "medium", "low"]),
  observed_vs_inferred: z.enum(["observed", "inferred"]),
  evidence: evidenceSchema,
  replication_requirements: z.array(z.string()),
});

const outgoingActionSchema = z.object({
  label: z.string(),
  action_type: z.enum(["click", "hover", "select", "type", "submit", "open_menu", "close"]),
  risk: riskSchema,
  target_hint: z.string().optional(),
  evidence: evidenceSchema,
});

const checklistItemSchema = z.object({
  item_id: z.string(),
  text: z.string(),
  priority: z.enum(["must", "should", "could"]),
  observed_vs_inferred: z.enum(["observed", "inferred"]),
  evidence: evidenceSchema,
});

const formDocSchema = z.object({
  form_name: z.string(),
  fields: z.array(
    z.object({
      label: z.string(),
      input_type: z.string(),
      required: z.boolean(),
      options_sample: z.array(z.string()).optional(),
      validation_observed: z.array(z.string()).optional(),
    }),
  ),
});

const explorationHintSchema = z.object({
  hint: z.string(),
  why: z.string(),
  suggested_element_ids: z.array(z.string()).optional(),
});

export const uiStateAnalysisSchema = z.object({
  schema_version: z.literal("1.0"),
  node_id: z.string(),
  screen: z.object({
    proposed_title: z.string(),
    state_type: stateTypeSchema,
    module_candidates: z.array(z.string()),
    purpose: z.string(),
    who_uses_this: z.array(z.string()).optional(),
    key_entities: z.array(z.string()).optional(),
  }),
  features: z.array(featureSchema).min(1),
  navigation: z
    .object({
      outgoing_actions: z.array(outgoingActionSchema),
    })
    .optional(),
  forms: z.array(formDocSchema).optional(),
  ui_states_observed: z
    .object({
      empty_state: z.boolean().optional(),
      error_state: z.boolean().optional(),
      loading_state: z.boolean().optional(),
      success_state: z.boolean().optional(),
      notes: z.string().optional(),
    })
    .optional(),
  replication_checklist: z.array(checklistItemSchema).min(1),
  open_questions: z.array(z.string()).optional(),
  exploration_hints: z.array(explorationHintSchema).optional(),
});

export type UIStateAnalysis = z.infer<typeof uiStateAnalysisSchema>;

export function parseUiStateAnalysis(value: unknown): UIStateAnalysis {
  return uiStateAnalysisSchema.parse(value);
}
