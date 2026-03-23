const MODULE_ID = "remote-action";

export function isDebugEnabled() {
  return Boolean(game?.settings?.get(MODULE_ID, "debug"));
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

export function notifyWarning(message, options = {}) {
  ui?.notifications?.warn(message, options);
  logWarning(message);
}
