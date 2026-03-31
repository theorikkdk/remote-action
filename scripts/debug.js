const MODULE_ID = "remote-action";

export function isDebugEnabled() {
  try {
    if (!game?.settings?.get) return false;
    return Boolean(game.settings.get(MODULE_ID, "debug"));
  } catch (_error) {
    return false;
  }
}

export function logDebug(...args) {
  if (!isDebugEnabled()) return;
  console.debug(`${MODULE_ID} |`, ...args);
}

export function logInfo(...args) {
  console.info(`${MODULE_ID} |`, ...args);
}

export function logWarning(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

export function notifyInfo(message, options = {}) {
  ui?.notifications?.info(message, options);
  logInfo(message);
}

export function notifyWarning(message, options = {}) {
  ui?.notifications?.warn(message, options);
  logWarning(message);
}