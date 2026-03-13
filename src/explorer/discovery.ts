import type { Page } from "playwright";

import type { UIStatePacket } from "../contracts/state-packet.js";
import { hashString, shortHash } from "../utils/hash.js";

type InteractiveElement = UIStatePacket["ui"]["interactive_elements"][number];
type CandidateActionType = InteractiveElement["candidate_action_types"][number];
type RiskGuess = InteractiveElement["risk_guess"];

interface RawElement {
  role: string;
  name: string;
  href?: string;
  visible: boolean;
  enabled: boolean;
  bbox?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  css_path: string;
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input[type='button']",
  "input[type='submit']",
  "input[type='checkbox']",
  "input[type='radio']",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
].join(",");

export async function discoverInteractiveElements(page: Page): Promise<InteractiveElement[]> {
  const rawElements = await page.evaluate<RawElement[], string>((selector) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    const uniqueNodes = new Set<Element>();
    const raw: RawElement[] = [];

    for (const element of nodes) {
      if (uniqueNodes.has(element)) {
        continue;
      }
      uniqueNodes.add(element);

      const htmlElement = element as HTMLElement;
      const rect = htmlElement.getBoundingClientRect();
      const styles = window.getComputedStyle(htmlElement);

      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        styles.display !== "none" &&
        styles.visibility !== "hidden" &&
        styles.opacity !== "0";

      const enabled = !("disabled" in htmlElement && Boolean((htmlElement as HTMLButtonElement).disabled));

      let role = element.getAttribute("role") ?? "";
      if (!role) {
        if (element instanceof HTMLButtonElement) {
          role = "button";
        } else if (element instanceof HTMLAnchorElement) {
          role = "link";
        } else if (element instanceof HTMLTextAreaElement) {
          role = "textbox";
        } else if (element instanceof HTMLSelectElement) {
          role = "combobox";
        } else if (element instanceof HTMLInputElement) {
          if (element.type === "checkbox") {
            role = "checkbox";
          } else if (element.type === "radio") {
            role = "radio";
          } else if (element.type === "submit" || element.type === "button") {
            role = "button";
          } else {
            role = "textbox";
          }
        } else {
          role = "unknown";
        }
      }

      let name = element.getAttribute("aria-label")?.trim() ?? "";
      if (!name) {
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
            .filter((value) => value.length > 0);
          if (parts.length > 0) {
            name = parts.join(" ");
          }
        }
      }
      if (!name && element instanceof HTMLInputElement) {
        if (element.value.trim()) {
          name = element.value.trim();
        } else if (element.placeholder?.trim()) {
          name = element.placeholder.trim();
        }
      }
      if (!name && element instanceof HTMLElement) {
        const text = element.innerText.trim();
        if (text) {
          name = text;
        }
      }
      if (!name) {
        name = element.getAttribute("title")?.trim() ?? "";
      }

      const pathParts: string[] = [];
      let cursor: Element | null = element;
      while (cursor && cursor !== document.body) {
        const currentElement: Element = cursor;
        let selectorPart = currentElement.tagName.toLowerCase();
        if (currentElement.id) {
          selectorPart += `#${currentElement.id}`;
          pathParts.unshift(selectorPart);
          break;
        }
        const classNames = Array.from(currentElement.classList).slice(0, 2).join(".");
        if (classNames) {
          selectorPart += `.${classNames}`;
        }
        const siblings = currentElement.parentElement
          ? (Array.from(currentElement.parentElement.children) as Element[]).filter(
              (child) => child.tagName === currentElement.tagName,
            )
          : [];
        if (siblings.length > 1) {
          const index = siblings.indexOf(currentElement) + 1;
          selectorPart += `:nth-of-type(${index})`;
        }
        pathParts.unshift(selectorPart);
        cursor = currentElement.parentElement;
      }
      const cssPath = pathParts.join(" > ");

      let href: string | undefined;
      if (element instanceof HTMLAnchorElement && element.href) {
        href = element.href;
      }

      let bbox: RawElement["bbox"];
      if (visible) {
        bbox = {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          w: Number(rect.width.toFixed(2)),
          h: Number(rect.height.toFixed(2)),
        };
      }

      const rawElement: RawElement = {
        role,
        name,
        visible,
        enabled,
        css_path: cssPath,
      };

      if (href) {
        rawElement.href = href;
      }
      if (bbox) {
        rawElement.bbox = bbox;
      }

      raw.push(rawElement);
    }

    return raw;
  }, INTERACTIVE_SELECTOR);

  const deduped = new Map<string, InteractiveElement>();

  for (const rawElement of rawElements) {
    const role = rawElement.role || "unknown";
    const name = rawElement.name.trim() || "(unnamed control)";
    const key = `${role}|${name}|${rawElement.css_path}`;
    if (deduped.has(key)) {
      continue;
    }

    const elementIdMaterial = `${key}|${rawElement.bbox?.x ?? 0}|${rawElement.bbox?.y ?? 0}`;
    const element: InteractiveElement = {
      element_id: `el_${shortHash(hashString(elementIdMaterial), 10)}`,
      role,
      name,
      locator: buildLocator(role, name, rawElement.css_path),
      visible: rawElement.visible,
      enabled: rawElement.enabled,
      candidate_action_types: guessActionTypes(role, name, rawElement.href),
      risk_guess: guessRisk(name),
    };

    if (rawElement.href) {
      element.href = rawElement.href;
    }
    if (rawElement.bbox) {
      element.bbox = rawElement.bbox;
    }

    deduped.set(key, element);
  }

  return Array.from(deduped.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 400);
}

function buildLocator(role: string, name: string, cssPath: string): string {
  if (role !== "unknown" && name !== "(unnamed control)") {
    const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `getByRole('${role}', { name: '${escapedName}' })`;
  }
  const escapedCss = cssPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `locator('${escapedCss}')`;
}

function guessActionTypes(role: string, name: string, href?: string): CandidateActionType[] {
  const lowerRole = role.toLowerCase();
  const lowerName = name.toLowerCase();
  const actions = new Set<CandidateActionType>();

  if (href || lowerRole === "link" || lowerRole === "button" || lowerRole === "tab" || lowerRole === "menuitem") {
    actions.add("click");
  }
  if (lowerRole === "combobox" || lowerRole === "checkbox" || lowerRole === "radio") {
    actions.add("select");
  }
  if (lowerRole === "textbox" || lowerRole === "searchbox") {
    actions.add("type");
  }
  if (lowerName.includes("menu") || lowerName.includes("more") || lowerName.includes("actions")) {
    actions.add("open_menu");
  }
  if (lowerName.includes("submit") || lowerName.includes("save") || lowerName.includes("create")) {
    actions.add("submit");
  }

  if (actions.size === 0) {
    actions.add("click");
  }

  return Array.from(actions);
}

function guessRisk(name: string): RiskGuess {
  const dangerousPattern =
    /\b(delete|remove|destroy|purge|revoke|disable|archive|reset|refund|charge|pay|purchase|checkout|deploy|publish|merge)\b/i;
  const mutatingPattern =
    /\b(save|create|add|new|submit|update|edit|send|apply|invite|upload|import|connect|sync|approve)\b/i;

  if (dangerousPattern.test(name)) {
    return "dangerous";
  }
  if (mutatingPattern.test(name)) {
    return "mutating";
  }
  return "safe";
}
