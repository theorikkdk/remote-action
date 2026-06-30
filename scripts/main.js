import { MODULE_ID, registerSettings } from "./settings.js";
import { registerSocket } from "./socket.js";
import { registerUiHooks } from "./ui-hooks.js";
import { debugConfig, pingRelay, relayAction, relayActivityUse, sendAction } from "./relay.js";
import { logDebug, logInfo, logWarning } from "./debug.js";
import { registerSecondaryAoeActivityObservers, registerSpellWorkflowComparisonHooks } from "./execute.js";

const REMOTE_ACTION_BUILD_FINGERPRINT = "2026-03-31-activity-use-wrapper-aoe-compat-01";

function logModuleFingerprint(stage) {
  const module = game.modules.get(MODULE_ID);

  logDebug("Remote Action module fingerprint.", {
    stage,
    moduleId: MODULE_ID,
    moduleVersion: module?.version ?? null,
    buildFingerprint: REMOTE_ACTION_BUILD_FINGERPRINT,
    systemId: game.system?.id ?? null,
    currentUserId: game.user?.id ?? null,
    currentUserName: game.user?.name ?? null
  });
}

Hooks.once("init", () => {
  logModuleFingerprint("init");
  logInfo("Initializing module.");

  if (game.system.id !== "dnd5e") {
    logWarning("The module is designed for dnd5e only.");
  }

  registerSettings();
  registerUiHooks();

  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = {
      debugConfig,
      pingRelay,
      relayAction,
      relayActivityUse,
      sendAction
    };
  }
});

Hooks.once("setup", () => {
  registerSocket();
  logDebug("Setup complete.");
});

Hooks.once("ready", () => {
  game.remoteAction = {
    debugConfig,
    pingRelay,
    relayAction,
    relayActivityUse,
    sendAction
  };

  registerSecondaryAoeActivityObservers();

  if (game.user?.isGM) {
    registerSpellWorkflowComparisonHooks();
  } else {
    logDebug("Remote Action local GM spell workflow comparison hooks skipped from main ready on non-GM client.", {
      currentUserId: game.user?.id ?? null,
      currentUserName: game.user?.name ?? null,
      isGM: Boolean(game.user?.isGM),
      monitorRegistrationPath: "main-ready-skip-non-gm",
      note: "Remote Action ignores non-GM comparison hooks on this client so TouchVTT and MidiItem note errors stay outside the spell workflow diagnosis."
    });
  }
  logModuleFingerprint("ready");
  logDebug("Console API exposed on game.remoteAction.");
  logDebug("Ready.");
});
