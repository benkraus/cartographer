import type { UIStatePacket } from "../contracts/state-packet.js";
import { hashString, shortHash } from "../utils/hash.js";

type InteractiveElement = UIStatePacket["ui"]["interactive_elements"][number];

export interface ActionPolicy {
  allow_mutating: boolean;
  allow_dangerous: boolean;
  allow_label_patterns: string[];
  deny_label_patterns: string[];
}

export interface ActionCandidate {
  action_id: string;
  element_id: string;
  action_type: InteractiveElement["candidate_action_types"][number];
  action_label: string;
  risk: InteractiveElement["risk_guess"];
  expected_result_type: "navigation" | "open_modal" | "open_menu" | "state_change" | "unknown";
  locator: string;
  executable: boolean;
  skip_reason?: string;
}

export const defaultActionPolicy: ActionPolicy = {
  allow_mutating: false,
  allow_dangerous: false,
  allow_label_patterns: [],
  deny_label_patterns: [],
};

export function buildActionCandidates(
  elements: InteractiveElement[],
  policyInput: Partial<ActionPolicy> = {},
): ActionCandidate[] {
  const policy = {
    ...defaultActionPolicy,
    ...policyInput,
    allow_label_patterns: policyInput.allow_label_patterns ?? defaultActionPolicy.allow_label_patterns,
    deny_label_patterns: policyInput.deny_label_patterns ?? defaultActionPolicy.deny_label_patterns,
  };

  const allowPatterns = compilePatterns(policy.allow_label_patterns);
  const denyPatterns = compilePatterns(policy.deny_label_patterns);
  const candidates: ActionCandidate[] = [];

  for (const element of elements) {
    if (!element.visible) {
      continue;
    }

    for (const actionType of element.candidate_action_types) {
      const actionLabel = buildActionLabel(actionType, element.name);
      const risk = element.risk_guess;

      const overrideAllowed = matchesAnyPattern(actionLabel, allowPatterns);
      const deniedByPattern = matchesAnyPattern(actionLabel, denyPatterns);

      const decision = decideExecutability({
        risk,
        overrideAllowed,
        deniedByPattern,
        policy,
      });

      const actionMaterial = `${element.element_id}|${actionType}|${actionLabel}`;
      const candidate: ActionCandidate = {
        action_id: `ac_${shortHash(hashString(actionMaterial), 10)}`,
        element_id: element.element_id,
        action_type: actionType,
        action_label: actionLabel,
        risk,
        expected_result_type: inferExpectedResultType(element, actionType),
        locator: element.locator,
        executable: decision.executable,
      };

      if (decision.skip_reason) {
        candidate.skip_reason = decision.skip_reason;
      }

      candidates.push(candidate);
    }
  }

  return candidates.sort((a, b) => {
    if (a.executable !== b.executable) {
      return a.executable ? -1 : 1;
    }
    return a.action_label.localeCompare(b.action_label);
  });
}

function buildActionLabel(actionType: InteractiveElement["candidate_action_types"][number], name: string): string {
  const verb =
    actionType === "open_menu"
      ? "Open menu"
      : actionType === "select"
        ? "Select"
        : actionType === "type"
          ? "Type in"
          : actionType === "hover"
            ? "Hover"
            : actionType === "submit"
              ? "Submit"
              : "Click";

  return `${verb} \"${name}\"`;
}

function inferExpectedResultType(
  element: InteractiveElement,
  actionType: InteractiveElement["candidate_action_types"][number],
): "navigation" | "open_modal" | "open_menu" | "state_change" | "unknown" {
  const name = element.name.toLowerCase();

  if (actionType === "open_menu" || /\b(menu|more|actions|kebab|ellipsis)\b/.test(name)) {
    return "open_menu";
  }
  if (element.href || element.role === "link") {
    return "navigation";
  }
  if (/\b(new|add|create|edit|details|view|open)\b/.test(name)) {
    return "open_modal";
  }
  if (actionType === "click" || actionType === "select" || actionType === "submit") {
    return "state_change";
  }

  return "unknown";
}

function decideExecutability(input: {
  risk: InteractiveElement["risk_guess"];
  overrideAllowed: boolean;
  deniedByPattern: boolean;
  policy: ActionPolicy;
}): { executable: boolean; skip_reason?: string } {
  if (input.deniedByPattern) {
    return {
      executable: false,
      skip_reason: "Denied by --deny-action pattern.",
    };
  }

  if (input.overrideAllowed) {
    return {
      executable: true,
    };
  }

  if (input.risk === "dangerous" && !input.policy.allow_dangerous) {
    return {
      executable: false,
      skip_reason: "Dangerous action blocked by policy.",
    };
  }

  if (input.risk === "mutating" && !input.policy.allow_mutating) {
    return {
      executable: false,
      skip_reason: "Mutating action blocked by policy.",
    };
  }

  return {
    executable: true,
  };
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern, "i");
    } catch {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(escaped, "i");
    }
  });
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(value)) {
      return true;
    }
  }
  return false;
}
