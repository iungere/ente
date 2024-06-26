import { ipcRenderer } from "electron";
import { AppUpdateInfo } from "../types";

export const registerUpdateEventListener = (
    showUpdateDialog: (updateInfo: AppUpdateInfo) => void,
) => {
    ipcRenderer.removeAllListeners("show-update-dialog");
    ipcRenderer.on("show-update-dialog", (_, updateInfo: AppUpdateInfo) => {
        showUpdateDialog(updateInfo);
    });
};

export const registerForegroundEventListener = (onForeground: () => void) => {
    ipcRenderer.removeAllListeners("app-in-foreground");
    ipcRenderer.on("app-in-foreground", () => {
        onForeground();
    });
};
