import { logDebug, logInfo, logWarning } from "./debug.js";
import { MODULE_ID, getWorkflowSettings } from "./settings.js";

const NOTIFICATION_LEVELS = new Set(["info", "warn", "error"]);
const MANUAL_HIT_WORKFLOW_MODE = "midi-auto-hit-complete-activity-use";
const MIDI_SPELL_WORKFLOW_MODE = "midi-spell-complete-activity-use";
const REMOTE_SPELL_AUTO_ROLL_DAMAGE_MODE = "saveOnly";
const LOCAL_GM_SPELL_WORKFLOW_MODE = "local-gm-native-spell-use";
const REMOTE_TV_SPELL_WORKFLOW_SOURCE = "remote-tv";
const LOCAL_GM_SPELL_WORKFLOW_SOURCE = "local-gm";
const SECONDARY_AOE_MODULE_ID = "foundryvtt-dnd5e-aoe-secondary";
const SECONDARY_AOE_FLAG_KEY = "secondaryAoe";
const REMOTE_SPELL_ACTIVITY_MARKERS = new Map();
const LOCAL_GM_SPELL_WORKFLOW_MONITORS = new Map();
let spellWorkflowComparisonHooksRegistered = false;
let secondaryAoeActivityObserversRegistered = false;
let remoteActionAutoHitWorkflowClass = null;

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

function validateRelayActivityUseRequest(request) {
  const payload = request?.payload;
  const errors = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      errors: ["payload must be an object for actionType 'relay-activity-use'."],
      normalizedPayload: null
    };
  }

  const normalizedPayload = {};
  const requiredStringFields = ["itemUuid", "activityUuid"];
  const optionalStringFields = ["sourceActorUuid", "sourceTokenUuid"];

  for (const field of requiredStringFields) {
    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      errors.push(`${field} is required and must be a non-empty string for actionType 'relay-activity-use'.`);
    } else {
      normalizedPayload[field] = payload[field].trim();
    }
  }

  for (const field of optionalStringFields) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === "") continue;

    if (typeof payload[field] !== "string" || !payload[field].trim()) {
      errors.push(`${field} must be a non-empty string when provided for actionType 'relay-activity-use'.`);
    } else {
      normalizedPayload[field] = payload[field].trim();
    }
  }

  if (payload.targetTokenUuids !== undefined) {
    if (!Array.isArray(payload.targetTokenUuids)) {
      errors.push("targetTokenUuids must be an array of strings when provided for actionType 'relay-activity-use'.");
    } else {
      normalizedPayload.targetTokenUuids = payload.targetTokenUuids
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean);
    }
  } else {
    normalizedPayload.targetTokenUuids = [];
  }

  if (payload.options !== undefined && (!payload.options || typeof payload.options !== "object" || Array.isArray(payload.options))) {
    errors.push("options must be an object when provided for actionType 'relay-activity-use'.");
  } else {
    normalizedPayload.options = payload.options ?? {};
  }

  if (payload.context !== undefined && (!payload.context || typeof payload.context !== "object" || Array.isArray(payload.context))) {
    errors.push("context must be an object when provided for actionType 'relay-activity-use'.");
  } else {
    normalizedPayload.context = payload.context ?? {};
  }

  normalizedPayload.aoeSecondaryExecution = Boolean(
    payload.aoeSecondaryExecution
    ?? payload.options?.aoeSecondaryExecution
    ?? payload.context?.aoeSecondaryExecution
  );

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      normalizedPayload: null
    };
  }

  return {
    ok: true,
    errors: [],
    normalizedPayload
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

function summarizeActivityIdentity(activity) {
  return {
    id: String(activity?.id ?? activity?._id ?? ""),
    uuid: activity?.uuid ?? null,
    name: activity?.name ?? null,
    type: activity?.type ?? activity?.metadata?.type ?? activity?.constructor?.name ?? null
  };
}

function getSecondaryAoeDiagnostic(item) {
  const rawConfig = item?.getFlag?.(SECONDARY_AOE_MODULE_ID, SECONDARY_AOE_FLAG_KEY) ?? {};
  const itemActivities = getItemActivities(item).map((activity) => summarizeActivityIdentity(activity));
  const firstItemActivity = itemActivities[0] ?? null;
  const secondaryActivityId = String(rawConfig?.secondaryActivityId ?? "");
  const secondaryActivity = itemActivities.find((activity) => activity.id === secondaryActivityId) ?? null;

  return {
    aoeModuleActive: Boolean(game.modules?.get(SECONDARY_AOE_MODULE_ID)?.active),
    aoeEnabled: Boolean(rawConfig?.enabled),
    aoeTrigger: rawConfig?.trigger ?? null,
    secondaryActivityId,
    secondaryActivityUuid: secondaryActivity?.uuid ?? null,
    secondaryActivityName: secondaryActivity?.name ?? null,
    secondaryActivityType: secondaryActivity?.type ?? null,
    firstItemActivityId: firstItemActivity?.id ?? "",
    firstItemActivityUuid: firstItemActivity?.uuid ?? null,
    firstItemActivityName: firstItemActivity?.name ?? null,
    firstItemActivityType: firstItemActivity?.type ?? null,
    itemActivityIds: itemActivities.map((activity) => activity.id),
    itemActivities
  };
}

function getWorkflowItemCard(workflow) {
  if (workflow?.itemCard) return workflow.itemCard;
  if (!workflow?.itemCardUuid) return null;

  try {
    return fromUuidSync(workflow.itemCardUuid) ?? null;
  } catch (_error) {
    return null;
  }
}

function getRemoteActionExecutionMetadata(workflow) {
  const itemCard = getWorkflowItemCard(workflow);
  const remoteActionExecution = Boolean(
    workflow?.remoteActionExecution
    ?? workflow?.options?.remoteActionExecution
    ?? workflow?.workflowOptions?.remoteActionExecution
    ?? workflow?.midiOptions?.remoteActionExecution
    ?? itemCard?.getFlag?.(MODULE_ID, "remoteActionExecution")
    ?? itemCard?.flags?.[MODULE_ID]?.remoteActionExecution
  );
  const remoteActionExecutionMode = itemCard?.getFlag?.(MODULE_ID, "remoteActionExecutionMode")
    ?? itemCard?.flags?.[MODULE_ID]?.remoteActionExecutionMode
    ?? null;

  return {
    remoteActionExecution,
    remoteActionExecutionMode,
    itemCardUuid: itemCard?.uuid ?? workflow?.itemCardUuid ?? null
  };
}

function getNativeExecutionPathFromExecutionMode(executionMode = null) {
  if (executionMode?.includes(":activity.use")) return "activity.use";
  if (executionMode?.includes("item.use")) return "item.use";
  return null;
}

function getSecondaryAoeModuleApi() {
  return game.modules?.get(SECONDARY_AOE_MODULE_ID)?.api ?? null;
}

function summarizeSecondaryAoePlan(plan) {
  if (!plan || typeof plan !== "object") return null;

  return {
    ready: Boolean(plan.ready),
    reason: plan.reason ?? null,
    primaryActivityId: String(plan.primaryActivityId ?? ""),
    secondaryActivityId: String(plan.secondaryActivityId ?? ""),
    primaryActivityUuid: plan.primaryActivity?.uuid ?? null,
    secondaryActivityUuid: plan.secondaryActivity?.uuid ?? null,
    secondaryTargetCount: Number(plan.secondaryTargetCount ?? 0),
    hook: plan.debug?.midi?.hook ?? null,
    trigger: plan.debug?.midi?.trigger ?? null,
    itemUuid: plan.debug?.midi?.itemUuid ?? null,
    itemName: plan.debug?.midi?.itemName ?? null
  };
}

function summarizeSecondaryAoeExecutionResult(result) {
  if (!result || typeof result !== "object") return null;

  return {
    executed: Boolean(result.executed),
    reason: result.reason ?? null,
    primaryActivityId: String(result.primaryActivityId ?? ""),
    secondaryActivityId: String(result.secondaryActivityId ?? ""),
    usedActivityId: String(result.usedActivityId ?? ""),
    attemptedTargetCount: Number(result.attemptedTargetCount ?? 0),
    consumptionSuppressed: Boolean(result.consumptionSuppressed),
    hook: result.resultSummary?.hook ?? null,
    trigger: result.resultSummary?.trigger ?? null,
    triggerReason: result.resultSummary?.triggerReason ?? null
  };
}

function getSecondaryAoeRuntimeSnapshot() {
  const api = getSecondaryAoeModuleApi();
  const apiErrors = [];
  let lastPlan = null;
  let lastExecutionResult = null;

  if (api) {
    if (typeof api.getLastMidiSecondaryAoePlan === "function") {
      try {
        lastPlan = api.getLastMidiSecondaryAoePlan();
      } catch (error) {
        apiErrors.push(`getLastMidiSecondaryAoePlan:${error?.message ?? String(error)}`);
      }
    }

    if (typeof api.getLastMidiSecondaryAoeExecutionResult === "function") {
      try {
        lastExecutionResult = api.getLastMidiSecondaryAoeExecutionResult();
      } catch (error) {
        apiErrors.push(`getLastMidiSecondaryAoeExecutionResult:${error?.message ?? String(error)}`);
      }
    }
  }

  return {
    apiAvailable: Boolean(api),
    apiErrors,
    lastPlan: summarizeSecondaryAoePlan(lastPlan),
    lastExecutionResult: summarizeSecondaryAoeExecutionResult(lastExecutionResult)
  };
}

function buildFlatSecondaryAoeRuntimeSnapshotLogData(runtimeSnapshot = {}) {
  const lastPlan = runtimeSnapshot?.lastPlan ?? null;
  const lastExecutionResult = runtimeSnapshot?.lastExecutionResult ?? null;

  return {
    secondaryAoePlanReady: lastPlan?.ready ?? null,
    secondaryAoePlanReason: lastPlan?.reason ?? null,
    secondaryAoePlanPrimaryActivityId: lastPlan?.primaryActivityId ?? "",
    secondaryAoePlanSecondaryActivityId: lastPlan?.secondaryActivityId ?? "",
    secondaryAoePlanPrimaryActivityUuid: lastPlan?.primaryActivityUuid ?? null,
    secondaryAoePlanSecondaryActivityUuid: lastPlan?.secondaryActivityUuid ?? null,
    secondaryAoePlanSecondaryTargetCount: lastPlan?.secondaryTargetCount ?? 0,
    secondaryAoePlanHook: lastPlan?.hook ?? null,
    secondaryAoePlanTrigger: lastPlan?.trigger ?? null,
    secondaryAoePlanJson: serializeDiagnosticValue(lastPlan),
    secondaryAoeExecutionExecuted: lastExecutionResult?.executed ?? null,
    secondaryAoeExecutionReason: lastExecutionResult?.reason ?? null,
    secondaryAoeExecutionPrimaryActivityId: lastExecutionResult?.primaryActivityId ?? "",
    secondaryAoeExecutionSecondaryActivityId: lastExecutionResult?.secondaryActivityId ?? "",
    secondaryAoeExecutionUsedActivityId: lastExecutionResult?.usedActivityId ?? "",
    secondaryAoeExecutionAttemptedTargetCount: lastExecutionResult?.attemptedTargetCount ?? 0,
    secondaryAoeExecutionConsumptionSuppressed: lastExecutionResult?.consumptionSuppressed ?? null,
    secondaryAoeExecutionHook: lastExecutionResult?.hook ?? null,
    secondaryAoeExecutionTrigger: lastExecutionResult?.trigger ?? null,
    secondaryAoeExecutionTriggerReason: lastExecutionResult?.triggerReason ?? null,
    secondaryAoeExecutionJson: serializeDiagnosticValue(lastExecutionResult)
  };
}

function shouldObserveAoeHookWorkflow(workflow) {
  const item = workflow?.item ?? workflow?.activity?.item ?? null;
  if (!item) return false;

  const aoe = getSecondaryAoeDiagnostic(item);
  const executionMetadata = getRemoteActionExecutionMetadata(workflow);
  return aoe.aoeEnabled || executionMetadata.remoteActionExecution;
}

function buildAoeHookObserverLogData(workflow, hookName, hookStage) {
  const item = workflow?.item ?? workflow?.activity?.item ?? null;
  const executionMetadata = getRemoteActionExecutionMetadata(workflow);
  const runtimeSnapshot = getSecondaryAoeRuntimeSnapshot();
  const aoeObservationEligible = shouldObserveAoeHookWorkflow(workflow);

  return {
    hookName,
    hookStage,
    aoeObservationEligible,
    ...buildAoeDiagnosticLogData({
      item,
      launchedActivity: workflow?.activity ?? null,
      workflow,
      stage: `${hookName}:${hookStage}`,
      nativeExecutionPath: getNativeExecutionPathFromExecutionMode(executionMetadata.remoteActionExecutionMode),
      workflowMode: executionMetadata.remoteActionExecutionMode ?? null,
      executionMode: executionMetadata.remoteActionExecutionMode ?? null
    }),
    remoteActionExecution: executionMetadata.remoteActionExecution,
    remoteActionExecutionMode: executionMetadata.remoteActionExecutionMode,
    remoteActionItemCardUuid: executionMetadata.itemCardUuid,
    workflowSummary: summarizeMidiWorkflow(workflow),
    secondaryAoeApiAvailable: runtimeSnapshot.apiAvailable,
    secondaryAoeApiErrors: runtimeSnapshot.apiErrors,
    ...buildFlatSecondaryAoeRuntimeSnapshotLogData(runtimeSnapshot),
    secondaryAoeLastPlan: runtimeSnapshot.lastPlan,
    secondaryAoeLastExecutionResult: runtimeSnapshot.lastExecutionResult
  };
}

function buildAoeHookEntryLogData(workflow, hookName) {
  const item = workflow?.item ?? workflow?.activity?.item ?? null;

  return {
    hookName,
    itemUuid: item?.uuid ?? null,
    activityUuid: workflow?.activity?.uuid ?? null,
    currentUserId: game.user?.id ?? null,
    isGM: Boolean(game.user?.isGM)
  };
}

function observeAoeHookWorkflow(workflow, hookName) {
  logInfo(`Remote Action AOE hook observer at ${hookName}.`, buildAoeHookObserverLogData(workflow, hookName, "entry"));

  setTimeout(() => {
    logInfo(`Remote Action AOE hook observer after ${hookName}.`, buildAoeHookObserverLogData(workflow, hookName, "after-hook"));
  }, 0);
}

function shouldObserveSecondaryAoeActivity(activity) {
  const item = activity?.item ?? activity?.parent ?? null;
  if (!(item instanceof Item)) return false;
  return getSecondaryAoeDiagnostic(item).aoeEnabled;
}

function buildAoeActivityHookLogData(activity, hookName, hookStage, extra = {}) {
  const item = activity?.item ?? activity?.parent ?? null;
  const runtimeSnapshot = getSecondaryAoeRuntimeSnapshot();

  return {
    hookName,
    hookStage,
    currentUserId: game.user?.id ?? null,
    currentUserName: game.user?.name ?? null,
    isGM: Boolean(game.user?.isGM),
    ...buildAoeDiagnosticLogData({
      item,
      launchedActivity: activity ?? null,
      stage: `${hookName}:${hookStage}`
    }),
    secondaryAoeApiAvailable: runtimeSnapshot.apiAvailable,
    secondaryAoeApiErrors: runtimeSnapshot.apiErrors,
    ...buildFlatSecondaryAoeRuntimeSnapshotLogData(runtimeSnapshot),
    secondaryAoeLastPlan: runtimeSnapshot.lastPlan,
    secondaryAoeLastExecutionResult: runtimeSnapshot.lastExecutionResult,
    ...extra
  };
}

function observeSecondaryAoeActivityHook(activity, hookName, extra = {}) {
  if (!shouldObserveSecondaryAoeActivity(activity)) return;

  logInfo(`Remote Action AOE activity hook observed at ${hookName}.`, buildAoeActivityHookLogData(activity, hookName, "entry", extra));

  setTimeout(() => {
    logInfo(`Remote Action AOE activity hook observed after ${hookName}.`, buildAoeActivityHookLogData(activity, hookName, "after-hook", extra));
  }, 0);
}

function buildPrimaryWorkflowAoeApiSnapshotExportText(logPayload = {}) {
  return serializeDiagnosticValue({
    secondaryAoePlanReady: logPayload.secondaryAoePlanReady ?? null,
    secondaryAoePlanReason: logPayload.secondaryAoePlanReason ?? null,
    secondaryAoePlanPrimaryActivityId: logPayload.secondaryAoePlanPrimaryActivityId ?? "",
    secondaryAoePlanSecondaryActivityId: logPayload.secondaryAoePlanSecondaryActivityId ?? "",
    secondaryAoeExecutionReason: logPayload.secondaryAoeExecutionReason ?? null,
    secondaryAoeExecutionPrimaryActivityId: logPayload.secondaryAoeExecutionPrimaryActivityId ?? "",
    secondaryAoeExecutionSecondaryActivityId: logPayload.secondaryAoeExecutionSecondaryActivityId ?? "",
    secondaryAoePlanJson: logPayload.secondaryAoePlanJson ?? null,
    secondaryAoeExecutionJson: logPayload.secondaryAoeExecutionJson ?? null
  });
}

function logAoeApiSnapshotAfterPrimaryWorkflow({
  item,
  activity,
  workflow = null,
  resultSummary = null,
  attemptedMethod = null,
  workflowMode = null,
  hookSource = null
} = {}) {
  if (!item || !getSecondaryAoeDiagnostic(item).aoeEnabled) return;

  const buildPayload = (snapshotStage) => {
    const runtimeSnapshot = getSecondaryAoeRuntimeSnapshot();

    return {
      snapshotStage,
      hookSource,
      currentUserId: game.user?.id ?? null,
      currentUserName: game.user?.name ?? null,
      isGM: Boolean(game.user?.isGM),
      ...buildAoeDiagnosticLogData({
        item,
        launchedActivity: activity ?? null,
        workflow,
        stage: `primary-workflow-resolution:${snapshotStage}`,
        attemptedMethod,
        workflowMode,
        executionMode: workflowMode
      }),
      workflowSummary: summarizeMidiWorkflow(workflow),
      resultSummary,
      secondaryAoeApiAvailable: runtimeSnapshot.apiAvailable,
      secondaryAoeApiErrors: runtimeSnapshot.apiErrors,
      ...buildFlatSecondaryAoeRuntimeSnapshotLogData(runtimeSnapshot),
      secondaryAoeLastPlan: runtimeSnapshot.lastPlan,
      secondaryAoeLastExecutionResult: runtimeSnapshot.lastExecutionResult
    };
  };

  const entryPayload = buildPayload("entry");
  logInfo(`Remote Action AOE API snapshot after primary workflow resolution. ${buildPrimaryWorkflowAoeApiSnapshotExportText(entryPayload)}`);

  setTimeout(() => {
    const afterTickPayload = buildPayload("after-tick");
    logInfo(`Remote Action AOE API snapshot after primary workflow resolution tick. ${buildPrimaryWorkflowAoeApiSnapshotExportText(afterTickPayload)}`);
  }, 0);
}

function buildAoeDiagnosticLogData({
  item,
  launchedActivity = null,
  workflow = null,
  stage = null,
  relayEntryPoint = null,
  nativeExecutionPath = null,
  actionType = null,
  attemptedMethod = null,
  workflowMode = null,
  executionMode = null
} = {}) {
  const itemDocument = item ?? workflow?.item ?? null;
  const launched = summarizeActivityIdentity(launchedActivity);
  const workflowActivity = summarizeActivityIdentity(workflow?.activity ?? null);
  const aoe = getSecondaryAoeDiagnostic(itemDocument);
  const predictedPrimaryActivityId = launched.id || "";
  const workflowPrimaryActivityId = workflowActivity.id || "";

  return {
    stage,
    actionType,
    relayEntryPoint,
    nativeExecutionPath,
    attemptedMethod,
    workflowMode,
    executionMode,
    itemUuid: itemDocument?.uuid ?? null,
    itemName: itemDocument?.name ?? null,
    launchedActivityId: launched.id,
    launchedActivityUuid: launched.uuid,
    launchedActivityName: launched.name,
    launchedActivityType: launched.type,
    workflowActivityId: workflowActivity.id,
    workflowActivityUuid: workflowActivity.uuid,
    workflowActivityName: workflowActivity.name,
    workflowActivityType: workflowActivity.type,
    secondaryActivityId: aoe.secondaryActivityId,
    secondaryActivityUuid: aoe.secondaryActivityUuid,
    secondaryActivityName: aoe.secondaryActivityName,
    secondaryActivityType: aoe.secondaryActivityType,
    firstItemActivityId: aoe.firstItemActivityId,
    firstItemActivityUuid: aoe.firstItemActivityUuid,
    firstItemActivityName: aoe.firstItemActivityName,
    firstItemActivityType: aoe.firstItemActivityType,
    itemActivityIds: aoe.itemActivityIds,
    itemActivities: aoe.itemActivities,
    aoeModuleActive: aoe.aoeModuleActive,
    aoeEnabled: aoe.aoeEnabled,
    aoeTrigger: aoe.aoeTrigger,
    predictedPrimaryActivityId,
    predictedDuplicateWithSecondary: Boolean(
      aoe.secondaryActivityId
      && predictedPrimaryActivityId
      && (aoe.secondaryActivityId === predictedPrimaryActivityId)
    ),
    midiWorkflowPrimaryActivityId: workflowPrimaryActivityId,
    midiWorkflowDuplicateWithSecondary: Boolean(
      aoe.secondaryActivityId
      && workflowPrimaryActivityId
      && (aoe.secondaryActivityId === workflowPrimaryActivityId)
    ),
    launchedMatchesSecondary: Boolean(
      aoe.secondaryActivityId
      && launched.id
      && (aoe.secondaryActivityId === launched.id)
    ),
    workflowMatchesSecondary: Boolean(
      aoe.secondaryActivityId
      && workflowActivity.id
      && (aoe.secondaryActivityId === workflowActivity.id)
    ),
    workflowMatchesLaunched: Boolean(
      launched.id
      && workflowActivity.id
      && (launched.id === workflowActivity.id)
    )
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

function normalizeWorkflowParticipants(participants = {}) {
  return {
    sourceActor: participants?.sourceActor ?? null,
    sourceToken: participants?.sourceToken ?? null,
    sourceResolution: participants?.sourceResolution ?? null,
    controlledTokens: Array.isArray(participants?.controlledTokens)
      ? participants.controlledTokens.filter(Boolean)
      : [],
    targets: Array.isArray(participants?.targets)
      ? participants.targets.filter(Boolean)
      : []
  };
}

function isThenable(value) {
  return typeof value?.then === "function";
}

function cloneExecutionConfig(config = {}) {
  return (config && typeof config === "object" && !Array.isArray(config))
    ? foundry.utils.deepClone(config)
    : {};
}

function applyRemoteActionExecutionFlags(config, executionMode) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config;

  config.remoteActionExecution = true;
  foundry.utils.setProperty(config, `flags.${MODULE_ID}.remoteActionExecution`, true);

  if (executionMode) {
    foundry.utils.setProperty(config, `flags.${MODULE_ID}.remoteActionExecutionMode`, executionMode);
  }

  return config;
}

function buildRemoteActionExecutionConfigs(usage = {}, dialog = {}, message = {}, { executionMode = "remote-action" } = {}) {
  const usagePayload = applyRemoteActionExecutionFlags(cloneExecutionConfig(usage), executionMode);
  const dialogConfig = applyRemoteActionExecutionFlags(cloneExecutionConfig(dialog), executionMode);
  const messageConfig = applyRemoteActionExecutionFlags(cloneExecutionConfig(message), executionMode);

  foundry.utils.setProperty(usagePayload, "context.remoteActionExecution", true);
  foundry.utils.setProperty(usagePayload, "workflowOptions.remoteActionExecution", true);
  foundry.utils.setProperty(usagePayload, "midiOptions.remoteActionExecution", true);
  foundry.utils.setProperty(usagePayload, "midiOptions.workflowOptions.remoteActionExecution", true);
  foundry.utils.setProperty(messageConfig, `data.flags.${MODULE_ID}.remoteActionExecution`, true);

  if (executionMode) {
    foundry.utils.setProperty(messageConfig, `data.flags.${MODULE_ID}.remoteActionExecutionMode`, executionMode);
  }

  return {
    usagePayload,
    dialogConfig,
    messageConfig
  };
}

function getCurrentUserTargetIds() {
  return Array.from(game.user?.targets ?? []).map((token) => token?.id).filter(Boolean);
}

function applyUserTargetIds(tokenIds) {
  if (typeof game.user?.updateTokenTargets === "function") {
    game.user.updateTokenTargets(tokenIds);
    return;
  }

  const desired = new Set(tokenIds ?? []);
  for (const token of canvas?.tokens?.placeables ?? []) {
    token.setTarget(desired.has(token.id), {
      user: game.user,
      releaseOthers: false,
      groupSelection: true
    });
  }
}

async function resolveUuidDocumentSafely(uuid) {
  if (typeof uuid !== "string" || !uuid.trim()) return null;

  try {
    return await fromUuid(uuid.trim());
  } catch (_error) {
    return null;
  }
}

async function resolveWorkflowToken(uuid) {
  const resolved = await resolveUuidDocumentSafely(uuid);
  return resolved?.object ?? resolved ?? null;
}

function getItemActivities(item) {
  if (typeof item?.system?.activities?.filter === "function") {
    return item.system.activities.filter(() => true);
  }

  if (Array.isArray(item?.system?.activities?.contents)) {
    return item.system.activities.contents.filter(Boolean);
  }

  if (Array.isArray(item?.system?.activities)) {
    return item.system.activities.filter(Boolean);
  }

  return [];
}

async function resolveItemActivity(item, activityUuid) {
  const resolvedByUuid = await resolveUuidDocumentSafely(activityUuid);
  if (resolvedByUuid) return resolvedByUuid;

  const normalizedActivityUuid = String(activityUuid ?? "").trim();
  const fallbackId = normalizedActivityUuid.split(".").pop();
  const activities = getItemActivities(item);

  return activities.find((activity) => {
    const activityId = String(activity?.id ?? activity?._id ?? "");
    const activityDocumentUuid = String(activity?.uuid ?? "");
    return activityDocumentUuid === normalizedActivityUuid
      || activityId === normalizedActivityUuid
      || activityId === fallbackId;
  }) ?? null;
}

async function resolveExplicitWorkflowParticipants(item, payload = {}) {
  const sourceActorDocument = payload?.sourceActorUuid
    ? await resolveUuidDocumentSafely(payload.sourceActorUuid)
    : item?.actor ?? null;
  const sourceActor = sourceActorDocument?.actor ?? sourceActorDocument ?? item?.actor ?? null;

  let sourceToken = payload?.sourceTokenUuid
    ? await resolveWorkflowToken(payload.sourceTokenUuid)
    : null;
  let sourceResolution = sourceToken
    ? "payload-source-token"
    : payload?.sourceActorUuid
      ? "payload-source-actor"
      : "item-actor-default";

  if (!sourceToken) {
    const actorActiveToken = sourceActor?.getActiveTokens?.()?.[0] ?? null;
    if (actorActiveToken) {
      sourceToken = actorActiveToken;
      sourceResolution = payload?.sourceActorUuid
        ? "payload-source-actor-active-token-fallback"
        : "item-actor-active-token-fallback";
    }
  }

  const targetUuids = Array.isArray(payload?.targetTokenUuids) ? payload.targetTokenUuids : [];
  const resolvedTargets = await Promise.all(targetUuids.map((targetUuid) => resolveWorkflowToken(targetUuid)));

  return normalizeWorkflowParticipants({
    sourceActor,
    sourceToken,
    sourceResolution,
    controlledTokens: [],
    targets: resolvedTargets.filter(Boolean)
  });
}

function buildExplicitActivityExecutionConfig(payload = {}) {
  const usagePayload = foundry.utils.deepClone(payload?.options?.usage ?? {});
  const dialogConfig = foundry.utils.deepClone(payload?.options?.dialog ?? { configure: false });
  const messageConfig = foundry.utils.deepClone(payload?.options?.message ?? {});
  const aoeSecondaryExecution = Boolean(payload?.aoeSecondaryExecution);
  const bridgeModuleId = payload?.context?.bridgeModuleId ?? null;

  if (aoeSecondaryExecution) {
    usagePayload.aoeSecondaryExecution = true;
    foundry.utils.setProperty(usagePayload, "workflowOptions.aoeSecondaryExecution", true);
    foundry.utils.setProperty(usagePayload, "midiOptions.aoeSecondaryExecution", true);

    if (bridgeModuleId) {
      foundry.utils.setProperty(usagePayload, `flags.${bridgeModuleId}.aoeSecondaryExecution`, true);
      foundry.utils.setProperty(messageConfig, `flags.${bridgeModuleId}.aoeSecondaryExecution`, true);
    }
  }

  if (dialogConfig.configure === undefined) {
    dialogConfig.configure = false;
  }

  const executionConfigs = buildRemoteActionExecutionConfigs(
    usagePayload,
    dialogConfig,
    messageConfig,
    { executionMode: "relay-activity-use" }
  );

  return {
    usagePayload: executionConfigs.usagePayload,
    dialogConfig: executionConfigs.dialogConfig,
    messageConfig: executionConfigs.messageConfig,
    aoeSecondaryExecution,
    bridgeModuleId,
    remoteActionExecution: true
  };
}
function getMidiQolApi() {
  if (!game.modules?.get("midi-qol")?.active) return null;
  if (globalThis.MidiQOL?.DamageOnlyWorkflow) return globalThis.MidiQOL;
  return game.modules.get("midi-qol")?.api ?? null;
}

function getRemoteActionAutoHitWorkflowClass(midiApi = getMidiQolApi()) {
  if (remoteActionAutoHitWorkflowClass) return remoteActionAutoHitWorkflowClass;

  const BaseWorkflowClass = midiApi?.workflowClass ?? globalThis.MidiQOL?.workflowClass ?? null;
  if (typeof BaseWorkflowClass !== "function") return null;

  class RemoteActionAutoHitWorkflow extends BaseWorkflowClass {
    static get forceCreate() {
      return false;
    }

    get workflowType() {
      return "RemoteActionAutoHitWorkflow";
    }

    async WorkflowState_WaitForAttackRoll(context = {}) {
      if (context.attackRoll || !this.activity?.attack) {
        return super.WorkflowState_WaitForAttackRoll(context);
      }

      this.rollOptions.fastForwardAttack = true;
      this.rollOptions.autoRollAttack = true;
      this.workflowOptions.fastForwardAttack = true;
      this.workflowOptions.autoRollAttack = true;
      this.workflowOptions.attackRollDSN = false;
      this.workflowOptions.targetConfirmation ??= "none";

      try {
        const attackRolls = await this.activity.rollAttack?.(
          {
            event: this.rollOptions.event,
            workflow: this,
            midiOptions: {
              ...this.rollOptions,
              chatMessage: false,
              isDummy: true,
              fastForward: true,
              fastForwardAttack: true,
              autoRollAttack: true,
              workflowOptions: this.workflowOptions
            }
          },
          {},
          {}
        );

        const firstAttackRoll = Array.isArray(attackRolls)
          ? attackRolls[0] ?? null
          : attackRolls ?? null;

        if (firstAttackRoll) this.attackRoll = firstAttackRoll;
      } catch (error) {
        logWarning("Remote Action Midi auto-hit hidden attack roll failed.", {
          workflowType: this.workflowType,
          itemUuid: this.item?.uuid ?? null,
          itemName: this.item?.name ?? null,
          activityUuid: this.activity?.uuid ?? null,
          activityName: this.activity?.name ?? null,
          error: error?.message ?? String(error)
        });
      }

      return this.WorkflowState_AttackRollComplete;
    }

    async processAttackRoll() {
      if (this.activity?.attack && this.attackRoll && typeof super.processAttackRoll === "function") {
        await super.processAttackRoll();
      } else if (!this.activity?.attack && typeof super.processAttackRoll === "function") {
        await super.processAttackRoll();
      }

      if (this.activity?.attack) {
        this.isCritical = false;
        this.isFumble = false;
        this.attackTotal = Number.MAX_SAFE_INTEGER;
      }

      return this.attackRoll ?? null;
    }

    async checkHits(options = {}) {
      const result = typeof super.checkHits === "function"
        ? await super.checkHits(options)
        : undefined;

      if (this.activity?.attack) {
        this.hitTargets = new Set(this.targets ?? []);
        this.hitTargetsEC = new Set();
      }

      return result;
    }

    async displayAttackRoll(displayOptions = {}) {
      if (!this.activity?.attack || typeof super.displayAttackRoll !== "function") {
        return super.displayAttackRoll?.(displayOptions);
      }

      return this.chatCard ?? null;
    }

    async displayHits(whisper = false, showHits = true) {
      if (this.activity?.attack && this.hitDisplayData && typeof this.hitDisplayData === "object") {
        for (const hitData of Object.values(this.hitDisplayData)) {
          if (!hitData?.target) continue;
          hitData.isHit = this.hitTargets?.has(hitData.target) ?? false;
          hitData.hitClass = hitData.isHit ? "success" : "failure";
        }
      }

      return super.displayHits?.(whisper, showHits);
    }
  }

  remoteActionAutoHitWorkflowClass = RemoteActionAutoHitWorkflow;
  return remoteActionAutoHitWorkflowClass;
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
  const activityType = activity?.type ?? activity?.metadata?.type ?? null;
  const isAttackActivity = activityType === "attack";

  return isAttackActivity && !Boolean(workflowSettings?.useAttackRolls);
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

function getActivityDamageKinds(activity) {
  const parts = activity?.damage?.parts ?? [];
  const types = new Set();

  for (const part of parts) {
    const partTypes = part?.types;
    if (Array.isArray(partTypes)) {
      for (const type of partTypes) {
        if (type) types.add(type);
      }
    } else if (partTypes instanceof Set) {
      for (const type of partTypes) {
        if (type) types.add(type);
      }
    }
  }

  return Array.from(types);
}

function classifyRemoteActivityWorkflow(item, activity, workflowSettings, midiApi) {
  const activityType = activity?.type ?? activity?.metadata?.type ?? null;
  const activitySummary = getActivitySummary(activity, {});
  const actionType = activity?.attack?.type ?? item?.system?.actionType ?? item?.system?.activation?.type ?? null;
  const damageKinds = getActivityDamageKinds(activity);
  const hasDamage = Boolean(activity?.hasDamage);
  const hasTemplate = Boolean(activity?.target?.template?.type);
  const isAttackActivity = activityType === "attack";
  const isSaveActivity = activityType === "save";
  const isCheckActivity = activityType === "check";
  const isSpellItem = (item?.type === "spell") || Boolean(activity?.isSpell);
  const isWeaponItem = item?.type === "weapon";
  const isSpellAttack = isAttackActivity && isSpellItem;
  const spellWorkflowProbe = getSpellWorkflowBranchProbe(item, activity, midiApi);

  let actionFamily = "utility";
  if (isWeaponItem && isAttackActivity && ["rwak", "rsak"].includes(actionType)) {
    actionFamily = "ranged-attack-simple";
  } else if (isWeaponItem && isAttackActivity) {
    actionFamily = "weapon-attack-simple";
  } else if (isSpellAttack) {
    actionFamily = "spell-attack";
  } else if (isSaveActivity && hasTemplate && hasDamage) {
    actionFamily = "save-template-damage";
  } else if (isSaveActivity && hasTemplate) {
    actionFamily = "save-template";
  } else if (isSaveActivity) {
    actionFamily = "save";
  } else if (isCheckActivity) {
    actionFamily = "check";
  } else if (activityType === "heal" || damageKinds.includes("healing")) {
    actionFamily = "heal";
  } else if (hasDamage) {
    actionFamily = "damage";
  }

  let strategy = "native-foundry";
  if (shouldUseManualHitDamageWorkflow(item, activity, workflowSettings)) {
    strategy = "midi-auto-hit";
  } else if (spellWorkflowProbe.shouldUseMidiSpellWorkflow) {
    strategy = "midi-spell";
  }

  return {
    actionFamily,
    strategy,
    itemType: item?.type ?? null,
    activityType,
    actionType,
    hasDamage,
    hasTemplate,
    templateType: activity?.target?.template?.type ?? null,
    isSpellItem,
    isWeaponItem,
    isAttackActivity,
    isSaveActivity,
    isCheckActivity,
    isSpellAttack,
    damageKinds,
    requiresDialog: activitySummary.requiresDialog,
    spellWorkflowProbe
  };
}

async function routeRemoteActivityWorkflow(item, activity, participants, options = {}) {
  const {
    workflowSettings = getWorkflowSettings(),
    midiApi = getMidiQolApi(),
    classification = classifyRemoteActivityWorkflow(item, activity, workflowSettings, midiApi)
  } = options;

  switch (classification.strategy) {
    case "midi-auto-hit":
      return startMidiAutoHitActivityWorkflow(item, activity, participants, {
        workflowMode: MANUAL_HIT_WORKFLOW_MODE,
        workflowSettings,
        midiApi
      });
    case "midi-spell":
      return startMidiCompleteActivityWorkflow(item, activity, participants, {
        workflowSettings,
        midiApi
      });
    default:
      return null;
  }
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
    workflowActivityId: String(workflow?.activity?.id ?? workflow?.activity?._id ?? ""),
    workflowActivityUuid: workflow?.activity?.uuid ?? null,
    workflowActivityName: workflow?.activity?.name ?? null,
    workflowActivityType: workflow?.activity?.type ?? workflow?.activity?.metadata?.type ?? null,
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
  const normalizedParticipants = normalizeWorkflowParticipants(participants);
  participants = normalizedParticipants;
  const baseActivitySummary = getActivitySummary(activity, {});

  if (typeof activity?._prepareUsageConfig !== "function") {
    logWarning("Remote spell workflow prerequisites missing before item.use.", {
      itemUuid: item?.uuid ?? null,
      itemName: item?.name ?? null,
      activityUuid: activity?.uuid ?? null,
      activityName: baseActivitySummary.activityName,
      activityType: baseActivitySummary.activityType,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      missingPrerequisite: "activity._prepareUsageConfig",
      midiAvailable: Boolean(midiApi),
      sourceActor: serializeActor(normalizedParticipants.sourceActor),
      sourceToken: serializeToken(normalizedParticipants.sourceToken),
      sourceResolution: normalizedParticipants.sourceResolution,
      targets: normalizedParticipants.targets.map(serializeToken)
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
      sourceActor: serializeActor(normalizedParticipants.sourceActor),
      sourceToken: serializeToken(normalizedParticipants.sourceToken),
      sourceResolution: normalizedParticipants.sourceResolution,
      targets: normalizedParticipants.targets.map(serializeToken),
      ...baseActivitySummary,
      errors: ["The dnd5e activity._prepareUsageConfig API is not available for this item."]
    };
  }

  if (typeof item?.use !== "function") {
    logWarning("Remote spell workflow prerequisites missing before item.use.", {
      itemUuid: item?.uuid ?? null,
      itemName: item?.name ?? null,
      activityUuid: activity?.uuid ?? null,
      activityName: baseActivitySummary.activityName,
      activityType: baseActivitySummary.activityType,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      missingPrerequisite: "item.use",
      midiAvailable: Boolean(midiApi),
      sourceActor: serializeActor(normalizedParticipants.sourceActor),
      sourceToken: serializeToken(normalizedParticipants.sourceToken),
      sourceResolution: normalizedParticipants.sourceResolution,
      targets: normalizedParticipants.targets.map(serializeToken)
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
      sourceActor: serializeActor(normalizedParticipants.sourceActor),
      sourceToken: serializeToken(normalizedParticipants.sourceToken),
      sourceResolution: normalizedParticipants.sourceResolution,
      targets: normalizedParticipants.targets.map(serializeToken),
      ...baseActivitySummary,
      errors: ["The dnd5e item.use API is not available for this item."]
    };
  }


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
  logDebug("Remote Action AOE diagnostic before remote spell item.use replacement.", buildAoeDiagnosticLogData({
    item,
    launchedActivity: activity,
    stage: "before-launch",
    actionType: "open-item-use-dialog",
    relayEntryPoint: "open-item-use-dialog",
    nativeExecutionPath: "item.use",
    attemptedMethod: "item.use",
    workflowMode: MIDI_SPELL_WORKFLOW_MODE,
    executionMode: MIDI_SPELL_WORKFLOW_MODE
  }));
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

    const remoteExecutionConfigs = buildRemoteActionExecutionConfigs(
      remoteSpellUsage,
      { configure: true },
      { create: true },
      { executionMode: MIDI_SPELL_WORKFLOW_MODE }
    );

    logDebug("Prepared remoteActionExecution marker for remote spell workflow native execution.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      executionMode: MIDI_SPELL_WORKFLOW_MODE,
      shouldForceRemoteSpellDamageRoll,
      remoteSpellWorkflowOptions: remoteSpellWorkflowOptions
    });

    workflowPromise = item.use(
      remoteExecutionConfigs.usagePayload,
      remoteExecutionConfigs.dialogConfig,
      remoteExecutionConfigs.messageConfig
    );

    if (!isThenable(workflowPromise)) {
      throw new Error("item.use did not return a promise.");
    }

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
    logAoeApiSnapshotAfterPrimaryWorkflow({
      item,
      activity,
      workflow,
      resultSummary,
      attemptedMethod: "item.use",
      workflowMode: MIDI_SPELL_WORKFLOW_MODE,
      hookSource: "remote-spell-item.use"
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

export function registerSecondaryAoeActivityObservers() {
  if (secondaryAoeActivityObserversRegistered) return;
  secondaryAoeActivityObserversRegistered = true;

  Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
    if (!shouldObserveSecondaryAoeActivity(activity)) return;

    logInfo("Remote Action AOE activity hook callback entered.", {
      hookName: "dnd5e.preUseActivity",
      itemUuid: activity?.item?.uuid ?? activity?.parent?.uuid ?? null,
      activityUuid: activity?.uuid ?? null,
      currentUserId: game.user?.id ?? null,
      isGM: Boolean(game.user?.isGM)
    });

    observeSecondaryAoeActivityHook(activity, "dnd5e.preUseActivity", {
      usageConfigSubsequentActions: usageConfig?.subsequentActions ?? null
    });
  });

  Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
    if (!shouldObserveSecondaryAoeActivity(activity)) return;

    logInfo("Remote Action AOE activity hook callback entered.", {
      hookName: "dnd5e.postUseActivity",
      itemUuid: activity?.item?.uuid ?? activity?.parent?.uuid ?? null,
      activityUuid: activity?.uuid ?? null,
      currentUserId: game.user?.id ?? null,
      isGM: Boolean(game.user?.isGM)
    });

    observeSecondaryAoeActivityHook(activity, "dnd5e.postUseActivity", {
      usageConfigSubsequentActions: usageConfig?.subsequentActions ?? null,
      resultSummary: summarizeWorkflowResult(results)
    });
  });

  logInfo("Remote Action AOE activity observers registered.", {
    currentUserId: game.user?.id ?? null,
    currentUserName: game.user?.name ?? null,
    isGM: Boolean(game.user?.isGM),
    registeredHooks: [
      "dnd5e.preUseActivity",
      "dnd5e.postUseActivity"
    ]
  });
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

  Hooks.on("midi-qol.AttackRollComplete", (workflow) => {
    logInfo("Remote Action AOE hook callback entered.", buildAoeHookEntryLogData(workflow, "midi-qol.AttackRollComplete"));
    observeAoeHookWorkflow(workflow, "midi-qol.AttackRollComplete");
  });

  Hooks.on("midi-qol.RollComplete", (workflow) => {
    logInfo("Remote Action AOE hook callback entered.", buildAoeHookEntryLogData(workflow, "midi-qol.RollComplete"));
    const activityUuid = workflow?.activity?.uuid ?? null;
    if (!activityUuid) return;
    observeAoeHookWorkflow(workflow, "midi-qol.RollComplete");


    const executionMetadata = getRemoteActionExecutionMetadata(workflow);
    if (executionMetadata.remoteActionExecution) {
      logDebug("Remote Action AOE diagnostic at midi-qol.RollComplete.", {
        ...buildAoeDiagnosticLogData({
          item: workflow?.item ?? null,
          launchedActivity: workflow?.activity ?? null,
          workflow,
          stage: "midi-qol.RollComplete",
          nativeExecutionPath: executionMetadata.remoteActionExecutionMode?.includes(":activity.use")
            ? "activity.use"
            : executionMetadata.remoteActionExecutionMode?.includes("item.use")
              ? "item.use"
              : null,
          workflowMode: executionMetadata.remoteActionExecutionMode ?? null,
          executionMode: executionMetadata.remoteActionExecutionMode ?? null
        }),
        remoteActionExecution: executionMetadata.remoteActionExecution,
        remoteActionExecutionMode: executionMetadata.remoteActionExecutionMode,
        remoteActionItemCardUuid: executionMetadata.itemCardUuid,
        workflowSummary: summarizeMidiWorkflow(workflow)
      });
    }

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

  logInfo("Remote Action AOE hook observers registered.", {
    currentUserId: game.user?.id ?? null,
    currentUserName: game.user?.name ?? null,
    isGM: Boolean(game.user?.isGM),
    registeredHooks: [
      "midi-qol.AttackRollComplete",
      "midi-qol.RollComplete"
    ]
  });

  logDebug("Remote Action local GM spell workflow comparison hooks registered.", {
    currentUserId: game.user?.id ?? null,
    currentUserName: game.user?.name ?? null,
    isGM: Boolean(game.user?.isGM),
    monitorRegistrationPath: "ready-gm-register",
    moduleEnvironment: getSpellWorkflowModuleEnvironment()
  });
}

async function startMidiAutoHitActivityWorkflow(item, activity, participants, options = {}) {
  const {
    workflowMode = MANUAL_HIT_WORKFLOW_MODE,
    workflowSettings = getWorkflowSettings(),
    midiApi = getMidiQolApi()
  } = options;
  participants = normalizeWorkflowParticipants(participants);

  const activitySummary = getActivitySummary(activity, {});
  const completeActivityUse = midiApi?.completeActivityUse;
  const autoHitWorkflowClass = getRemoteActionAutoHitWorkflowClass(midiApi);
  const targetTokenUuids = participants.targets
    .map((token) => token?.document?.uuid ?? token?.uuid ?? null)
    .filter(Boolean);

  if (activity?.target?.affects?.type !== "self" && targetTokenUuids.length === 0) {
    return {
      ok: false,
      reason: "missing-targets",
      launchMode: "unavailable",
      workflowMode,
      attemptedMethod: "MidiQOL.completeActivityUse",
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable: Boolean(midiApi),
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      ...activitySummary,
      errors: ["At least one target token must be targeted for this remote Midi auto-hit workflow."]
    };
  }

  if (typeof completeActivityUse !== "function" || typeof autoHitWorkflowClass !== "function") {
    return {
      ok: false,
      reason: "midi-auto-hit-workflow-unavailable",
      launchMode: "unavailable",
      workflowMode,
      attemptedMethod: "MidiQOL.completeActivityUse",
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable: Boolean(midiApi),
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      ...activitySummary,
      errors: ["The Midi-QOL completeActivityUse API or remote auto-hit workflow class is not available for this item."]
    };
  }

  const beforeIds = new Set(Object.keys(ui?.windows ?? {}));
  const beforeMessageIds = new Set(Array.from(game.messages ?? []).map((message) => String(message.id)));
  const baseUsage = {
    legacy: false,
    midiOptions: {
      targetUuids: targetTokenUuids,
      ignoreUserTargets: true,
      checkGMstatus: false,
      autoRollAttack: true,
      fastForwardAttack: true,
      autoRollDamage: workflowSettings.useDamageRolls ? "onHit" : "none",
      fastForwardDamage: Boolean(workflowSettings.useDamageRolls),
      workflowOptions: {
        autoRollAttack: true,
        fastForwardAttack: true,
        autoRollDamage: workflowSettings.useDamageRolls ? "onHit" : "none",
        fastForwardDamage: Boolean(workflowSettings.useDamageRolls),
        targetConfirmation: "none",
        attackRollDSN: false
      }
    }
  };
  const remoteExecutionConfigs = buildRemoteActionExecutionConfigs(
    baseUsage,
    { configure: false },
    { create: true },
    { executionMode: workflowMode }
  );
  remoteExecutionConfigs.usagePayload.midi ??= {};
  remoteExecutionConfigs.usagePayload.midi.workflowClass = autoHitWorkflowClass;

  logDebug("Preparing Midi-QOL complete auto-hit workflow.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "MidiQOL.completeActivityUse",
    workflowMode,
    workflowSettings,
    midiAvailable: Boolean(midiApi),
    midiUsed: true,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    targetTokenUuids
  });

  let workflow;
  try {
    workflow = await completeActivityUse(
      activity?.uuid ?? activity,
      remoteExecutionConfigs.usagePayload,
      remoteExecutionConfigs.dialogConfig,
      remoteExecutionConfigs.messageConfig
    );
  } catch (error) {
    logWarning("Failed to start Midi-QOL complete auto-hit workflow.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod: "MidiQOL.completeActivityUse",
      workflowMode,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      error: error?.message ?? String(error)
    });

    return {
      ok: false,
      reason: "midi-auto-hit-workflow-failed",
      launchMode: "unavailable",
      workflowMode,
      attemptedMethod: "MidiQOL.completeActivityUse",
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable: Boolean(midiApi),
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      ...activitySummary,
      errors: [error?.message ?? "Midi-QOL complete auto-hit workflow failed to start for this item."]
    };
  }

  await waitForWorkflowUi();

  const dialogApp = getNewUiWindows(beforeIds)[0] ?? null;
  const dialogVisible = Boolean(dialogApp?.rendered);
  const workflowMessage = workflow?.itemCardUuid ? fromUuidSync(workflow.itemCardUuid) : null;
  const chatMessage = workflowMessage ?? getNewChatMessages(beforeMessageIds)[0] ?? null;
  const chatCardCreated = Boolean(chatMessage);
  const chatFocusActions = chatMessage
    ? focusChatPanel(chatMessage, {
        itemUuid: item.uuid,
        itemName: item.name,
        activityName: activitySummary.activityName,
        activityType: activitySummary.activityType,
        attemptedMethod: "MidiQOL.completeActivityUse",
        workflowMode
      })
    : [];
  const workflowSummary = summarizeMidiWorkflow(workflow);
  const resultSummary = summarizeWorkflowResult(workflow);

  logDebug("Midi-QOL complete auto-hit workflow resolved.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "MidiQOL.completeActivityUse",
    workflowMode,
    midiAvailable: Boolean(midiApi),
    midiUsed: true,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    workflowSummary,
    resultSummary
  });

  logAoeApiSnapshotAfterPrimaryWorkflow({
    item,
    activity,
    workflow,
    resultSummary,
    attemptedMethod: "MidiQOL.completeActivityUse",
    workflowMode,
    hookSource: "midi-auto-hit-complete-activity-use"
  });

  logInfo("Remote Action Midi auto-hit complete activity workflow started.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod: "MidiQOL.completeActivityUse",
    workflowMode,
    midiAvailable: Boolean(midiApi),
    midiUsed: true,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    workflowId: workflow?.id ?? null,
    workflowItemCardUuid: workflow?.itemCardUuid ?? null,
    hitTargetCount: workflow?.hitTargets?.size ?? 0,
    targetCount: workflow?.targets?.size ?? participants.targets.length,
    damageRollCount: Array.isArray(workflow?.damageRolls)
      ? workflow.damageRolls.length
      : (workflow?.damageRoll ? 1 : 0)
  });

  return {
    ok: true,
    attemptedMethod: "MidiQOL.completeActivityUse",
    workflowMode,
    launchMode: "direct-workflow",
    midiAvailable: Boolean(midiApi),
    midiUsed: true,
    damageRolled: Boolean(workflow?.damageRoll || (Array.isArray(workflow?.damageRolls) && workflow.damageRolls.length > 0)),
    isCritical: Boolean(workflow?.isCritical),
    dialogApp,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    workflowId: workflow?.id ?? null,
    workflowItemCardUuid: workflow?.itemCardUuid ?? null,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    templatePlaced: Boolean(workflow?.templateUuid),
    templateUuid: workflow?.templateUuid ?? null,
    saveWorkflowStarted: (workflow?.saves?.size ?? 0) > 0 || (workflow?.failedSaves?.size ?? 0) > 0,
    damageWorkflowStarted: Array.isArray(workflow?.damageRolls)
      ? workflow.damageRolls.length > 0
      : Boolean(workflow?.damageRoll),
    finalResult: workflowSummary,
    requiresDialog: false,
    ...activitySummary
  };
}
async function startDnd5eDamageOnlyWorkflow(item, activity, participants, options = {}) {
  const {
    workflowMode = MANUAL_HIT_WORKFLOW_MODE,
    isCritical = false,
    midiApi = getMidiQolApi()
  } = options;
  participants = normalizeWorkflowParticipants(participants);

  const activitySummary = getActivitySummary(activity, {});
  const midiAvailable = Boolean(midiApi?.DamageOnlyWorkflow);
  if (typeof activity?.rollDamage !== "function") {
    return {
      ok: false,
      reason: "damage-workflow-unavailable",
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
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      ...activitySummary,
      errors: ["The dnd5e activity.rollDamage API is not available for this item."]
    };
  }

  const sourceActor = participants.sourceActor;
  const sourceToken = participants.sourceToken;
  const targets = participants.targets;

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

    if (!isThenable(damagePromise)) {
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
        errors: ["The dnd5e activity.rollDamage API did not return a promise for this item."]
      };
    }

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

async function startExplicitActivityUseWorkflow(item, activity, participants, bridgePayload = {}, options = {}) {
  participants = normalizeWorkflowParticipants(participants);
  const workflowSettings = options?.workflowSettings ?? getWorkflowSettings();
  const midiApi = options?.midiApi ?? getMidiQolApi();
  const workflowClassification = options?.workflowClassification
    ?? classifyRemoteActivityWorkflow(item, activity, workflowSettings, midiApi);
  const {
    usagePayload,
    dialogConfig,
    messageConfig,
    aoeSecondaryExecution,
    bridgeModuleId
    } = buildExplicitActivityExecutionConfig(bridgePayload);
  const activitySummary = getActivitySummary(activity, usagePayload);

  if (workflowClassification.strategy === "midi-auto-hit") {
    logDebug("Explicit remote activity workflow routed to Midi auto-hit workflow branch.", {
      itemUuid: item?.uuid ?? null,
      itemName: item?.name ?? null,
      activityUuid: activity?.uuid ?? bridgePayload?.activityUuid ?? null,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      workflowMode: MANUAL_HIT_WORKFLOW_MODE,
      actionFamily: workflowClassification.actionFamily,
      strategy: workflowClassification.strategy,
      aoeSecondaryExecution,
      bridgeModuleId
    });

    const routedWorkflowResult = await routeRemoteActivityWorkflow(item, activity, participants, {
      workflowSettings,
      midiApi,
      classification: workflowClassification
    });

    if (routedWorkflowResult) {
      return {
        ...routedWorkflowResult,
        actionFamily: workflowClassification.actionFamily,
        strategy: workflowClassification.strategy,
        requiresDialog: false,
        aoeSecondaryExecution,
        bridgeModuleId
      };
    }
  }

  logDebug("Prepared remoteActionExecution marker for explicit remote activity workflow.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? bridgePayload?.activityUuid ?? null,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    executionMode: "relay-activity-use",
    aoeSecondaryExecution,
    bridgeModuleId
  });

  if (typeof activity?.use !== "function") {
    return {
      ok: false,
      reason: "usage-workflow-unavailable",
      launchMode: "unavailable",
      workflowMode: "explicit-activity-use",
      attemptedMethod: "activity.use",
      attemptedMethods: [],
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
      actionFamily: workflowClassification.actionFamily,
      strategy: "explicit-activity-use",
      aoeSecondaryExecution,
      bridgeModuleId,
      ...activitySummary,
      errors: ["The dnd5e activity.use API is not available for this explicit remote activity workflow."]
    };
  }

  const beforeIds = new Set(Object.keys(ui?.windows ?? {}));
  const beforeMessageIds = new Set(Array.from(game.messages ?? []).map((message) => String(message.id)));
  const attemptedMethods = [];
  let attemptedMethod = "activity.use(explicit-payload)";
  let workflowResult = null;

  logDebug("Remote Action AOE diagnostic before explicit activity.use workflow.", buildAoeDiagnosticLogData({
    item,
    launchedActivity: activity,
    stage: "before-launch",
    actionType: "relay-activity-use",
    relayEntryPoint: "relay-activity-use",
    nativeExecutionPath: "activity.use",
    attemptedMethod,
    workflowMode: "explicit-activity-use",
    executionMode: "relay-activity-use"
  }));

  try {
    attemptedMethods.push(attemptedMethod);
    const workflowPromise = activity.use(usagePayload, dialogConfig, messageConfig);
    if (!isThenable(workflowPromise)) {
      throw new Error("The dnd5e activity.use API did not return a promise for the explicit remote activity workflow.");
    }

    workflowResult = await workflowPromise;
  } catch (firstError) {
    const targetIds = participants.targets.map((token) => token?.id).filter(Boolean);
    if (targetIds.length === 0) {
      return {
        ok: false,
        reason: "activity-use-failed",
        launchMode: "unavailable",
        workflowMode: "explicit-activity-use",
        attemptedMethod,
        attemptedMethods,
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
        actionFamily: workflowClassification.actionFamily,
        strategy: "explicit-activity-use",
        aoeSecondaryExecution,
        bridgeModuleId,
        ...activitySummary,
        errors: [firstError?.message ?? String(firstError)]
      };
    }

    const savedTargetIds = getCurrentUserTargetIds();
    const fallbackUsagePayload = foundry.utils.deepClone(usagePayload);
    foundry.utils.setProperty(fallbackUsagePayload, "midiOptions.ignoreUserTargets", false);
    attemptedMethod = "activity.use(explicit-payload-user-targets-fallback)";

    try {
      applyUserTargetIds(targetIds);
      attemptedMethods.push(attemptedMethod);
      const fallbackPromise = activity.use(fallbackUsagePayload, dialogConfig, messageConfig);
      if (!isThenable(fallbackPromise)) {
        throw new Error("The dnd5e activity.use API did not return a promise for the explicit remote activity workflow fallback.");
      }

      workflowResult = await fallbackPromise;
    } catch (secondError) {
      return {
        ok: false,
        reason: "activity-use-failed",
        launchMode: "unavailable",
        workflowMode: "explicit-activity-use",
        attemptedMethod,
        attemptedMethods,
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
        actionFamily: workflowClassification.actionFamily,
        strategy: "explicit-activity-use",
        aoeSecondaryExecution,
        bridgeModuleId,
        ...activitySummary,
        errors: [firstError?.message ?? String(firstError), secondError?.message ?? String(secondError)]
      };
    } finally {
      applyUserTargetIds(savedTargetIds);
    }
  }

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
        attemptedMethod,
        workflowMode: "explicit-activity-use",
        aoeSecondaryExecution,
        bridgeModuleId
      })
    : [];

  logDebug("Explicit remote activity workflow started.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod,
    attemptedMethods,
    workflowMode: "explicit-activity-use",
    launchMode: dialogVisible ? "dialog" : "direct-workflow",
    midiAvailable: Boolean(midiApi),
    midiUsed: Boolean(midiApi),
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    actionFamily: workflowClassification.actionFamily,
    strategy: "explicit-activity-use",
    requiresDialog: activitySummary.requiresDialog,
    aoeSecondaryExecution,
    bridgeModuleId,
    usagePayload,
    dialogConfig,
    messageConfig,
    dialogAppId: dialogApp?.appId ?? null,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    workflowResult: summarizeWorkflowResult(workflowResult)
  });

  return {
    ok: true,
    attemptedMethod,
    attemptedMethods,
    dialogApp,
    dialogVisible,
    chatMessageId: chatMessage?.id ?? null,
    chatCardCreated,
    chatFocusActions,
    launchMode: dialogVisible ? "dialog" : "direct-workflow",
    workflowMode: "explicit-activity-use",
    midiAvailable: Boolean(midiApi),
    midiUsed: Boolean(midiApi),
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    actionFamily: workflowClassification.actionFamily,
    strategy: "explicit-activity-use",
    aoeSecondaryExecution,
    bridgeModuleId,
    ...activitySummary
  };
}
async function startDnd5eItemUsageWorkflow(item) {
  if (!item) {
    return {
      ok: false,
      reason: "document-not-found",
      launchMode: "unavailable",
      workflowMode: "native-foundry",
      attemptedMethod: null,
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable: false,
      midiUsed: false,
      sourceActor: null,
      sourceToken: null,
      sourceResolution: null,
      targets: [],
      activityId: null,
      activityName: null,
      activityType: null,
      requiresDialog: null,
      errors: ["No Item document was provided for the remote usage workflow."]
    };
  }

  if (item.system?.activities && typeof item.system.activities.filter !== "function") {
    logWarning("Remote item usage prerequisites missing before activity resolution.", {
      itemUuid: item.uuid,
      itemName: item.name,
      missingPrerequisite: "item.system.activities.filter"
    });

    return {
      ok: false,
      reason: "usage-workflow-unavailable",
      launchMode: "unavailable",
      workflowMode: "native-foundry",
      attemptedMethod: null,
      dialogApp: null,
      dialogVisible: false,
      chatMessageId: null,
      chatCardCreated: false,
      chatFocusActions: [],
      midiAvailable: false,
      midiUsed: false,
      sourceActor: null,
      sourceToken: null,
      sourceResolution: null,
      targets: [],
      activityId: null,
      activityName: null,
      activityType: null,
      requiresDialog: null,
      errors: ["The dnd5e activity collection is not available for this item."]
    };
  }

  const activities = typeof item.system?.activities?.filter === "function"
    ? item.system.activities.filter((activity) => activity.canUse)
    : [];
  const activity = activities[0] ?? null;
  const workflowSettings = getWorkflowSettings();
  const participants = normalizeWorkflowParticipants(getWorkflowParticipants(item));
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

  const workflowClassification = classifyRemoteActivityWorkflow(item, activity, workflowSettings, midiApi);

  logDebug("Remote activity workflow classified.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? null,
    activityName: activity?.name ?? null,
    activityType: activity?.type ?? activity?.metadata?.type ?? null,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    workflowClassification
  });

  const routedWorkflowResult = await routeRemoteActivityWorkflow(item, activity, participants, {
    workflowSettings,
    midiApi,
    classification: workflowClassification
  });

  if (routedWorkflowResult) {
    logDebug("Remote activity workflow route selected.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? null,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      workflowClassification,
      selectedStrategy: workflowClassification.strategy
    });

    return { ...routedWorkflowResult, actionFamily: workflowClassification.actionFamily, strategy: workflowClassification.strategy };
  }

  if (typeof activity._prepareUsageConfig !== "function") {
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
      activityId: activity.id ?? null,
      activityName: activity.name ?? null,
      activityType: activity.type ?? activity.metadata?.type ?? null,
      requiresDialog: null,
      errors: ["The dnd5e activity._prepareUsageConfig API is not available for this item."]
    };
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
  const useItemDialogWorkflow = launchMode === "dialog" && typeof item?.use === "function";
  const attemptedMethod = useItemDialogWorkflow ? "item.use" : "activity.use";

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
    attemptedMethod,
    workflowMode: "native-foundry",
    workflowSettings,
    midiAvailable,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    launchMode,
    actionFamily: workflowClassification.actionFamily,
    strategy: workflowClassification.strategy,
    requiresDialog: activitySummary.requiresDialog,
    usageConfig,
    hasActivityUse: typeof activity.use === "function"
  });

  if (!useItemDialogWorkflow && typeof activity.use !== "function") {
    return {
      ok: false,
      reason: "usage-workflow-unavailable",
      launchMode: "unavailable",
      workflowMode: "native-foundry",
      attemptedMethod,
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
  const remoteExecutionConfigs = buildRemoteActionExecutionConfigs(
    useItemDialogWorkflow ? { legacy: false } : {},
    { configure: true },
    { create: true },
    {
      executionMode: useItemDialogWorkflow
        ? "open-item-use-dialog:item.use"
        : "open-item-use-dialog:activity.use"
    }
  );

  logDebug("Prepared remoteActionExecution marker for native dnd5e item workflow on receiver.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod,
    workflowMode: "native-foundry",
    executionMode: useItemDialogWorkflow
      ? "open-item-use-dialog:item.use"
      : "open-item-use-dialog:activity.use"
  });

  logDebug("Remote Action AOE diagnostic before native open-item-use-dialog workflow.", buildAoeDiagnosticLogData({
    item,
    launchedActivity: activity,
    stage: "before-launch",
    actionType: "open-item-use-dialog",
    relayEntryPoint: "open-item-use-dialog",
    nativeExecutionPath: attemptedMethod,
    attemptedMethod,
    workflowMode: "native-foundry",
    executionMode: useItemDialogWorkflow
      ? "open-item-use-dialog:item.use"
      : "open-item-use-dialog:activity.use"
  }));

  const workflowPromise = useItemDialogWorkflow
    ? item.use(
      remoteExecutionConfigs.usagePayload,
      remoteExecutionConfigs.dialogConfig,
      remoteExecutionConfigs.messageConfig
    )
    : activity.use(
      remoteExecutionConfigs.usagePayload,
      remoteExecutionConfigs.dialogConfig,
      remoteExecutionConfigs.messageConfig
    );

  if (!isThenable(workflowPromise)) {
    return {
      ok: false,
      reason: "usage-workflow-unavailable",
      launchMode: "unavailable",
      workflowMode: "native-foundry",
      attemptedMethod,
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
      errors: [`The dnd5e ${attemptedMethod} API did not return a promise for this item.`]
    };
  }

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
          attemptedMethod,
          workflowMode: "native-foundry",
          launchMode
        })
      : [];

    logDebug("dnd5e activity.use workflow resolved.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod,
      workflowMode: "native-foundry",
      launchMode,
      midiAvailable,
      midiUsed: false,
      sourceActor: serializeActor(participants.sourceActor),
      sourceToken: serializeToken(participants.sourceToken),
      sourceResolution: participants.sourceResolution,
      targets: participants.targets.map(serializeToken),
      actionFamily: workflowClassification.actionFamily,
      strategy: workflowClassification.strategy,
      requiresDialog: activitySummary.requiresDialog,
      workflowResult: resultSummary,
      chatMessageId: resultMessage?.id ?? null,
      chatCardCreated,
      chatFocusActions,
      result
    });
    logAoeApiSnapshotAfterPrimaryWorkflow({
      item,
      activity,
      workflow: getMidiWorkflowByActivityUuid(activity?.uuid) ?? null,
      resultSummary,
      attemptedMethod,
      workflowMode: "native-foundry",
      hookSource: "open-item-use-dialog"
    });
  }).catch((error) => {
    logDebug("dnd5e activity.use workflow rejected.", {
      itemUuid: item.uuid,
      itemName: item.name,
      activityName: activitySummary.activityName,
      activityType: activitySummary.activityType,
      attemptedMethod,
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
        attemptedMethod,
        workflowMode: "native-foundry",
        launchMode
      })
    : [];

  logDebug("dnd5e item usage workflow started.", {
    itemUuid: item.uuid,
    itemName: item.name,
    activityName: activitySummary.activityName,
    activityType: activitySummary.activityType,
    attemptedMethod,
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
    actionFamily: workflowClassification.actionFamily,
    strategy: workflowClassification.strategy,
    requiresDialog: activitySummary.requiresDialog,
    directWorkflow: launchMode === "direct-workflow",
    expectsManualUseClick: true,
    workflowLinkedToExecution: true,
    expectedSubmitHandler: launchMode === "dialog"
      ? `dnd5e ActivityUsageDialog form handler via ${attemptedMethod}`
      : `dnd5e direct ${attemptedMethod} workflow without visible dialog`
  });

  return {
    ok: true,
    attemptedMethod,
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
    actionFamily: workflowClassification.actionFamily,
    strategy: workflowClassification.strategy,
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

async function handleRelayActivityUseAction(request) {
  const actionType = "relay-activity-use";
  const validation = validateRelayActivityUseRequest(request);

  if (!validation.ok) {
    logDebug("relay-activity-use payload validation failed.", {
      actionType,
      errors: validation.errors,
      request
    });
    return buildInvalidActionResponse(request, validation.errors);
  }

  const payload = validation.normalizedPayload;
  const item = await resolveUuidDocumentSafely(payload.itemUuid);

  if (!item) {
    return buildDocumentErrorResponse(request, "document-not-found", [
      `No document found for itemUuid '${payload.itemUuid}'.`
    ]);
  }

  if (!(item instanceof Item)) {
    return buildDocumentErrorResponse(request, "invalid-document-type", [
      `UUID '${payload.itemUuid}' does not resolve to an Item.`
    ]);
  }

  const activity = await resolveItemActivity(item, payload.activityUuid);
  if (!activity) {
    return buildDocumentErrorResponse(request, "activity-not-found", [
      `No dnd5e activity found for activityUuid '${payload.activityUuid}' on item '${item.name}'.`
    ]);
  }

  const participants = await resolveExplicitWorkflowParticipants(item, payload);
  const workflowSettings = getWorkflowSettings();
  const midiApi = getMidiQolApi();
  const workflowClassification = classifyRemoteActivityWorkflow(item, activity, workflowSettings, midiApi);

  logDebug("Executing explicit remote activity bridge workflow.", {
    actionType,
    itemUuid: item.uuid,
    itemName: item.name,
    activityUuid: activity?.uuid ?? payload.activityUuid,
    activityName: activity?.name ?? null,
    activityType: activity?.type ?? activity?.metadata?.type ?? null,
    sourceActor: serializeActor(participants.sourceActor),
    sourceToken: serializeToken(participants.sourceToken),
    sourceResolution: participants.sourceResolution,
    targets: participants.targets.map(serializeToken),
    actionFamily: workflowClassification.actionFamily,
    strategy: "explicit-activity-use",
    requiresDialog: workflowClassification.requiresDialog,
    aoeSecondaryExecution: payload.aoeSecondaryExecution,
    bridgeContext: payload.context ?? {}
  });

  const workflowResult = await startExplicitActivityUseWorkflow(item, activity, participants, payload, {
    workflowClassification,
    workflowSettings,
    midiApi
  });

  if (!workflowResult.ok) {
    logWarning("Explicit remote activity bridge workflow failed.", {
      actionType,
      itemUuid: item.uuid,
      itemName: item.name,
      activityUuid: activity?.uuid ?? payload.activityUuid,
      activityName: activity?.name ?? null,
      activityType: activity?.type ?? activity?.metadata?.type ?? null,
      attemptedMethod: workflowResult.attemptedMethod,
      attemptedMethods: workflowResult.attemptedMethods ?? [],
      sourceActor: workflowResult.sourceActor,
      sourceToken: workflowResult.sourceToken,
      targets: workflowResult.targets,
      actionFamily: workflowResult.actionFamily ?? workflowClassification.actionFamily,
      strategy: workflowResult.strategy ?? "explicit-activity-use",
      aoeSecondaryExecution: workflowResult.aoeSecondaryExecution ?? payload.aoeSecondaryExecution,
      reason: workflowResult.reason,
      errors: workflowResult.errors
    });

    return {
      ...buildDocumentErrorResponse(request, workflowResult.reason, workflowResult.errors),
      itemName: item.name,
      attemptedMethod: workflowResult.attemptedMethod,
      attemptedMethods: workflowResult.attemptedMethods ?? [],
      workflowMode: workflowResult.workflowMode,
      launchMode: workflowResult.launchMode,
      activityId: workflowResult.activityId ?? activity?.id ?? null,
      activityName: workflowResult.activityName ?? activity?.name ?? null,
      activityType: workflowResult.activityType ?? activity?.type ?? activity?.metadata?.type ?? null,
      actionFamily: workflowResult.actionFamily ?? workflowClassification.actionFamily,
      strategy: workflowResult.strategy ?? "explicit-activity-use",
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
      aoeSecondaryExecution: workflowResult.aoeSecondaryExecution ?? payload.aoeSecondaryExecution
    };
  }

  return buildBaseResponse(request, {
    handled: true,
    message: "Remote Action executed an explicit activity bridge workflow on the receiver.",
    item: {
      uuid: item.uuid,
      id: item.id,
      name: item.name
    },
    itemName: item.name,
    attemptedMethod: workflowResult.attemptedMethod,
    attemptedMethods: workflowResult.attemptedMethods ?? [],
    workflowMode: workflowResult.workflowMode,
    launchMode: workflowResult.launchMode,
    activityId: workflowResult.activityId ?? activity?.id ?? null,
    activityName: workflowResult.activityName ?? activity?.name ?? null,
    activityType: workflowResult.activityType ?? activity?.type ?? activity?.metadata?.type ?? null,
    actionFamily: workflowResult.actionFamily ?? workflowClassification.actionFamily,
    strategy: workflowResult.strategy ?? "explicit-activity-use",
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
    aoeSecondaryExecution: workflowResult.aoeSecondaryExecution ?? payload.aoeSecondaryExecution
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
      actionFamily: workflowResult.actionFamily ?? null,
      strategy: workflowResult.strategy ?? null,
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
      ? "Remote Action started a Midi-QOL complete auto-hit workflow on the receiver."
      : "Remote Action started an auto-hit workflow on the receiver."
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
    actionFamily: workflowResult.actionFamily ?? null,
    strategy: workflowResult.strategy ?? null,
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
    case "relay-activity-use":
      return handleRelayActivityUseAction(request);
    default:
      return handleUnknownAction(request);
  }
}
