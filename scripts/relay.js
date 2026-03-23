import {
  getPrimaryReceiverUserId,
  isSenderAuthorized
} from "./settings.js";
import { getRemoteActionSocket, SOCKET_HANDLERS } from "./socket.js";
import { logDebug, logWarning } from "./debug.js";

function canRelayFromCurrentUser() {
  const currentUserId = game.user?.id;
  return isSenderAuthorized(currentUserId);
}

export async function relayAction(actionType, payload = {}) {
  logDebug("Relay requested.", {
    actionType,
    senderUserId: game.user?.id,
    payload
  });

  const targetUserId = getPrimaryReceiverUserId();

  if (!targetUserId) {
    logWarning("No primary receiver configured.");
    return { ok: false, reason: "missing-receiver" };
  }

  if (!canRelayFromCurrentUser()) {
    logWarning("Current user is not allowed to relay actions.");
    return { ok: false, reason: "unauthorized-sender" };
  }

  const socket = getRemoteActionSocket();
  if (!socket) {
    logWarning("Remote Action socket is not available.");
    return { ok: false, reason: "missing-socket" };
  }

  const request = {
    actionType,
    payload,
    senderUserId: game.user.id,
    targetUserId,
    sentAt: new Date().toISOString()
  };

  logDebug("Sending relay request to receiver.", request);

  const response = await socket.executeAsUser(
    SOCKET_HANDLERS.EXECUTE_REMOTE_ACTION,
    targetUserId,
    request
  );

  logDebug("Relay response received.", response);
  return response;
}

export async function pingRelay() {
  const payload = {
    message: "Remote Action ping relay test",
    sourceUserName: game.user?.name ?? "Unknown User"
  };

  logDebug("Starting ping relay test.", payload);
  return relayAction("ping", payload);
}