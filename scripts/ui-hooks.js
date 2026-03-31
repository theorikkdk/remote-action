import { notifyWarning, logDebug, logInfo, logWarning } from "./debug.js";
import { sendAction } from "./relay.js";
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
    itemUuid
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
  });

  Hooks.once("ready", () => {
    if (game.system.id !== "dnd5e") {
      notifyWarning(game.i18n.localize("REMOTE_ACTION.Errors.Dnd5eOnly"));
      return;
    }

    registerActorSheetUseInterceptionWrapper();

    logDebug("UI hooks ready for dnd5e.");
    logDebug("Remote item use interception state prepared.", {
      strategy: ITEM_USE_INTERCEPTION_STATE.strategy,
      sheetWrapperRegistered: ITEM_USE_INTERCEPTION_STATE.sheetWrapperRegistered,
      itemUseFallbackRegistered: ITEM_USE_INTERCEPTION_STATE.itemUseFallbackRegistered,
      domFallbackActive: ITEM_USE_INTERCEPTION_STATE.domFallbackEnabled,
      knownCompatibleItemUseWrapperIds: KNOWN_COMPATIBLE_ITEM_USE_WRAPPER_IDS,
      sheetPlan: SHEET_ITEM_USE_INTERCEPTION_PLAN,
      itemUseFallbackPlan: ITEM_USE_FALLBACK_PLAN,
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