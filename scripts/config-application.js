import {
  MODULE_ID,
  SETTING_KEYS,
  getAuthorizedSenderUserIds,
  getPrimaryReceiverUserId,
  getRelevantRemoteActionUsers,
  stringifyAuthorizedSenderIds
} from "./settings.js";
import { logDebug } from "./debug.js";

function getRoleLabel(user) {
  const roleNames = {
    1: game.i18n.localize("REMOTE_ACTION.Roles.Player"),
    2: game.i18n.localize("REMOTE_ACTION.Roles.Trusted"),
    3: game.i18n.localize("REMOTE_ACTION.Roles.Assistant"),
    4: game.i18n.localize("REMOTE_ACTION.Roles.Gamemaster")
  };

  return roleNames[user.role] ?? game.i18n.localize("REMOTE_ACTION.Roles.Unknown");
}

export class RemoteActionUserConfigApplication extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "remote-action-user-config",
      classes: ["remote-action", "sheet"],
      template: "modules/remote-action/templates/user-config.hbs",
      width: 720,
      height: "auto",
      title: game.i18n.localize("REMOTE_ACTION.Settings.UserConfiguration.Title"),
      closeOnSubmit: true,
      submitOnChange: false,
      submitOnClose: false
    });
  }

  getData() {
    const primaryReceiverUserId = getPrimaryReceiverUserId();
    const authorizedSenderIds = new Set(getAuthorizedSenderUserIds());
    const users = getRelevantRemoteActionUsers().map((user) => ({
      id: user.id,
      name: user.name,
      role: getRoleLabel(user),
      isActive: user.active,
      isPrimaryReceiver: user.id === primaryReceiverUserId,
      isAuthorizedSender: authorizedSenderIds.has(user.id),
      isCurrentUser: user.id === game.user?.id
    }));

    return {
      users,
      hasUsers: users.length > 0,
      hasPrimaryReceiver: Boolean(primaryReceiverUserId),
      noUsersMessage: game.i18n.localize("REMOTE_ACTION.Settings.NoRelevantUsers")
    };
  }

  async _updateObject(event, formData) {
    const expanded = foundry.utils.expandObject(formData);
    const selectedPrimaryReceiver = expanded.primaryReceiverUserId ?? "";
    const authorizedFlags = expanded.authorizedSenderUserIds ?? {};
    const authorizedUserIds = Object.entries(authorizedFlags)
      .filter(([, isChecked]) => Boolean(isChecked))
      .map(([userId]) => userId);

    await game.settings.set(
      MODULE_ID,
      SETTING_KEYS.PRIMARY_RECEIVER,
      selectedPrimaryReceiver
    );

    await game.settings.set(
      MODULE_ID,
      SETTING_KEYS.AUTHORIZED_SENDERS,
      stringifyAuthorizedSenderIds(authorizedUserIds)
    );

    logDebug("Remote Action user configuration saved.", {
      currentUserId: game.user?.id,
      currentUserName: game.user?.name,
      primaryReceiverUserId: selectedPrimaryReceiver,
      authorizedUserIds
    });
  }
}