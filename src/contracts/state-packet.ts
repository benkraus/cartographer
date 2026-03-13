import { z } from "zod";

const stateTypeSchema = z.enum(["screen", "modal", "dialog", "menu", "drawer", "toast", "popover"]);
const actionTypeSchema = z.enum(["click", "hover", "select", "type", "submit", "open_menu"]);
const riskSchema = z.enum(["safe", "mutating", "dangerous", "unknown"]);

const bboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

const artifactSchema = z.object({
  artifact_id: z.string(),
  kind: z.enum(["screenshot_full", "screenshot_viewport", "screenshot_crop", "html_snapshot", "a11y_snapshot"]),
  mime_type: z.enum(["image/png", "image/jpeg", "text/html", "text/plain"]),
  path: z.string(),
  sha256: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  bbox: bboxSchema.optional(),
  notes: z.string().optional(),
});

const interactiveElementSchema = z.object({
  element_id: z.string(),
  role: z.string(),
  name: z.string(),
  locator: z.string(),
  href: z.string().optional(),
  visible: z.boolean(),
  enabled: z.boolean().optional(),
  bbox: bboxSchema.optional(),
  candidate_action_types: z.array(actionTypeSchema),
  risk_guess: riskSchema,
});

const formFieldSchema = z.object({
  field_id: z.string(),
  label: z.string(),
  input_type: z.enum([
    "text",
    "textarea",
    "number",
    "date",
    "datetime",
    "time",
    "select",
    "checkbox",
    "radio",
    "toggle",
    "search",
    "unknown",
  ]),
  required: z.boolean().optional(),
  options_sample: z.array(z.string()).optional(),
  validation_hints: z.array(z.string()).optional(),
});

const formExtractSchema = z.object({
  form_id: z.string(),
  title: z.string().optional(),
  fields: z.array(formFieldSchema),
});

const tableOrListExtractSchema = z.object({
  list_id: z.string(),
  title: z.string().optional(),
  columns: z.array(z.string()).optional(),
  row_actions_present: z.boolean().optional(),
  pagination_present: z.boolean().optional(),
  filters_present: z.boolean().optional(),
});

export const uiStatePacketSchema = z.object({
  packet_version: z.literal("1.0"),
  capture: z.object({
    run_id: z.string(),
    run_label: z.string().optional(),
    captured_at: z.string().datetime(),
    timezone: z.string(),
    role: z.string(),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      device_scale_factor: z.number().positive(),
    }),
    redactions_applied: z.array(z.string()).optional(),
  }),
  node: z.object({
    node_id: z.string(),
    state_type: stateTypeSchema,
    url: z.string(),
    route_template: z.string(),
    title_candidates: z.array(z.string()).optional(),
    parent_node_id: z.string().optional(),
    fingerprint: z.object({
      dom_hash: z.string(),
      a11y_hash: z.string(),
      phash_full: z.string(),
      phash_viewport: z.string().optional(),
    }),
  }),
  artifacts: z.array(artifactSchema).min(1),
  ui: z.object({
    visible_text_sample: z.array(z.string()),
    a11y_tree_text: z.string(),
    interactive_elements: z.array(interactiveElementSchema),
    forms: z.array(formExtractSchema).optional(),
    tables_or_lists: z.array(tableOrListExtractSchema).optional(),
    toasts: z.array(z.string()).optional(),
  }),
});

export type UIStatePacket = z.infer<typeof uiStatePacketSchema>;

export function parseUiStatePacket(value: unknown): UIStatePacket {
  return uiStatePacketSchema.parse(value);
}
