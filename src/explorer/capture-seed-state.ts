import { chromium, type BrowserContextOptions } from "playwright";

import type { UIStatePacket } from "../contracts/state-packet.js";
import type { RunContext } from "../run/initialize-run.js";
import { captureCurrentState } from "./capture-state.js";

export interface CaptureSeedStateInput {
  run: RunContext;
  role: string;
  start_url: string;
  storage_state_path?: string;
  headless: boolean;
  viewport: {
    width: number;
    height: number;
  };
}

export async function captureSeedState(input: CaptureSeedStateInput): Promise<UIStatePacket> {
  const browser = await chromium.launch({ headless: input.headless });

  try {
    const contextOptions: BrowserContextOptions = {
      viewport: {
        width: input.viewport.width,
        height: input.viewport.height,
      },
    };
    if (input.storage_state_path) {
      contextOptions.storageState = input.storage_state_path;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    await page.goto(input.start_url, { waitUntil: "domcontentloaded" });
    const packet = await captureCurrentState({
      page,
      run: input.run,
      role: input.role,
      capture_id: "seed",
      state_type: "screen",
    });

    await context.close();
    return packet;
  } finally {
    await browser.close();
  }
}
