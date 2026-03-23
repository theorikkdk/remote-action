import { notifyWarning, logDebug } from "./debug.js";

export function registerUiHooks() {
  Hooks.once("ready", () => {
    if (game.system.id !== "dnd5e") {
      notifyWarning(game.i18n.localize("REMOTE_ACTION.Errors.Dnd5eOnly"));
      return;
    }

    logDebug("UI hooks ready for dnd5e.");
  });
}