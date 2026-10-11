import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the real-app tests look for an app when its SEED_*_REPO variable is not set (decision D10): the `apps` folder inside this repository
 * (where SEED's installer puts apps by default) if the app is there, otherwise a sibling folder of this repository, both named as the catalog
 * names the app (`openmc-studio`, `nodal-studio`, `raft`, `feed`, `sneed`).
 */
export function appDir(folder: string): string {
  const inApps = join(__dirname, "..", "..", "apps", folder);
  return existsSync(inApps) ? inApps : join(__dirname, "..", "..", "..", folder);
}
