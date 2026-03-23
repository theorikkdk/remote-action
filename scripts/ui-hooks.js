import { notifyWarning, logDebug } from "./debug.js";

export function registerUiHooks() {
  // Placeholder for future UI integration. The MVP only validates that the
  // module is loaded in a dnd5e world and keeps UI wiring centralized here.
  Hooks.once("ready", () => {
    if (game.system.id !== "dnd5e") {
      notifyWarning(game.i18n.localize("REMOTE_ACTION.Errors.Dnd5eOnly"));
      return;
    }

    logDebug("UI hooks ready for dnd5e.");
  });
}
