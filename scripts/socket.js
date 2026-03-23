import { logDebug, logWarning } from "./debug.js";
import { executeRemoteAction } from "./execute.js";

export const SOCKET_NAME = "module.remote-action";
export const SOCKET_HANDLERS = {
  EXECUTE_REMOTE_ACTION: "executeRemoteAction"
};

let remoteActionSocket = null;

export function registerSocket() {
  if (!game.modules.get("socketlib")?.active) {
    logWarning("socketlib is required but not active.");
    return null;
  }

  if (remoteActionSocket) {
    logDebug("Socket already registered.", SOCKET_NAME);
    return remoteActionSocket;
  }

  remoteActionSocket = socketlib.registerModule("remote-action");
  remoteActionSocket.register(
    SOCKET_HANDLERS.EXECUTE_REMOTE_ACTION,
    executeRemoteAction
  );

  logDebug("Socket registered", SOCKET_NAME);
  return remoteActionSocket;
}

export function getRemoteActionSocket() {
  return remoteActionSocket;
}