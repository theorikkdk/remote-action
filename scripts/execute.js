import { logDebug } from "./debug.js";

function buildBaseResponse(request, overrides = {}) {
  return {
    ok: true,
    handled: false,
    actionType: request.actionType ?? "unknown",
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request,
    ...overrides
  };
}

function handlePingAction(request) {
  return buildBaseResponse(request, {
    handled: true,
    message: "Remote Action ping received by placeholder receiver."
  });
}

function handleUnknownAction(request) {
  return buildBaseResponse(request, {
    handled: false,
    message: `Remote Action placeholder: actionType '${request.actionType ?? "unknown"}' is not implemented yet.`
  });
}

export async function executeRemoteAction(request = {}) {
  logDebug("Receiver placeholder executing remote action.", {
    currentUserId: game.user?.id,
    currentUserName: game.user?.name,
    request
  });

  switch (request.actionType) {
    case "ping":
      return handlePingAction(request);
    default:
      return handleUnknownAction(request);
  }
}