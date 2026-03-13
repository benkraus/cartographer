import path from "node:path";

export interface AppConfig {
  output_root: string;
  state_store_path: string;
  storage_state_dir: string;
  default_viewport: {
    width: number;
    height: number;
  };
}

export function loadConfig(): AppConfig {
  const outputRoot = path.resolve(process.cwd(), process.env.CARTOGRAPHER_OUTPUT_ROOT ?? "output");

  return {
    output_root: outputRoot,
    state_store_path: path.join(outputRoot, "state", "graph-store.json"),
    storage_state_dir: path.join(outputRoot, "auth", "storage-state"),
    default_viewport: {
      width: 1600,
      height: 1000,
    },
  };
}
