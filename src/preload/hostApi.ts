// The only bridge between the host's own pages (top bar, welcome page) and the main process. App tabs get no preload at all.
import { contextBridge, ipcRenderer } from "electron";

const api: HostApi = {
  runLesson: (caseId) => ipcRenderer.send("lesson:run", caseId),
  cancelLesson: () => ipcRenderer.send("lesson:cancel"),
  saveLesson: () => ipcRenderer.send("lesson:save"),
  getState: () => ipcRenderer.invoke("state:get"),
  onState: (cb) => { ipcRenderer.on("state", (_e, s: HostState) => cb(s)); },
  openApp: (appId) => ipcRenderer.send("tab:openApp", appId),
  newTab: () => ipcRenderer.send("tab:new"),
  activate: (tabId) => ipcRenderer.send("tab:activate", tabId),
  close: (tabId) => ipcRenderer.send("tab:close", tabId),
  retry: (tabId) => ipcRenderer.send("tab:retry", tabId),
  menu: (action) => ipcRenderer.send("menu:action", action),
  setBarExpanded: (expanded) => ipcRenderer.send("bar:expand", expanded),
  install: (id) => ipcRenderer.send("inst:install", id),
  update: (id) => ipcRenderer.send("inst:update", id),
  checkUpdates: (id) => ipcRenderer.send("inst:check", id),
  cancelJob: (id) => ipcRenderer.send("inst:cancel", id),
  adopt: (id) => ipcRenderer.send("inst:adopt", id),
  useFound: (id) => ipcRenderer.send("inst:useFound", id),
  forget: (id) => ipcRenderer.send("inst:forget", id),
  chooseInstallRoot: () => ipcRenderer.send("inst:root"),
};

contextBridge.exposeInMainWorld("host", api);
