import { MODULE_ID, registerSettings, registerUserConfigurationMenu } from "./settings.js";
import { logDebug, logInfo, logWarning } from "./debug.js";

const REMOTE_ACTION_BUILD_FINGERPRINT = "2026-07-01-clean-roll-modes-01";
let runtimeModulesPromise = null;

function loadRuntimeModules() {
  if (!runtimeModulesPromise) {
    runtimeModulesPromise = Promise.all([
      import("./socket.js"),
      import("./ui-hooks.js"),
      import("./relay.js"),
      import("./execute.js")
    ]).then(([socket, uiHooks, relay, execute]) => ({
      socket,
      uiHooks,
      relay,
      execute
    }));
  }

  return runtimeModulesPromise;
}

function logRuntimeLoadError(stage, error) {
  logWarning("Remote Action runtime modules could not be loaded.", {
    stage,
    message: error?.message ?? String(error),
    stack: error?.stack ?? null
  });
}

function logModuleFingerprint(stage) {
  const module = game.modules.get(MODULE_ID);
  const payload = {
    stage,
    moduleId: MODULE_ID,
    moduleVersion: module?.version ?? null,
    buildFingerprint: REMOTE_ACTION_BUILD_FINGERPRINT,
    systemId: game.system?.id ?? null,
    currentUserId: game.user?.id ?? null,
    currentUserName: game.user?.name ?? null,
    isGM: Boolean(game.user?.isGM)
  };

  logDebug("Remote Action module fingerprint.", payload);
}

Hooks.once("init", () => {
  logModuleFingerprint("init");
  logInfo("Initializing module.");

  if (game.system.id !== "dnd5e") {
    logWarning("The module is designed for dnd5e only.");
  }

  registerSettings();

  import("./config-application.js")
    .then(({ RemoteActionUserConfigApplication }) => {
      registerUserConfigurationMenu(RemoteActionUserConfigApplication);
      logDebug("User configuration settings menu registered.");
    })
    .catch((error) => {
      logWarning("User configuration settings menu could not be registered.", {
        message: error?.message ?? String(error),
        stack: error?.stack ?? null
      });
    });

  loadRuntimeModules()
    .then(({ uiHooks, relay }) => {
      uiHooks.registerUiHooks();

      const module = game.modules.get(MODULE_ID);
      if (module) {
        module.api = {
          debugConfig: relay.debugConfig,
          pingRelay: relay.pingRelay,
          relayAction: relay.relayAction,
          relayActivityUse: relay.relayActivityUse,
          sendAction: relay.sendAction
        };
      }
    })
    .catch((error) => {
      logRuntimeLoadError("init", error);
    });
});

Hooks.once("setup", () => {
  loadRuntimeModules()
    .then(({ socket }) => {
      socket.registerSocket();
      logDebug("Setup complete.");
    })
    .catch((error) => {
      logRuntimeLoadError("setup", error);
    });
});

Hooks.once("ready", () => {
  loadRuntimeModules()
    .then(({ relay, execute }) => {
      game.remoteAction = {
        debugConfig: relay.debugConfig,
        pingRelay: relay.pingRelay,
        relayAction: relay.relayAction,
        relayActivityUse: relay.relayActivityUse,
        sendAction: relay.sendAction
      };

      execute.registerSecondaryAoeActivityObservers();

      if (game.user?.isGM) {
        execute.registerSpellWorkflowComparisonHooks();
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
    })
    .catch((error) => {
      logRuntimeLoadError("ready", error);
    });
});
