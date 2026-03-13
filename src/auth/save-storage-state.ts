import { createInterface } from "node:readline/promises";

import { chromium } from "playwright";

export interface SaveStorageStateInput {
  role: string;
  login_url: string;
  storage_state_path: string;
  headless: boolean;
  timeout_ms: number;
  viewport: {
    width: number;
    height: number;
  };
  mode: "manual" | "scripted";
  post_login_url_pattern?: string;
  post_login_selector?: string;
  scripted?: {
    username: string;
    password: string;
    username_selector: string;
    password_selector: string;
    submit_selector: string;
    submit_with_enter: boolean;
  };
}

export interface SaveStorageStateResult {
  role: string;
  mode: "manual" | "scripted";
  storage_state_path: string;
  captured_at: string;
  final_url: string;
}

export async function saveRoleStorageState(input: SaveStorageStateInput): Promise<SaveStorageStateResult> {
  const browser = await chromium.launch({ headless: input.headless });

  try {
    const context = await browser.newContext({
      viewport: {
        width: input.viewport.width,
        height: input.viewport.height,
      },
    });
    const page = await context.newPage();

    await page.goto(input.login_url, { waitUntil: "domcontentloaded" });

    if (input.mode === "scripted") {
      if (!input.scripted) {
        throw new Error("Scripted mode requires scripted login options.");
      }

      await page.locator(input.scripted.username_selector).first().fill(input.scripted.username);
      await page.locator(input.scripted.password_selector).first().fill(input.scripted.password);

      if (input.scripted.submit_with_enter) {
        await page.locator(input.scripted.password_selector).first().press("Enter");
      } else {
        await page.locator(input.scripted.submit_selector).first().click();
      }

      await waitForPostLogin(page, input);
    } else {
      console.log(`Manual login mode for role '${input.role}'.`);
      console.log(`Login URL opened: ${input.login_url}`);
      console.log("Complete login in the browser window.");

      if (input.post_login_selector || input.post_login_url_pattern) {
        console.log("Waiting for post-login condition...");
        await waitForPostLogin(page, input);
      } else {
        await waitForManualConfirmation(input.timeout_ms);
      }
    }

    await context.storageState({ path: input.storage_state_path });

    const result: SaveStorageStateResult = {
      role: input.role,
      mode: input.mode,
      storage_state_path: input.storage_state_path,
      captured_at: new Date().toISOString(),
      final_url: page.url(),
    };

    await context.close();
    return result;
  } finally {
    await browser.close();
  }
}

async function waitForPostLogin(
  page: import("playwright").Page,
  input: Pick<SaveStorageStateInput, "login_url" | "post_login_selector" | "post_login_url_pattern" | "timeout_ms">,
): Promise<void> {
  const conditions: Array<Promise<unknown>> = [waitForUrlChange(page, input.login_url, input.timeout_ms)];

  if (input.post_login_url_pattern) {
    conditions.push(page.waitForURL(input.post_login_url_pattern, { timeout: input.timeout_ms }));
  }
  if (input.post_login_selector) {
    conditions.push(page.locator(input.post_login_selector).first().waitFor({ state: "visible", timeout: input.timeout_ms }));
  }

  try {
    await Promise.any(conditions);
  } catch {
    throw new Error(
      "Post-login condition not met before timeout. Provide --post-login-url or --post-login-selector for more reliable detection.",
    );
  }

  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
}

async function waitForUrlChange(page: import("playwright").Page, loginUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (page.url() !== loginUrl) {
      return;
    }
    await page.waitForTimeout(250);
  }

  throw new Error("URL did not change from login URL before timeout.");
}

async function waitForManualConfirmation(timeoutMs: number): Promise<void> {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await Promise.race([
        readline.question("Press Enter once login is complete..."),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out waiting for manual confirmation after ${timeoutMs}ms.`)), timeoutMs),
        ),
      ]);
    } finally {
      readline.close();
    }
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
}
