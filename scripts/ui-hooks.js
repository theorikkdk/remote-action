import { notifyWarning, logDebug, logInfo, logWarning } from "./debug.js";
import { buildActivityUseRelayPayload, getRemoteActionExecutionMarker, relayActivityUse, sendAction } from "./relay.js";
import {
  MODULE_ID,
  getPrimaryReceiverUserId,
  isAutoInterceptItemUseEnabled,
  isSenderAuthorized
} from "./settings.js";

const KNOWN_COMPATIBLE_ITEM_USE_WRAPPER_IDS = Object.freeze([
  "midi-qol",
  "encounterplus-importer",
  "tidy5e-sheet",
  "sheet-only"
]);

const SHEET_ITEM_USE_INTERCEPTION_PLAN = Object.freeze({
  wrapperTarget: "dnd5e.applications.actor.BaseActorSheet.prototype._onUseItem",
  wrapperMethod: "libWrapper",
  wrapperType: "MIXED",
  relayActionType: "open-item-use-dialog"
});

const ITEM_USE_FALLBACK_PLAN = Object.freeze({
  wrapperTarget: "CONFIG.Item.documentClass.prototype.use",
  wrapperMethod: "libWrapper-item-use-fallback",
  wrapperType: "MIXED",
  relayActionType: "open-item-use-dialog"
});

const ACTIVITY_USE_INTERCEPTION_PLAN = Object.freeze({
  wrapperMethod: "libWrapper-activity-use",
  wrapperType: "MIXED"
});

const SECONDARY_AOE_MODULE_ID = "foundryvtt-dnd5e-aoe-secondary";
const SECONDARY_AOE_FLAG_KEY = "secondaryAoe";
const AOE_SECONDARY_CONTEXT_PATHS = Object.freeze({
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

const DOM_FALLBACK_PLAN = Object.freeze({
  method: "actor-sheet-dom-fallback",
  selector: ".item-image.item-action[data-action='use']",
  itemRowSelector: "[data-item-id]",
  relayActionType: "open-item-use-dialog"
});

const ITEM_USE_INTERCEPTION_STATE = {
  strategy: "uninitialized",
  sheetWrapperRegistered: false,
  itemUseFallbackRegistered: false,
  activityUseWrappersRegistered: false,
  activityUseWrapperTargets: [],
  domFallbackEnabled: false
};

function getHtmlRoot(html, app) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (app?.element instanceof HTMLElement) return app.element;
  if (app?.element?.[0] instanceof HTMLElement) return app.element[0];
  return null;
}

function getSheetActor(app, data = {}) {
  return app?.actor ?? data?.actor ?? app?.document ?? app?.object ?? null;
}

function getInterceptionContext() {
  const currentUser = game.user ?? null;
  const currentUserId = currentUser?.id ?? null;
  const currentUserName = currentUser?.name ?? null;
  const primaryReceiverUserId = getPrimaryReceiverUserId();
  const interceptionEnabledSetting = isAutoInterceptItemUseEnabled();
  const isAuthorizedSender = isSenderAuthorized(currentUserId);
  const isReceiverSelf = Boolean(currentUserId && primaryReceiverUserId && (currentUserId === primaryReceiverUserId));
  const dnd5eActive = game.system.id === "dnd5e";

  return {
    dnd5eActive,
    interceptionEnabledSetting,
    currentUserId,
    currentUserName,
    primaryReceiverUserId,
    isAuthorizedSender,
    isReceiverSelf,
    canRelay: dnd5eActive && interceptionEnabledSetting && Boolean(primaryReceiverUserId) && isAuthorizedSender && !isReceiverSelf
  };
}

function getInterceptionInactiveReason(context) {
  if (!context.dnd5eActive) return "non-dnd5e-system";
  if (!context.interceptionEnabledSetting) return "client-setting-disabled";
  if (!context.primaryReceiverUserId) return "missing-primary-receiver";
  if (!context.isAuthorizedSender) return "unauthorized-sender";
  if (context.isReceiverSelf) return "current-user-is-primary-receiver";
  return "relay-context-inactive";
}

function buildRelayFailureResponse(itemUuid, error) {
  return {
    ok: false,
    reason: "relay-failed",
    handled: false,
    itemUuid,
    error: error?.message ?? String(error)
  };
}

function buildActivityRelayFailureResponse(itemUuid, activityUuid, error) {
  return {
    ok: false,
    reason: "relay-failed",
    handled: false,
    itemUuid,
    activityUuid,
    error: error?.message ?? String(error)
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findFirstTruePropertyPath(value, paths = []) {
  if (!isPlainObject(value)) return null;

  for (const path of paths) {
    if (foundry.utils.getProperty(value, path) === true) return path;
  }

  return null;
}

function findActivityUseFlagModuleId(configs = [], flagName) {
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

function getActivityUseSecondaryContext(activity, usage = {}, dialog = {}, message = {}) {
  const item = activity?.item ?? null;
  const rawConfig = item?.getFlag?.(SECONDARY_AOE_MODULE_ID, SECONDARY_AOE_FLAG_KEY) ?? {};
  const activityId = String(activity?.id ?? activity?._id ?? "");
  const configuredSecondaryActivityId = String(rawConfig?.secondaryActivityId ?? "");
  const usagePath = findFirstTruePropertyPath(usage, AOE_SECONDARY_CONTEXT_PATHS.usage);
  const dialogPath = findFirstTruePropertyPath(dialog, AOE_SECONDARY_CONTEXT_PATHS.dialog);
  const messagePath = findFirstTruePropertyPath(message, AOE_SECONDARY_CONTEXT_PATHS.message);
  const flagModuleId = findActivityUseFlagModuleId([usage, dialog, message], "aoeSecondaryExecution");
  const aoeSecondaryExecutionDetected = Boolean(usagePath || dialogPath || messagePath || flagModuleId);
  const aoeSecondaryExecutionSource = usagePath
    ? `usage:${usagePath}`
    : dialogPath
      ? `dialog:${dialogPath}`
      : messagePath
        ? `message:${messagePath}`
        : flagModuleId
          ? `flags.${flagModuleId}.aoeSecondaryExecution`
          : null;
  const matchesConfiguredSecondary = Boolean(
    configuredSecondaryActivityId
    && activityId
    && (configuredSecondaryActivityId === activityId)
  );

  return {
    aoeModuleActive: Boolean(game.modules?.get(SECONDARY_AOE_MODULE_ID)?.active),
    aoeEnabled: Boolean(rawConfig?.enabled),
    aoeTrigger: rawConfig?.trigger ?? null,
    configuredSecondaryActivityId,
    currentActivityId: activityId,
    currentActivityUuid: activity?.uuid ?? null,
    aoeSecondaryExecutionDetected,
    aoeSecondaryExecutionSource,
    aoeSecondaryFlagModuleId: flagModuleId ?? null,
    matchesConfiguredSecondary,
    shouldHighlight: Boolean(aoeSecondaryExecutionDetected || matchesConfiguredSecondary)
  };
}

function buildActivityUseDecisionLogData({
  activity,
  context,
  marker = null,
  relayPayload = null,
  secondaryContext = null,
  relayDecision = null,
  reason = null,
  relayAttempted = false,
  relaySucceeded = null,
  localUseSuppressed = false,
  wrappedCalled = false
} = {}) {
  const item = activity?.item ?? null;
  const resolvedSecondaryContext = secondaryContext ?? getActivityUseSecondaryContext(activity);

  return {
    interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
    wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
    itemUuid: item?.uuid ?? null,
    itemName: item?.name ?? null,
    activityUuid: activity?.uuid ?? null,
    activityId: String(activity?.id ?? activity?._id ?? ""),
    activityName: activity?.name ?? null,
    activityType: activity?.type ?? activity?.metadata?.type ?? null,
    currentUserId: context?.currentUserId ?? null,
    currentUserName: context?.currentUserName ?? null,
    primaryReceiverUserId: context?.primaryReceiverUserId ?? null,
    relayDecision,
    relayAttempted,
    relaySucceeded,
    localUseSuppressed,
    wrappedCalled,
    reason,
    markerSource: marker?.source ?? null,
    markerPath: marker?.path ?? null,
    sourceActorUuid: relayPayload?.sourceActorUuid ?? null,
    sourceTokenUuid: relayPayload?.sourceTokenUuid ?? null,
    targetTokenUuids: relayPayload?.targetTokenUuids ?? [],
    bridgeModuleId: relayPayload?.context?.bridgeModuleId ?? resolvedSecondaryContext.aoeSecondaryFlagModuleId ?? null,
    relayOrigin: relayPayload?.context?.relayOrigin ?? null,
    relayPayloadAoeSecondaryExecution: relayPayload?.aoeSecondaryExecution ?? null,
    aoeModuleActive: resolvedSecondaryContext.aoeModuleActive,
    aoeEnabled: resolvedSecondaryContext.aoeEnabled,
    aoeTrigger: resolvedSecondaryContext.aoeTrigger,
    configuredSecondaryActivityId: resolvedSecondaryContext.configuredSecondaryActivityId,
    currentActivityId: resolvedSecondaryContext.currentActivityId,
    currentActivityUuid: resolvedSecondaryContext.currentActivityUuid,
    aoeSecondaryExecutionDetected: resolvedSecondaryContext.aoeSecondaryExecutionDetected,
    aoeSecondaryExecutionSource: resolvedSecondaryContext.aoeSecondaryExecutionSource,
    aoeSecondaryFlagModuleId: resolvedSecondaryContext.aoeSecondaryFlagModuleId,
    matchesConfiguredSecondary: resolvedSecondaryContext.matchesConfiguredSecondary
  };
}

function getActivityUseWrapperProbes() {
  const activityTypes = globalThis.CONFIG?.DND5E?.activityTypes ?? {};

  return Object.entries(activityTypes).flatMap(([activityType, config]) => {
    const documentClass = config?.documentClass ?? null;
    const prototype = documentClass?.prototype ?? null;
    const inheritedPrototype = prototype ? Object.getPrototypeOf(prototype) : null;
    const useMethod = prototype?.use ?? null;

    if (typeof useMethod !== "function") return [];

    return [{
      activityType,
      documentClassName: documentClass?.name ?? null,
      wrapperTarget: `CONFIG.DND5E.activityTypes.${activityType}.documentClass.prototype.use`,
      hasUse: true,
      hasOwnUse: Boolean(prototype && Object.prototype.hasOwnProperty.call(prototype, "use")),
      inheritedFrom: inheritedPrototype?.constructor?.name ?? null
    }];
  });
}

async function relayInterceptedItemUse(item, interceptionMethod) {
  const context = getInterceptionContext();
  const itemUuid = item?.uuid ?? null;
  const itemName = item?.name ?? null;

  logDebug("Remote item use interception captured a DnD5e item usage request.", {
    interceptionMethod,
    itemUuid,
    itemName,
    currentUserId: context.currentUserId,
    currentUserName: context.currentUserName,
    primaryReceiverUserId: context.primaryReceiverUserId,
    interceptionEnabledSetting: context.interceptionEnabledSetting,
    isAuthorizedSender: context.isAuthorizedSender,
    relayAttempted: true,
    relayActionType: SHEET_ITEM_USE_INTERCEPTION_PLAN.relayActionType
  });

  const response = await sendAction({
    actionType: SHEET_ITEM_USE_INTERCEPTION_PLAN.relayActionType,
    itemUuid,
    context: {
      itemName
    }
  });

  logDebug("Remote item use interception relay completed.", {
    interceptionMethod,
    itemUuid,
    itemName,
    currentUserId: context.currentUserId,
    currentUserName: context.currentUserName,
    primaryReceiverUserId: context.primaryReceiverUserId,
    interceptionEnabledSetting: context.interceptionEnabledSetting,
    isAuthorizedSender: context.isAuthorizedSender,
    relayAttempted: true,
    relaySucceeded: Boolean(response?.ok),
    response
  });

  return response;
}

async function actorSheetItemUseInterceptionWrapper(wrapped, item, options = {}) {
  const context = getInterceptionContext();
  const itemUuid = item?.uuid ?? null;
  const itemName = item?.name ?? null;

  if (!context.canRelay) {
    logDebug("Actor sheet _onUseItem wrapper left native local behavior in place.", {
      interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: false,
      relaySucceeded: false,
      localUseSuppressed: false,
      wrappedCalled: true,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      reason: getInterceptionInactiveReason(context)
    });

    return wrapped.call(this, item, options);
  }

  if (!itemUuid) {
    logDebug("Actor sheet _onUseItem wrapper could not resolve an item UUID and will leave native local behavior in place.", {
      interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: false,
      relaySucceeded: false,
      localUseSuppressed: false,
      wrappedCalled: true,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled
    });

    return wrapped.call(this, item, options);
  }

  try {
    const response = await relayInterceptedItemUse(item, SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod);

    logDebug("Actor sheet _onUseItem wrapper suppressed local item use after successful remote relay.", {
      interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: true,
      relaySucceeded: Boolean(response?.ok),
      localUseSuppressed: true,
      wrappedCalled: false,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      response
    });

    return response;
  } catch (error) {
    logWarning("Actor sheet _onUseItem wrapper relay failed after local use was suppressed.", {
      interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: true,
      relaySucceeded: false,
      localUseSuppressed: true,
      wrappedCalled: false,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      error: error?.message ?? String(error)
    });

    return buildRelayFailureResponse(itemUuid, error);
  }
}

async function itemUseInterceptionWrapper(wrapped, usage = {}, dialog = {}, message = {}) {
  const context = getInterceptionContext();
  const item = this;
  const itemUuid = item?.uuid ?? null;
  const itemName = item?.name ?? null;

  if (!context.canRelay) {
    logDebug("Item.use fallback wrapper left native local behavior in place.", {
      interceptionMethod: ITEM_USE_FALLBACK_PLAN.wrapperMethod,
      wrapperType: ITEM_USE_FALLBACK_PLAN.wrapperType,
      itemUuid,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: false,
      relaySucceeded: false,
      localUseSuppressed: false,
      wrappedCalled: true,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      reason: getInterceptionInactiveReason(context)
    });

    return wrapped.call(this, usage, dialog, message);
  }

  if (!itemUuid) {
    logDebug("Item.use fallback wrapper could not resolve an item UUID and will leave native local behavior in place.", {
      interceptionMethod: ITEM_USE_FALLBACK_PLAN.wrapperMethod,
      wrapperType: ITEM_USE_FALLBACK_PLAN.wrapperType,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: false,
      relaySucceeded: false,
      localUseSuppressed: false,
      wrappedCalled: true,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled
    });

    return wrapped.call(this, usage, dialog, message);
  }

  try {
    const response = await relayInterceptedItemUse(item, ITEM_USE_FALLBACK_PLAN.wrapperMethod);

    logDebug("Item.use fallback wrapper returned the remote relay response without calling wrapped.", {
      interceptionMethod: ITEM_USE_FALLBACK_PLAN.wrapperMethod,
      wrapperType: ITEM_USE_FALLBACK_PLAN.wrapperType,
      itemUuid,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: true,
      relaySucceeded: Boolean(response?.ok),
      localUseSuppressed: true,
      wrappedCalled: false,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      response
    });

    return response;
  } catch (error) {
    logWarning("Item.use fallback wrapper relay failed after local use was suppressed.", {
      interceptionMethod: ITEM_USE_FALLBACK_PLAN.wrapperMethod,
      wrapperType: ITEM_USE_FALLBACK_PLAN.wrapperType,
      itemUuid,
      itemName,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      interceptionEnabledSetting: context.interceptionEnabledSetting,
      isAuthorizedSender: context.isAuthorizedSender,
      relayAttempted: true,
      relaySucceeded: false,
      localUseSuppressed: true,
      wrappedCalled: false,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      error: error?.message ?? String(error)
    });

    return buildRelayFailureResponse(itemUuid, error);
  }
}

async function activityUseInterceptionWrapper(wrapped, usage = {}, dialog = {}, message = {}) {
  const context = getInterceptionContext();
  const activity = this;
  const item = activity?.item ?? null;
  const itemUuid = item?.uuid ?? null;
  const itemName = item?.name ?? null;
  const activityUuid = activity?.uuid ?? null;
  const activityName = activity?.name ?? null;
  const activityType = activity?.type ?? activity?.metadata?.type ?? null;
  const marker = getRemoteActionExecutionMarker(usage, dialog, message);
  const secondaryContext = getActivityUseSecondaryContext(activity, usage, dialog, message);

  if (secondaryContext.shouldHighlight) {
    logInfo("Remote Action activity.use secondary-context observed.", buildActivityUseDecisionLogData({
      activity,
      context,
      marker,
      secondaryContext,
      relayDecision: "inspect",
      reason: "secondary-context-detected"
    }));
  }

  if (marker.found) {
    logInfo("Remote Action activity.use decision: anti-loop.", buildActivityUseDecisionLogData({
      activity,
      context,
      marker,
      secondaryContext,
      relayDecision: "anti-loop",
      reason: "remoteActionExecution-marker",
      wrappedCalled: true
    }));

    logDebug("Activity.use wrapper anti-loop marker detected. Native local execution will continue.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      activityUuid,
      activityName,
      activityType,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      relayDecision: "native-local",
      relayAttempted: false,
      wrappedCalled: true,
      markerSource: marker.source,
      markerPath: marker.path,
      reason: "remoteActionExecution-marker"
    });

    return wrapped.call(this, usage, dialog, message);
  }

  if (!context.canRelay) {
    logInfo("Remote Action activity.use decision: native.", buildActivityUseDecisionLogData({
      activity,
      context,
      marker,
      secondaryContext,
      relayDecision: "native",
      reason: getInterceptionInactiveReason(context),
      wrappedCalled: true
    }));

    logDebug("Activity.use wrapper left native local behavior in place.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      activityUuid,
      activityName,
      activityType,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      relayDecision: "native-local",
      relayAttempted: false,
      wrappedCalled: true,
      reason: getInterceptionInactiveReason(context)
    });

    return wrapped.call(this, usage, dialog, message);
  }

  if (!itemUuid || !activityUuid) {
    logInfo("Remote Action activity.use decision: native.", buildActivityUseDecisionLogData({
      activity,
      context,
      marker,
      secondaryContext,
      relayDecision: "native",
      reason: "missing-item-or-activity-uuid",
      wrappedCalled: true
    }));

    logDebug("Activity.use wrapper could not resolve item/activity UUIDs and will leave native local behavior in place.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      activityUuid,
      activityName,
      activityType,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      relayDecision: "native-local",
      relayAttempted: false,
      wrappedCalled: true,
      reason: "missing-item-or-activity-uuid"
    });

    return wrapped.call(this, usage, dialog, message);
  }

  const relayPayload = buildActivityUseRelayPayload(activity, usage, dialog, message, {
    interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod
  });

  logInfo("Remote Action activity.use decision: relay.", buildActivityUseDecisionLogData({
    activity,
    context,
    marker,
    relayPayload,
    secondaryContext,
    relayDecision: "relay",
    reason: "relay-to-primary-receiver",
    relayAttempted: true,
    wrappedCalled: false
  }));

  logDebug("Activity.use wrapper relaying activity execution to the primary receiver.", {
    interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
    wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
    itemUuid,
    itemName,
    activityUuid,
    activityName,
    activityType,
    currentUserId: context.currentUserId,
    currentUserName: context.currentUserName,
    primaryReceiverUserId: context.primaryReceiverUserId,
    relayDecision: "relay-remote",
    relayAttempted: true,
    wrappedCalled: false,
    sourceActorUuid: relayPayload.sourceActorUuid ?? null,
    sourceTokenUuid: relayPayload.sourceTokenUuid ?? null,
    targetTokenUuids: relayPayload.targetTokenUuids ?? [],
    aoeSecondaryExecution: relayPayload.aoeSecondaryExecution,
    bridgeModuleId: relayPayload.context?.bridgeModuleId ?? null
  });

  try {
    const response = await relayActivityUse(relayPayload);

    logDebug("Activity.use wrapper suppressed local activity use after remote relay.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      activityUuid,
      activityName,
      activityType,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      relayDecision: "relay-remote",
      relayAttempted: true,
      relaySucceeded: Boolean(response?.ok),
      localUseSuppressed: true,
      wrappedCalled: false,
      aoeSecondaryExecution: relayPayload.aoeSecondaryExecution,
      bridgeModuleId: relayPayload.context?.bridgeModuleId ?? null,
      response
    });

    return response;
  } catch (error) {
    logWarning("Activity.use wrapper relay failed after local activity use was suppressed.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      itemUuid,
      itemName,
      activityUuid,
      activityName,
      activityType,
      currentUserId: context.currentUserId,
      currentUserName: context.currentUserName,
      primaryReceiverUserId: context.primaryReceiverUserId,
      relayDecision: "relay-remote",
      relayAttempted: true,
      relaySucceeded: false,
      localUseSuppressed: true,
      wrappedCalled: false,
      error: error?.message ?? String(error)
    });

    return buildActivityRelayFailureResponse(itemUuid, activityUuid, error);
  }
}

function registerKnownCompatibleConflictIgnores(libWrapperApi) {
  if (!libWrapperApi?.ignore_conflicts) return;

  try {
    libWrapperApi.ignore_conflicts(
      MODULE_ID,
      KNOWN_COMPATIBLE_ITEM_USE_WRAPPER_IDS,
      ITEM_USE_FALLBACK_PLAN.wrapperTarget
    );

    logDebug("Registered libWrapper conflict ignores for known compatible Item.use wrappers.", {
      wrapperTarget: ITEM_USE_FALLBACK_PLAN.wrapperTarget,
      ignoredPackageIds: KNOWN_COMPATIBLE_ITEM_USE_WRAPPER_IDS
    });
  } catch (error) {
    logWarning("Unable to register libWrapper conflict ignores for Item.use.", {
      wrapperTarget: ITEM_USE_FALLBACK_PLAN.wrapperTarget,
      ignoredPackageIds: KNOWN_COMPATIBLE_ITEM_USE_WRAPPER_IDS,
      error: error?.message ?? String(error)
    });
  }
}

function updateDomFallbackState() {
  ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled = !ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered
    && !ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered;

  if (ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered) {
    ITEM_USE_INTERCEPTION_STATE.strategy = SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod;
    return;
  }

  if (ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered) {
    ITEM_USE_INTERCEPTION_STATE.strategy = ITEM_USE_FALLBACK_PLAN.wrapperMethod;
    return;
  }

  ITEM_USE_INTERCEPTION_STATE.strategy = DOM_FALLBACK_PLAN.method;
}

function getActorSheetWrapperProbe() {
  const baseActorSheet = globalThis.dnd5e?.applications?.actor?.BaseActorSheet ?? null;
  const onUseItem = baseActorSheet?.prototype?._onUseItem ?? null;

  return {
    wrapperTarget: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperTarget,
    dnd5eAvailable: Boolean(globalThis.dnd5e),
    hasApplicationsNamespace: Boolean(globalThis.dnd5e?.applications),
    hasActorNamespace: Boolean(globalThis.dnd5e?.applications?.actor),
    hasBaseActorSheetClass: Boolean(baseActorSheet),
    hasOnUseItem: typeof onUseItem === "function"
  };
}

function registerActorSheetUseInterceptionWrapper(libWrapperApi = globalThis.libWrapper) {
  if (game.system.id !== "dnd5e") return;
  if (ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered) return;

  const probe = getActorSheetWrapperProbe();

  logInfo("Remote Action actor sheet _onUseItem wrapper probe.", {
    interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
    wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
    ...probe
  });

  if (!libWrapperApi?.register) {
    ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered = false;
    updateDomFallbackState();
    return;
  }

  if (!probe.hasOnUseItem) {
    ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered = false;
    updateDomFallbackState();

    logWarning("Actor sheet _onUseItem interception wrapper registration deferred because the dnd5e sheet class is not ready yet.", {
      interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
      ...probe
    });
    return;
  }

  try {
    libWrapperApi.register(
      MODULE_ID,
      SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperTarget,
      actorSheetItemUseInterceptionWrapper,
      libWrapperApi.MIXED ?? SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType
    );
    ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered = true;

    logInfo("Registered actor sheet _onUseItem interception wrapper for Remote Action.", {
      interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
      ...probe
    });
  } catch (error) {
    ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered = false;
    logWarning("Actor sheet _onUseItem interception wrapper registration failed.", {
      interceptionMethod: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperType,
      ...probe,
      error: error?.message ?? String(error)
    });
  }

  updateDomFallbackState();
}

function registerItemUseInterceptionWrappers() {
  if (game.system.id !== "dnd5e") {
    ITEM_USE_INTERCEPTION_STATE.strategy = "disabled";
    ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets = [];
    ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled = false;
    return;
  }

  const libWrapperApi = globalThis.libWrapper;
  if (!libWrapperApi?.register) {
    ITEM_USE_INTERCEPTION_STATE.strategy = DOM_FALLBACK_PLAN.method;
    ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled = true;

    logWarning("libWrapper is not available. Remote Action will keep actor sheet DOM interception as fallback only.", {
      sheetWrapperTarget: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperTarget,
      itemUseWrapperTarget: ITEM_USE_FALLBACK_PLAN.wrapperTarget,
      domFallbackSelector: DOM_FALLBACK_PLAN.selector
    });

    return;
  }

  logInfo("Remote Action will register the actor sheet _onUseItem wrapper at ready once dnd5e sheet classes are available.", {
    wrapperTarget: SHEET_ITEM_USE_INTERCEPTION_PLAN.wrapperTarget,
    itemUseFallbackTarget: ITEM_USE_FALLBACK_PLAN.wrapperTarget
  });

  try {
    libWrapperApi.register(
      MODULE_ID,
      ITEM_USE_FALLBACK_PLAN.wrapperTarget,
      itemUseInterceptionWrapper,
      libWrapperApi.MIXED ?? ITEM_USE_FALLBACK_PLAN.wrapperType
    );
    registerKnownCompatibleConflictIgnores(libWrapperApi);
    ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered = true;

    logDebug("Registered Item.use fallback interception wrapper for Remote Action.", {
      interceptionMethod: ITEM_USE_FALLBACK_PLAN.wrapperMethod,
      wrapperType: ITEM_USE_FALLBACK_PLAN.wrapperType,
      wrapperTarget: ITEM_USE_FALLBACK_PLAN.wrapperTarget
    });
  } catch (error) {
    ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered = false;
    logWarning("Item.use fallback interception wrapper registration failed.", {
      interceptionMethod: ITEM_USE_FALLBACK_PLAN.wrapperMethod,
      wrapperType: ITEM_USE_FALLBACK_PLAN.wrapperType,
      wrapperTarget: ITEM_USE_FALLBACK_PLAN.wrapperTarget,
      error: error?.message ?? String(error)
    });
  }

  updateDomFallbackState();
}

function registerActivityUseInterceptionWrappers(libWrapperApi = globalThis.libWrapper) {
  if (game.system.id !== "dnd5e") {
    ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets = [];
    return;
  }

  if (!libWrapperApi?.register) {
    ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets = [];

    logWarning("libWrapper is not available. Remote Action cannot install activity.use wrappers.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType
    });
    return;
  }

  const probes = getActivityUseWrapperProbes();
  const alreadyRegisteredTargets = new Set(ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets);

  logInfo("Remote Action activity.use wrapper probe.", {
    interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
    wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
    discoveredTargets: probes.length,
    probes
  });

  if (!probes.length) {
    ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered = false;
    ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets = [];

    logWarning("No dnd5e activity.use targets were discovered for Remote Action.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType
    });
    return;
  }

  if (alreadyRegisteredTargets.size === probes.length) {
    ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered = true;

    logDebug("Remote Action activity.use wrappers were already registered.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      registeredCount: alreadyRegisteredTargets.size,
      wrapperTargets: Array.from(alreadyRegisteredTargets)
    });
    return;
  }

  const failedTargets = [];

  for (const probe of probes) {
    if (alreadyRegisteredTargets.has(probe.wrapperTarget)) continue;

    try {
      libWrapperApi.register(
        MODULE_ID,
        probe.wrapperTarget,
        activityUseInterceptionWrapper,
        libWrapperApi.MIXED ?? ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType
      );
      alreadyRegisteredTargets.add(probe.wrapperTarget);
    } catch (error) {
      failedTargets.push({
        ...probe,
        error: error?.message ?? String(error)
      });
    }
  }

  ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets = Array.from(alreadyRegisteredTargets);
  ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered = ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets.length > 0;

  if (ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered) {
    logInfo("Registered Remote Action activity.use wrappers.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      registeredCount: ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets.length,
      wrapperTargets: ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets
    });
  }

  if (failedTargets.length > 0) {
    logWarning("Some Remote Action activity.use wrapper registrations failed.", {
      interceptionMethod: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperMethod,
      wrapperType: ACTIVITY_USE_INTERCEPTION_PLAN.wrapperType,
      failedTargets
    });
  }
}

function resolveSheetItem(app, data, useElement) {
  const actor = getSheetActor(app, data);
  const itemRow = useElement.closest(DOM_FALLBACK_PLAN.itemRowSelector);
  const itemId = itemRow?.dataset?.itemId ?? null;
  const item = itemId ? actor?.items?.get?.(itemId) ?? null : null;

  return {
    actor,
    itemRow,
    itemId,
    item,
    itemUuid: item?.uuid ?? null
  };
}

function attachActorSheetInterceptor(app, html, data = {}) {
  if (!ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled) return;

  const root = getHtmlRoot(html, app);
  if (!root) {
    logDebug("Actor sheet DOM fallback interception skipped because no root element was found.", {
      appId: app?.appId ?? null,
      actorName: getSheetActor(app, data)?.name ?? null
    });
    return;
  }

  app._remoteActionUseInterceptorAbort?.abort?.();
  const abortController = new AbortController();
  app._remoteActionUseInterceptorAbort = abortController;

  const actor = getSheetActor(app, data);
  const interceptionContext = getInterceptionContext();

  logDebug("Attaching actor sheet DOM fallback item use interception listener.", {
    appId: app?.appId ?? null,
    actorName: actor?.name ?? null,
    actorUuid: actor?.uuid ?? null,
    interceptionMethod: DOM_FALLBACK_PLAN.method,
    interceptionPlan: DOM_FALLBACK_PLAN,
    domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
    interceptionContext
  });

  root.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const useElement = target?.closest?.(DOM_FALLBACK_PLAN.selector) ?? null;
    if (!useElement) return;

    const clickContext = getInterceptionContext();
    if (!clickContext.canRelay) {
      logDebug("Actor sheet DOM fallback interception left native local behavior in place.", {
        interceptionMethod: DOM_FALLBACK_PLAN.method,
        itemUuid: null,
        currentUserId: clickContext.currentUserId,
        currentUserName: clickContext.currentUserName,
        primaryReceiverUserId: clickContext.primaryReceiverUserId,
        interceptionEnabledSetting: clickContext.interceptionEnabledSetting,
        isAuthorizedSender: clickContext.isAuthorizedSender,
        relayAttempted: false,
        relaySucceeded: false,
        localUseSuppressed: false,
        wrappedCalled: false,
        domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
        reason: getInterceptionInactiveReason(clickContext)
      });
      return;
    }

    const resolved = resolveSheetItem(app, data, useElement);
    if (!resolved.item || !resolved.itemUuid) {
      logDebug("Actor sheet DOM fallback interception could not resolve an item and will leave native local behavior in place.", {
        interceptionMethod: DOM_FALLBACK_PLAN.method,
        actorName: resolved.actor?.name ?? null,
        itemId: resolved.itemId,
        hasItemRow: Boolean(resolved.itemRow),
        hasItem: Boolean(resolved.item),
        currentUserId: clickContext.currentUserId,
        currentUserName: clickContext.currentUserName,
        primaryReceiverUserId: clickContext.primaryReceiverUserId,
        interceptionEnabledSetting: clickContext.interceptionEnabledSetting,
        isAuthorizedSender: clickContext.isAuthorizedSender,
        relayAttempted: false,
        relaySucceeded: false,
        localUseSuppressed: false,
        wrappedCalled: false,
        domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled
      });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    try {
      const response = await relayInterceptedItemUse(resolved.item, DOM_FALLBACK_PLAN.method);

      logDebug("Actor sheet DOM fallback interception suppressed local use after remote relay.", {
        interceptionMethod: DOM_FALLBACK_PLAN.method,
        itemName: resolved.item.name,
        itemUuid: resolved.itemUuid,
        currentUserId: clickContext.currentUserId,
        currentUserName: clickContext.currentUserName,
        primaryReceiverUserId: clickContext.primaryReceiverUserId,
        interceptionEnabledSetting: clickContext.interceptionEnabledSetting,
        isAuthorizedSender: clickContext.isAuthorizedSender,
        relayAttempted: true,
        relaySucceeded: Boolean(response?.ok),
        localUseSuppressed: true,
        wrappedCalled: false,
        domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
        response
      });
    } catch (error) {
      logWarning("Actor sheet DOM fallback interception relay failed after local use was suppressed.", {
        interceptionMethod: DOM_FALLBACK_PLAN.method,
        itemName: resolved.item.name,
        itemUuid: resolved.itemUuid,
        currentUserId: clickContext.currentUserId,
        currentUserName: clickContext.currentUserName,
        primaryReceiverUserId: clickContext.primaryReceiverUserId,
        interceptionEnabledSetting: clickContext.interceptionEnabledSetting,
        isAuthorizedSender: clickContext.isAuthorizedSender,
        relayAttempted: true,
        relaySucceeded: false,
        localUseSuppressed: true,
        wrappedCalled: false,
        domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
        error: error?.message ?? String(error)
      });
    }
  }, { capture: true, signal: abortController.signal });
}

export function registerUiHooks() {
  Hooks.once("setup", () => {
    registerItemUseInterceptionWrappers();
    registerActivityUseInterceptionWrappers();
  });

  Hooks.once("ready", () => {
    if (game.system.id !== "dnd5e") {
      notifyWarning(game.i18n.localize("REMOTE_ACTION.Errors.Dnd5eOnly"));
      return;
    }

    registerActorSheetUseInterceptionWrapper();
    registerActivityUseInterceptionWrappers();

    logDebug("UI hooks ready for dnd5e.");
    logDebug("Remote item use interception state prepared.", {
      strategy: ITEM_USE_INTERCEPTION_STATE.strategy,
      sheetWrapperRegistered: ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered,
      itemUseFallbackRegistered: ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered,
      activityUseWrappersRegistered: ITEM_USE_INTERCEPTION_STATE.activityUseWrappersRegistered,
      activityUseWrapperTargets: ITEM_USE_INTERCEPTION_STATE.activityUseWrapperTargets,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      knownCompatibleItemUseWrapperIds: KNOWN_COMPATIBLE_ITEM_USE_WRAPPER_IDS,
      sheetPlan: SHEET_ITEM_USE_INTERCEPTION_PLAN,
      itemUseFallbackPlan: ITEM_USE_FALLBACK_PLAN,
      activityUsePlan: ACTIVITY_USE_INTERCEPTION_PLAN,
      domFallbackPlan: DOM_FALLBACK_PLAN
    });
  });

  Hooks.on("renderActorSheetV2", (app, html, data) => {
    attachActorSheetInterceptor(app, html, data);
  });

  Hooks.on("renderActorSheet", (app, html, data) => {
    attachActorSheetInterceptor(app, html, data);
  });
}
