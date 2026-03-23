import { MODULE_ID, registerSettings } from "./settings.js";
import { registerSocket } from "./socket.js";
import { registerUiHooks } from "./ui-hooks.js";
import { pingRelay, relayAction } from "./relay.js";
import { logDebug, logInfo, logWarning } from "./debug.js";

Hooks.once("init", () => {
  logInfo("Initializing module.");

  if (game.system.id !== "dnd5e") {
    logWarning("The module is designed for dnd5e only.");
  }

  registerSettings();
  registerUiHooks();

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      pingRelay,
      relayAction
    };
  }
});

Hooks.once("setup", () => {
  registerSocket();
  logDebug("Setup complete.");
});

Hooks.once("ready", () => {
  game.remoteAction = {
    pingRelay,
    relayAction
  };

  logDebug("Console API exposed on game.remoteAction.");
  logDebug("Ready.");
});