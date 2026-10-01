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
  /** Whether a tab for it is open and what it is doing. */
  status: TabStatus;
}

interface HostState {
  tabs: HostTab[];
  activeId: string | undefined;
  apps: HostApp[];
  registrySource: string;
  registryProblems: string[];
}

type MenuAction =
  | "newTab" | "closeTab" | "quit" | "reloadTab" | "devTools" | "fullscreen"
  | "nextTab" | "prevTab" | "editRegistry" | "reloadRegistry" | "about";

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
}

interface Window {
  host: HostApi;
}
