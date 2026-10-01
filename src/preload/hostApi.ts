// The only bridge between the host's own pages (top bar, welcome page) and the main process. App tabs get no preload at all.
import { contextBridge, ipcRenderer } from "electron";

const api: HostApi = {
  getState: () => ipcRenderer.invoke("state:get"),
  onState: (cb) => { ipcRenderer.on("state", (_e, s: HostState) => cb(s)); },
  openApp: (appId) => ipcRenderer.send("tab:openApp", appId),
  newTab: () => ipcRenderer.send("tab:new"),
  activate: (tabId) => ipcRenderer.send("tab:activate", tabId),
  close: (tabId) => ipcRenderer.send("tab:close", tabId),
  retry: (tabId) => ipcRenderer.send("tab:retry", tabId),
  menu: (action) => ipcRenderer.send("menu:action", action),
  setBarExpanded: (expanded) => ipcRenderer.send("bar:expand", expanded),
};

contextBridge.exposeInMainWorld("host", api);
