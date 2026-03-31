import { logDebug } from "./debug.js";
import { RemoteActionUserConfigApplication } from "./config-application.js";

export const MODULE_ID = "remote-action";

export const SETTING_KEYS = {
  PRIMARY_RECEIVER: "primaryReceiverUserId",
  AUTHORIZED_SENDERS: "authorizedSenderUserIds",
  DEBUG: "debug",
  EMITTER_NOTIFICATIONS: "emitterNotifications",
  AUTO_INTERCEPT_ITEM_USE: "autoInterceptItemUse",
  USE_ATTACK_ROLLS: "useFoundryAttackRolls",
  USE_DAMAGE_ROLLS: "useFoundryDamageRolls",
  USE_SAVE_ROLLS: "useFoundrySaveRolls"
};

export function getRelevantRemoteActionUsers() {
  const currentUserId = game.user?.id;
  const users = Array.from(game.users ?? []).filter((user) => !user.isGM);

  const currentUser = game.users?.get(currentUserId);
  if (currentUser && !users.some((user) => user.id === currentUser.id)) {
    users.push(currentUser);
  }

  return users.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseAuthorizedSenderIds(rawValue) {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue);
    if (Array.isArray(parsed)) {
      return parsed.map((value) => String(value).trim()).filter(Boolean);
    }
  } catch (_error) {
    // Keep backward compatibility with the previous comma-separated format.
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function stringifyAuthorizedSenderIds(userIds) {
  return JSON.stringify(
    (userIds ?? []).map((value) => String(value).trim()).filter(Boolean)
  );
}

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, "userConfiguration", {
    name: "REMOTE_ACTION.Settings.UserConfiguration.Name",
    hint: "REMOTE_ACTION.Settings.UserConfiguration.Hint",
    label: "REMOTE_ACTION.Settings.UserConfiguration.Label",
    icon: "fas fa-users-cog",
    type: RemoteActionUserConfigApplication,
    restricted: true
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.PRIMARY_RECEIVER, {
    name: "REMOTE_ACTION.Settings.PrimaryReceiver.Name",
    hint: "REMOTE_ACTION.Settings.PrimaryReceiver.Hint",
    scope: "world",
    config: false,
    type: String,
    default: "",
    requiresReload: false,
    onChange: (value) => {
      logDebug("Primary receiver updated", value);
    }
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.AUTHORIZED_SENDERS, {
    name: "REMOTE_ACTION.Settings.AuthorizedSenders.Name",
    hint: "REMOTE_ACTION.Settings.AuthorizedSenders.Hint",
    scope: "world",
    config: false,
    type: String,
    default: "[]",
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

  game.settings.register(MODULE_ID, SETTING_KEYS.EMITTER_NOTIFICATIONS, {
    name: "REMOTE_ACTION.Settings.EmitterNotifications.Name",
    hint: "REMOTE_ACTION.Settings.EmitterNotifications.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.AUTO_INTERCEPT_ITEM_USE, {
    name: "REMOTE_ACTION.Settings.AutoInterceptItemUse.Name",
    hint: "REMOTE_ACTION.Settings.AutoInterceptItemUse.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.USE_ATTACK_ROLLS, {
    name: "REMOTE_ACTION.Settings.UseAttackRolls.Name",
    hint: "REMOTE_ACTION.Settings.UseAttackRolls.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.USE_DAMAGE_ROLLS, {
    name: "REMOTE_ACTION.Settings.UseDamageRolls.Name",
    hint: "REMOTE_ACTION.Settings.UseDamageRolls.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, SETTING_KEYS.USE_SAVE_ROLLS, {
    name: "REMOTE_ACTION.Settings.UseSaveRolls.Name",
    hint: "REMOTE_ACTION.Settings.UseSaveRolls.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
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

export function isEmitterNotificationsEnabled() {
  return Boolean(game.settings.get(MODULE_ID, SETTING_KEYS.EMITTER_NOTIFICATIONS));
}

export function isAutoInterceptItemUseEnabled() {
  return Boolean(game.settings.get(MODULE_ID, SETTING_KEYS.AUTO_INTERCEPT_ITEM_USE));
}

export function getWorkflowSettings() {
  return {
    useAttackRolls: Boolean(game.settings.get(MODULE_ID, SETTING_KEYS.USE_ATTACK_ROLLS)),
    useDamageRolls: Boolean(game.settings.get(MODULE_ID, SETTING_KEYS.USE_DAMAGE_ROLLS)),
    useSaveRolls: Boolean(game.settings.get(MODULE_ID, SETTING_KEYS.USE_SAVE_ROLLS))
  };
}

export function getRemoteActionConfigSnapshot() {
  const currentUser = game.user ?? null;
  const primaryReceiverUserId = getPrimaryReceiverUserId();
  const primaryReceiver = primaryReceiverUserId ? game.users?.get(primaryReceiverUserId) ?? null : null;
  const authorizedSenderUserIds = getAuthorizedSenderUserIds();
  const authorizedSenderUsers = authorizedSenderUserIds
    .map((userId) => game.users?.get(userId) ?? { id: userId, name: "Unknown User" });

  return {
    currentUser: currentUser
      ? {
          id: currentUser.id,
          name: currentUser.name
        }
      : null,
    primaryReceiver: primaryReceiverUserId
      ? {
          id: primaryReceiverUserId,
          name: primaryReceiver?.name ?? "Unknown User"
        }
      : null,
    authorizedSenderUserIds,
    authorizedSenderUsers: authorizedSenderUsers.map((user) => ({
      id: user.id,
      name: user.name
    })),
    isCurrentUserAuthorized: currentUser
      ? authorizedSenderUserIds.includes(currentUser.id)
      : false,
    emitterNotifications: isEmitterNotificationsEnabled(),
    autoInterceptItemUse: isAutoInterceptItemUseEnabled(),
    workflowSettings: getWorkflowSettings()
  };
}

export function isSenderAuthorized(userId) {
  if (!userId) return false;
  return getAuthorizedSenderUserIds().includes(userId);
}