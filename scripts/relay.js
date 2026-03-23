import {
  getPrimaryReceiverUserId,
  getAuthorizedSenderUserIds,
  getRemoteActionConfigSnapshot,
  isSenderAuthorized
} from "./settings.js";
import { getRemoteActionSocket, SOCKET_HANDLERS } from "./socket.js";
import { logDebug, logWarning } from "./debug.js";

export function debugConfig() {
  const snapshot = getRemoteActionConfigSnapshot();
  const socketAvailable = Boolean(getRemoteActionSocket());
  const debugData = {
    currentUser: snapshot.currentUser,
    primaryReceiver: snapshot.primaryReceiver,
    authorizedSenders: snapshot.authorizedSenderUsers,
    authorizedSenderUserIds: snapshot.authorizedSenderUserIds,
    socketAvailable,
    isCurrentUserAuthorized: snapshot.isCurrentUserAuthorized
  };

  console.info("remote-action | Debug config", debugData);
  logDebug("Debug config snapshot generated.", debugData);
  return debugData;
}

function canRelayFromCurrentUser() {
  const currentUserId = game.user?.id;
  return isSenderAuthorized(currentUserId);
}

export async function relayAction(actionType, payload = {}) {
  const currentUserId = game.user?.id ?? null;
  const currentUserName = game.user?.name ?? null;
  const primaryReceiverUserId = getPrimaryReceiverUserId();
  const authorizedSenderUserIds = getAuthorizedSenderUserIds();

  logDebug("Relay requested.", {
    actionType,
    currentUserId,
    currentUserName,
    primaryReceiverUserId,
    authorizedSenderUserIds,
    payload
  });

  if (!primaryReceiverUserId) {
    logWarning("No primary receiver configured.");
    return { ok: false, reason: "missing-receiver" };
  }

  if (!canRelayFromCurrentUser()) {
    logWarning("Current user is not allowed to relay actions.", {
      currentUserId,
      currentUserName,
      primaryReceiverUserId,
      authorizedSenderUserIds
    });
    return { ok: false, reason: "unauthorized-sender" };
  }

  const socket = getRemoteActionSocket();
  if (!socket) {
    logWarning("Remote Action socket is not available.", {
      currentUserId,
      currentUserName,
      primaryReceiverUserId,
      authorizedSenderUserIds
    });
    return { ok: false, reason: "missing-socket" };
  }

  const request = {
    actionType,
    payload,
    senderUserId: currentUserId,
    senderUserName: currentUserName,
    targetUserId: primaryReceiverUserId,
    sentAt: new Date().toISOString()
  };

  logDebug("Sending relay request to receiver.", request);

  const response = await socket.executeAsUser(
    SOCKET_HANDLERS.EXECUTE_REMOTE_ACTION,
    primaryReceiverUserId,
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