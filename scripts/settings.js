import { logDebug } from "./debug.js";

export const MODULE_ID = "remote-action";

export const SETTING_KEYS = {
  PRIMARY_RECEIVER: "primaryReceiverUserId",
  AUTHORIZED_SENDERS: "authorizedSenderUserIds",
  DEBUG: "debug"
};

function buildUserChoices() {
  const choices = { "": game.i18n.localize("REMOTE_ACTION.Settings.NoUser") };

  for (const user of game.users ?? []) {
    choices[user.id] = user.name;
  }

  return choices;
}

export function parseAuthorizedSenderIds(rawValue) {
  if (!rawValue) return [];

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function registerSettings() {
  const userChoices = buildUserChoices();

  game.settings.register(MODULE_ID, SETTING_KEYS.PRIMARY_RECEIVER, {
    name: "REMOTE_ACTION.Settings.PrimaryReceiver.Name",
    hint: "REMOTE_ACTION.Settings.PrimaryReceiver.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    choices: userChoices,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.AUTHORIZED_SENDERS, {
    name: "REMOTE_ACTION.Settings.AuthorizedSenders.Name",
    hint: "REMOTE_ACTION.Settings.AuthorizedSenders.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    requiresReload: false,
    onChange: (value) => {
      logDebug("Authorized senders updated", parseAuthorizedSenderIds(value));
    }
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.DEBUG, {
    name: "REMOTE_ACTION.Settings.Debug.Name",
    hint: "REMOTE_ACTION.Settings.Debug.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: false
  });
}

export function getPrimaryReceiverUserId() {
  return game.settings.get(MODULE_ID, SETTING_KEYS.PRIMARY_RECEIVER);
}

export function getAuthorizedSenderUserIds() {
  const rawValue = game.settings.get(MODULE_ID, SETTING_KEYS.AUTHORIZED_SENDERS);
  return parseAuthorizedSenderIds(rawValue);
}

export function isSenderAuthorized(userId) {
  if (!userId) return false;
  return getAuthorizedSenderUserIds().includes(userId);
}
