import { logDebug } from "./debug.js";

export async function executeRemoteAction(request = {}) {
  logDebug("Receiver placeholder executing remote action.", {
    currentUserId: game.user?.id,
    currentUserName: game.user?.name,
    request
  });

  // The actual DnD5e execution layer will be added in a later iteration.
  // For now we only acknowledge the request shape so the module wiring is ready.
  return {
    ok: true,
    handled: true,
    actionType: request.actionType ?? "unknown",
    message: "Remote Action ping received by placeholder receiver.",
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request
  };
}