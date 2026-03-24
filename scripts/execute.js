import { logDebug } from "./debug.js";

const NOTIFICATION_LEVELS = new Set(["info", "warn", "error"]);

function getRequestActionType(request) {
  return request?.actionType ?? request?.payload?.actionType ?? "unknown";
}

function buildBaseResponse(request, overrides = {}) {
  return {
    ok: true,
    handled: false,
    actionType: getRequestActionType(request),
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request,
    ...overrides
  };
}

function buildInvalidActionResponse(request, errors) {
  return {
    ok: false,
    handled: false,
    reason: "invalid-action-payload",
    errors,
    actionType: getRequestActionType(request),
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request
  };
}

function buildDocumentErrorResponse(request, reason, errors) {
  return {
    ok: false,
    handled: false,
    reason,
    errors,
    actionType: getRequestActionType(request),
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request
  };
}

function handlePingAction(request) {
  return buildBaseResponse(request, {
    handled: true,
    message: "Remote Action ping received by placeholder receiver."
  });
}

function validateNotifyRequest(request) {
  const errors = [];
  const context = request?.payload?.context;

  if (!context || typeof context !== "object" || Array.isArray(context)) {
    errors.push("context must be an object for actionType 'notify'.");
  }

  if (typeof context?.message !== "string" || !context.message.trim()) {
    errors.push(
      "context.message is required and must be a non-empty string for actionType 'notify'."
    );
  }

  if (
    context?.level !== undefined
    && (typeof context.level !== "string" || !NOTIFICATION_LEVELS.has(context.level))
  ) {
    errors.push("context.level must be one of: info, warn, error.");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      normalizedContext: null
    };
  }

  return {
    ok: true,
    errors: [],
    normalizedContext: {
      message: context.message.trim(),
      level: context.level ?? "info"
    }
  };
}

function validateDocumentUuidRequest(request, fieldName, actionType) {
  const uuid = request?.payload?.[fieldName];
  const errors = [];

  if (typeof uuid !== "string" || !uuid.trim()) {
    errors.push(`${fieldName} is required and must be a non-empty string for actionType '${actionType}'.`);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      normalizedUuid: null
    };
  }

  return {
    ok: true,
    errors: [],
    normalizedUuid: uuid.trim()
  };
}

function getSheetState(sheet) {
  return {
    hasSheet: Boolean(sheet),
    appId: sheet?.appId ?? null,
    rendered: Boolean(sheet?.rendered),
    minimized: Boolean(sheet?._minimized ?? sheet?.minimized),
    sheetClass: sheet?.constructor?.name ?? null,
    supportsBringToFront: typeof sheet?.bringToFront === "function",
    supportsBringToTop: typeof sheet?.bringToTop === "function",
    supportsMaximize: typeof sheet?.maximize === "function"
  };
}

async function makeSheetVisible(sheet) {
  const actions = [];
  const before = getSheetState(sheet);

  if (!sheet) {
    return {
      actions,
      before,
      after: before
    };
  }

  logDebug("Preparing sheet visibility update.", before);

  await sheet.render(true);
  actions.push("render");

  let currentState = getSheetState(sheet);

  if (currentState.minimized && currentState.supportsMaximize) {
    await sheet.maximize();
    actions.push("maximize");
    currentState = getSheetState(sheet);
  }

  if (currentState.supportsBringToFront) {
    sheet.bringToFront();
    actions.push("bringToFront");
  } else if (currentState.supportsBringToTop) {
    sheet.bringToTop();
    actions.push("bringToTop");
  }

  return {
    actions,
    before,
    after: getSheetState(sheet)
  };
}

function handleNotifyAction(request) {
  logDebug("Entering notify handler.", {
    actionType: getRequestActionType(request),
    request
  });

  const validation = validateNotifyRequest(request);
  if (!validation.ok) {
    logDebug("Notify action payload validation failed.", {
      actionType: getRequestActionType(request),
      errors: validation.errors,
      request
    });
    return buildInvalidActionResponse(request, validation.errors);
  }

  const { message, level } = validation.normalizedContext;

  logDebug("Displaying notify action on receiver.", {
    actionType: getRequestActionType(request),
    level,
    message
  });

  ui?.notifications?.[level]?.(message);

  return buildBaseResponse(request, {
    handled: true,
    message: "Remote Action notify displayed on receiver.",
    notification: {
      level,
      message
    }
  });
}

async function handleOpenDocumentSheetAction(request, options) {
  const {
    actionType,
    uuidField,
    expectedClass,
    expectedTypeLabel,
    responseKey,
    successMessage
  } = options;

  logDebug(`Entering ${actionType} handler.`, {
    actionType,
    uuidField,
    documentUuid: request?.payload?.[uuidField],
    request
  });

  const validation = validateDocumentUuidRequest(request, uuidField, actionType);
  if (!validation.ok) {
    logDebug(`${actionType} payload validation failed.`, {
      actionType,
      errors: validation.errors,
      request
    });
    return buildInvalidActionResponse(request, validation.errors);
  }

  const documentUuid = validation.normalizedUuid;
  const document = await fromUuid(documentUuid);

  logDebug("Resolved document sheet target.", {
    actionType,
    documentUuid,
    documentFound: Boolean(document),
    documentName: document?.name ?? null,
    documentType: document?.documentName ?? null
  });

  if (!document) {
    return buildDocumentErrorResponse(request, "document-not-found", [
      `No document found for ${uuidField} '${documentUuid}'.`
    ]);
  }

  if (!(document instanceof expectedClass)) {
    return buildDocumentErrorResponse(request, "invalid-document-type", [
      `UUID '${documentUuid}' does not resolve to an ${expectedTypeLabel}.`
    ]);
  }

  const sheet = document.sheet ?? null;
  const initialSheetState = getSheetState(sheet);

  logDebug("Document sheet instance resolved.", {
    actionType,
    documentUuid,
    documentName: document.name,
    expectedTypeLabel,
    hasSheet: initialSheetState.hasSheet,
    sheetClass: initialSheetState.sheetClass,
    sheetAppId: initialSheetState.appId,
    sheetRendered: initialSheetState.rendered,
    sheetMinimized: initialSheetState.minimized,
    supportsBringToFront: initialSheetState.supportsBringToFront,
    supportsBringToTop: initialSheetState.supportsBringToTop,
    supportsMaximize: initialSheetState.supportsMaximize
  });

  if (!sheet) {
    return buildDocumentErrorResponse(request, "sheet-unavailable", [
      `No sheet instance is available for ${uuidField} '${documentUuid}'.`
    ]);
  }

  const visibilityResult = await makeSheetVisible(sheet);

  logDebug("Document sheet visibility actions applied.", {
    actionType,
    documentUuid,
    documentName: document.name,
    expectedTypeLabel,
    sheetClass: visibilityResult.after.sheetClass,
    sheetAppId: visibilityResult.after.appId,
    renderedBefore: visibilityResult.before.rendered,
    minimizedBefore: visibilityResult.before.minimized,
    renderedAfter: visibilityResult.after.rendered,
    minimizedAfter: visibilityResult.after.minimized,
    supportsBringToFront: visibilityResult.after.supportsBringToFront,
    supportsBringToTop: visibilityResult.after.supportsBringToTop,
    supportsMaximize: visibilityResult.after.supportsMaximize,
    actions: visibilityResult.actions
  });

  return buildBaseResponse(request, {
    handled: true,
    message: successMessage,
    [responseKey]: {
      uuid: documentUuid,
      id: document.id,
      name: document.name
    },
    [`${responseKey}Name`]: document.name,
    sheetClass: visibilityResult.after.sheetClass,
    sheetAppId: visibilityResult.after.appId,
    sheetRendered: visibilityResult.after.rendered,
    sheetMinimized: visibilityResult.after.minimized,
    supportsBringToFront: visibilityResult.after.supportsBringToFront,
    supportsBringToTop: visibilityResult.after.supportsBringToTop,
    supportsMaximize: visibilityResult.after.supportsMaximize,
    actions: visibilityResult.actions
  });
}

async function handleOpenActorSheetAction(request) {
  return handleOpenDocumentSheetAction(request, {
    actionType: "open-actor-sheet",
    uuidField: "actorUuid",
    expectedClass: Actor,
    expectedTypeLabel: "Actor",
    responseKey: "actor",
    successMessage: "Remote Action opened actor sheet on receiver."
  });
}

async function handleOpenItemSheetAction(request) {
  return handleOpenDocumentSheetAction(request, {
    actionType: "open-item-sheet",
    uuidField: "itemUuid",
    expectedClass: Item,
    expectedTypeLabel: "Item",
    responseKey: "item",
    successMessage: "Remote Action opened item sheet on receiver."
  });
}

function handleUnknownAction(request) {
  const actionType = getRequestActionType(request);

  logDebug("Falling back to generic placeholder handler.", {
    actionType,
    request
  });

  return buildBaseResponse(request, {
    handled: false,
    message: `Remote Action placeholder: actionType '${actionType}' is not implemented yet.`
  });
}

export async function executeRemoteAction(request = {}) {
  const actionType = getRequestActionType(request);

  logDebug("Receiver placeholder executing remote action.", {
    currentUserId: game.user?.id,
    currentUserName: game.user?.name,
    actionType,
    request
  });

  switch (actionType) {
    case "ping":
      return handlePingAction(request);
    case "notify":
      return handleNotifyAction(request);
    case "open-actor-sheet":
      return handleOpenActorSheetAction(request);
    case "open-item-sheet":
      return handleOpenItemSheetAction(request);
    default:
      return handleUnknownAction(request);
  }
}