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
    default:
      return handleUnknownAction(request);
  }
}