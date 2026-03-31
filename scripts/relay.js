import {
  getPrimaryReceiverUserId,
  getAuthorizedSenderUserIds,
  getRemoteActionConfigSnapshot,
  isEmitterNotificationsEnabled,
  isSenderAuthorized
} from "./settings.js";
import { getRemoteActionSocket, SOCKET_HANDLERS } from "./socket.js";
import { logDebug, logWarning, notifyInfo, notifyWarning } from "./debug.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildInvalidPayloadResponse(errors, payload) {
  return {
    ok: false,
    reason: "invalid-payload",
    errors,
    payload
  };
}

function buildEmitterNotificationMessage(payload, response) {
  const itemLabel = response?.itemName ?? payload?.itemUuid ?? payload?.actionType ?? "item";

  if (response?.ok && response?.handled) {
    if (response.launchMode === "dialog") {
      return game.i18n.format("REMOTE_ACTION.Notifications.ItemUseDialogSent", { item: itemLabel });
    }

    if (response.launchMode === "direct-workflow") {
      return game.i18n.format("REMOTE_ACTION.Notifications.ItemUseDirectWorkflowSent", { item: itemLabel });
    }

    return game.i18n.format("REMOTE_ACTION.Notifications.ItemUseSent", { item: itemLabel });
  }

  const reason = response?.reason ?? "unknown";
  return game.i18n.format("REMOTE_ACTION.Notifications.ItemUseFailed", {
    item: itemLabel,
    reason
  });
}

function maybeNotifyEmitter(actionType, payload, response) {
  if (!isEmitterNotificationsEnabled()) return;
  if (actionType !== "open-item-use-dialog") return;

  const message = buildEmitterNotificationMessage(payload, response);
  if (response?.ok && response?.handled) {
    notifyInfo(message);
    return;
  }

  notifyWarning(message);
}

export function validateActionPayload(payload) {
  const errors = [];

  if (!isPlainObject(payload)) {
    errors.push("Payload must be an object.");
    return {
      ok: false,
      errors,
      normalizedPayload: null
    };
  }

  if (typeof payload.actionType !== "string" || !payload.actionType.trim()) {
    errors.push("actionType is required and must be a non-empty string.");
  }

  const stringFields = ["actorUuid", "itemUuid", "tokenUuid"];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      errors.push(`${field} must be a string when provided.`);
    }
  }

  if (payload.context !== undefined && !isPlainObject(payload.context)) {
    errors.push("context must be an object when provided.");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      normalizedPayload: null
    };
  }

  const normalizedPayload = {
    actionType: payload.actionType.trim()
  };

  for (const field of stringFields) {
    if (payload[field]) {
      normalizedPayload[field] = payload[field];
    }
  }

  if (payload.context) {
    normalizedPayload.context = payload.context;
  }

  return {
    ok: true,
    errors: [],
    normalizedPayload
  };
}

export function debugConfig() {
  const snapshot = getRemoteActionConfigSnapshot();
  const socketAvailable = Boolean(getRemoteActionSocket());
  const recommendedTableModeActive = !snapshot.workflowSettings.useAttackRolls && snapshot.workflowSettings.useDamageRolls;
  const currentWorkflowProfile = recommendedTableModeActive
    ? "recommended-manual-hit-foundry-damage"
    : snapshot.workflowSettings.useAttackRolls
      ? "native-foundry-attack-experimental"
      : "custom-workflow-profile";

  const debugData = {
    currentUser: snapshot.currentUser,
    primaryReceiver: snapshot.primaryReceiver,
    authorizedSenders: snapshot.authorizedSenderUsers,
    authorizedSenderUserIds: snapshot.authorizedSenderUserIds,
    socketAvailable,
    isCurrentUserAuthorized: snapshot.isCurrentUserAuthorized,
    emitterNotifications: snapshot.emitterNotifications,
    workflowSettings: snapshot.workflowSettings,
    recommendedTableModeActive,
    currentWorkflowProfile,
    nativeAttackWorkflowExperimental: snapshot.workflowSettings.useAttackRolls
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
    const response = { ok: false, reason: "missing-receiver" };
    maybeNotifyEmitter(actionType, payload, response);
    return response;
  }

  if (!canRelayFromCurrentUser()) {
    logWarning("Current user is not allowed to relay actions.", {
      currentUserId,
      currentUserName,
      primaryReceiverUserId,
      authorizedSenderUserIds
    });
    const response = { ok: false, reason: "unauthorized-sender" };
    maybeNotifyEmitter(actionType, payload, response);
    return response;
  }

  const socket = getRemoteActionSocket();
  if (!socket) {
    logWarning("Remote Action socket is not available.", {
      currentUserId,
      currentUserName,
      primaryReceiverUserId,
      authorizedSenderUserIds
    });
    const response = { ok: false, reason: "missing-socket" };
    maybeNotifyEmitter(actionType, payload, response);
    return response;
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
  maybeNotifyEmitter(actionType, payload, response);
  return response;
}

export async function sendAction(payload) {
  const validation = validateActionPayload(payload);

  if (!validation.ok) {
    logWarning("Remote action payload validation failed.", {
      errors: validation.errors,
      payload
    });
    const response = buildInvalidPayloadResponse(validation.errors, payload);
    maybeNotifyEmitter(payload?.actionType, payload, response);
    return response;
  }

  const normalizedPayload = validation.normalizedPayload;
  logDebug("Sending generic remote action.", normalizedPayload);
  return relayAction(normalizedPayload.actionType, normalizedPayload);
}

export async function pingRelay() {
  const payload = {
    message: "Remote Action ping relay test",
    sourceUserName: game.user?.name ?? "Unknown User"
  };

  logDebug("Starting ping relay test.", payload);
  return relayAction("ping", payload);
}