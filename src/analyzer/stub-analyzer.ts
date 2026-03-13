import type { UIStateAnalysis } from "../contracts/state-analysis.js";
import type { UIStatePacket } from "../contracts/state-packet.js";
import { hashString, shortHash } from "../utils/hash.js";

export function generateStubAnalysis(packet: UIStatePacket): UIStateAnalysis {
  const title =
    packet.node.title_candidates?.find((candidate) => candidate.trim().length > 0) ??
    inferTitleFromRoute(packet.node.route_template);

  const module = inferPrimaryModule(packet.node.route_template, title);

  const features: UIStateAnalysis["features"] = packet.ui.interactive_elements.slice(0, 30).map((element) => {
    const category = inferFeatureCategory(element.name);
    const capability = inferCapability(element.risk_guess, category);
    const featureId = `${module.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.${slugify(element.name)}_${shortHash(element.element_id, 6)}`;

    return {
      feature_id: featureId,
      name: element.name,
      description: `Control available on ${title}.`,
      category,
      capability,
      risk: element.risk_guess,
      confidence: "high" as const,
      observed_vs_inferred: "observed" as const,
      evidence: {
        artifact_ids: ["art_full"],
        element_ids: [element.element_id],
        exact_text: [element.name],
      },
      replication_requirements: [`Implement control labeled "${element.name}" with matching behavior.`],
    };
  });

  const outgoingActions: NonNullable<UIStateAnalysis["navigation"]>["outgoing_actions"] = packet.ui.interactive_elements
    .slice(0, 20)
    .map((element) => ({
      label: `Activate ${element.name}`,
      action_type: normalizeActionType(element.candidate_action_types[0]),
      risk: element.risk_guess,
      target_hint: "unknown",
      evidence: {
        artifact_ids: ["art_full"],
        element_ids: [element.element_id],
        exact_text: [element.name],
      },
    }));

  const checklist: UIStateAnalysis["replication_checklist"] = features.slice(0, 20).map((feature) => ({
    item_id: `chk_${shortHash(hashString(`${packet.node.node_id}:${feature.feature_id}`), 10)}`,
    text: `Implement ${feature.name} behavior on ${title}.`,
    priority: feature.risk === "mutating" || feature.risk === "dangerous" ? ("must" as const) : ("should" as const),
    observed_vs_inferred: "observed" as const,
    evidence: feature.evidence,
  }));

  if (features.length === 0) {
    features.push({
      feature_id: `${module.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.screen_presence`,
      name: `${title} screen present`,
      description: "Base screen exists and renders in the current role.",
      category: "view_data",
      capability: "read",
      risk: "safe",
      confidence: "medium",
      observed_vs_inferred: "observed",
      evidence: {
        artifact_ids: ["art_full"],
        element_ids: [],
        exact_text: packet.ui.visible_text_sample.slice(0, 3),
      },
      replication_requirements: ["Implement screen layout and module entry point."],
    });
  }

  if (checklist.length === 0) {
    checklist.push({
      item_id: `chk_${shortHash(hashString(packet.node.node_id), 10)}`,
      text: `Recreate ${title} layout and baseline interactions.`,
      priority: "must",
      observed_vs_inferred: "observed",
      evidence: {
        artifact_ids: ["art_full"],
        element_ids: [],
        exact_text: packet.ui.visible_text_sample.slice(0, 3),
      },
    });
  }

  return {
    schema_version: "1.0",
    node_id: packet.node.node_id,
    screen: {
      proposed_title: title,
      state_type: packet.node.state_type,
      module_candidates: [module],
      purpose: `Support ${module} workflows visible on ${title}.`,
      who_uses_this: [packet.capture.role],
      key_entities: inferKeyEntities(packet.node.route_template, packet.ui.visible_text_sample),
    },
    features,
    navigation: {
      outgoing_actions: outgoingActions,
    },
    replication_checklist: checklist,
    open_questions: [
      "Replace stub analysis with strict LLM extraction once analyzer pipeline is wired.",
      "Validate mutating and dangerous action behavior through workflow mode.",
    ],
    exploration_hints: packet.ui.interactive_elements.slice(0, 5).map((element) => ({
      hint: `Explore action: ${element.name}`,
      why: `Could reveal additional states from ${title}.`,
      suggested_element_ids: [element.element_id],
    })),
  };
}

function normalizeActionType(actionType: string | undefined): "click" | "hover" | "select" | "type" | "submit" | "open_menu" | "close" {
  if (actionType === "hover" || actionType === "select" || actionType === "type" || actionType === "submit" || actionType === "open_menu") {
    return actionType;
  }
  return "click";
}

function inferFeatureCategory(name: string):
  | "navigation"
  | "view_data"
  | "search_filter"
  | "create"
  | "edit"
  | "delete"
  | "export"
  | "settings"
  | "workflow"
  | "security_permissions"
  | "integration"
  | "other" {
  const normalized = name.toLowerCase();
  if (/(search|filter|sort)/.test(normalized)) {
    return "search_filter";
  }
  if (/(new|create|add)/.test(normalized)) {
    return "create";
  }
  if (/(edit|update)/.test(normalized)) {
    return "edit";
  }
  if (/(delete|remove|destroy|archive)/.test(normalized)) {
    return "delete";
  }
  if (/(export|download|print)/.test(normalized)) {
    return "export";
  }
  if (/(settings|config|preferences)/.test(normalized)) {
    return "settings";
  }
  if (/(tab|menu|next|back|previous|home|dashboard|overview|browse|view all|open)/.test(normalized)) {
    return "navigation";
  }
  return "other";
}

function inferCapability(
  risk: "safe" | "mutating" | "dangerous" | "unknown",
  category:
    | "navigation"
    | "view_data"
    | "search_filter"
    | "create"
    | "edit"
    | "delete"
    | "export"
    | "settings"
    | "workflow"
    | "security_permissions"
    | "integration"
    | "other",
): "read" | "write" | "update" | "remove" | "execute" | "configure" | "unknown" {
  if (category === "create") {
    return "write";
  }
  if (category === "edit") {
    return "update";
  }
  if (category === "delete") {
    return "remove";
  }
  if (category === "settings") {
    return "configure";
  }
  if (risk === "mutating" || risk === "dangerous") {
    return "execute";
  }
  if (category === "navigation" || category === "search_filter" || category === "view_data") {
    return "read";
  }
  return "unknown";
}

function inferPrimaryModule(routeTemplate: string, title: string): string {
  const source = `${routeTemplate} ${title}`.toLowerCase();
  const routeSegments = routeTemplate
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !segment.startsWith("{"));

  if (/(settings|admin|organization|workspace|team|member|user|role|permission|security)/.test(source)) {
    return "Administration";
  }
  if (/(dashboard|home|overview)/.test(source)) {
    return "Dashboard";
  }
  if (/(report|analytics|insight|metric|kpi)/.test(source)) {
    return "Reporting";
  }
  if (/(message|inbox|notification|chat|comment|activity)/.test(source)) {
    return "Communication";
  }
  if (/(billing|invoice|subscription|payment|checkout|order|cart)/.test(source)) {
    return "Commerce";
  }
  if (/(project|task|ticket|issue|board|workflow|queue)/.test(source)) {
    return "Work Management";
  }
  if (/(file|asset|media|document|content|library)/.test(source)) {
    return "Content";
  }

  const firstSegment = routeSegments[0];
  if (firstSegment) {
    return toTitleCase(firstSegment.replace(/[-_]+/g, " "));
  }

  return "Workspace";
}

function inferTitleFromRoute(routeTemplate: string): string {
  const segments = routeTemplate
    .split("/")
    .filter((segment) => segment.length > 0 && !segment.startsWith("{"))
    .map((segment) => segment.replace(/[-_]+/g, " "));

  if (segments.length === 0) {
    return "Untitled State";
  }

  return segments
    .join(" ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function inferKeyEntities(routeTemplate: string, visibleText: string[]): string[] {
  const source = `${routeTemplate} ${visibleText.slice(0, 40).join(" ")}`.toLowerCase();
  const entities = new Set<string>();
  const routeSegments = routeTemplate
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !segment.startsWith("{"));

  for (const segment of routeSegments.slice(0, 3)) {
    entities.add(toSingularTitleCase(segment.replace(/[-_]+/g, " ")));
  }

  const keywordToEntity: Array<[RegExp, string]> = [
    [/\b(user|member|account|profile)\b/, "User"],
    [/\b(project|task|ticket|issue)\b/, "Work Item"],
    [/\b(order|invoice|payment|subscription)\b/, "Transaction"],
    [/\b(file|document|asset|media)\b/, "Asset"],
    [/\b(message|notification|comment|chat)\b/, "Message"],
    [/\b(report|dashboard|metric|analytics)\b/, "Report"],
  ];

  for (const [pattern, label] of keywordToEntity) {
    if (pattern.test(source)) {
      entities.add(label);
    }
  }

  if (entities.size === 0) {
    entities.add("UI State");
  }

  return Array.from(entities);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
}

function toTitleCase(value: string): string {
  return value.replace(/\b\w/g, (match) => match.toUpperCase());
}

function toSingularTitleCase(value: string): string {
  const normalized = value.replace(/\b(\w+?)s\b/g, "$1");
  return toTitleCase(normalized);
}
