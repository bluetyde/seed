// Types shared by the main process, the preload script and the renderer pages. Ambient (no imports) so the renderer scripts stay
// plain browser scripts.

type TabStatus = "starting" | "running" | "error" | "idle";

interface HostTab {
  id: string;
  kind: "welcome" | "app";
  appId?: string;
  title: string;
  icon: string;
  status: TabStatus;
  error?: { message: string; output: string };
}

interface HostApp {
  id: string;
  name: string;
  icon: string;
  /** False when the app comes from the catalog and is not installed yet. */
  available: boolean;
  /** Whether a tab for it is open and what it is doing. */
  status: TabStatus;
}

interface HostInstall {
  id: string;
  name: string;
  notes?: string;
  isPrivate: boolean;
  state: "not-installed" | "installed" | "up-to-date" | "update-available" | "blocked";
  path?: string;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  /** Something the user should know about this copy, in plain words. */
  message?: string;
  /** A clone of this app that is already on this computer, offered as "use this one". */
  candidate?: string;
  prerequisites: { id: string; label: string; ok: boolean; fix?: string; when: "install" | "run" }[];
  job?: { kind: "install" | "update" | "check" | "adopt"; step: string; lines: string[]; running: boolean; error?: string };
}

interface HostState {
  installs: HostInstall[];
  installRoot: string;
  tabs: HostTab[];
  activeId: string | undefined;
  apps: HostApp[];
  registrySource: string;
  registryProblems: string[];
}

type MenuAction =
  | "newTab" | "closeTab" | "quit" | "reloadTab" | "devTools" | "fullscreen"
  | "nextTab" | "prevTab" | "editRegistry" | "reloadRegistry" | "about" | "chooseInstallRoot" | "checkUpdates";

interface HostApi {
  getState(): Promise<HostState>;
  onState(cb: (s: HostState) => void): void;
  openApp(appId: string): void;
  newTab(): void;
  activate(tabId: string): void;
  close(tabId: string): void;
  retry(tabId: string): void;
  menu(action: MenuAction): void;
  /** While a menu is open the bar covers the whole window so the menu can overlap the app. */
  setBarExpanded(expanded: boolean): void;
  install(id: string): void;
  update(id: string): void;
  checkUpdates(id?: string): void;
  cancelJob(id: string): void;
  /** Opens a folder picker and uses the chosen clone. */
  adopt(id: string): void;
  useFound(id: string): void;
  forget(id: string): void;
  chooseInstallRoot(): void;
}

interface Window {
  host: HostApi;
}
