import {
  MODULE_ID,
  getPrimaryReceiverUserId,
  getAuthorizedSenderUserIds,
  getRemoteActionConfigSnapshot,
  isEmitterNotificationsEnabled,
  isSenderAuthorized
} from "./settings.js";
import { getRemoteActionSocket, SOCKET_HANDLERS } from "./socket.js";
import { logDebug, logWarning, notifyInfo, notifyWarning } from "./debug.js";
import { executeRemoteAction } from "./execute.js";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringArray(values) {
  return Array.isArray(values)
    ? values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
}

function buildInvalidPayloadResponse(errors, payload) {
  return {
    ok: false,
    reason: "invalid-payload",
    errors,
    payload
  };
}

const REMOTE_ACTION_EXECUTION_MARKER_PATHS = Object.freeze({
  usage: [
    "remoteActionExecution",
    "context.remoteActionExecution",
    "workflowOptions.remoteActionExecution",
    "midiOptions.remoteActionExecution",
    "midiOptions.workflowOptions.remoteActionExecution",
    `flags.${MODULE_ID}.remoteActionExecution`
  ],
  dialog: [
    "remoteActionExecution",
    "options.remoteActionExecution",
    `flags.${MODULE_ID}.remoteActionExecution`
  ],
  message: [
    "remoteActionExecution",
    `flags.${MODULE_ID}.remoteActionExecution`,
    `data.flags.${MODULE_ID}.remoteActionExecution`
  ]
});

const AOE_SECONDARY_EXECUTION_PATHS = Object.freeze({
  usage: [
    "aoeSecondaryExecution",
    "context.aoeSecondaryExecution",
    "workflowOptions.aoeSecondaryExecution",
    "midiOptions.aoeSecondaryExecution",
    "midiOptions.workflowOptions.aoeSecondaryExecution"
  ],
  dialog: [
    "aoeSecondaryExecution",
    "options.aoeSecondaryExecution"
  ],
  message: [
    "aoeSecondaryExecution",
    "context.aoeSecondaryExecution"
  ]
});

function findFirstMatchingPath(value, paths = [], matcher = (candidate) => candidate === true) {
  if (!isPlainObject(value)) return null;

  for (const path of paths) {
    if (matcher(foundry.utils.getProperty(value, path))) return path;
  }

  return null;
}

function findFlagModuleId(configs = [], flagName) {
  for (const config of configs) {
    const flagContainers = [];

    if (isPlainObject(config?.flags)) flagContainers.push(config.flags);
    if (isPlainObject(config?.data?.flags)) flagContainers.push(config.data.flags);

    for (const flags of flagContainers) {
      for (const [moduleId, moduleFlags] of Object.entries(flags)) {
        if (isPlainObject(moduleFlags) && moduleFlags[flagName] === true) return moduleId;
      }
    }
  }

  return null;
}

function hasFlagInConfigs(configs = [], flagName) {
  return Boolean(findFlagModuleId(configs, flagName));
}

function sanitizeRelayValue(value, seen = new WeakSet()) {
  if ((value === null) || (value === undefined)) return value;

  const valueType = typeof value;
  if ((valueType === "string") || (valueType === "number") || (valueType === "boolean")) return value;
  if (valueType === "bigint") return value.toString();
  if ((valueType === "function") || (valueType === "symbol")) return undefined;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeRelayValue(entry, seen))
      .filter((entry) => entry !== undefined);
  }

  if (value instanceof Set) {
    return Array.from(value)
      .map((entry) => sanitizeRelayValue(entry, seen))
      .filter((entry) => entry !== undefined);
  }

  if (value instanceof Map) {
    const result = {};

    for (const [key, entry] of value.entries()) {
      if (typeof key !== "string") continue;
      const sanitized = sanitizeRelayValue(entry, seen);
      if (sanitized !== undefined) result[key] = sanitized;
    }

    return result;
  }

  if ((typeof Event !== "undefined") && (value instanceof Event)) return undefined;
  if ((typeof HTMLElement !== "undefined") && (value instanceof HTMLElement)) return undefined;

  if (seen.has(value)) return undefined;
  seen.add(value);

  if (!isPlainObject(value)) {
    if (typeof value?.toObject === "function") {
      try {
        return sanitizeRelayValue(value.toObject(), seen);
      } catch (_error) {
        return undefined;
      }
    }

    if (typeof value?.uuid === "string" && value.uuid.trim()) return value.uuid.trim();
    if (typeof value?.id === "string" && value.id.trim()) return value.id.trim();
    return undefined;
  }

  const result = {};

  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeRelayValue(entry, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }

  return result;
}

function sanitizeRelayConfig(config = {}) {
  const sanitized = sanitizeRelayValue(config);
  return isPlainObject(sanitized) ? sanitized : {};
}

function getActivityRelayParticipants(activity) {
  const item = activity?.item ?? null;
  const sourceActor = activity?.actor ?? item?.actor ?? null;
  const controlledTokens = Array.from(canvas?.tokens?.controlled ?? []);
  const controlledSourceToken = controlledTokens.find((token) => token.actor?.id === sourceActor?.id) ?? null;
  const actorActiveTokens = sourceActor?.getActiveTokens?.() ?? [];
  const sourceToken = controlledSourceToken ?? actorActiveTokens[0] ?? null;
  const sourceResolution = controlledSourceToken
    ? "controlled-token"
    : sourceToken
      ? "actor-active-token-fallback"
      : "actor-only";
  const targets = Array.from(game.user?.targets ?? []).filter(Boolean);

  return {
    sourceActor,
    sourceToken,
    sourceResolution,
    targets
  };
}

function getAoeSecondaryExecutionFlag(usage = {}, dialog = {}, message = {}) {
  const configs = [
    { value: usage, paths: AOE_SECONDARY_EXECUTION_PATHS.usage },
    { value: dialog, paths: AOE_SECONDARY_EXECUTION_PATHS.dialog },
    { value: message, paths: AOE_SECONDARY_EXECUTION_PATHS.message }
  ];

  for (const config of configs) {
    if (findFirstMatchingPath(config.value, config.paths)) return true;
  }

  return hasFlagInConfigs([usage, dialog, message], "aoeSecondaryExecution");
}

export function getRemoteActionExecutionMarker(usage = {}, dialog = {}, message = {}) {
  const configs = [
    { source: "usage", value: usage, paths: REMOTE_ACTION_EXECUTION_MARKER_PATHS.usage },
    { source: "dialog", value: dialog, paths: REMOTE_ACTION_EXECUTION_MARKER_PATHS.dialog },
    { source: "message", value: message, paths: REMOTE_ACTION_EXECUTION_MARKER_PATHS.message }
  ];

  for (const config of configs) {
    const path = findFirstMatchingPath(config.value, config.paths);
    if (!path) continue;

    return {
      found: true,
      source: config.source,
      path
    };
  }

  return {
    found: false,
    source: null,
    path: null
  };
}

export function buildActivityUseRelayPayload(activity, usage = {}, dialog = {}, message = {}, context = {}) {
  const item = activity?.item ?? null;
  const participants = getActivityRelayParticipants(activity);
  const bridgeModuleId = findFlagModuleId([usage, message], "aoeSecondaryExecution");
  const aoeSecondaryExecution = getAoeSecondaryExecutionFlag(usage, dialog, message);
  const normalizedUsage = sanitizeRelayConfig(usage);
  const normalizedDialog = sanitizeRelayConfig(dialog);
  const normalizedMessage = sanitizeRelayConfig(message);
  const targetTokenUuids = participants.targets
    .map((token) => token?.document?.uuid ?? token?.uuid ?? null)
    .filter(Boolean);

  delete normalizedDialog.applicationClass;

  return {
    itemUuid: item?.uuid ?? null,
    activityUuid: activity?.uuid ?? null,
    sourceActorUuid: participants.sourceActor?.uuid ?? item?.actor?.uuid ?? null,
    sourceTokenUuid: participants.sourceToken?.document?.uuid ?? participants.sourceToken?.uuid ?? null,
    targetTokenUuids,
    aoeSecondaryExecution,
    options: {
      usage: normalizedUsage,
      dialog: normalizedDialog,
      message: normalizedMessage
    },
    context: {
      relayOrigin: "activity.use-wrapper",
      interceptionMethod: context.interceptionMethod ?? "activity.use",
      itemName: item?.name ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      sourceResolution: participants.sourceResolution,
      bridgeModuleId: bridgeModuleId ?? null
    }
  };
}

function buildEmitterNotificationMessage(payload, response) {
  const itemLabel = response?.itemName ?? payload?.context?.itemName ?? response?.activityName ?? payload?.itemUuid ?? payload?.actionType ?? "item";

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

function validateActivityRelayPayload(payload) {
  const errors = [];

  if (!isPlainObject(payload)) {
    return {
      ok: false,
      errors: ["Payload must be an object."],
      normalizedPayload: null
    };
  }

  const requiredStringFields = ["itemUuid", "activityUuid"];
  const optionalStringFields = ["sourceActorUuid", "sourceTokenUuid"];
  const normalizedPayload = {};

  for (const field of requiredStringFields) {
    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      errors.push(`${field} is required and must be a non-empty string.`);
    } else {
      normalizedPayload[field] = payload[field].trim();
    }
  }

  for (const field of optionalStringFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === "") continue;

    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      errors.push(`${field} must be a non-empty string when provided.`);
    } else {
      normalizedPayload[field] = payload[field].trim();
    }
  }

  if (payload.targetTokenUuids !== undefined && !Array.isArray(payload.targetTokenUuids)) {
    errors.push("targetTokenUuids must be an array of strings when provided.");
  } else {
    normalizedPayload.targetTokenUuids = normalizeStringArray(payload.targetTokenUuids);
  }

  if (payload.options !== undefined && !isPlainObject(payload.options)) {
    errors.push("options must be an object when provided.");
  } else {
    normalizedPayload.options = payload.options ?? {};
  }

  if (payload.context !== undefined && !isPlainObject(payload.context)) {
    errors.push("context must be an object when provided.");
  } else {
    normalizedPayload.context = payload.context ?? {};
  }

  normalizedPayload.aoeSecondaryExecution = Boolean(
    payload.aoeSecondaryExecution
    ?? payload.options?.aoeSecondaryExecution
    ?? payload.context?.aoeSecondaryExecution
  );

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      normalizedPayload: null
    };
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

function canRelayExplicitActivityFromCurrentUser() {
  const currentUserId = game.user?.id;
  return Boolean(game.user?.isGM) || isSenderAuthorized(currentUserId);
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

export async function relayActivityUse(payload = {}) {
  const validation = validateActivityRelayPayload(payload);

  if (!validation.ok) {
    logWarning("Remote activity relay payload validation failed.", {
      errors: validation.errors,
      payload
    });
    return buildInvalidPayloadResponse(validation.errors, payload);
  }

  const normalizedPayload = validation.normalizedPayload;
  const currentUserId = game.user?.id ?? null;
  const currentUserName = game.user?.name ?? null;
  const primaryReceiverUserId = getPrimaryReceiverUserId();
  const authorizedSenderUserIds = getAuthorizedSenderUserIds();

  logDebug("Explicit activity relay requested.", {
    actionType: "relay-activity-use",
    currentUserId,
    currentUserName,
    currentUserIsGM: Boolean(game.user?.isGM),
    primaryReceiverUserId,
    authorizedSenderUserIds,
    payload: normalizedPayload
  });

  if (!primaryReceiverUserId) {
    logWarning("No primary receiver configured for explicit activity relay.", {
      currentUserId,
      currentUserName,
      currentUserIsGM: Boolean(game.user?.isGM)
    });
    return { ok: false, reason: "missing-receiver", handled: false, payload: normalizedPayload };
  }

  const request = {
    actionType: "relay-activity-use",
    payload: normalizedPayload,
    senderUserId: currentUserId,
    senderUserName: currentUserName,
    targetUserId: primaryReceiverUserId,
    sentAt: new Date().toISOString()
  };

  if (currentUserId === primaryReceiverUserId) {
    logDebug("Executing explicit activity relay locally on the primary receiver.", request);
    return executeRemoteAction(request);
  }

  if (!canRelayExplicitActivityFromCurrentUser()) {
    logWarning("Current user is not allowed to relay explicit activity uses.", {
      currentUserId,
      currentUserName,
      currentUserIsGM: Boolean(game.user?.isGM),
      primaryReceiverUserId,
      authorizedSenderUserIds,
      payload: normalizedPayload
    });
    return { ok: false, reason: "unauthorized-sender", handled: false, payload: normalizedPayload };
  }

  const socket = getRemoteActionSocket();
  if (!socket) {
    logWarning("Remote Action socket is not available for explicit activity relay.", {
      currentUserId,
      currentUserName,
      currentUserIsGM: Boolean(game.user?.isGM),
      primaryReceiverUserId,
      authorizedSenderUserIds,
      payload: normalizedPayload
    });
    return { ok: false, reason: "missing-socket", handled: false, payload: normalizedPayload };
  }

  logDebug("Sending explicit activity relay request to receiver.", request);

  const response = await socket.executeAsUser(
    SOCKET_HANDLERS.EXECUTE_REMOTE_ACTION,
    primaryReceiverUserId,
    request
  );

  logDebug("Explicit activity relay response received.", response);
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
