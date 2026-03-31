import { logDebug, logInfo, logWarning } from "./debug.js";
import { getWorkflowSettings } from "./settings.js";

const NOTIFICATION_LEVELS = new Set(["info", "warn", "error"]);
const MANUAL_HIT_WORKFLOW_MODE = "manual-hit-foundry-damage";
const MIDI_SPELL_WORKFLOW_MODE = "midi-spell-complete-activity-use";
const REMOTE_SPELL_AUTO_ROLL_DAMAGE_MODE = "saveOnly";
const LOCAL_GM_SPELL_WORKFLOW_MODE = "local-gm-native-spell-use";
const REMOTE_TV_SPELL_WORKFLOW_SOURCE = "remote-tv";
const LOCAL_GM_SPELL_WORKFLOW_SOURCE = "local-gm";
const REMOTE_SPELL_ACTIVITY_MARKERS = new Map();
const LOCAL_GM_SPELL_WORKFLOW_MONITORS = new Map();
let spellWorkflowComparisonHooksRegistered = false;

function getRequestActionType(request) {
  return request?.actionType ?? request?.payload?.actionType ?? "unknown";
}

function buildBaseResponse(request, overrides = {}) {
  return {
    ok: true,
    handled: false,
    actionType: getRequestActionType(request),
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request,
    ...overrides
  };
}

function buildInvalidActionResponse(request, errors) {
  return {
    ok: false,
    handled: false,
    reason: "invalid-action-payload",
    errors,
    actionType: getRequestActionType(request),
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request
  };
}

function buildDocumentErrorResponse(request, reason, errors) {
  return {
    ok: false,
    handled: false,
    reason,
    errors,
    actionType: getRequestActionType(request),
    receiverUserId: game.user?.id ?? null,
    receiverUserName: game.user?.name ?? null,
    request
  };
}

function handlePingAction(request) {
  return buildBaseResponse(request, {
    handled: true,
    message: "Remote Action ping received by placeholder receiver."
  });
}

function validateNotifyRequest(request) {
  const errors = [];
  const context = request?.payload?.context;

  if (!context || typeof context !== "object" || Array.isArray(context)) {
    errors.push("context must be an object for actionType 'notify'.");
  }

  if (typeof context?.message !== "string" || !context.message.trim()) {
    errors.push(
      "context.message is required and must be a non-empty string for actionType 'notify'."
    );
  }

  if (
    context?.level !== undefined
    && (typeof context.level !== "string" || !NOTIFICATION_LEVELS.has(context.level))
  ) {
    errors.push("context.level must be one of: info, warn, error.");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      normalizedContext: null
    };
  }

  return {
    ok: true,
    errors: [],
    normalizedContext: {
      message: context.message.trim(),
      level: context.level ?? "info"
    }
  };
}

function validateDocumentUuidRequest(request, fieldName, actionType) {
  const uuid = request?.payload?.[fieldName];
  const errors = [];

  if (typeof uuid !== "string" || !uuid.trim()) {
    errors.push(`${fieldName} is required and must be a non-empty string for actionType '${actionType}'.`);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      normalizedUuid: null
    };
  }

  return {
    ok: true,
    errors: [],
    normalizedUuid: uuid.trim()
  };
}

function getSheetState(sheet) {
  return {
    hasSheet: Boolean(sheet),
    appId: sheet?.appId ?? null,
    rendered: Boolean(sheet?.rendered),
    minimized: Boolean(sheet?._minimized ?? sheet?.minimized),
    sheetClass: sheet?.constructor?.name ?? null,
    supportsBringToFront: typeof sheet?.bringToFront === "function",
    supportsBringToTop: typeof sheet?.bringToTop === "function",
    supportsMaximize: typeof sheet?.maximize === "function"
  };
}

async function makeSheetVisible(sheet) {
  const actions = [];
  const before = getSheetState(sheet);

  if (!sheet) {
    return {
      actions,
      before,
      after: before
    };
  }

  logDebug("Preparing sheet visibility update.", before);

  await sheet.render(true);
  actions.push("render");

  let currentState = getSheetState(sheet);

  if (currentState.minimized && currentState.supportsMaximize) {
    await sheet.maximize();
    actions.push("maximize");
    currentState = getSheetState(sheet);
  }

  if (currentState.supportsBringToFront) {
    sheet.bringToFront();
    actions.push("bringToFront");
  } else if (currentState.supportsBringToTop) {
    sheet.bringToTop();
    actions.push("bringToTop");
  }

  return {
    actions,
    before,
    after: getSheetState(sheet)
  };
}

function getNewUiWindows(beforeIds) {
  const windows = Object.values(ui?.windows ?? {});
  return windows.filter((app) => !beforeIds.has(String(app.appId)));
}

function getNewChatMessages(beforeIds) {
  const messages = Array.from(game.messages ?? []);
  return messages.filter((message) => !beforeIds.has(String(message.id)));
}

function getActivitySummary(activity, usageConfig) {
  const requiresDialog = typeof activity?._requiresConfigurationDialog === "function"
    ? activity._requiresConfigurationDialog(usageConfig)
    : null;

  return {
    activityId: activity?.id ?? null,
    activityName: activity?.name ?? null,
    activityType: activity?.type ?? activity?.metadata?.type ?? activity?.constructor?.name ?? null,
    requiresDialog
  };
}

function summarizeWorkflowResult(result) {
  return {
    hasResult: Boolean(result),
    resultKeys: result ? Object.keys(result) : [],
    messageId: result?.message?.id ?? null,
    hasMessage: Boolean(result?.message),
    effectCount: Array.isArray(result?.effects) ? result.effects.length : 0,
    templateCount: Array.isArray(result?.templates) ? result.templates.length : 0,
    hasUpdates: Boolean(result?.updates)
  };
}

function serializeToken(token) {
  return token
    ? {
        id: token.id ?? null,
        name: token.name ?? token.document?.name ?? null,
        uuid: token.document?.uuid ?? token.uuid ?? null,
        actorId: token.actor?.id ?? null,
        actorName: token.actor?.name ?? null
      }
    : null;
}

function serializeActor(actor) {
  return actor
    ? {
        id: actor.id ?? null,
        name: actor.name ?? null,
        uuid: actor.uuid ?? null
      }
    : null;
}

function getWorkflowParticipants(item) {
  const actor = item?.actor ?? null;
  const controlledTokens = Array.from(canvas?.tokens?.controlled ?? []);
  const controlledSourceToken = controlledTokens.find((token) => token.actor?.id === actor?.id) ?? null;
  const actorActiveTokens = actor?.getActiveTokens?.() ?? [];
  const fallbackSourceToken = actorActiveTokens[0] ?? null;
  const sourceToken = controlledSourceToken ?? fallbackSourceToken ?? null;
  const sourceResolution = controlledSourceToken
    ? "controlled-token"
    : fallbackSourceToken
      ? "actor-active-token-fallback"
      : "actor-only";
  const targets = Array.from(game.user?.targets ?? []).filter(Boolean);

  return {
    sourceActor: actor,
    sourceToken,
    sourceResolution,
    controlledTokens,
    targets
  };
}

function getMidiQolApi() {
  if (!game.modules?.get("midi-qol")?.active) return null;
  if (globalThis.MidiQOL?.DamageOnlyWorkflow) return globalThis.MidiQOL;
  return game.modules.get("midi-qol")?.api ?? null;
}

function getPrimaryDamageType(activity, roll) {
  const rollType = roll?.options?.type;
  if (rollType) return rollType;

  const activityDamageParts = activity?.damage?.parts ?? [];
  const firstTypes = activityDamageParts[0]?.types;
  if (Array.isArray(firstTypes) && firstTypes.length > 0) return firstTypes[0];
  if (firstTypes instanceof Set && firstTypes.size > 0) return Array.from(firstTypes)[0];

  return "";
}

async function waitForUiTick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForWorkflowUi() {
  await waitForUiTick();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function focusChatPanel(message, context = {}) {
  const sidebar = ui?.sidebar;
  const chat = ui?.chat;
  const actions = [];

  if (typeof sidebar?.activateTab === "function") {
    sidebar.activateTab("chat");
    actions.push("activateChatTab");
  }

  if (typeof chat?.scrollBottom === "function") {
    chat.scrollBottom();
    actions.push("scrollChatBottom");
  }

  logDebug("Focused chat panel for remote action workflow.", {
    messageId: message?.id ?? null,
    messageUuid: message?.uuid ?? null,
    chatFocusActions: actions,
    ...context
  });

  return actions;
}

function shouldUseManualHitDamageWorkflow(item, activity, workflowSettings) {
  const isWeaponAttack = (item?.type === "weapon") && ((activity?.type ?? activity?.metadata?.type) === "attack");
  return isWeaponAttack && !workflowSettings.useAttackRolls && workflowSettings.useDamageRolls;
}

function getSpellWorkflowBranchProbe(item, activity, midiApi) {
  const activityType = activity?.type ?? activity?.metadata?.type ?? null;
  const activityMetadataType = activity?.metadata?.type ?? null;
  const isSpellItem = (item?.type === "spell") || Boolean(activity?.isSpell);
  const hasTemplate = Boolean(activity?.target?.template?.type);
  const templateType = activity?.target?.template?.type ?? null;
  const isSaveActivity = activityType === "save";
  const hasCompleteActivityUse = typeof midiApi?.completeActivityUse === "function";

  return {
    itemType: item?.type ?? null,
    activityType,
    activityMetadataType,
    isSpellItem,
    hasTemplate,
    templateType,
    isSaveActivity,
    hasCompleteActivityUse,
    shouldUseMidiSpellWorkflow: hasCompleteActivityUse && isSpellItem && (hasTemplate || isSaveActivity)
  };
}

function shouldUseMidiSpellWorkflow(item, activity, midiApi) {
  return getSpellWorkflowBranchProbe(item, activity, midiApi).shouldUseMidiSpellWorkflow;
}

function shouldForceRemoteSpellDamageRoll(activity, activitySummary, workflowSettings) {
  return Boolean(workflowSettings?.useDamageRolls)
    && activitySummary?.activityType === "save"
    && Boolean(activity?.target?.template?.type)
    && Boolean(activity?.hasDamage);
}

function buildRemoteSpellUsage(activity, activitySummary, workflowSettings) {
  const usage = { legacy: false };
  const shouldForceDamageRoll = shouldForceRemoteSpellDamageRoll(
    activity,
    activitySummary,
    workflowSettings
  );

  if (shouldForceDamageRoll) {
    foundry.utils.setProperty(
      usage,
      "midiOptions.workflowOptions.autoRollDamage",
      REMOTE_SPELL_AUTO_ROLL_DAMAGE_MODE
    );
    foundry.utils.setProperty(usage, "midiOptions.workflowOptions.fastForwardDamage", true);
    foundry.utils.setProperty(usage, "midiOptions.fastForwardDamage", true);
  }

  return {
    usage,
    shouldForceRemoteSpellDamageRoll: shouldForceDamageRoll,
    remoteSpellWorkflowOptions:
      foundry.utils.getProperty(usage, "midiOptions.workflowOptions") ?? {}
  };
}

function getSpellWorkflowMonitorLabel(monitorSource) {
  return monitorSource === LOCAL_GM_SPELL_WORKFLOW_SOURCE
    ? "Local GM spell workflow"
    : "Remote TV spell workflow";
}

function captureComparisonStack(label) {
  try {
    return new Error(label).stack ?? null;
  } catch (_error) {
    return null;
  }
}

function markRemoteSpellActivity(activityUuid) {
  if (!activityUuid) return;

  clearRemoteSpellActivity(activityUuid);

  const timeoutId = setTimeout(() => {
    REMOTE_SPELL_ACTIVITY_MARKERS.delete(activityUuid);
  }, 30000);

  REMOTE_SPELL_ACTIVITY_MARKERS.set(activityUuid, timeoutId);
}

function clearRemoteSpellActivity(activityUuid) {
  const timeoutId = REMOTE_SPELL_ACTIVITY_MARKERS.get(activityUuid);
  if (timeoutId) clearTimeout(timeoutId);
  REMOTE_SPELL_ACTIVITY_MARKERS.delete(activityUuid);
}

function isRemoteSpellActivity(activityUuid) {
  return Boolean(activityUuid) && REMOTE_SPELL_ACTIVITY_MARKERS.has(activityUuid);
}

function getWorkflowStateLabel(workflowState) {
  if (!workflowState) return null;
  return typeof workflowState === "function"
    ? (workflowState.name ?? "anonymous-workflow-state")
    : String(workflowState);
}

function getMidiWorkflowByActivityUuid(activityUuid) {
  return globalThis.MidiQOL?.Workflow?.getWorkflowByActivityUuid?.(activityUuid) ?? null;
}

function summarizeMidiWorkflow(workflow) {
  return {
    hasWorkflow: Boolean(workflow),
    workflowId: workflow?.id ?? null,
    workflowName: workflow?.workflowName ?? workflow?.constructor?.name ?? null,
    workflowCurrentAction: getWorkflowStateLabel(workflow?.currentAction),
    itemCardUuid: workflow?.itemCardUuid ?? null,
    templateUuid: workflow?.templateUuid ?? null,
    targetCount: workflow?.targets?.size ?? 0,
    hitTargetCount: workflow?.hitTargets?.size ?? 0,
    saveCount: workflow?.saves?.size ?? 0,
    failedSaveCount: workflow?.failedSaves?.size ?? 0,
    damageRollCount: Array.isArray(workflow?.damageRolls)
      ? workflow.damageRolls.length
      : (workflow?.damageRoll ? 1 : 0),
    hasDamageRoll: Boolean(workflow?.damageRoll)
  };
}

function getMidiWorkflowStateName(workflow) {
  if (!workflow?.currentAction) return null;

  const stateNames = [
    "WorkflowState_AwaitTemplate",
    "WorkflowState_TemplatePlaced",
    "WorkflowState_AoETargetConfirmation",
    "WorkflowState_ValidateRoll",
    "WorkflowState_PreambleComplete",
    "WorkflowState_WaitForAttackRoll"
  ];

  for (const stateName of stateNames) {
    if (workflow[stateName] === workflow.currentAction) return stateName;
  }

  return getWorkflowStateLabel(workflow.currentAction);
}

function summarizeResumeReturnValue(value) {
  if (value === undefined) return "undefined";
  if (value === null) return null;
  if (value?.currentAction || value?.workflowName || value?.id) {
    return summarizeMidiWorkflow(value);
  }
  if (typeof value === "function") {
    return value.name ?? "anonymous-function";
  }
  if (typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return String(value);
    }
  }
  return value;
}

function serializeDiagnosticValue(value) {
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function isModuleActive(moduleId) {
  return Boolean(game.modules?.get(moduleId)?.active);
}

function getSpellWorkflowModuleEnvironment() {
  return {
    midiQolActive: isModuleActive("midi-qol"),
    encounterPlusImporterActive: isModuleActive("encounterplus-importer"),
    tidy5eSheetActive: isModuleActive("tidy5e-sheet"),
    sheetOnlyActive: isModuleActive("sheet-only"),
    tokenMagicActive: isModuleActive("tokenmagic"),
    touchVttActive: isModuleActive("touch-vtt"),
    dnd5eSheetNotesActive: isModuleActive("dnd5e-sheet-notes")
  };
}

function getActiveUiWindowSummaries() {
  return Object.values(ui?.windows ?? {}).map((app) => ({
    appId: app?.appId ?? null,
    className: app?.constructor?.name ?? null,
    title: app?.title ?? app?.window?.title ?? null,
    rendered: Boolean(app?.rendered)
  }));
}

function getActiveGmSummaries() {
  return Array.from(game.users ?? [])
    .filter((user) => user?.active && user?.isGM)
    .map((user) => ({
      id: user.id ?? null,
      name: user.name ?? null,
      active: Boolean(user.active),
      isSelf: Boolean(user.isSelf)
    }));
}

function shouldTreatRemoteTvSpellProgressAsAuthorityHandoff(monitorSource) {
  if (monitorSource !== REMOTE_TV_SPELL_WORKFLOW_SOURCE) return false;
  if (game.user?.isGM) return false;
  return getActiveGmSummaries().length > 0;
}

function logSpellWorkflowCheckpoint({
  item,
  activity,
  attemptedMethod,
  workflowMode,
  monitorSource,
  monitorLabel,
  checkpoint,
  workflow,
  extra = {}
}) {
  const workflowState = getWorkflowStateLabel(workflow?.currentAction);
  const workflowAction = typeof workflow?.nameForState === "function"
    ? workflow.nameForState(workflow.currentAction)
    : workflowState;
  const workflowUuid = workflow?.uuid ?? workflow?.id ?? null;
  const checkpointStack = captureComparisonStack(
    `${monitorLabel} checkpoint ${checkpoint}`
  );
  const payload = {
    itemUuid: item?.uuid ?? null,
    itemName: item?.name ?? null,
    activityUuid: activity?.uuid ?? null,
    activityName: activity?.name ?? null,
    activityType: activity?.type ?? activity?.metadata?.type ?? null,
    attemptedMethod,
    workflowMode,
    monitorSource,
    checkpoint,
    workflowUuid,
    workflowState,
    workflowAction,
    isGM: Boolean(game.user?.isGM),
    moduleEnvironment: getSpellWorkflowModuleEnvironment(),
    checkpointStack,
    checkpointSerialized: serializeDiagnosticValue({
      checkpoint,
      workflowUuid,
      workflowState,
      workflowAction,
      isGM: Boolean(game.user?.isGM)
    }),
    ...extra
  };

  logDebug(`Remote spell workflow checkpoint: ${checkpoint}.`, payload);
  logDebug(`${monitorLabel} checkpoint: ${checkpoint}.`, payload);
}

function recordPreCheckSavesCheckpoint(state, checkpoint, workflow) {
  state.lastCheckpointBeforePreCheckSaves = checkpoint;
  state.lastCheckpointBeforePreCheckSavesWorkflowState = getWorkflowStateLabel(workflow?.currentAction);
  state.lastCheckpointBeforePreCheckSavesWorkflowAction = typeof workflow?.nameForState === "function"
    ? workflow.nameForState(workflow.currentAction)
    : state.lastCheckpointBeforePreCheckSavesWorkflowState;
}

function inferRemotePreCheckSavesStallReason(state) {
  if (state.lastCheckpointBeforePreCheckSaves) {
    return "stalled-after-" + state.lastCheckpointBeforePreCheckSaves;
  }
  if (state.workflowStateAfterResumeAttempt === "WorkflowState_PreambleComplete") {
    return "workflow-never-left-PreambleComplete-after-targetingComplete";
  }
  if (state.workflowStateAfterResumeAttempt === "WorkflowState_WaitForAttackRoll") {
    return "workflow-never-entered-WaitForDamageRoll-after-targetingComplete";
  }
  if (state.workflowStateAfterResumeAttempt === "WorkflowState_WaitForDamageRoll") {
    return "workflow-entered-WaitForDamageRoll-but-never-reached-WaitForSaves";
  }
  return "no-preCheckSaves-precursor-hook-fired";
}

function inferRemoteWaitForDamageRollStallReason(state) {
  if (state.shouldRollDamageAtWaitForDamageEntry === false) {
    return "workflow-entered-WaitForDamageRoll-with-shouldRollDamage-false";
  }
  if (!state.preRollDamageHookSeen) {
    return "activity.rollDamage-never-fired-from-WaitForDamageRoll";
  }
  if (state.preRollDamageHookSeen && !state.rollDamageHookSeen) {
    return "activity.rollDamage-started-but-never-resolved";
  }
  if (state.rollDamageHookSeen && !state.damageWorkflowStarted && !state.saveWorkflowStarted) {
    return "activity.rollDamage-resolved-but-workflow-never-unsuspended";
  }
  return inferRemotePreCheckSavesStallReason(state);
}

function selectRemoteSpellSaveTransition(workflow, templateDocument) {
  if (!workflow) {
    return {
      method: null,
      stateName: null,
      reason: "workflow-not-found",
      replayedState: null
    };
  }

  const currentStateName = getMidiWorkflowStateName(workflow);

  if (
    workflow.suspended
    && typeof workflow.unSuspend === "function"
    && workflow.currentAction === workflow.WorkflowState_AwaitTemplate
  ) {
    return {
      method: "unSuspend",
      stateName: currentStateName,
      reason: "resume-suspended-template-workflow",
      replayedState: currentStateName,
      context: {
        templateDocument,
        itemUseComplete: true
      }
    };
  }

  return {
    method: null,
    stateName: currentStateName,
    reason: "native-midi-post-template-continuation",
    replayedState: null
  };
}

function createSpellWorkflowMonitor({
  item,
  activity,
  participants,
  attemptedMethod,
  workflowMode,
  monitorSource = REMOTE_TV_SPELL_WORKFLOW_SOURCE
}) {
  const monitorLabel = getSpellWorkflowMonitorLabel(monitorSource);
  const monitorRegistrationPath = monitorSource === LOCAL_GM_SPELL_WORKFLOW_SOURCE
    ? "local-gm-preUseActivity"
    : "remote-tv-open-item-use-dialog";
  const state = {
    monitorSource,
    dialogOpened: false,
    templatePlaced: false,
    templateUuid: null,
    workflowStateAfterTemplate: null,
    workflowActionAfterTemplate: null,
    resumedAfterTemplate: false,
    resumeMethod: null,
    workflowFound: false,
    workflowUuid: null,
    workflowActivityUuid: null,
    workflowStateBeforeResume: null,
    workflowActionBeforeResume: null,
    hasUnSuspend: false,
    hasPerformState: false,
    resumeMethodChosen: null,
    unSuspendCalled: false,
    performStateCalled: false,
    resumeResult: null,
    workflowStateAfterResumeAttempt: null,
    workflowSuspended: false,
    replayedState: null,
    subsequentWorkflowTriggered: false,
    saveWorkflowStarted: false,
    saveWorkflowState: null,
    saveWorkflowAction: null,
    saveWorkflowTriggerStack: null,
    lastCheckpointBeforePreCheckSaves: null,
    lastCheckpointBeforePreCheckSavesWorkflowState: null,
    lastCheckpointBeforePreCheckSavesWorkflowAction: null,
    waitForDamageRollEntered: false,
    waitForDamageRollExited: false,
    waitForDamageRollStateAtEntry: null,
    waitForDamageRollActionAtEntry: null,
    shouldRollDamageAtWaitForDamageEntry: null,
    workflowSuspendedAtWaitForDamageEntry: null,
    preRollDamageHookSeen: false,
    rollDamageHookSeen: false,
    damageWorkflowStarted: false,
    damageRollCount: 0,
    finalResult: null,
    savePhaseAbsenceLogged: false
  };

  const hookRegistrations = [];
  const registerHook = (hookName, callback) => {
    const hookId = Hooks.on(hookName, callback);
    hookRegistrations.push([hookName, hookId]);
  };

  logDebug("Remote spell workflow monitor registered.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activity?.name ?? null,
    activityType: activity?.type ?? activity?.metadata?.type ?? null,
    attemptedMethod,
    workflowMode,
    isGM: Boolean(game.user?.isGM),
    monitorRegistrationPath,
    moduleEnvironment: getSpellWorkflowModuleEnvironment(),
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    targets: participants.targets.map(serializeToken),
  });

  logDebug(`${monitorLabel} monitor registered.`, {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activity?.name ?? null,
    activityType: activity?.type ?? activity?.metadata?.type ?? null,
    attemptedMethod,
    workflowMode,
    monitorSource,
    isGM: Boolean(game.user?.isGM),
    monitorRegistrationPath,
    moduleEnvironment: getSpellWorkflowModuleEnvironment(),
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    targets: participants.targets.map(serializeToken),
  });

  registerHook("dnd5e.postUseActivity", (hookActivity, usageConfig, results) => {
    if (hookActivity?.uuid !== activity?.uuid) return;

    state.subsequentWorkflowTriggered = usageConfig?.subsequentActions !== false;

    logDebug("Remote spell workflow post-use hook fired.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activity.name,
      activityType: activity.type ?? activity.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      subsequentWorkflowTriggered: state.subsequentWorkflowTriggered,
      resultSummary: summarizeWorkflowResult(results),
      usageConfig
    });
  });

  registerHook("createMeasuredTemplate", (templateDocument) => {
    const origin = templateDocument?.getFlag?.("dnd5e", "origin")
      ?? templateDocument?.flags?.dnd5e?.origin
      ?? null;
    const templateItemUuid = templateDocument?.getFlag?.("dnd5e", "item")
      ?? templateDocument?.flags?.dnd5e?.item
      ?? null;

    logDebug("Remote spell workflow raw template hook fired.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      templateDocumentUuid: templateDocument?.uuid ?? null,
      templateOrigin: origin,
      templateItemUuid,
      originMatchesActivity: origin === activity?.uuid,
      itemMatchesTemplate: templateItemUuid === item.uuid
    });

    if (origin !== activity?.uuid) return;

    logDebug("Remote spell workflow raw template hook matched activity.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      attemptedMethod,
      workflowMode,
      templateDocumentUuid: templateDocument?.uuid ?? null,
      templateOrigin: origin
    });

    state.templatePlaced = true;
    state.templateUuid = templateDocument?.uuid ?? null;

    logDebug("Remote spell workflow template placed.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activity.name,
      activityType: activity.type ?? activity.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      templatePlaced: state.templatePlaced,
      templateUuid: state.templateUuid,
      workflowStateAfterTemplate: state.workflowStateAfterTemplate,
      resumedAfterTemplate: state.resumedAfterTemplate,
      resumeMethod: state.resumeMethod
    });

    setTimeout(async () => {
      logDebug("Remote spell workflow entering post-template resume callback.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityUuid: activity?.uuid ?? null,
        activityName: activity?.name ?? null,
        attemptedMethod,
        workflowMode,
        templateUuid: state.templateUuid
      });

      const workflow = getMidiWorkflowByActivityUuid(activity?.uuid);
      logSpellWorkflowCheckpoint({
        item,
        activity,
        attemptedMethod,
        workflowMode,
        monitorSource,
        monitorLabel,
        checkpoint: "post-template-resume-callback-entered",
        workflow,
        extra: {
          templateUuid: state.templateUuid,
          templatePlaced: state.templatePlaced,
          monitorRegistrationPath
        }
      });
      const workflowSummary = summarizeMidiWorkflow(workflow);
      const workflowStateBeforeResume = workflowSummary.workflowCurrentAction;
      const workflowActionBeforeResume = typeof workflow?.nameForState === "function"
        ? workflow.nameForState(workflow.currentAction)
        : workflowStateBeforeResume;
      const workflowUuid = workflow?.uuid ?? workflow?.id ?? null;
      const workflowActivityUuid = workflow?.activity?.uuid ?? null;
      const hasUnSuspend = typeof workflow?.unSuspend === "function";
      const hasPerformState = typeof workflow?.performState === "function";

      state.workflowFound = Boolean(workflow);
      state.workflowUuid = workflowUuid;
      state.workflowActivityUuid = workflowActivityUuid;
      state.workflowStateBeforeResume = workflowStateBeforeResume;
      state.workflowActionBeforeResume = workflowActionBeforeResume;
      state.workflowStateAfterTemplate = workflowSummary.workflowCurrentAction;
      state.hasUnSuspend = hasUnSuspend;
      state.hasPerformState = hasPerformState;
      state.workflowSuspended = Boolean(workflow?.suspended);

      logDebug("Remote spell workflow resume context captured.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityUuid: activity?.uuid ?? null,
        workflowFound: state.workflowFound,
        workflowUuid: state.workflowUuid,
        activityUuidFromWorkflow: state.workflowActivityUuid,
        workflowStateBeforeResume: state.workflowStateBeforeResume,
        workflowActionBeforeResume: state.workflowActionBeforeResume,
        hasUnSuspend: state.hasUnSuspend,
        hasPerformState: state.hasPerformState,
        workflowSuspended: state.workflowSuspended,
        replayedState: state.replayedState,
        workflowSummary,
        workflowStateBeforeResumeText: String(state.workflowStateBeforeResume),
        workflowActionBeforeResumeText: String(state.workflowActionBeforeResume),
        isGM: Boolean(game.user?.isGM),
        monitorRegistrationPath,
        resumeContextSerialized: serializeDiagnosticValue({
          workflowFound: state.workflowFound,
          workflowUuid: state.workflowUuid,
          workflowStateBeforeResume: state.workflowStateBeforeResume,
          workflowActionBeforeResume: state.workflowActionBeforeResume,
          hasUnSuspend: state.hasUnSuspend,
          hasPerformState: state.hasPerformState,
          workflowSuspended: state.workflowSuspended,
          replayedState: state.replayedState,
          isGM: Boolean(game.user?.isGM),
          monitorRegistrationPath
        })
      });

      let resumeMethod = "native-activity-use-no-manual-resume";
      let resumeMethodChosen = "native-activity-use-no-manual-resume";
      let unSuspendCalled = false;
      let performStateCalled = false;
      let resumeResult = null;

      if (monitorSource === REMOTE_TV_SPELL_WORKFLOW_SOURCE) {
        logDebug("Remote TV spell workflow exact remote call/state after TemplatePlaced.", {
          itemUuid: item.uuid,
          itemName: item.name,
          activityUuid: activity?.uuid ?? null,
          activityName: activity?.name ?? null,
          activityType: activity?.type ?? activity?.metadata?.type ?? null,
          workflowMode,
          templatePlaced: state.templatePlaced,
          workflowFound: state.workflowFound,
          workflowUuid: state.workflowUuid,
          workflowStateBeforeResume: state.workflowStateBeforeResume,
          workflowActionBeforeResume: state.workflowActionBeforeResume,
          workflowStateAfterTemplate: state.workflowStateAfterTemplate,
          workflowActionAfterTemplate: state.workflowActionAfterTemplate,
          authorityHandoffLikely: shouldTreatRemoteTvSpellProgressAsAuthorityHandoff(monitorSource),
          activeGMs: getActiveGmSummaries()
        });
      }

      try {
        if (!workflow) {
          resumeMethod = "workflow-not-found";
          resumeMethodChosen = "workflow-not-found";
        } else if (state.saveWorkflowStarted || state.damageWorkflowStarted) {
          state.resumedAfterTemplate = true;
          resumeMethod = "automatic-midi-continuation";
          resumeMethodChosen = "automatic-midi-continuation";
        } else if (monitorSource !== REMOTE_TV_SPELL_WORKFLOW_SOURCE) {
          state.resumedAfterTemplate = true;
          resumeMethod = "native-activity-use-owns-post-template-continuation";
          resumeMethodChosen = "native-activity-use-owns-post-template-continuation";
        } else {
          const remoteTrigger = selectRemoteSpellSaveTransition(workflow, templateDocument);
          state.replayedState = remoteTrigger.replayedState ?? null;

          logDebug("Remote TV spell workflow replacement save trigger selected.", {
            itemUuid: item.uuid,
            itemName: item.name,
            activityUuid: activity?.uuid ?? null,
            activityName: activity?.name ?? null,
            activityType: activity?.type ?? activity?.metadata?.type ?? null,
            workflowMode,
            workflowUuid: state.workflowUuid,
            workflowStateBeforeResume: state.workflowStateBeforeResume,
            workflowActionBeforeResume: state.workflowActionBeforeResume,
            replacementTriggerUsed: remoteTrigger.method,
            replacementStateName: remoteTrigger.stateName,
            whyRemoteDoesNotTransition: remoteTrigger.reason,
            hasUnSuspend,
            hasPerformState,
            workflowSuspended: state.workflowSuspended,
            replayedState: state.replayedState
          });

          state.resumedAfterTemplate = true;

          if (remoteTrigger.method === "unSuspend") {
            unSuspendCalled = true;
            resumeMethod = "remote-tv-unSuspend-after-template";
            resumeMethodChosen = remoteTrigger.reason ?? resumeMethod;
            resumeResult = await workflow.unSuspend(remoteTrigger.context ?? {});
          } else if (remoteTrigger.method === "performState") {
            performStateCalled = true;
            resumeMethod = `remote-tv-performState-${remoteTrigger.stateName}`;
            resumeMethodChosen = remoteTrigger.reason ?? resumeMethod;
            resumeResult = await workflow.performState(remoteTrigger.stateFn, remoteTrigger.context ?? {});
          } else {
            resumeMethod = `remote-tv-no-replacement-trigger: ${remoteTrigger.reason ?? "unknown"}`;
            resumeMethodChosen = remoteTrigger.reason ?? "remote-tv-no-replacement-trigger";
          }
        }
      } catch (error) {
        resumeMethod = `resume-error: ${error?.message ?? String(error)}`;
        resumeMethodChosen = resumeMethodChosen === "native-activity-use-no-manual-resume"
          ? "resume-error"
          : `${resumeMethodChosen}-error`;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      const workflowAfterResume = getMidiWorkflowByActivityUuid(activity?.uuid);
      const workflowSummaryAfterResume = summarizeMidiWorkflow(workflowAfterResume);
      state.workflowSuspended = Boolean(workflowAfterResume?.suspended ?? workflow?.suspended);
      state.workflowStateAfterResumeAttempt = workflowSummaryAfterResume.workflowCurrentAction;
      state.resumeMethod = resumeMethod;
      state.resumeMethodChosen = resumeMethodChosen;
      state.unSuspendCalled = unSuspendCalled;
      state.performStateCalled = performStateCalled;
      state.resumeResult = summarizeResumeReturnValue(resumeResult);

      logDebug("Remote spell workflow resume attempt finished.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityUuid: activity?.uuid ?? null,
        workflowFound: state.workflowFound,
        workflowUuid: state.workflowUuid,
        workflowStateBeforeResume: state.workflowStateBeforeResume,
        workflowSuspended: state.workflowSuspended,
        replayedState: state.replayedState,
        resumeMethodChosen: state.resumeMethodChosen,
        unSuspendCalled: state.unSuspendCalled,
        performStateCalled: state.performStateCalled,
        returnValue: state.resumeResult,
        workflowStateAfterResumeAttempt: state.workflowStateAfterResumeAttempt,
        workflowSummaryAfterResume,
        workflowStateBeforeResumeText: String(state.workflowStateBeforeResume),
        workflowStateAfterResumeAttemptText: String(state.workflowStateAfterResumeAttempt),
        resumeMethodChosenText: String(state.resumeMethodChosen),
        returnValueSerialized: serializeDiagnosticValue(state.resumeResult),
        isGM: Boolean(game.user?.isGM),
        monitorRegistrationPath
      });

      logSpellWorkflowCheckpoint({
        item,
        activity,
        attemptedMethod,
        workflowMode,
        monitorSource,
        monitorLabel,
        checkpoint: "post-template-resume-attempt-finished",
        workflow: workflowAfterResume,
        extra: {
          templateUuid: state.templateUuid,
          workflowStateBeforeResumeText: String(state.workflowStateBeforeResume),
          workflowStateAfterResumeAttemptText: String(state.workflowStateAfterResumeAttempt),
          resumeMethodChosenText: String(state.resumeMethodChosen),
          returnValueSerialized: serializeDiagnosticValue(state.resumeResult),
          monitorRegistrationPath
        }
      });

      logDebug("Remote spell workflow post-template resume check.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityName: activity.name,
        activityType: activity.type ?? activity.metadata?.type ?? null,
        attemptedMethod,
        workflowMode,
        sourceActor: serializeActor(participants.sourceActor),
        sourceToken: serializeToken(participants.sourceToken),
        targets: participants.targets.map(serializeToken),
        templatePlaced: state.templatePlaced,
        templateUuid: state.templateUuid,
        workflowFound: state.workflowFound,
        workflowUuid: state.workflowUuid,
        activityUuid: state.workflowActivityUuid,
        workflowStateBeforeResume: state.workflowStateBeforeResume,
        workflowActionBeforeResume: state.workflowActionBeforeResume,
        hasUnSuspend: state.hasUnSuspend,
        hasPerformState: state.hasPerformState,
        workflowSuspended: state.workflowSuspended,
        replayedState: state.replayedState,
        resumeMethodChosen: state.resumeMethodChosen,
        unSuspendCalled: state.unSuspendCalled,
        performStateCalled: state.performStateCalled,
        returnValue: state.resumeResult,
        workflowStateAfterResumeAttempt: state.workflowStateAfterResumeAttempt,
        workflowStateAfterTemplate: state.workflowStateAfterTemplate,
        resumedAfterTemplate: state.resumedAfterTemplate,
        resumeMethod,
        saveWorkflowStarted: state.saveWorkflowStarted,
        damageWorkflowStarted: state.damageWorkflowStarted,
        finalResult: state.finalResult,
        workflowSummary,
        workflowSummaryAfterResume,
        workflowStateBeforeResumeText: String(state.workflowStateBeforeResume),
        workflowStateAfterResumeAttemptText: String(state.workflowStateAfterResumeAttempt),
        resumeMethodChosenText: String(state.resumeMethodChosen),
        returnValueSerialized: serializeDiagnosticValue(state.resumeResult),
        isGM: Boolean(game.user?.isGM),
        monitorRegistrationPath
      });

      setTimeout(() => {
        if (state.saveWorkflowStarted || state.savePhaseAbsenceLogged) return;

        const stalledWorkflow = getMidiWorkflowByActivityUuid(activity?.uuid);
        const stalledWorkflowSummary = summarizeMidiWorkflow(stalledWorkflow);
        const stalledWorkflowAction = typeof stalledWorkflow?.nameForState === "function"
          ? stalledWorkflow.nameForState(stalledWorkflow.currentAction)
          : stalledWorkflowSummary.workflowCurrentAction;

        state.savePhaseAbsenceLogged = true;

        const authorityHandoffLikely = shouldTreatRemoteTvSpellProgressAsAuthorityHandoff(monitorSource);
        const savePhaseAbsencePayload = {
          itemUuid: item.uuid,
          itemName: item.name,
          activityUuid: activity?.uuid ?? null,
          activityName: activity?.name ?? null,
          activityType: activity?.type ?? activity?.metadata?.type ?? null,
          attemptedMethod,
          workflowMode,
          monitorSource,
          templatePlaced: state.templatePlaced,
          workflowUuid: state.workflowUuid,
          workflowStateBeforeResume: state.workflowStateBeforeResume,
          workflowStateAfterTemplate: state.workflowStateAfterTemplate,
          workflowActionAfterTemplate: state.workflowActionAfterTemplate,
          workflowStateAfterResumeAttempt: state.workflowStateAfterResumeAttempt,
          workflowSuspended: state.workflowSuspended,
          replayedState: state.replayedState,
          stalledWorkflowState: stalledWorkflowSummary.workflowCurrentAction,
          stalledWorkflowAction,
          saveWorkflowStarted: state.saveWorkflowStarted,
          damageWorkflowStarted: state.damageWorkflowStarted,
          finalResult: state.finalResult,
          lastCheckpointBeforePreCheckSaves: state.lastCheckpointBeforePreCheckSaves,
          lastCheckpointBeforePreCheckSavesWorkflowState: state.lastCheckpointBeforePreCheckSavesWorkflowState,
          lastCheckpointBeforePreCheckSavesWorkflowAction: state.lastCheckpointBeforePreCheckSavesWorkflowAction,
          exactHookCallThatShouldFirePreCheckSaves: "midi-qol.preWaitForSaves",
          whyRemoteNeverReachesPreCheckSaves: inferRemotePreCheckSavesStallReason(state),
          whyRemoteNeverReachesPostWaitForDamageRoll: inferRemoteWaitForDamageRollStallReason(state),
          shouldRollDamageAtEntry: state.shouldRollDamageAtWaitForDamageEntry,
          workflowSuspendedAtEntry: state.workflowSuspendedAtWaitForDamageEntry,
          preRollDamageHookSeen: state.preRollDamageHookSeen,
          rollDamageHookSeen: state.rollDamageHookSeen,
          waitForDamageRollEntered: state.waitForDamageRollEntered,
          waitForDamageRollExited: state.waitForDamageRollExited,
          stalledWorkflowSummary,
          workflowStateBeforeResumeText: String(state.workflowStateBeforeResume),
          workflowStateAfterResumeAttemptText: String(state.workflowStateAfterResumeAttempt),
          resumeMethodChosenText: String(state.resumeMethodChosen),
          returnValueSerialized: serializeDiagnosticValue(state.resumeResult),
          isGM: Boolean(game.user?.isGM),
          monitorRegistrationPath,
          authorityHandoffLikely,
          activeGMs: getActiveGmSummaries()
        };

        if (authorityHandoffLikely) {
          logDebug("Remote TV spell workflow local save-phase telemetry stopped after TemplatePlaced, but downstream resolution may be executing on an active GM client.", savePhaseAbsencePayload);
        } else {
          logWarning(`${monitorLabel} exact call that starts save phase is still absent after TemplatePlaced.`, savePhaseAbsencePayload);
        }
      }, 250);
    }, 150);
  });

  const preCheckSavesTransitionHooks = [
    "midi-qol.preWaitForAttackRoll",
    "midi-qol.postWaitForAttackRoll",
    "midi-qol.preWaitForDamageRoll",
    "midi-qol.postWaitForDamageRoll",
    "midi-qol.preDamageRollStarted",
    "midi-qol.postDamageRollStarted",
    "midi-qol.preDamageRollComplete",
    "midi-qol.postDamageRollComplete",
    "midi-qol.preWaitForSaves"
  ];

  for (const transitionHook of preCheckSavesTransitionHooks) {
    registerHook(transitionHook, (workflow) => {
      if (workflow?.activity?.uuid !== activity?.uuid) return;

      recordPreCheckSavesCheckpoint(state, transitionHook, workflow);

      logSpellWorkflowCheckpoint({
        item,
        activity,
        attemptedMethod,
        workflowMode,
        monitorSource,
        monitorLabel,
        checkpoint: transitionHook,
        workflow,
        extra: {
          templatePlaced: state.templatePlaced,
          templateUuid: state.templateUuid,
          lastCheckpointBeforePreCheckSaves: state.lastCheckpointBeforePreCheckSaves,
          lastCheckpointBeforePreCheckSavesWorkflowState: state.lastCheckpointBeforePreCheckSavesWorkflowState,
          lastCheckpointBeforePreCheckSavesWorkflowAction: state.lastCheckpointBeforePreCheckSavesWorkflowAction
        }
      });

      if (transitionHook === "midi-qol.preWaitForDamageRoll") {
        state.waitForDamageRollEntered = true;
        state.waitForDamageRollStateAtEntry = getWorkflowStateLabel(workflow?.currentAction);
        state.waitForDamageRollActionAtEntry = typeof workflow?.nameForState === "function"
          ? workflow.nameForState(workflow.currentAction)
          : state.waitForDamageRollStateAtEntry;
        state.shouldRollDamageAtWaitForDamageEntry = workflow?.shouldRollDamage ?? null;
        state.workflowSuspendedAtWaitForDamageEntry = Boolean(workflow?.suspended);

        if (monitorSource === REMOTE_TV_SPELL_WORKFLOW_SOURCE) {
          logDebug("Remote TV spell workflow exact call/state entering preWaitForDamageRoll.", {
            itemUuid: item.uuid,
            itemName: item.name,
            activityUuid: activity?.uuid ?? null,
            activityName: activity?.name ?? null,
            activityType: activity?.type ?? activity?.metadata?.type ?? null,
            attemptedMethod,
            workflowMode,
            workflowUuid: workflow?.uuid ?? workflow?.id ?? null,
            workflowStateAtEntry: state.waitForDamageRollStateAtEntry,
            workflowActionAtEntry: state.waitForDamageRollActionAtEntry,
            shouldRollDamageAtEntry: state.shouldRollDamageAtWaitForDamageEntry,
            workflowSuspendedAtEntry: state.workflowSuspendedAtWaitForDamageEntry,
            hasDamage: Boolean(activity?.hasDamage),
            hasSave: Boolean(activity?.save || activity?.check),
            hasAttack: Boolean(activity?.attack),
            rollOptions: workflow?.rollOptions ?? null,
            authorityHandoffLikely: shouldTreatRemoteTvSpellProgressAsAuthorityHandoff(monitorSource),
            activeGMs: getActiveGmSummaries()
          });

          setTimeout(() => {
            if (state.preRollDamageHookSeen || state.waitForDamageRollExited) return;

            const authorityHandoffLikely = shouldTreatRemoteTvSpellProgressAsAuthorityHandoff(monitorSource);
            const waitForDamageRollPayload = {
              itemUuid: item.uuid,
              itemName: item.name,
              activityUuid: activity?.uuid ?? null,
              activityName: activity?.name ?? null,
              activityType: activity?.type ?? activity?.metadata?.type ?? null,
              attemptedMethod,
              workflowMode,
              workflowUuid: workflow?.uuid ?? workflow?.id ?? null,
              workflowStateAtEntry: state.waitForDamageRollStateAtEntry,
              workflowActionAtEntry: state.waitForDamageRollActionAtEntry,
              shouldRollDamageAtEntry: state.shouldRollDamageAtWaitForDamageEntry,
              workflowSuspendedAtEntry: state.workflowSuspendedAtWaitForDamageEntry,
              preRollDamageHookSeen: state.preRollDamageHookSeen,
              rollDamageHookSeen: state.rollDamageHookSeen,
              waitForDamageRollExited: state.waitForDamageRollExited,
              whyRemoteNeverReachesPostWaitForDamageRoll: inferRemoteWaitForDamageRollStallReason(state),
              activeUiWindows: getActiveUiWindowSummaries(),
              authorityHandoffLikely,
              activeGMs: getActiveGmSummaries()
            };

            if (authorityHandoffLikely) {
              logDebug("Remote TV spell workflow local damage-roll telemetry stopped after preWaitForDamageRoll, but downstream resolution may be executing on an active GM client.", waitForDamageRollPayload);
            } else {
              logWarning("Remote TV spell workflow damage roll is still waiting after preWaitForDamageRoll.", waitForDamageRollPayload);
            }
          }, 250);
        }
      }

      if (transitionHook === "midi-qol.postWaitForDamageRoll") {
        state.waitForDamageRollExited = true;

        if (monitorSource === LOCAL_GM_SPELL_WORKFLOW_SOURCE) {
          logDebug("Local GM spell workflow exact call/state exiting postWaitForDamageRoll.", {
            itemUuid: item.uuid,
            itemName: item.name,
            activityUuid: activity?.uuid ?? null,
            activityName: activity?.name ?? null,
            activityType: activity?.type ?? activity?.metadata?.type ?? null,
            attemptedMethod,
            workflowMode,
            workflowUuid: workflow?.uuid ?? workflow?.id ?? null,
            workflowStateAtExit: getWorkflowStateLabel(workflow?.currentAction),
            workflowActionAtExit: typeof workflow?.nameForState === "function"
              ? workflow.nameForState(workflow.currentAction)
              : getWorkflowStateLabel(workflow?.currentAction),
            shouldRollDamageAtEntry: state.shouldRollDamageAtWaitForDamageEntry,
            preRollDamageHookSeen: state.preRollDamageHookSeen,
            rollDamageHookSeen: state.rollDamageHookSeen
          });
        }
      }

      if (transitionHook === "midi-qol.preWaitForSaves") {
        logDebug(monitorLabel + " last checkpoint before preCheckSaves.", {
          itemUuid: item.uuid,
          itemName: item.name,
          activityUuid: activity?.uuid ?? null,
          activityName: activity?.name ?? null,
          activityType: activity?.type ?? activity?.metadata?.type ?? null,
          attemptedMethod,
          workflowMode,
          monitorSource,
          isGM: Boolean(game.user?.isGM),
          exactHookCallThatShouldFirePreCheckSaves: transitionHook,
          lastCheckpointBeforePreCheckSaves: state.lastCheckpointBeforePreCheckSaves,
          lastCheckpointBeforePreCheckSavesWorkflowState: state.lastCheckpointBeforePreCheckSavesWorkflowState,
          lastCheckpointBeforePreCheckSavesWorkflowAction: state.lastCheckpointBeforePreCheckSavesWorkflowAction
        });
      }
    });
  }

  registerHook("midi-qol.targetingComplete", (workflow) => {
    if (workflow?.activity?.uuid !== activity?.uuid) return;

    state.resumedAfterTemplate = true;
    state.workflowStateAfterTemplate = getWorkflowStateLabel(workflow?.currentAction);
    state.workflowActionAfterTemplate = typeof workflow?.nameForState === "function"
      ? workflow.nameForState(workflow.currentAction)
      : state.workflowStateAfterTemplate;

    logDebug("Remote spell workflow resumed after template targeting.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activity.name,
      activityType: activity.type ?? activity.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      templatePlaced: state.templatePlaced,
      workflowStateAfterTemplate: state.workflowStateAfterTemplate,
      resumedAfterTemplate: state.resumedAfterTemplate,
      resumeMethod: state.resumeMethod
    });

    logDebug(`${monitorLabel} first state after TemplatePlaced.`, {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      monitorSource,
      templatePlaced: state.templatePlaced,
      workflowStateAfterTemplate: state.workflowStateAfterTemplate,
      workflowActionAfterTemplate: state.workflowActionAfterTemplate,
      workflowSummary: summarizeMidiWorkflow(workflow)
    });

    recordPreCheckSavesCheckpoint(state, "midi-qol.targetingComplete", workflow);

    logSpellWorkflowCheckpoint({
      item,
      activity,
      attemptedMethod,
      workflowMode,
      monitorSource,
      monitorLabel,
      checkpoint: "midi-qol.targetingComplete",
      workflow,
      extra: {
        templatePlaced: state.templatePlaced,
        templateUuid: state.templateUuid,
        workflowStateAfterTemplate: state.workflowStateAfterTemplate,
        workflowActionAfterTemplate: state.workflowActionAfterTemplate,
        lastCheckpointBeforePreCheckSaves: state.lastCheckpointBeforePreCheckSaves,
        lastCheckpointBeforePreCheckSavesWorkflowState: state.lastCheckpointBeforePreCheckSavesWorkflowState,
        lastCheckpointBeforePreCheckSavesWorkflowAction: state.lastCheckpointBeforePreCheckSavesWorkflowAction
      }
    });
  });

  registerHook("dnd5e.preRollDamage", (rollConfig) => {
    if (rollConfig?.workflow?.activity?.uuid !== activity?.uuid) return;

    state.preRollDamageHookSeen = true;

    if (monitorSource === REMOTE_TV_SPELL_WORKFLOW_SOURCE) {
      logDebug("Remote TV spell workflow dnd5e.preRollDamage hook fired.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityUuid: activity?.uuid ?? null,
        activityName: activity?.name ?? null,
        activityType: activity?.type ?? activity?.metadata?.type ?? null,
        attemptedMethod,
        workflowMode,
        workflowUuid: rollConfig?.workflow?.uuid ?? rollConfig?.workflow?.id ?? null,
        shouldRollDamageAtEntry: state.shouldRollDamageAtWaitForDamageEntry,
        workflowSuspendedAtEntry: state.workflowSuspendedAtWaitForDamageEntry,
        rollConfig: {
          critical: rollConfig?.critical ?? null,
          midiOptions: rollConfig?.midiOptions ?? null
        }
      });
    }

    if (monitorSource === LOCAL_GM_SPELL_WORKFLOW_SOURCE) {
      logDebug("Local GM spell workflow exact local call from preWaitForDamageRoll to dnd5e.preRollDamage.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityUuid: activity?.uuid ?? null,
        activityName: activity?.name ?? null,
        activityType: activity?.type ?? activity?.metadata?.type ?? null,
        attemptedMethod,
        workflowMode,
        workflowUuid: rollConfig?.workflow?.uuid ?? rollConfig?.workflow?.id ?? null,
        shouldRollDamageAtEntry: state.shouldRollDamageAtWaitForDamageEntry,
        workflowSuspendedAtEntry: state.workflowSuspendedAtWaitForDamageEntry,
        rollConfig: {
          critical: rollConfig?.critical ?? null,
          midiOptions: rollConfig?.midiOptions ?? null
        }
      });
    }
  });

  registerHook("dnd5e.rollDamage", (rolls, rollConfig = {}) => {
    if (rollConfig?.workflow?.activity?.uuid !== activity?.uuid) return;

    state.rollDamageHookSeen = true;

    if (monitorSource === REMOTE_TV_SPELL_WORKFLOW_SOURCE) {
      logDebug("Remote TV spell workflow dnd5e.rollDamage hook fired.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityUuid: activity?.uuid ?? null,
        activityName: activity?.name ?? null,
        activityType: activity?.type ?? activity?.metadata?.type ?? null,
        attemptedMethod,
        workflowMode,
        workflowUuid: rollConfig?.workflow?.uuid ?? rollConfig?.workflow?.id ?? null,
        rollCount: Array.isArray(rolls) ? rolls.length : 0,
        shouldRollDamageAtEntry: state.shouldRollDamageAtWaitForDamageEntry,
        workflowSuspendedAtEntry: state.workflowSuspendedAtWaitForDamageEntry,
        workflowSuspendedNow: Boolean(rollConfig?.workflow?.suspended)
      });
    }
  });

  registerHook("midi-qol.preCheckSaves", (workflow) => {
    if (workflow?.activity?.uuid !== activity?.uuid) return;

    state.saveWorkflowStarted = true;
    state.saveWorkflowState = getWorkflowStateLabel(workflow?.currentAction);
    state.saveWorkflowAction = typeof workflow?.nameForState === "function"
      ? workflow.nameForState(workflow.currentAction)
      : state.saveWorkflowState;
    state.saveWorkflowTriggerStack = captureComparisonStack(
      `${monitorLabel} save phase trigger stack`
    );

    logDebug("Remote spell workflow save phase started.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activity.name,
      activityType: activity.type ?? activity.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      templatePlaced: state.templatePlaced,
      workflowStateAfterTemplate: state.workflowStateAfterTemplate,
      resumedAfterTemplate: state.resumedAfterTemplate,
      saveWorkflowStarted: state.saveWorkflowStarted
    });

    logDebug(`${monitorLabel} exact call that starts save phase.`, {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      monitorSource,
      templatePlaced: state.templatePlaced,
      workflowStateAfterTemplate: state.workflowStateAfterTemplate,
      workflowActionAfterTemplate: state.workflowActionAfterTemplate,
      workflowStateAtSaveStart: state.saveWorkflowState,
      workflowActionAtSaveStart: state.saveWorkflowAction,
      savePhaseTriggerStack: state.saveWorkflowTriggerStack
    });

    if (monitorSource === LOCAL_GM_SPELL_WORKFLOW_SOURCE) {
      logDebug("Local GM spell workflow exact local call/state that triggers save phase.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityUuid: activity?.uuid ?? null,
        activityName: activity?.name ?? null,
        activityType: activity?.type ?? activity?.metadata?.type ?? null,
        workflowMode,
        workflowStateAfterTemplate: state.workflowStateAfterTemplate,
        workflowActionAfterTemplate: state.workflowActionAfterTemplate,
        workflowStateAtSaveStart: state.saveWorkflowState,
        workflowActionAtSaveStart: state.saveWorkflowAction,
        savePhaseTriggerStack: state.saveWorkflowTriggerStack
      });
    }

    logSpellWorkflowCheckpoint({
      item,
      activity,
      attemptedMethod,
      workflowMode,
      monitorSource,
      monitorLabel,
      checkpoint: "midi-qol.preCheckSaves",
      workflow,
      extra: {
        templatePlaced: state.templatePlaced,
        templateUuid: state.templateUuid,
        workflowStateAfterTemplate: state.workflowStateAfterTemplate,
        workflowActionAfterTemplate: state.workflowActionAfterTemplate,
        workflowStateAtSaveStart: state.saveWorkflowState,
        workflowActionAtSaveStart: state.saveWorkflowAction,
        savePhaseTriggerStack: state.saveWorkflowTriggerStack,
        lastCheckpointBeforePreCheckSaves: state.lastCheckpointBeforePreCheckSaves,
        lastCheckpointBeforePreCheckSavesWorkflowState: state.lastCheckpointBeforePreCheckSavesWorkflowState,
        lastCheckpointBeforePreCheckSavesWorkflowAction: state.lastCheckpointBeforePreCheckSavesWorkflowAction
      }
    });
  });

  registerHook("dnd5e.rollDamageV2", (rolls, data = {}) => {
    if (data?.subject?.uuid !== activity?.uuid) return;

    state.damageWorkflowStarted = true;
    state.damageRollCount += Array.isArray(rolls) ? rolls.length : 0;

    logDebug("Remote spell workflow damage roll started.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activity.name,
      activityType: activity.type ?? activity.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      damageRollCount: state.damageRollCount,
      damageWorkflowStarted: state.damageWorkflowStarted
    });

    const workflow = getMidiWorkflowByActivityUuid(activity?.uuid);
    logSpellWorkflowCheckpoint({
      item,
      activity,
      attemptedMethod,
      workflowMode,
      monitorSource,
      monitorLabel,
      checkpoint: "dnd5e.rollDamageV2",
      workflow,
      extra: {
        damageRollCount: state.damageRollCount,
        damageWorkflowStarted: state.damageWorkflowStarted
      }
    });
  });

  registerHook("midi-qol.RollComplete", (workflow) => {
    if (workflow?.activity?.uuid !== activity?.uuid) return;

    state.finalResult = summarizeMidiWorkflow(workflow);

    logDebug("Remote spell workflow completed.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activity.name,
      activityType: activity.type ?? activity.metadata?.type ?? null,
      attemptedMethod,
      workflowMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      templatePlaced: state.templatePlaced,
      workflowStateAfterTemplate: state.workflowStateAfterTemplate,
      resumedAfterTemplate: state.resumedAfterTemplate,
      saveWorkflowStarted: state.saveWorkflowStarted,
      damageWorkflowStarted: state.damageWorkflowStarted,
      finalResult: state.finalResult
    });

    logSpellWorkflowCheckpoint({
      item,
      activity,
      attemptedMethod,
      workflowMode,
      monitorSource,
      monitorLabel,
      checkpoint: "midi-qol.RollComplete",
      workflow,
      extra: {
        finalResult: state.finalResult,
        saveWorkflowStarted: state.saveWorkflowStarted,
        damageWorkflowStarted: state.damageWorkflowStarted
      }
    });
  });

  return {
    state,
    cleanup() {
      for (const [hookName, hookId] of hookRegistrations) {
        Hooks.off(hookName, hookId);
      }
    }
  };
}

async function startMidiCompleteActivityWorkflow(item, activity, participants, options = {}) {
  const {
    workflowSettings = getWorkflowSettings(),
    midiApi = getMidiQolApi()
  } = options;

  const usageConfig = activity._prepareUsageConfig({});
  const activitySummary = getActivitySummary(activity, usageConfig);
  const beforeIds = new Set(Object.keys(ui?.windows ?? {}));
  const beforeMessageIds = new Set(Array.from(game.messages ?? []).map((message) => String(message.id)));
  const monitor = createSpellWorkflowMonitor({
    item,
    activity,
    participants,
    attemptedMethod: "item.use",
    workflowMode: MIDI_SPELL_WORKFLOW_MODE,
    monitorSource: REMOTE_TV_SPELL_WORKFLOW_SOURCE
  });
  const {
    usage: remoteSpellUsage,
    shouldForceRemoteSpellDamageRoll,
    remoteSpellWorkflowOptions
  } = buildRemoteSpellUsage(activity, activitySummary, workflowSettings);


  logDebug("Preparing remote spell item.use workflow.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "item.use",
    workflowMode: MIDI_SPELL_WORKFLOW_MODE,
    workflowSettings,
    midiAvailable: Boolean(midiApi),
    midiUsed: Boolean(midiApi),
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    launchMode: activitySummary.requiresDialog ? "dialog" : "direct-workflow",
    usageConfig,
    nativeSpellWorkflow: true,
    shouldForceRemoteSpellDamageRoll,
    remoteSpellWorkflowOptions: remoteSpellWorkflowOptions
  });

  logDebug("Remote spell workflow replacement trigger selected.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    workflowMode: MIDI_SPELL_WORKFLOW_MODE,
    replacementTriggerUsed: "item.use({ legacy: false })",
    previousRemoteTrigger: "activity.use",
    whyRemoteDoesNotTransition:
      "Direct remote activity.use reached TemplatePlaced but never emitted midi-qol.preCheckSaves on the TV client.",
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    targets: participants.targets.map(serializeToken),
    shouldForceRemoteSpellDamageRoll,
    remoteSpellWorkflowOptions: remoteSpellWorkflowOptions
  });
  let workflowPromise;
  try {
    markRemoteSpellActivity(activity?.uuid);

    logDebug("Remote spell workflow calling item.use.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      shouldForceRemoteSpellDamageRoll,
      remoteSpellWorkflowOptions: remoteSpellWorkflowOptions
    });

    workflowPromise = item.use(remoteSpellUsage, { configure: true }, { create: true });

    logDebug("Remote spell workflow item.use returned promise.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      hasThen: typeof workflowPromise?.then === "function",
      shouldForceRemoteSpellDamageRoll,
      remoteSpellWorkflowOptions: remoteSpellWorkflowOptions
    });
  } catch (error) {
    clearRemoteSpellActivity(activity?.uuid);
    monitor.cleanup();

    logWarning("Failed to start remote spell item.use workflow.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      midiAvailable: Boolean(midiApi),
      midiUsed: Boolean(midiApi),
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      error: error?.message ?? String(error)
    });

    return {
      ok: false,
      reason: "usage-workflow-unavailable",
      launchMode: "unavailable",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      attemptedMethod: "item.use",
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable: Boolean(midiApi),
      midiUsed: Boolean(midiApi),
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      ...activitySummary,
      errors: [error?.message ?? "item.use failed to start for this item."]
    };
  }

  workflowPromise.then((result) => {
    const workflow = getMidiWorkflowByActivityUuid(activity?.uuid);
    const workflowSummary = summarizeMidiWorkflow(workflow);
    const resultSummary = summarizeWorkflowResult(result);
    const resultMessage = result?.message
      ?? (workflow?.itemCardUuid ? fromUuidSync(workflow.itemCardUuid) : null)
      ?? getNewChatMessages(beforeMessageIds)[0]
      ?? null;
    const chatCardCreated = Boolean(resultMessage);
    const chatFocusActions = resultMessage
      ? focusChatPanel(resultMessage, {
          itemUuid: item.uuid,
          itemName: item.name,
          activityName: activitySummary.activityName,
          activityType: activitySummary.activityType,
          attemptedMethod: "item.use",
          workflowMode: MIDI_SPELL_WORKFLOW_MODE
        })
      : [];

    logDebug("Remote spell workflow item.use resolved.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      midiAvailable: Boolean(midiApi),
      midiUsed: Boolean(midiApi),
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      dialogOpened: monitor.state.dialogOpened,
      templatePlaced: monitor.state.templatePlaced,
      templateUuid: monitor.state.templateUuid,
      workflowStateAfterTemplate: monitor.state.workflowStateAfterTemplate,
      resumedAfterTemplate: monitor.state.resumedAfterTemplate,
      resumeMethod: monitor.state.resumeMethod,
      resumeMethodChosen: monitor.state.resumeMethodChosen,
      saveWorkflowStarted: monitor.state.saveWorkflowStarted,
      damageWorkflowStarted: monitor.state.damageWorkflowStarted,
      finalResult: monitor.state.finalResult,
      chatMessageId: resultMessage?.id ?? null,
      chatCardCreated,
      chatFocusActions,
      resultSummary,
      workflowSummary
    });
    clearRemoteSpellActivity(activity?.uuid);
  }).catch((error) => {
    logWarning("Remote spell workflow item.use rejected.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      midiAvailable: Boolean(midiApi),
      midiUsed: Boolean(midiApi),
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      dialogOpened: monitor.state.dialogOpened,
      templatePlaced: monitor.state.templatePlaced,
      templateUuid: monitor.state.templateUuid,
      workflowStateAfterTemplate: monitor.state.workflowStateAfterTemplate,
      resumedAfterTemplate: monitor.state.resumedAfterTemplate,
      resumeMethod: monitor.state.resumeMethod,
      resumeMethodChosen: monitor.state.resumeMethodChosen,
      saveWorkflowStarted: monitor.state.saveWorkflowStarted,
      damageWorkflowStarted: monitor.state.damageWorkflowStarted,
      finalResult: monitor.state.finalResult,
      error: error?.message ?? String(error)
    });
    clearRemoteSpellActivity(activity?.uuid);
  });

  setTimeout(() => {
    clearRemoteSpellActivity(activity?.uuid);
    monitor.cleanup();
  }, 30000);

  await waitForWorkflowUi();

  const dialogApp = getNewUiWindows(beforeIds)[0] ?? null;
  const dialogVisible = Boolean(dialogApp?.rendered);
  const chatMessage = getNewChatMessages(beforeMessageIds)[0] ?? null;
  const chatCardCreated = Boolean(chatMessage);
  const chatFocusActions = chatMessage
    ? focusChatPanel(chatMessage, {
        itemUuid: item.uuid,
        itemName: item.name,
        activityName: activitySummary.activityName,
        activityType: activitySummary.activityType,
        attemptedMethod: "item.use",
        workflowMode: MIDI_SPELL_WORKFLOW_MODE
      })
    : [];

  monitor.state.dialogOpened = dialogVisible;

  logInfo("Remote spell item.use workflow started.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "item.use",
    workflowMode: MIDI_SPELL_WORKFLOW_MODE,
    workflowSettings,
    midiAvailable: Boolean(midiApi),
    midiUsed: Boolean(midiApi),
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    dialogAppId: dialogApp?.appId ?? null,
    dialogClass: dialogApp?.constructor?.name ?? null,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    templatePlacementExpected: Boolean(activity?.target?.template?.type),
    saveWorkflowExpected: Boolean(activity?.save),
    damageWorkflowExpected: Boolean(activity?.hasDamage ?? activity?.damage?.parts?.length),
    nativeSpellWorkflow: true,
  });

  return {
    ok: true,
    attemptedMethod: "item.use",
    dialogApp,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    launchMode: activitySummary.requiresDialog ? "dialog" : "direct-workflow",
    workflowMode: MIDI_SPELL_WORKFLOW_MODE,
    midiAvailable: Boolean(midiApi),
    midiUsed: Boolean(midiApi),
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    templatePlaced: monitor.state.templatePlaced,
    templateUuid: monitor.state.templateUuid,
    workflowStateAfterTemplate: monitor.state.workflowStateAfterTemplate,
    resumedAfterTemplate: monitor.state.resumedAfterTemplate,
    resumeMethod: monitor.state.resumeMethod,
    resumeMethodChosen: monitor.state.resumeMethodChosen,
    workflowFound: monitor.state.workflowFound,
    workflowUuid: monitor.state.workflowUuid,
    workflowStateBeforeResume: monitor.state.workflowStateBeforeResume,
    workflowActionBeforeResume: monitor.state.workflowActionBeforeResume,
    hasUnSuspend: monitor.state.hasUnSuspend,
    hasPerformState: monitor.state.hasPerformState,
    unSuspendCalled: monitor.state.unSuspendCalled,
    performStateCalled: monitor.state.performStateCalled,
    returnValue: monitor.state.resumeResult,
    workflowStateAfterResumeAttempt: monitor.state.workflowStateAfterResumeAttempt,
    subsequentWorkflowTriggered: monitor.state.subsequentWorkflowTriggered,
    saveWorkflowStarted: monitor.state.saveWorkflowStarted,
    damageWorkflowStarted: monitor.state.damageWorkflowStarted,
    finalResult: monitor.state.finalResult,
    ...activitySummary,
    usageConfig
  };
}

export function registerSpellWorkflowComparisonHooks() {
  if (!game.user?.isGM) {
    logDebug("Remote Action local GM spell workflow comparison hooks skipped on non-GM client.", {
      currentUserId: game.user?.id ?? null,
      currentUserName: game.user?.name ?? null,
      isGM: Boolean(game.user?.isGM),
      monitorRegistrationPath: "ready-skip-non-gm",
      note:
        "Remote Action local GM comparison hooks are disabled on non-GM clients. External MidiItem initialization errors for non-dnd5e items are outside this comparison monitor."
    });
    logDebug("Remote Action external client noise isolated from spell workflow diagnosis.", {
      currentUserId: game.user?.id ?? null,
      currentUserName: game.user?.name ?? null,
      isGM: Boolean(game.user?.isGM),
      isolatedSignals: [
        "MidiItem dnd5e-sheet-notes.note initialization error",
        "TouchVTT client initialization failure"
      ],
      monitorRegistrationPath: "ready-skip-non-gm",
      moduleEnvironment: getSpellWorkflowModuleEnvironment()
    });
    return;
  }

  if (spellWorkflowComparisonHooksRegistered) return;
  spellWorkflowComparisonHooksRegistered = true;

  Hooks.on("dnd5e.preUseActivity", (activity) => {
    if (!game.user?.isGM) return;
    if (!activity?.uuid) return;
    if (isRemoteSpellActivity(activity.uuid)) return;

    const item = activity?.item ?? activity?.parent ?? null;
    if (!(item instanceof Item)) return;

    const midiApi = getMidiQolApi();
    const spellWorkflowProbe = getSpellWorkflowBranchProbe(item, activity, midiApi);
    if (!spellWorkflowProbe.shouldUseMidiSpellWorkflow) return;

    const existingMonitor = LOCAL_GM_SPELL_WORKFLOW_MONITORS.get(activity.uuid);
    if (existingMonitor) {
      clearTimeout(existingMonitor.timeoutId);
      existingMonitor.monitor.cleanup();
      LOCAL_GM_SPELL_WORKFLOW_MONITORS.delete(activity.uuid);
    }

    const participants = getWorkflowParticipants(item);
    const monitor = createSpellWorkflowMonitor({
      item,
      activity,
      participants,
      attemptedMethod: "item.use",
      workflowMode: LOCAL_GM_SPELL_WORKFLOW_MODE,
      monitorSource: LOCAL_GM_SPELL_WORKFLOW_SOURCE
    });

    const timeoutId = setTimeout(() => {
      monitor.cleanup();
      LOCAL_GM_SPELL_WORKFLOW_MONITORS.delete(activity.uuid);
    }, 30000);

    LOCAL_GM_SPELL_WORKFLOW_MONITORS.set(activity.uuid, {
      monitor,
      timeoutId
    });

    logDebug("Local GM spell workflow comparison hook armed.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity.uuid,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      workflowMode: LOCAL_GM_SPELL_WORKFLOW_MODE,
      attemptedMethod: "item.use",
      isGM: Boolean(game.user?.isGM),
      monitorRegistrationPath: "local-gm-preUseActivity",
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      spellWorkflowProbe
    });
  });

  Hooks.on("midi-qol.RollComplete", (workflow) => {
    const activityUuid = workflow?.activity?.uuid ?? null;
    if (!activityUuid) return;

    const existingMonitor = LOCAL_GM_SPELL_WORKFLOW_MONITORS.get(activityUuid);
    if (!existingMonitor) return;

    clearTimeout(existingMonitor.timeoutId);
    existingMonitor.monitor.cleanup();
    LOCAL_GM_SPELL_WORKFLOW_MONITORS.delete(activityUuid);
  });

  Hooks.on("dnd5e.postUseActivity", (activity) => {
    const activityUuid = activity?.uuid ?? null;
    if (!activityUuid) return;

    const existingMonitor = LOCAL_GM_SPELL_WORKFLOW_MONITORS.get(activityUuid);
    if (!existingMonitor) return;

    setTimeout(() => {
      const stillRegisteredMonitor = LOCAL_GM_SPELL_WORKFLOW_MONITORS.get(activityUuid);
      if (!stillRegisteredMonitor) return;
      if (
        stillRegisteredMonitor.monitor.state.saveWorkflowStarted
        || stillRegisteredMonitor.monitor.state.damageWorkflowStarted
        || stillRegisteredMonitor.monitor.state.finalResult
      ) {
        return;
      }

      logDebug("Local GM spell workflow comparison monitor is still waiting after postUseActivity.", {
        activityUuid,
        workflowMode: LOCAL_GM_SPELL_WORKFLOW_MODE,
        monitorState: stillRegisteredMonitor.monitor.state
      });
    }, 500);
  });

  logDebug("Remote Action local GM spell workflow comparison hooks registered.", {
    currentUserId: game.user?.id ?? null,
    currentUserName: game.user?.name ?? null,
    isGM: Boolean(game.user?.isGM),
    monitorRegistrationPath: "ready-gm-register",
    moduleEnvironment: getSpellWorkflowModuleEnvironment()
  });
}

async function startDnd5eDamageOnlyWorkflow(item, activity, participants, options = {}) {
  const {
    workflowMode = MANUAL_HIT_WORKFLOW_MODE,
    isCritical = false,
    midiApi = getMidiQolApi()
  } = options;

  const activitySummary = getActivitySummary(activity, {});
  const sourceActor = participants.sourceActor;
  const sourceToken = participants.sourceToken;
  const targets = participants.targets;
  const midiAvailable = Boolean(midiApi?.DamageOnlyWorkflow);

  if (targets.length === 0) {
    return {
      ok: false,
      reason: "missing-targets",
      launchMode: "unavailable",
      workflowMode,
      attemptedMethod: midiAvailable ? "MidiQOL.DamageOnlyWorkflow" : "activity.rollDamage",
      isCritical,
      damageRolled: false,
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable,
      midiUsed: false,
      sourceActor: serializeActor(sourceActor),
      sourceToken: serializeToken(sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: targets.map(serializeToken),
      ...activitySummary,
      errors: ["At least one target token must be targeted for this remote damage workflow."]
    };
  }

  if (!midiAvailable) {
    logDebug("Midi-QOL not available for manual-hit workflow, using dnd5e fallback.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      workflowMode,
      sourceActor: serializeActor(sourceActor),
      sourceToken: serializeToken(sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: targets.map(serializeToken)
    });

    if (typeof activity.rollDamage !== "function") {
      return {
        ok: false,
        reason: "damage-workflow-unavailable",
        launchMode: "unavailable",
        workflowMode,
        attemptedMethod: "activity.rollDamage",
        isCritical,
        damageRolled: false,
        dialogApp: null,
        dialogVisible: false,
        chatMessageId: null,
        chatCardCreated: false,
        chatFocusActions: [],
        midiAvailable: false,
        midiUsed: false,
        sourceActor: serializeActor(sourceActor),
        sourceToken: serializeToken(sourceToken),
        sourceResolution: participants.sourceResolution,
        targets: targets.map(serializeToken),
        ...activitySummary,
        errors: ["The dnd5e activity.rollDamage API is not available for this item."]
      };
    }

    const beforeIds = new Set(Object.keys(ui?.windows ?? {}));
    const beforeMessageIds = new Set(Array.from(game.messages ?? []).map((message) => String(message.id)));
    const damagePromise = activity.rollDamage(
      { isCritical },
      { configure: true },
      { create: true }
    );

    damagePromise.then((result) => {
      const resultSummary = summarizeWorkflowResult(result);
      const resultMessage = getNewChatMessages(beforeMessageIds)[0] ?? null;
      const chatCardCreated = Boolean(resultMessage);
      const chatFocusActions = resultMessage
        ? focusChatPanel(resultMessage, {
            itemUuid: item.uuid,
            itemName: item.name,
            activityName: activitySummary.activityName,
            activityType: activitySummary.activityType,
            attemptedMethod: "activity.rollDamage",
            workflowMode
          })
        : [];

      logDebug("dnd5e activity.rollDamage workflow resolved.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityName: activitySummary.activityName,
        activityType: activitySummary.activityType,
        attemptedMethod: "activity.rollDamage",
        workflowMode,
        isCritical,
        midiAvailable: false,
        midiUsed: false,
        sourceActor: serializeActor(sourceActor),
        sourceToken: serializeToken(sourceToken),
        sourceResolution: participants.sourceResolution,
        targets: targets.map(serializeToken),
        workflowResult: resultSummary,
        chatMessageId: resultMessage?.id ?? null,
        chatCardCreated,
        chatFocusActions,
        result
      });
    }).catch((error) => {
      logDebug("dnd5e activity.rollDamage workflow rejected.", {
        itemUuid: item.uuid,
        itemName: item.name,
        activityName: activitySummary.activityName,
        activityType: activitySummary.activityType,
        attemptedMethod: "activity.rollDamage",
        workflowMode,
        isCritical,
        midiAvailable: false,
        midiUsed: false,
        sourceActor: serializeActor(sourceActor),
        sourceToken: serializeToken(sourceToken),
        sourceResolution: participants.sourceResolution,
        targets: targets.map(serializeToken),
        error: error?.message ?? String(error)
      });
    });

    await waitForWorkflowUi();

    const dialogApp = getNewUiWindows(beforeIds)[0] ?? null;
    const dialogVisible = Boolean(dialogApp?.rendered);
    const chatMessage = getNewChatMessages(beforeMessageIds)[0] ?? null;
    const chatCardCreated = Boolean(chatMessage);
    const chatFocusActions = chatMessage
      ? focusChatPanel(chatMessage, {
          itemUuid: item.uuid,
          itemName: item.name,
          activityName: activitySummary.activityName,
          activityType: activitySummary.activityType,
          attemptedMethod: "activity.rollDamage",
          workflowMode
        })
      : [];

    return {
      ok: true,
      attemptedMethod: "activity.rollDamage",
      isCritical,
      damageRolled: true,
      dialogApp,
      dialogVisible,
      chatMessageId: chatMessage?.id ?? null,
      chatCardCreated,
      chatFocusActions,
      launchMode: dialogVisible ? "dialog" : "direct-workflow",
      workflowMode,
      midiAvailable: false,
      midiUsed: false,
      sourceActor: serializeActor(sourceActor),
      sourceToken: serializeToken(sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: targets.map(serializeToken),
      ...activitySummary
    };
  }

  logDebug("Preparing Midi-QOL damage workflow.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "MidiQOL.DamageOnlyWorkflow",
    workflowMode,
    isCritical,
    midiAvailable: true,
    midiUsed: true,
    sourceActor: serializeActor(sourceActor),
    sourceToken: serializeToken(sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: targets.map(serializeToken)
  });

  const damageRolls = await activity.rollDamage(
    { isCritical },
    { configure: true },
    { create: false }
  );

  const damageRoll = Array.isArray(damageRolls) ? damageRolls[0] ?? null : null;
  if (!damageRoll) {
    return {
      ok: false,
      reason: "damage-roll-unavailable",
      launchMode: "unavailable",
      workflowMode,
      attemptedMethod: "activity.rollDamage -> MidiQOL.DamageOnlyWorkflow",
      isCritical,
      damageRolled: false,
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable: true,
      midiUsed: false,
      sourceActor: serializeActor(sourceActor),
      sourceToken: serializeToken(sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: targets.map(serializeToken),
      ...activitySummary,
      errors: ["No damage roll was produced by dnd5e before starting Midi-QOL damage workflow."]
    };
  }

  const damageType = getPrimaryDamageType(activity, damageRoll);
  const beforeIds = new Set(Object.keys(ui?.windows ?? {}));
  const beforeMessageIds = new Set(Array.from(game.messages ?? []).map((message) => String(message.id)));

  const workflow = new midiApi.DamageOnlyWorkflow(
    sourceActor,
    sourceToken,
    damageRoll.total,
    damageType,
    targets,
    damageRoll,
    {
      item,
      flavor: item.name,
      itemCardUuid: "new",
      isCritical,
      storeWorkflow: true
    }
  );

  await waitForWorkflowUi();

  const dialogApp = getNewUiWindows(beforeIds)[0] ?? null;
  const dialogVisible = Boolean(dialogApp?.rendered);
  const chatMessage = getNewChatMessages(beforeMessageIds)[0] ?? null;
  const chatCardCreated = Boolean(chatMessage);
  const chatFocusActions = chatMessage
    ? focusChatPanel(chatMessage, {
        itemUuid: item.uuid,
        itemName: item.name,
        activityName: activitySummary.activityName,
        activityType: activitySummary.activityType,
        attemptedMethod: "MidiQOL.DamageOnlyWorkflow",
        workflowMode
      })
    : [];

  logDebug("Midi-QOL damage workflow started.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "MidiQOL.DamageOnlyWorkflow",
    workflowMode,
    isCritical,
    midiAvailable: true,
    midiUsed: true,
    sourceActor: serializeActor(sourceActor),
    sourceToken: serializeToken(sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: targets.map(serializeToken),
    damageRollFormula: damageRoll.formula,
    damageRollTotal: damageRoll.total,
    damageType,
    workflowId: workflow?.id ?? null,
    itemCardUuid: workflow?.itemCardUuid ?? null,
    dialogAppId: dialogApp?.appId ?? null,
    dialogClass: dialogApp?.constructor?.name ?? null,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions
  });

  return {
    ok: true,
    attemptedMethod: "MidiQOL.DamageOnlyWorkflow",
    workflowMode,
    launchMode: dialogVisible ? "dialog" : "direct-workflow",
    midiAvailable: true,
    midiUsed: true,
    isCritical,
    damageRolled: true,
    dialogApp,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    workflowId: workflow?.id ?? null,
    workflowItemCardUuid: workflow?.itemCardUuid ?? null,
    damageRollFormula: damageRoll.formula,
    damageRollTotal: damageRoll.total,
    damageType,
    sourceActor: serializeActor(sourceActor),
    sourceToken: serializeToken(sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: targets.map(serializeToken),
    ...activitySummary
  };
}

async function startDnd5eItemUsageWorkflow(item) {
  const activities = item.system.activities?.filter((activity) => activity.canUse) ?? [];
  const activity = activities[0] ?? null;
  const workflowSettings = getWorkflowSettings();
  const participants = getWorkflowParticipants(item);
  const midiApi = getMidiQolApi();
  const midiAvailable = Boolean(midiApi?.DamageOnlyWorkflow);

  if (!activity) {
    return {
      ok: false,
      reason: "no-usable-activity",
      launchMode: "unavailable",
      workflowMode: "native-foundry",
      attemptedMethod: null,
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable,
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      activityId: null,
      activityName: null,
      activityType: null,
      requiresDialog: null,
      errors: ["No usable dnd5e activity was found on this item."]
    };
  }

  if (shouldUseManualHitDamageWorkflow(item, activity, workflowSettings)) {
    logDebug("Switching to target-driven damage workflow based on workflow settings.", {
      itemUuid: item.uuid,
      itemName: item.name,
      workflowSettings,
      workflowMode: MANUAL_HIT_WORKFLOW_MODE,
      midiAvailable,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      activityId: activity.id,
      activityName: activity.name,
      activityType: activity.type ?? activity.metadata?.type ?? null
    });

    return startDnd5eDamageOnlyWorkflow(item, activity, participants, {
      workflowMode: MANUAL_HIT_WORKFLOW_MODE,
      midiApi
    });
  }

  const spellWorkflowProbe = getSpellWorkflowBranchProbe(item, activity, midiApi);
  const shouldTraceSpellWorkflow = spellWorkflowProbe.isSpellItem
    || spellWorkflowProbe.hasTemplate
    || spellWorkflowProbe.isSaveActivity;

  if (shouldTraceSpellWorkflow) {
    logDebug("Remote spell workflow branch probe.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      attemptedMethod: "item.use",
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      spellWorkflowProbe
    });
  }

  if (spellWorkflowProbe.shouldUseMidiSpellWorkflow) {
    logDebug("Remote spell workflow branch selected.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      attemptedMethod: "item.use",
      midiAvailable: Boolean(midiApi),
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      spellWorkflowProbe
    });

    return startMidiCompleteActivityWorkflow(item, activity, participants, {
      workflowSettings,
      midiApi
    });
  }

  if (shouldTraceSpellWorkflow) {
    logDebug("Remote spell workflow branch NOT selected.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      attemptedMethod: "item.use",
      midiAvailable: Boolean(midiApi),
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken),
      spellWorkflowProbe
    });
  }

  const usageConfig = activity._prepareUsageConfig({});
  const activitySummary = getActivitySummary(activity, usageConfig);
  const launchMode = activitySummary.requiresDialog ? "dialog" : "direct-workflow";
  const nativeAttackModeExperimental = workflowSettings.useAttackRolls
    && item.type === "weapon"
    && activitySummary.activityType === "attack";
  const workflowProfile = nativeAttackModeExperimental
    ? "native-foundry-attack-experimental"
    : workflowSettings.useAttackRolls
      ? "native-foundry"
      : "custom-workflow-profile";

  if (nativeAttackModeExperimental) {
    logDebug("Using native Foundry attack workflow for a weapon activity. This mode remains experimental until stabilized.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      workflowProfile,
      launchMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      targets: participants.targets.map(serializeToken)
    });
  }

  logDebug("Preparing dnd5e item usage workflow.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "activity.use",
    workflowMode: "native-foundry",
    workflowSettings,
    midiAvailable,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    launchMode,
    usageConfig,
    hasActivityUse: typeof activity.use === "function"
  });

  if (typeof activity.use !== "function") {
    return {
      ok: false,
      reason: "usage-workflow-unavailable",
      launchMode: "unavailable",
      workflowMode: "native-foundry",
      attemptedMethod: "activity.use",
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable,
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      ...activitySummary,
      errors: ["The dnd5e activity.use API is not available for this item."]
    };
  }

  const beforeIds = new Set(Object.keys(ui?.windows ?? {}));
  const beforeMessageIds = new Set(Array.from(game.messages ?? []).map((message) => String(message.id)));
  const workflowPromise = activity.use({}, { configure: true }, { create: true });

  workflowPromise.then((result) => {
    const resultSummary = summarizeWorkflowResult(result);
    const resultMessage = result?.message ?? getNewChatMessages(beforeMessageIds)[0] ?? null;
    const chatCardCreated = Boolean(resultMessage);
    const chatFocusActions = resultMessage
      ? focusChatPanel(resultMessage, {
          itemUuid: item.uuid,
          itemName: item.name,
          activityName: activitySummary.activityName,
          activityType: activitySummary.activityType,
          attemptedMethod: "activity.use",
          workflowMode: "native-foundry",
          launchMode
        })
      : [];

    logDebug("dnd5e activity.use workflow resolved.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "activity.use",
      workflowMode: "native-foundry",
      launchMode,
      midiAvailable,
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      workflowResult: resultSummary,
      chatMessageId: resultMessage?.id ?? null,
      chatCardCreated,
      chatFocusActions,
      result
    });
  }).catch((error) => {
    logDebug("dnd5e activity.use workflow rejected.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "activity.use",
      workflowMode: "native-foundry",
      launchMode,
      midiAvailable,
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      error: error?.message ?? String(error)
    });
  });

  await waitForWorkflowUi();

  const dialogApp = getNewUiWindows(beforeIds)[0] ?? null;
  const dialogVisible = Boolean(dialogApp?.rendered);
  const chatMessage = getNewChatMessages(beforeMessageIds)[0] ?? null;
  const chatCardCreated = Boolean(chatMessage);
  const chatFocusActions = chatMessage
    ? focusChatPanel(chatMessage, {
        itemUuid: item.uuid,
        itemName: item.name,
        activityName: activitySummary.activityName,
        activityType: activitySummary.activityType,
        attemptedMethod: "activity.use",
        workflowMode: "native-foundry",
        launchMode
      })
    : [];

  logDebug("dnd5e item usage workflow started.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "activity.use",
    workflowMode: "native-foundry",
    workflowSettings,
    midiAvailable,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    launchMode,
    dialogAppId: dialogApp?.appId ?? null,
    dialogClass: dialogApp?.constructor?.name ?? null,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    directWorkflow: launchMode === "direct-workflow",
    expectsManualUseClick: true,
    workflowLinkedToExecution: true,
    expectedSubmitHandler: launchMode === "dialog"
      ? "dnd5e ActivityUsageDialog form handler via activity.use"
      : "dnd5e direct activity.use workflow without visible dialog"
  });

  return {
    ok: true,
    attemptedMethod: "activity.use",
    dialogApp,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    launchMode,
    workflowMode: "native-foundry",
    midiAvailable,
    midiUsed: false,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    ...activitySummary,
    usageConfig
  };
}

function handleNotifyAction(request) {
  logDebug("Entering notify handler.", {
    actionType: getRequestActionType(request),
    request
  });

  const validation = validateNotifyRequest(request);
  if (!validation.ok) {
    logDebug("Notify action payload validation failed.", {
      actionType: getRequestActionType(request),
      errors: validation.errors,
      request
    });
    return buildInvalidActionResponse(request, validation.errors);
  }

  const { message, level } = validation.normalizedContext;

  logDebug("Displaying notify action on receiver.", {
    actionType: getRequestActionType(request),
    level,
    message
  });

  ui?.notifications?.[level]?.(message);

  return buildBaseResponse(request, {
    handled: true,
    message: "Remote Action notify displayed on receiver.",
    notification: {
      level,
      message
    }
  });
}

async function handleOpenDocumentSheetAction(request, options) {
  const {
    actionType,
    uuidField,
    expectedClass,
    expectedTypeLabel,
    responseKey,
    successMessage
  } = options;

  logDebug(`Entering ${actionType} handler.`, {
    actionType,
    uuidField,
    documentUuid: request?.payload?.[uuidField],
    request
  });

  const validation = validateDocumentUuidRequest(request, uuidField, actionType);
  if (!validation.ok) {
    logDebug(`${actionType} payload validation failed.`, {
      actionType,
      errors: validation.errors,
      request
    });
    return buildInvalidActionResponse(request, validation.errors);
  }

  const documentUuid = validation.normalizedUuid;
  const document = await fromUuid(documentUuid);

  logDebug("Resolved document sheet target.", {
    actionType,
    documentUuid,
    documentFound: Boolean(document),
    documentName: document?.name ?? null,
    documentType: document?.documentName ?? null
  });

  if (!document) {
    return buildDocumentErrorResponse(request, "document-not-found", [
      `No document found for ${uuidField} '${documentUuid}'.`
    ]);
  }

  if (!(document instanceof expectedClass)) {
    return buildDocumentErrorResponse(request, "invalid-document-type", [
      `UUID '${documentUuid}' does not resolve to an ${expectedTypeLabel}.`
    ]);
  }

  const sheet = document.sheet ?? null;
  const initialSheetState = getSheetState(sheet);

  logDebug("Document sheet instance resolved.", {
    actionType,
    documentUuid,
    documentName: document.name,
    expectedTypeLabel,
    hasSheet: initialSheetState.hasSheet,
    sheetClass: initialSheetState.sheetClass,
    sheetAppId: initialSheetState.appId,
    sheetRendered: initialSheetState.rendered,
    sheetMinimized: initialSheetState.minimized,
    supportsBringToFront: initialSheetState.supportsBringToFront,
    supportsBringToTop: initialSheetState.supportsBringToTop,
    supportsMaximize: initialSheetState.supportsMaximize
  });

  if (!sheet) {
    return buildDocumentErrorResponse(request, "sheet-unavailable", [
      `No sheet instance is available for ${uuidField} '${documentUuid}'.`
    ]);
  }

  const visibilityResult = await makeSheetVisible(sheet);

  logDebug("Document sheet visibility actions applied.", {
    actionType,
    documentUuid,
    documentName: document.name,
    expectedTypeLabel,
    sheetClass: visibilityResult.after.sheetClass,
    sheetAppId: visibilityResult.after.appId,
    renderedBefore: visibilityResult.before.rendered,
    minimizedBefore: visibilityResult.before.minimized,
    renderedAfter: visibilityResult.after.rendered,
    minimizedAfter: visibilityResult.after.minimized,
    supportsBringToFront: visibilityResult.after.supportsBringToFront,
    supportsBringToTop: visibilityResult.after.supportsBringToTop,
    supportsMaximize: visibilityResult.after.supportsMaximize,
    actions: visibilityResult.actions
  });

  return buildBaseResponse(request, {
    handled: true,
    message: successMessage,
    [responseKey]: {
      uuid: documentUuid,
      id: document.id,
      name: document.name
    },
    [`${responseKey}Name`]: document.name,
    sheetClass: visibilityResult.after.sheetClass,
    sheetAppId: visibilityResult.after.appId,
    sheetRendered: visibilityResult.after.rendered,
    sheetMinimized: visibilityResult.after.minimized,
    supportsBringToFront: visibilityResult.after.supportsBringToFront,
    supportsBringToTop: visibilityResult.after.supportsBringToTop,
    supportsMaximize: visibilityResult.after.supportsMaximize,
    actions: visibilityResult.actions
  });
}

async function handleOpenActorSheetAction(request) {
  return handleOpenDocumentSheetAction(request, {
    actionType: "open-actor-sheet",
    uuidField: "actorUuid",
    expectedClass: Actor,
    expectedTypeLabel: "Actor",
    responseKey: "actor",
    successMessage: "Remote Action opened actor sheet on receiver."
  });
}

async function handleOpenItemSheetAction(request) {
  return handleOpenDocumentSheetAction(request, {
    actionType: "open-item-sheet",
    uuidField: "itemUuid",
    expectedClass: Item,
    expectedTypeLabel: "Item",
    responseKey: "item",
    successMessage: "Remote Action opened item sheet on receiver."
  });
}

async function handleOpenItemUseDialogAction(request) {
  const actionType = "open-item-use-dialog";

  logDebug("Entering open-item-use-dialog handler.", {
    actionType,
    itemUuid: request?.payload?.itemUuid,
    request
  });

  const validation = validateDocumentUuidRequest(request, "itemUuid", actionType);
  if (!validation.ok) {
    logDebug("open-item-use-dialog payload validation failed.", {
      actionType,
      errors: validation.errors,
      request
    });
    return buildInvalidActionResponse(request, validation.errors);
  }

  const itemUuid = validation.normalizedUuid;
  const document = await fromUuid(itemUuid);

  logDebug("Resolved item use dialog target.", {
    actionType,
    itemUuid,
    itemFound: Boolean(document),
    itemName: document?.name ?? null,
    documentType: document?.documentName ?? null,
    workflowSettings: getWorkflowSettings()
  });

  if (!document) {
    return buildDocumentErrorResponse(request, "document-not-found", [
      `No document found for itemUuid '${itemUuid}'.`
    ]);
  }

  if (!(document instanceof Item)) {
    return buildDocumentErrorResponse(request, "invalid-document-type", [
      `UUID '${itemUuid}' does not resolve to an Item.`
    ]);
  }

  const workflowResult = await startDnd5eItemUsageWorkflow(document);

  if (!workflowResult.ok) {
    logDebug("Failed to start dnd5e item usage workflow cleanly.", {
      actionType,
      itemUuid,
      itemName: document.name,
      attemptedMethod: workflowResult.attemptedMethod,
      workflowMode: workflowResult.workflowMode,
      launchMode: workflowResult.launchMode,
      activityName: workflowResult.activityName,
      activityType: workflowResult.activityType,
      midiAvailable: workflowResult.midiAvailable,
      midiUsed: workflowResult.midiUsed,
      sourceActor: workflowResult.sourceActor,
      sourceToken: workflowResult.sourceToken,
      targets: workflowResult.targets,
      chatMessageId: workflowResult.chatMessageId,
      chatCardCreated: workflowResult.chatCardCreated,
      reason: workflowResult.reason,
      errors: workflowResult.errors
    });

    return {
      ...buildDocumentErrorResponse(request, workflowResult.reason, workflowResult.errors),
      attemptedMethod: workflowResult.attemptedMethod,
      workflowMode: workflowResult.workflowMode,
      damageRolled: workflowResult.damageRolled ?? false,
      isCritical: workflowResult.isCritical ?? false,
      launchMode: workflowResult.launchMode,
      activityId: workflowResult.activityId,
      activityName: workflowResult.activityName,
      activityType: workflowResult.activityType,
      requiresDialog: workflowResult.requiresDialog,
      dialogVisible: workflowResult.dialogVisible,
      midiAvailable: workflowResult.midiAvailable ?? false,
      midiUsed: workflowResult.midiUsed ?? false,
      sourceActor: workflowResult.sourceActor ?? null,
      sourceToken: workflowResult.sourceToken ?? null,
      sourceResolution: workflowResult.sourceResolution ?? null,
      targets: workflowResult.targets ?? [],
      chatMessageId: workflowResult.chatMessageId ?? null,
      chatCardCreated: workflowResult.chatCardCreated ?? false,
      templatePlaced: workflowResult.templatePlaced ?? false,
      templateUuid: workflowResult.templateUuid ?? null,
      workflowStateAfterTemplate: workflowResult.workflowStateAfterTemplate ?? null,
      resumedAfterTemplate: workflowResult.resumedAfterTemplate ?? false,
      resumeMethod: workflowResult.resumeMethod ?? null,
      subsequentWorkflowTriggered: workflowResult.subsequentWorkflowTriggered ?? false,
      saveWorkflowStarted: workflowResult.saveWorkflowStarted ?? false,
      damageWorkflowStarted: workflowResult.damageWorkflowStarted ?? false,
      finalResult: workflowResult.finalResult ?? null
    };
  }

  const message = workflowResult.workflowMode === MANUAL_HIT_WORKFLOW_MODE
    ? workflowResult.midiUsed
      ? "Remote Action started Midi-QOL damage workflow after a manual hit assumption."
      : "Remote Action started Foundry damage workflow after a manual hit assumption."
    : workflowResult.launchMode === "dialog"
      ? "Remote Action opened item use dialog on receiver."
      : workflowResult.chatCardCreated
        ? "Remote Action started native item workflow on receiver and created a chat card."
        : "Remote Action started item use workflow on receiver without a visible dialog.";

  return buildBaseResponse(request, {
    handled: true,
    message,
    item: {
      uuid: itemUuid,
      id: document.id,
      name: document.name
    },
    itemName: document.name,
    attemptedMethod: workflowResult.attemptedMethod,
    workflowMode: workflowResult.workflowMode,
    damageRolled: workflowResult.damageRolled ?? false,
    isCritical: workflowResult.isCritical ?? false,
    launchMode: workflowResult.launchMode,
    activityId: workflowResult.activityId,
    activityName: workflowResult.activityName,
    activityType: workflowResult.activityType,
    requiresDialog: workflowResult.requiresDialog,
    dialogAppId: workflowResult.dialogApp?.appId ?? null,
    dialogClass: workflowResult.dialogApp?.constructor?.name ?? null,
    dialogVisible: workflowResult.dialogVisible,
    dialogRendered: Boolean(workflowResult.dialogApp?.rendered),
    midiAvailable: workflowResult.midiAvailable ?? false,
    midiUsed: workflowResult.midiUsed ?? false,
    sourceActor: workflowResult.sourceActor ?? null,
    sourceToken: workflowResult.sourceToken ?? null,
    sourceResolution: workflowResult.sourceResolution ?? null,
    targets: workflowResult.targets ?? [],
    chatMessageId: workflowResult.chatMessageId ?? null,
    chatCardCreated: workflowResult.chatCardCreated ?? false,
    chatFocusActions: workflowResult.chatFocusActions ?? [],
    workflowId: workflowResult.workflowId ?? null,
    workflowItemCardUuid: workflowResult.workflowItemCardUuid ?? null,
    damageRollFormula: workflowResult.damageRollFormula ?? null,
    damageRollTotal: workflowResult.damageRollTotal ?? null,
    damageType: workflowResult.damageType ?? null,
    templatePlaced: workflowResult.templatePlaced ?? false,
    templateUuid: workflowResult.templateUuid ?? null,
    workflowStateAfterTemplate: workflowResult.workflowStateAfterTemplate ?? null,
    resumedAfterTemplate: workflowResult.resumedAfterTemplate ?? false,
    resumeMethod: workflowResult.resumeMethod ?? null,
    subsequentWorkflowTriggered: workflowResult.subsequentWorkflowTriggered ?? false,
    saveWorkflowStarted: workflowResult.saveWorkflowStarted ?? false,
    damageWorkflowStarted: workflowResult.damageWorkflowStarted ?? false,
    finalResult: workflowResult.finalResult ?? null,
    workflowLinkedToExecution: workflowResult.workflowMode === MANUAL_HIT_WORKFLOW_MODE
      ? Boolean(workflowResult.damageRolled)
      : true,
    expectsManualUseClick: workflowResult.workflowMode === MANUAL_HIT_WORKFLOW_MODE
      ? false
      : true
  });
}

function handleUnknownAction(request) {
  const actionType = getRequestActionType(request);

  logDebug("Falling back to generic placeholder handler.", {
    actionType,
    request
  });

  return buildBaseResponse(request, {
    handled: false,
    message: `Remote Action placeholder: actionType '${actionType}' is not implemented yet.`
  });
}

export async function executeRemoteAction(request = {}) {
  const actionType = getRequestActionType(request);

  logDebug("Receiver placeholder executing remote action.", {
    currentUserId: game.user?.id,
    currentUserName: game.user?.name,
    actionType,
    request
  });

  switch (actionType) {
    case "ping":
      return handlePingAction(request);
    case "notify":
      return handleNotifyAction(request);
    case "open-actor-sheet":
      return handleOpenActorSheetAction(request);
    case "open-item-sheet":
      return handleOpenItemSheetAction(request);
    case "open-item-use-dialog":
      return handleOpenItemUseDialogAction(request);
    default:
      return handleUnknownAction(request);
  }
}
