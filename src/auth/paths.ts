import path from "node:path";

import { roleSlug } from "../utils/role.js";

export function defaultStorageStatePathForRole(storageStateDir: string, role: string): string {
  return path.join(storageStateDir, `${roleSlug(role)}.storage-state.json`);
}
