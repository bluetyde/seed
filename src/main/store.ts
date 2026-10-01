// What SEED remembers about installs: the folder new clones go into, and where each app's clone is. Plain JSON in the user data folder.
// A damaged file is reported, not replaced by empty settings: the user would lose the paths without knowing why.

import * as fs from "node:fs";
import * as path from "node:path";

export interface InstallSettings {
  installRoot: string;
  paths: Record<string, string>;
}

export class InstallStore {
  constructor(private readonly file: string, private readonly defaultRoot: string) {}

  load(): InstallSettings {
    if (!fs.existsSync(this.file)) return { installRoot: this.defaultRoot, paths: {} };
    const raw = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<InstallSettings>;       // a bad file throws with its position
    const paths: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.paths ?? {})) if (typeof v === "string") paths[k] = v;
    return { installRoot: typeof raw.installRoot === "string" && raw.installRoot ? raw.installRoot : this.defaultRoot, paths };
  }

  save(s: InstallSettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(tmp, this.file);
  }

  setPath(id: string, p: string | undefined): void {
    const s = this.load();
    if (p === undefined) delete s.paths[id]; else s.paths[id] = p;
    this.save(s);
  }

  setRoot(root: string): void {
    this.save({ ...this.load(), installRoot: root });
  }
}
