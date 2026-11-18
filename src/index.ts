import { evaluateRoomShiftIndependentOutcome, type RoomShiftOutcomeResult, type RoomShiftOutcomeSnapshot } from './roomshift/w2b/independent-validator';
import { World, RayInteractable, DistanceGrabbable, MovementMode, createSystem, XRMesh, EnvironmentRaycastTarget, RaycastSpace } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import * as THREE from 'three';

import { installRoomshiftHoverDebug } from './roomshift/w2c1/hover-debug.js';
import { installRoomshiftCompetitionPolish } from './roomshift/w3a/presentation-polish.js';
type PlanId = 'LASER_BYPASS' | 'DRONE_DIVERSION';
type WorldId = 'A_CLEAR' | 'B_BLOCKED' | 'A_PRIME_CLEAR';
type EvidenceEvent = { seq:number; at:string; seed:42; mission:'STEAL_THE_CORE'; world:WorldId; routeBlocked:boolean; plan:PlanId };
const MISSION_SEED=42, STORAGE_KEY='roomshift-w1a-evidence-v1';

// ROOMSHIFT_W1B0_SCENE_PROBE
type RoomShiftSpatialMesh = {
  semanticLabel: string;
  bounded: boolean;
  position: [number, number, number];
  dimensions: [number, number, number] | null;
};

let roomShiftSpatialMeshes: RoomShiftSpatialMesh[] = [];

class RoomShiftSpatialProbeSystem extends createSystem({
  meshEntities: { required: [XRMesh] },
}) {
  private lastPrint = 0;

  update() {
    const now = performance.now();
    if (now - this.lastPrint < 1500) return;
    this.lastPrint = now;

    const rows: RoomShiftSpatialMesh[] = [];

    this.queries.meshEntities.entities.forEach((entity: any) => {
      const bounded = Boolean(entity.getValue(XRMesh, 'isBounded3D'));
      const semanticLabel =
        String(entity.getValue(XRMesh, 'semanticLabel') ?? 'unlabeled');

      const p = new THREE.Vector3();
      entity.object3D?.getWorldPosition(p);

      let dimensions: [number, number, number] | null = null;
      if (bounded) {
        const d = entity.getValue(XRMesh, 'dimensions') as unknown;
        if (Array.isArray(d) && d.length >= 3) {
          dimensions = [Number(d[0]), Number(d[1]), Number(d[2])];
        }
      }

      rows.push({
        semanticLabel,
        bounded,
        position: [p.x, p.y, p.z],
        dimensions,
      });
    });

    roomShiftSpatialMeshes = rows;
    (window as any).roomshiftSpatialMeshes = rows;

    if (rows.length > 0) {
      console.info(
        '[ROOMSHIFT W1B0] scene meshes:',
        rows.length,
        rows.map(r => r.semanticLabel).join(', ')
      );
    }
  }
}

function roomShiftSpatialReport() {
  const bounded = roomShiftSpatialMeshes.filter(m => m.bounded);
  return {
    schema: 'roomshift.iwsdk.w1b0.scene-probe.v1',
    evidenceClass: 'IWER_SCENE_UNDERSTANDING_PROBE',
    capturedAt: new Date().toISOString(),
    meshCount: roomShiftSpatialMeshes.length,
    boundedMeshCount: bounded.length,
    semanticLabels: Array.from(new Set(bounded.map(m => m.semanticLabel))).sort(),
    meshes: roomShiftSpatialMeshes,
    sceneUnderstandingObserved: roomShiftSpatialMeshes.length > 0,
    routeBlockedDecision: 'NOT_EVALUATED',
    missionPlannerConnected: false,
    realHardwareValidation: 'NOT_PERFORMED',
  };
}

function roomShiftExportSpatialReport() {
  const report = roomShiftSpatialReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roomshift_w1b0_scene_probe.json';
  a.click();
  URL.revokeObjectURL(a.href);
  console.info('[ROOMSHIFT W1B0 REPORT]', report);
}

(window as any).roomshiftSpatialReport = roomShiftSpatialReport;
(window as any).roomshiftExportSpatialReport = roomShiftExportSpatialReport;

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'p') roomShiftExportSpatialReport();
});


const container=document.getElementById('scene-container') as HTMLDivElement|null;
if(!container) throw new Error('Missing #scene-container');
const world=await World.create(container,projectOptions);

// ROOMSHIFT W2C.1 - observational IWSDK target instrumentation
installRoomshiftHoverDebug(world);

// ROOMSHIFT_W1B1_ENV_RAYCAST_PROBE
type RoomShiftRaycastSample = {
  at: string;
  hasHit: boolean;
  visible: boolean;
  position: [number, number, number] | null;
  distanceFromHead: number | null;
};

const roomShiftRaycastSamples: RoomShiftRaycastSample[] = [];

// ROOMSHIFT_W1B2_AUTO_SPATIAL_PLANNER
const ROOMSHIFT_CORRIDOR_LENGTH_M = 3.0;
const ROOMSHIFT_DECISION_WINDOW = 12;
const ROOMSHIFT_REQUIRED_AGREEMENT = 9;
const ROOMSHIFT_W1B2_STORAGE_KEY = 'roomshift_w1b2_auto_spatial_v1';

type RoomShiftSpatialDecision = 'UNKNOWN' | 'CLEAR' | 'BLOCKED';
type RoomShiftAutoPlan = 'NONE' | 'LASER_BYPASS' | 'DRONE_DIVERSION';

type RoomShiftSpatialTransition = {
  seq: number;
  at: string;
  decision: 'CLEAR' | 'BLOCKED';
  plan: 'LASER_BYPASS' | 'DRONE_DIVERSION';
  corridorLengthMeters: number;
  hitDistanceMeters: number | null;
  decisionSource: 'ENVIRONMENT_RAYCAST_ONLY';
};

let roomShiftRecentBlocked: boolean[] = [];
let roomShiftStableDecision: RoomShiftSpatialDecision = 'UNKNOWN';
let roomShiftAutoPlan: RoomShiftAutoPlan = 'NONE';

function roomShiftLoadSpatialTransitions(): RoomShiftSpatialTransition[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(ROOMSHIFT_W1B2_STORAGE_KEY) ?? '[]',
    );
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function roomShiftSaveSpatialTransitions(rows: RoomShiftSpatialTransition[]) {
  localStorage.setItem(ROOMSHIFT_W1B2_STORAGE_KEY, JSON.stringify(rows));
}

function roomShiftResetSpatialEvidence() {
  roomShiftRecentBlocked = [];
  roomShiftStableDecision = 'UNKNOWN';
  roomShiftAutoPlan = 'NONE';
  localStorage.removeItem(ROOMSHIFT_W1B2_STORAGE_KEY);
  roomShiftRefreshSpatialOverlay();
  console.info('[ROOMSHIFT W1B2] spatial evidence reset');
}

function roomShiftDecisionToPlan(
  decision: 'CLEAR' | 'BLOCKED',
): 'LASER_BYPASS' | 'DRONE_DIVERSION' {
  return decision === 'BLOCKED' ? 'DRONE_DIVERSION' : 'LASER_BYPASS';
}

function roomShiftLatestHitDistance(): number | null {
  for (let i = roomShiftRaycastSamples.length - 1; i >= 0; i--) {
    const d = roomShiftRaycastSamples[i].distanceFromHead;
    if (typeof d === 'number' && Number.isFinite(d)) return d;
  }
  return null;
}


// ROOMSHIFT_W2A_SPATIAL_MISSION_INTEGRATION
type RoomShiftMissionStage =
  | 'DISABLE_CAMERA'
  | 'ACQUIRE_ACCESS_KEY'
  | 'EXECUTE_PLAN'
  | 'EXTRACT_CORE'
  | 'COMPLETE';

type RoomShiftMissionEvent = {
  seq: number;
  at: string;
  kind:
    | 'MISSION_RESET'
    | 'CAMERA_DISABLED'
    | 'ACCESS_KEY_ACQUIRED'
    | 'SPATIAL_DECISION'
    | 'WORLD_CHANGED'
    | 'MISSION_REPAIRED'
    | 'DRONE_DIVERSION_EXECUTED'
    | 'LASER_BYPASS_EXECUTED'
    | 'CORE_EXTRACTED';
  progress: number;
  stage: RoomShiftMissionStage;
  spatialDecision: RoomShiftSpatialDecision;
  plan: RoomShiftAutoPlan;
  source: 'ENVIRONMENT_RAYCAST' | 'PLAYER_ACTION' | 'SYSTEM';
};

const ROOMSHIFT_W2A_STORAGE_KEY = 'roomshift_w2a_spatial_mission_v1';

let roomShiftMissionStage: RoomShiftMissionStage = 'DISABLE_CAMERA';
let roomShiftMissionProgress = 0;
let roomShiftMissionSpatialDecision: RoomShiftSpatialDecision = 'UNKNOWN';
let roomShiftMissionPlan: RoomShiftAutoPlan = 'NONE';
let roomShiftCameraDisabled = false;
let roomShiftAccessKeyAcquired = false;
let roomShiftDroneDiversionExecuted = false;
let roomShiftLaserBypassExecuted = false;
let roomShiftCoreExtracted = false;
let roomShiftMissionRepairCount = 0;
let roomShiftW2AMagicTimer: number | undefined;

function roomShiftLoadMissionEvents(): RoomShiftMissionEvent[] {
  try {
    const value = JSON.parse(localStorage.getItem(ROOMSHIFT_W2A_STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function roomShiftSaveMissionEvents(rows: RoomShiftMissionEvent[]) {
  localStorage.setItem(ROOMSHIFT_W2A_STORAGE_KEY, JSON.stringify(rows));
}

function roomShiftMissionEvent(
  kind: RoomShiftMissionEvent['kind'],
  source: RoomShiftMissionEvent['source'],
) {
  const rows = roomShiftLoadMissionEvents();
  const ev: RoomShiftMissionEvent = {
    seq: rows.length + 1,
    at: new Date().toISOString(),
    kind,
    progress: roomShiftMissionProgress,
    stage: roomShiftMissionStage,
    spatialDecision: roomShiftMissionSpatialDecision,
    plan: roomShiftMissionPlan,
    source,
  };
  rows.push(ev);
  roomShiftSaveMissionEvents(rows);
  console.info(
    '[ROOMSHIFT W2A]',
    kind,
    'progress=' + roomShiftMissionProgress + '%',
    'world=' + roomShiftMissionSpatialDecision,
    'plan=' + roomShiftMissionPlan,
  );
}

function roomShiftMissionWorldLabel() {
  if (roomShiftMissionSpatialDecision === 'BLOCKED') return 'WORLD · ROUTE BLOCKED';
  if (roomShiftMissionSpatialDecision === 'CLEAR') return 'WORLD · ROUTE CLEAR';
  return 'WORLD · SCANNING ROUTE';
}

function roomShiftMissionPlanLabel() {
  if (roomShiftMissionStage === 'DISABLE_CAMERA') return 'OBJECTIVE · DISABLE CAMERA';
  if (roomShiftMissionStage === 'ACQUIRE_ACCESS_KEY') return 'OBJECTIVE · ACQUIRE ACCESS KEY';
  if (roomShiftMissionStage === 'EXTRACT_CORE') return 'OBJECTIVE · EXTRACT CORE';
  if (roomShiftMissionStage === 'COMPLETE') return 'MISSION COMPLETE';

  if (roomShiftMissionPlan === 'DRONE_DIVERSION') return 'PLAN B · DRONE DIVERSION';
  if (roomShiftMissionPlan === 'LASER_BYPASS') return 'PLAN A · LASER BYPASS';
  return 'PLAN · WAITING FOR WORLD';
}

function roomShiftRefreshMissionHUD() {
  const blocked = roomShiftMissionSpatialDecision === 'BLOCKED';

  updateText(
    status,
    roomShiftMissionWorldLabel(),
    blocked ? '#ffad33' : '#35f29a',
  );

  updateText(
    plan,
    roomShiftMissionPlanLabel(),
    roomShiftMissionPlan === 'DRONE_DIVERSION' ? '#4a8cff' : '#29e7ff',
  );

  if (roomShiftMissionStage === 'COMPLETE') {
    updateText(progress, '100% · CORE EXTRACTED', '#29e7ff');
  } else if (roomShiftMissionProgress === 67 && roomShiftMissionRepairCount > 0) {
    updateText(progress, '67% · PROGRESS PRESERVED', '#35f29a');
  } else {
    updateText(progress, roomShiftMissionProgress + '% COMPLETE');
  }
}

function roomShiftShowMissionRepairBeat() {
  magic.visible = true;
  updateText(magic, 'THE ROOM CHANGED.', '#ffad33', 'rgba(20,8,3,.88)');
  if (roomShiftW2AMagicTimer !== undefined) clearTimeout(roomShiftW2AMagicTimer);
  roomShiftW2AMagicTimer = window.setTimeout(() => {
    updateText(magic, 'MISSION REPAIRED.', '#35f29a', 'rgba(3,18,12,.88)');
  }, 850);
}

function roomShiftApplySpatialDecisionToMission(
  decision: 'CLEAR' | 'BLOCKED',
) {
  const previous = roomShiftMissionSpatialDecision;
  const nextPlan: RoomShiftAutoPlan =
    decision === 'BLOCKED' ? 'DRONE_DIVERSION' : 'LASER_BYPASS';

  roomShiftMissionSpatialDecision = decision;
  roomShiftMissionPlan = nextPlan;

  // Reuse the already-proven W1A visual alternatives, but do NOT record W1A evidence.
  setWorld(decision === 'BLOCKED' ? 'B_BLOCKED' : 'A_CLEAR', false);

  roomShiftMissionEvent('SPATIAL_DECISION', 'ENVIRONMENT_RAYCAST');

  // The repair is meaningful only after the first two mission nodes are complete.
  if (
    previous !== 'UNKNOWN' &&
    previous !== decision &&
    roomShiftAccessKeyAcquired &&
    roomShiftMissionProgress === 67
  ) {
    roomShiftMissionEvent('WORLD_CHANGED', 'ENVIRONMENT_RAYCAST');

    roomShiftMissionStage = 'EXECUTE_PLAN';
    roomShiftMissionRepairCount += 1;

    // Critical WMR invariant: progress is intentionally unchanged at 67.
    roomShiftShowMissionRepairBeat();
    roomShiftMissionEvent('MISSION_REPAIRED', 'SYSTEM');
  }

  roomShiftRefreshMissionHUD();
}


// ROOMSHIFT_W2B_INDEPENDENT_OUTCOME
type RoomShiftW2BTrigger =
  | 'EARLY_CORE_ATTEMPT'
  | 'CORE_AFTER_REQUIRED_PLAN';

type RoomShiftW2BValidationEvent = {
  seq: number;
  at: string;
  trigger: RoomShiftW2BTrigger;
  progress: number;
  stage: RoomShiftMissionStage;
  spatialDecision: RoomShiftSpatialDecision;
  activePlan: RoomShiftAutoPlan;
  result: RoomShiftOutcomeResult;
};

const ROOMSHIFT_W2B_STORAGE_KEY = 'roomshift_w2b_independent_outcome_v1';
let roomShiftCoreExtractionAttempted = false;

function roomShiftLoadW2BEvents(): RoomShiftW2BValidationEvent[] {
  try {
    const value = JSON.parse(localStorage.getItem(ROOMSHIFT_W2B_STORAGE_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function roomShiftSaveW2BEvents(rows: RoomShiftW2BValidationEvent[]) {
  localStorage.setItem(ROOMSHIFT_W2B_STORAGE_KEY, JSON.stringify(rows));
}

function roomShiftRuntimeSnapshot(): RoomShiftOutcomeSnapshot {
  return {
    spatialDecision: roomShiftMissionSpatialDecision,
    activePlan: roomShiftMissionPlan,
    stage: roomShiftMissionStage,
    progress: roomShiftMissionProgress,
    cameraDisabled: roomShiftCameraDisabled,
    accessKeyAcquired: roomShiftAccessKeyAcquired,
    laserBypassExecuted: roomShiftLaserBypassExecuted,
    droneDiversionExecuted: roomShiftDroneDiversionExecuted,
    coreExtractionAttempted: roomShiftCoreExtractionAttempted,
    coreExtracted: roomShiftCoreExtracted,
  };
}

function roomShiftRunIndependentValidator(
  trigger: RoomShiftW2BTrigger,
): RoomShiftOutcomeResult {
  const snapshot = roomShiftRuntimeSnapshot();
  const result = evaluateRoomShiftIndependentOutcome(snapshot);

  const rows = roomShiftLoadW2BEvents();
  rows.push({
    seq: rows.length + 1,
    at: new Date().toISOString(),
    trigger,
    progress: snapshot.progress,
    stage: snapshot.stage,
    spatialDecision: snapshot.spatialDecision,
    activePlan: snapshot.activePlan,
    result,
  });
  roomShiftSaveW2BEvents(rows);

  console.info(
    '[ROOMSHIFT W2B VALIDATOR]',
    'trigger=' + trigger,
    'result=' + result.code,
    'progress=' + snapshot.progress + '%',
    'plan=' + snapshot.activePlan,
  );

  return result;
}

function roomShiftShowRejectedOutcome(result: RoomShiftOutcomeResult) {
  magic.visible = true;
  updateText(
    magic,
    'EXTRACTION DENIED.',
    '#ff5f57',
    'rgba(28,4,4,.92)',
  );

  window.setTimeout(() => {
    if (roomShiftMissionPlan === 'DRONE_DIVERSION') {
      updateText(
        magic,
        'DRONE DIVERSION REQUIRED.',
        '#ffad33',
        'rgba(28,12,3,.92)',
      );
    } else {
      updateText(
        magic,
        'LASER BYPASS REQUIRED.',
        '#ffad33',
        'rgba(28,12,3,.92)',
      );
    }
  }, 700);

  console.warn('[ROOMSHIFT W2B WORLD PUSHBACK]', result.code, result.reason);
}

function roomShiftResetIndependentOutcomeEvidence() {
  localStorage.removeItem(ROOMSHIFT_W2B_STORAGE_KEY);
  roomShiftCoreExtractionAttempted = false;
}


// ROOMSHIFT_W2C_HANDS_FIRST_IWER
type RoomShiftW2CSemanticAction =
  | 'DISABLE_CAMERA'
  | 'ACQUIRE_ACCESS_KEY'
  | 'LASER_BYPASS'
  | 'DRONE_DIVERSION'
  | 'CORE';

type RoomShiftW2CActionEvent = {
  seq: number;
  at: string;
  action: RoomShiftW2CSemanticAction;
  stageBefore: RoomShiftMissionStage;
  progressBefore: number;
  spatialDecision: RoomShiftSpatialDecision;
  activePlan: RoomShiftAutoPlan;
  xrFramesObserved: number;
  handSources: number;
  controllerSources: number;
  pointerType: string;
  handOnlyRuntimeAtAction: boolean;
};

const ROOMSHIFT_W2C_STORAGE_KEY = 'roomshift_w2c_hands_first_iwer_v1';

let roomShiftW2CArmed = false;
let roomShiftW2CXRFrames = 0;
let roomShiftW2CHandSources = 0;
let roomShiftW2CControllerSources = 0;
let roomShiftW2CPeakHandSources = 0;
let roomShiftW2CKeyboardSemanticAttempts = 0;

function roomShiftLoadW2CActions(): RoomShiftW2CActionEvent[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(ROOMSHIFT_W2C_STORAGE_KEY) ?? '[]',
    );
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function roomShiftSaveW2CActions(rows: RoomShiftW2CActionEvent[]) {
  localStorage.setItem(ROOMSHIFT_W2C_STORAGE_KEY, JSON.stringify(rows));
}

const roomShiftW2COverlay = document.createElement('div');
roomShiftW2COverlay.id = 'roomshift-w2c-hands-overlay';
Object.assign(roomShiftW2COverlay.style, {
  position: 'fixed',
  top: '72px',
  left: '18px',
  zIndex: '99999',
  background: 'rgba(5,14,24,0.90)',
  color: '#ffffff',
  border: '1px solid #35f29a',
  borderRadius: '10px',
  padding: '10px 12px',
  fontFamily: 'monospace',
  fontSize: '13px',
  lineHeight: '1.45',
  pointerEvents: 'none',
  minWidth: '270px',
});

document.body.appendChild(roomShiftW2COverlay);

function roomShiftW2CHandOnlyReady() {
  return (
    roomShiftW2CXRFrames > 0 &&
    roomShiftW2CHandSources > 0 &&
    roomShiftW2CControllerSources === 0
  );
}

function roomShiftRefreshW2COverlay() {
  const actions = roomShiftLoadW2CActions();
  roomShiftW2COverlay.innerHTML =
    '<b>ROOMSHIFT W2C - HANDS FIRST</b><br>' +
    'armed: <b>' + (roomShiftW2CArmed ? 'YES' : 'NO') + '</b><br>' +
    'XR frames: ' + roomShiftW2CXRFrames + '<br>' +
    'hand sources: <b>' + roomShiftW2CHandSources + '</b><br>' +
    'controller sources: <b>' + roomShiftW2CControllerSources + '</b><br>' +
    'hand-only ready: <b>' + (roomShiftW2CHandOnlyReady() ? 'YES' : 'NO') + '</b><br>' +
    'semantic pointer actions: ' + actions.length + '<br>' +
    'blocked keyboard actions: ' + roomShiftW2CKeyboardSemanticAttempts +
    '<br><small>H = arm/reset | V = export</small>';
}

world.onXRFrame((frame: any) => {
  roomShiftW2CXRFrames += 1;
  const sources = Array.from(frame?.session?.inputSources ?? []) as any[];

  const handCount = sources.filter((s: any) => Boolean(s?.hand)).length;
  const controllerCount = sources.filter(
    (s: any) => !s?.hand && Boolean(s?.gamepad),
  ).length;

  const changed =
    handCount !== roomShiftW2CHandSources ||
    controllerCount !== roomShiftW2CControllerSources;

  roomShiftW2CHandSources = handCount;
  roomShiftW2CControllerSources = controllerCount;
  roomShiftW2CPeakHandSources = Math.max(
    roomShiftW2CPeakHandSources,
    handCount,
  );

  if (changed || roomShiftW2CXRFrames % 120 === 0) {
    roomShiftRefreshW2COverlay();
  }
});

function roomShiftResetW2CEvidence() {
  localStorage.removeItem(ROOMSHIFT_W2C_STORAGE_KEY);
  roomShiftW2CKeyboardSemanticAttempts = 0;
  roomShiftW2CPeakHandSources = roomShiftW2CHandSources;
  roomShiftRefreshW2COverlay();
}

function roomShiftArmHandsFirstEvidence() {
  if (!roomShiftW2CHandOnlyReady()) {
    roomShiftW2CArmed = false;
    magic.visible = true;
    updateText(
      magic,
      'SWITCH IWER TO HANDS FIRST.',
      '#ffad33',
      'rgba(28,12,3,.92)',
    );
    console.warn(
      '[ROOMSHIFT W2C] Cannot arm: expected active XR hand source(s) and zero controller sources.',
      'hands=' + roomShiftW2CHandSources,
      'controllers=' + roomShiftW2CControllerSources,
    );
    roomShiftRefreshW2COverlay();
    return;
  }

  roomShiftResetW2CEvidence();
  roomShiftW2CArmed = true;

  // Administrative reset is allowed. Mission semantics after this point must
  // come from pointer selections while the XR session is hand-only.
  roomShiftResetMissionIntegration();

  magic.visible = true;
  updateText(
    magic,
    'HANDS-FIRST PROOF ARMED.',
    '#35f29a',
    'rgba(3,18,12,.92)',
  );

  console.info(
    '[ROOMSHIFT W2C] ARMED',
    'hands=' + roomShiftW2CHandSources,
    'controllers=' + roomShiftW2CControllerSources,
  );

  roomShiftRefreshW2COverlay();
}

function roomShiftW2CPointerType(event: any): string {
  if (typeof event?.pointerType === 'string') return event.pointerType;
  if (typeof event?.type === 'string') return event.type;
  return 'UNKNOWN';
}

function roomShiftRecordW2CAction(
  action: RoomShiftW2CSemanticAction,
  event: any,
) {
  const rows = roomShiftLoadW2CActions();
  const pointerType = roomShiftW2CPointerType(event);
  const handOnly = roomShiftW2CHandOnlyReady();

  rows.push({
    seq: rows.length + 1,
    at: new Date().toISOString(),
    action,
    stageBefore: roomShiftMissionStage,
    progressBefore: roomShiftMissionProgress,
    spatialDecision: roomShiftMissionSpatialDecision,
    activePlan: roomShiftMissionPlan,
    xrFramesObserved: roomShiftW2CXRFrames,
    handSources: roomShiftW2CHandSources,
    controllerSources: roomShiftW2CControllerSources,
    pointerType,
    handOnlyRuntimeAtAction: handOnly,
  });

  roomShiftSaveW2CActions(rows);

  console.info(
    '[ROOMSHIFT W2C HAND ACTION]',
    action,
    'stage=' + roomShiftMissionStage,
    'progress=' + roomShiftMissionProgress + '%',
    'hands=' + roomShiftW2CHandSources,
    'controllers=' + roomShiftW2CControllerSources,
    'pointerType=' + pointerType,
  );

  roomShiftRefreshW2COverlay();
}

function roomShiftHandleW2CSemanticPointer(
  action: RoomShiftW2CSemanticAction,
  execute: () => void,
  event?: any,
) {
  // Before W2C is armed, preserve normal cross-modal development behavior.
  if (!roomShiftW2CArmed) {
    execute();
    return;
  }

  const pointerType = roomShiftW2CPointerType(event);

  // Explicitly reject browser mouse/touch attribution if the event exposes it.
  if (
    !roomShiftW2CHandOnlyReady() ||
    pointerType === 'mouse' ||
    pointerType === 'touch'
  ) {
    magic.visible = true;
    updateText(
      magic,
      'HANDS-FIRST INPUT REQUIRED.',
      '#ff5f57',
      'rgba(28,4,4,.92)',
    );
    console.warn(
      '[ROOMSHIFT W2C] semantic pointer rejected',
      action,
      'hands=' + roomShiftW2CHandSources,
      'controllers=' + roomShiftW2CControllerSources,
      'pointerType=' + pointerType,
    );
    return;
  }

  roomShiftRecordW2CAction(action, event);
  execute();
}

function roomShiftW2CSequencePass(actions: RoomShiftW2CActionEvent[]) {
  if (actions.length < 5) return false;

  const expected: RoomShiftW2CSemanticAction[] = [
    'DISABLE_CAMERA',
    'ACQUIRE_ACCESS_KEY',
    'CORE',
    'DRONE_DIVERSION',
    'CORE',
  ];

  for (let i = 0; i < expected.length; i++) {
    if (actions[i]?.action !== expected[i]) return false;
  }

  return (
    actions[0].stageBefore === 'DISABLE_CAMERA' &&
    actions[1].stageBefore === 'ACQUIRE_ACCESS_KEY' &&
    actions[2].stageBefore === 'EXECUTE_PLAN' &&
    actions[2].progressBefore === 67 &&
    actions[2].activePlan === 'DRONE_DIVERSION' &&
    actions[3].stageBefore === 'EXECUTE_PLAN' &&
    actions[3].activePlan === 'DRONE_DIVERSION' &&
    actions[4].stageBefore === 'EXTRACT_CORE'
  );
}

function roomShiftW2CReport() {
  const actions = roomShiftLoadW2CActions();
  const validatorEvents = roomShiftLoadW2BEvents();

  const negative = validatorEvents.find(
    e => e.result.code === 'FAIL_REQUIRED_PLAN_NOT_EXECUTED',
  );
  const success = validatorEvents.find(
    e => e.result.code === 'SUCCESS',
  );

  const everyActionHandOnly =
    actions.length > 0 &&
    actions.every(
      e =>
        e.handOnlyRuntimeAtAction &&
        e.handSources > 0 &&
        e.controllerSources === 0 &&
        e.xrFramesObserved > 0 &&
        e.pointerType !== 'mouse' &&
        e.pointerType !== 'touch',
    );

  const sequencePass = roomShiftW2CSequencePass(actions);

  const pass =
    roomShiftW2CArmed &&
    roomShiftW2CXRFrames > 0 &&
    roomShiftW2CPeakHandSources > 0 &&
    everyActionHandOnly &&
    roomShiftW2CKeyboardSemanticAttempts === 0 &&
    sequencePass &&
    Boolean(negative) &&
    negative?.progress === 67 &&
    Boolean(success) &&
    success?.result.success === true &&
    roomShiftMissionProgress === 100;

  return {
    schema: 'roomshift.iwsdk.w2c.hands-first-iwer.v1',
    evidenceClass: 'IWER_EMULATED_HANDS_FIRST',
    capturedAt: new Date().toISOString(),
    mission: 'STEAL_THE_CORE',
    missionSeed: 42,
    plannerInput: 'ENVIRONMENT_RAYCAST_ONLY',
    interactionPath: 'RAY_INTERACTABLE_POINTER_SELECTION',
    inputAttribution:
      'HAND_ONLY_XR_INPUT_SOURCE_STATE_AT_EACH_SEMANTIC_POINTER_ACTION',
    directPhysicalHardwareValidation: false,
    handTrackingRequested: true,
    armed: roomShiftW2CArmed,
    xrFramesObserved: roomShiftW2CXRFrames,
    peakHandSources: roomShiftW2CPeakHandSources,
    currentHandSources: roomShiftW2CHandSources,
    currentControllerSources: roomShiftW2CControllerSources,
    keyboardSemanticAttempts: roomShiftW2CKeyboardSemanticAttempts,
    semanticPointerActions: actions,
    expectedHandsFirstActionSequence:
      'DISABLE_CAMERA -> ACQUIRE_ACCESS_KEY -> EARLY_CORE_FAIL -> DRONE_DIVERSION -> CORE_SUCCESS',
    sequencePass,
    everyActionHandOnly,
    worldPushbackObserved: Boolean(negative),
    earlyCoreRejectedAt67:
      Boolean(negative) && negative?.progress === 67,
    independentSuccessObserved:
      Boolean(success) && success?.result.success === true,
    finalIndependentOutcome:
      validatorEvents.length > 0
        ? validatorEvents[validatorEvents.length - 1].result.code
        : 'NOT_PERFORMED',
    finalProgress: roomShiftMissionProgress,
    manualPlanSelectionUsed: false,
    handsFirstValidation: pass ? 'PASS_IWER_EMULATED' : 'FAIL',
    realHardwareValidation: 'NOT_PERFORMED',
  };
}

function roomShiftExportW2CReport() {
  const report = roomShiftW2CReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roomshift_w2c_hands_first_iwer.json';
  a.click();
  URL.revokeObjectURL(a.href);
  console.info('[ROOMSHIFT W2C REPORT]', report);
}

(window as any).roomshiftW2C = {
  arm: roomShiftArmHandsFirstEvidence,
  report: roomShiftW2CReport,
  export: roomShiftExportW2CReport,
};

roomShiftRefreshW2COverlay();

function roomShiftDisableCamera() {
  if (roomShiftMissionStage !== 'DISABLE_CAMERA') {
    console.warn('[ROOMSHIFT W2A] Disable Camera ignored: wrong stage');
    return;
  }

  roomShiftCameraDisabled = true;
  roomShiftMissionProgress = 33;
  roomShiftMissionStage = 'ACQUIRE_ACCESS_KEY';

  roomShiftMissionEvent('CAMERA_DISABLED', 'PLAYER_ACTION');
  roomShiftRefreshMissionHUD();
}

function roomShiftAcquireAccessKey() {
  if (
    roomShiftMissionStage !== 'ACQUIRE_ACCESS_KEY' ||
    !roomShiftCameraDisabled
  ) {
    console.warn('[ROOMSHIFT W2A] Access Key ignored: camera is not disabled');
    return;
  }

  roomShiftAccessKeyAcquired = true;
  roomShiftMissionProgress = 67;
  roomShiftMissionStage = 'EXECUTE_PLAN';

  roomShiftMissionEvent('ACCESS_KEY_ACQUIRED', 'PLAYER_ACTION');
  roomShiftRefreshMissionHUD();
}

function roomShiftExecuteDroneDiversion() {
  if (
    roomShiftMissionStage !== 'EXECUTE_PLAN' ||
    !roomShiftAccessKeyAcquired ||
    roomShiftMissionPlan !== 'DRONE_DIVERSION'
  ) {
    console.warn('[ROOMSHIFT W2A] Drone diversion ignored: Plan B is not currently required');
    return;
  }

  roomShiftDroneDiversionExecuted = true;
  roomShiftMissionProgress = 84;
  roomShiftMissionStage = 'EXTRACT_CORE';

  roomShiftMissionEvent('DRONE_DIVERSION_EXECUTED', 'PLAYER_ACTION');
  roomShiftRefreshMissionHUD();
}

function roomShiftExecuteLaserBypass() {
  if (
    roomShiftMissionStage !== 'EXECUTE_PLAN' ||
    !roomShiftAccessKeyAcquired ||
    roomShiftMissionPlan !== 'LASER_BYPASS'
  ) {
    console.warn('[ROOMSHIFT W2A] Laser bypass ignored: Plan A is not currently required');
    return;
  }

  roomShiftLaserBypassExecuted = true;
  roomShiftMissionProgress = 84;
  roomShiftMissionStage = 'EXTRACT_CORE';

  roomShiftMissionEvent('LASER_BYPASS_EXECUTED', 'PLAYER_ACTION');
  roomShiftRefreshMissionHUD();
}

function roomShiftExtractCore() {
  roomShiftCoreExtractionAttempted = true;

  const requiredPlanExecuted =
    (roomShiftMissionPlan === 'DRONE_DIVERSION' && roomShiftDroneDiversionExecuted) ||
    (roomShiftMissionPlan === 'LASER_BYPASS' && roomShiftLaserBypassExecuted);

  if (
    roomShiftMissionStage !== 'EXTRACT_CORE' ||
    !requiredPlanExecuted
  ) {
    const rejected = roomShiftRunIndependentValidator('EARLY_CORE_ATTEMPT');
    roomShiftShowRejectedOutcome(rejected);
    roomShiftRefreshMissionHUD();
    return;
  }

  // Mission controller records physical/runtime facts only.
  // It does NOT assign validator success.
  roomShiftCoreExtracted = true;
  roomShiftMissionProgress = 100;
  roomShiftMissionStage = 'COMPLETE';
  roomShiftMissionEvent('CORE_EXTRACTED', 'PLAYER_ACTION');

  const validated = roomShiftRunIndependentValidator('CORE_AFTER_REQUIRED_PLAN');

  if (validated.success) {
    magic.visible = true;
    updateText(
      magic,
      'THE GAME HAD TO CHANGE.',
      '#35f29a',
      'rgba(3,18,12,.88)',
    );
  } else {
    magic.visible = true;
    updateText(
      magic,
      'MISSION INVALID.',
      '#ff5f57',
      'rgba(28,4,4,.92)',
    );
  }

  roomShiftRefreshMissionHUD();
}

function roomShiftResetMissionIntegration() {
  localStorage.removeItem(ROOMSHIFT_W2A_STORAGE_KEY);
  roomShiftResetIndependentOutcomeEvidence();

  roomShiftMissionStage = 'DISABLE_CAMERA';
  roomShiftMissionProgress = 0;
  roomShiftMissionSpatialDecision = roomShiftStableDecision;
  roomShiftMissionPlan =
    roomShiftStableDecision === 'BLOCKED'
      ? 'DRONE_DIVERSION'
      : roomShiftStableDecision === 'CLEAR'
        ? 'LASER_BYPASS'
        : 'NONE';

  roomShiftCameraDisabled = false;
  roomShiftAccessKeyAcquired = false;
  roomShiftDroneDiversionExecuted = false;
  roomShiftLaserBypassExecuted = false;
  roomShiftCoreExtracted = false;
  roomShiftMissionRepairCount = 0;

  magic.visible = false;
  roomShiftMissionEvent('MISSION_RESET', 'SYSTEM');
  roomShiftRefreshMissionHUD();
}

function roomShiftW2AReport() {
  const events = roomShiftLoadMissionEvents();

  const camera = events.find(e => e.kind === 'CAMERA_DISABLED');
  const keyEvent = events.find(e => e.kind === 'ACCESS_KEY_ACQUIRED');
  const repair = events.find(e => e.kind === 'MISSION_REPAIRED');
  const drone = events.find(e => e.kind === 'DRONE_DIVERSION_EXECUTED');
  const laser = events.find(e => e.kind === 'LASER_BYPASS_EXECUTED');
  const coreEvent = events.find(e => e.kind === 'CORE_EXTRACTED');

  const repairPreserved67 = Boolean(
    repair &&
    repair.progress === 67 &&
    keyEvent &&
    keyEvent.progress === 67
  );

  const repairedPlanExecuted = Boolean(
    repair &&
    (
      (repair.plan === 'DRONE_DIVERSION' && drone) ||
      (repair.plan === 'LASER_BYPASS' && laser)
    )
  );

  const missionCompleted = Boolean(
    coreEvent &&
    coreEvent.progress === 100 &&
    roomShiftCoreExtracted
  );

  return {
    schema: 'roomshift.iwsdk.w2a.spatial-mission-integration.v1',
    evidenceClass: 'IWER_SPATIAL_TO_MISSION_INTEGRATION',
    capturedAt: new Date().toISOString(),
    mission: 'STEAL_THE_CORE',
    missionSeed: 42,
    plannerInput: 'ENVIRONMENT_RAYCAST_ONLY',
    corridorLengthMeters: ROOMSHIFT_CORRIDOR_LENGTH_M,
    events,
    cameraStepCompleted: Boolean(camera),
    accessKeyStepCompleted: Boolean(keyEvent),
    repairObserved: Boolean(repair),
    progressPreservedAt67DuringRepair: repairPreserved67,
    repairedPlanExecuted,
    missionCompleted,
    finalProgress: roomShiftMissionProgress,
    centralHudDrivenBySpatialDecision: true,
    manualWorldSelectionAvailable: false,
    manualPlanSelectionUsed: false,
    inputEvidenceClass: 'LOCAL_OR_IWER_POINTER_ACTIONS',
    handsFirstValidation: 'NOT_PERFORMED',
    realHardwareValidation: 'NOT_PERFORMED',
  };
}

function roomShiftExportW2AReport() {
  const report = roomShiftW2AReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roomshift_w2a_spatial_mission_integration.json';
  a.click();
  URL.revokeObjectURL(a.href);
  console.info('[ROOMSHIFT W2A REPORT]', report);
}


function roomShiftW2BReport() {
  const validatorEvents = roomShiftLoadW2BEvents();
  const missionEvents = roomShiftLoadMissionEvents();

  const negative = validatorEvents.find(
    e => e.result.code === 'FAIL_REQUIRED_PLAN_NOT_EXECUTED',
  );

  const success = validatorEvents.find(
    e => e.result.code === 'SUCCESS',
  );

  return {
    schema: 'roomshift.iwsdk.w2b.independent-outcome.v1',
    evidenceClass: 'IWER_INDEPENDENT_OUTCOME_VALIDATION',
    capturedAt: new Date().toISOString(),
    mission: 'STEAL_THE_CORE',
    missionSeed: 42,
    plannerInput: 'ENVIRONMENT_RAYCAST_ONLY',
    validatorModule: 'src/roomshift/w2b/independent-validator.ts',
    validatorInput: 'READ_ONLY_RUNTIME_SNAPSHOT',
    controllerSetsValidatorOutcome: false,
    missionEvents,
    validatorEvents,
    negativeOutcomeObserved: Boolean(negative),
    negativeOutcomeProgressPreserved:
      Boolean(negative) && negative!.progress === 67,
    worldPushbackObserved:
      Boolean(negative) && negative!.result.success === false,
    positiveOutcomeObserved: Boolean(success),
    finalIndependentOutcome:
      validatorEvents.length > 0
        ? validatorEvents[validatorEvents.length - 1].result.code
        : 'NOT_PERFORMED',
    finalProgress: roomShiftMissionProgress,
    manualWorldSelectionAvailable: false,
    manualPlanSelectionUsed: false,
    handsFirstValidation: 'NOT_PERFORMED',
    realHardwareValidation: 'NOT_PERFORMED',
  };
}

function roomShiftExportW2BReport() {
  const report = roomShiftW2BReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roomshift_w2b_independent_outcome.json';
  a.click();
  URL.revokeObjectURL(a.href);
  console.info('[ROOMSHIFT W2B REPORT]', report);
}

(window as any).roomshiftW2B = {
  validate: () => evaluateRoomShiftIndependentOutcome(roomShiftRuntimeSnapshot()),
  report: roomShiftW2BReport,
  export: roomShiftExportW2BReport,
};

(window as any).roomshiftW2A = {
  camera: roomShiftDisableCamera,
  key: roomShiftAcquireAccessKey,
  laser: roomShiftExecuteLaserBypass,
  decoy: roomShiftExecuteDroneDiversion,
  core: roomShiftExtractCore,
  reset: roomShiftResetMissionIntegration,
  report: roomShiftW2AReport,
  export: roomShiftExportW2AReport,
};

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();

  if (k === 'h') {
    roomShiftArmHandsFirstEvidence();
    return;
  }

  if (k === 'v') {
    roomShiftExportW2CReport();
    return;
  }

  if (
    roomShiftW2CArmed &&
    ['c', 'a', 'd', 'o', 'z', 'm'].includes(k)
  ) {
    roomShiftW2CKeyboardSemanticAttempts += 1;
    console.warn(
      '[ROOMSHIFT W2C] keyboard mission action blocked while hands-first proof is armed:',
      k,
    );
    roomShiftRefreshW2COverlay();
    return;
  }

  if (k === 'c') roomShiftDisableCamera();
  if (k === 'a') roomShiftAcquireAccessKey();
  if (k === 'd') roomShiftExecuteDroneDiversion();
  if (k === 'l') roomShiftExportW2AReport();
  if (k === 'm') roomShiftResetMissionIntegration();
  if (k === 'o') roomShiftExtractCore();
  if (k === 'z') roomShiftExecuteLaserBypass();
  if (k === 'p') roomShiftExportW2BReport();
});

function roomShiftUpdateSpatialDecision(sample: RoomShiftRaycastSample) {
  // Because EnvironmentRaycastTarget.maxDistance is exactly 3.0 m:
  // hasHit == true means a physical surface exists inside the route corridor.
  const blocked = sample.hasHit;

  roomShiftRecentBlocked.push(blocked);
  if (roomShiftRecentBlocked.length > ROOMSHIFT_DECISION_WINDOW) {
    roomShiftRecentBlocked.shift();
  }

  if (roomShiftRecentBlocked.length < ROOMSHIFT_DECISION_WINDOW) {
    roomShiftRefreshSpatialOverlay();
    return;
  }

  const blockedVotes = roomShiftRecentBlocked.filter(Boolean).length;
  const clearVotes = roomShiftRecentBlocked.length - blockedVotes;

  let next: RoomShiftSpatialDecision = 'UNKNOWN';
  if (blockedVotes >= ROOMSHIFT_REQUIRED_AGREEMENT) next = 'BLOCKED';
  if (clearVotes >= ROOMSHIFT_REQUIRED_AGREEMENT) next = 'CLEAR';

  if (next !== 'UNKNOWN' && next !== roomShiftStableDecision) {
    roomShiftStableDecision = next;
    roomShiftAutoPlan = roomShiftDecisionToPlan(next);

    const rows = roomShiftLoadSpatialTransitions();
    const transition: RoomShiftSpatialTransition = {
      seq: rows.length + 1,
      at: new Date().toISOString(),
      decision: next,
      plan: roomShiftAutoPlan,
      corridorLengthMeters: ROOMSHIFT_CORRIDOR_LENGTH_M,
      hitDistanceMeters: sample.hasHit ? sample.distanceFromHead : null,
      decisionSource: 'ENVIRONMENT_RAYCAST_ONLY',
    };
    rows.push(transition);
    roomShiftSaveSpatialTransitions(rows);

    console.info(
      '[ROOMSHIFT W1B2] AUTO DECISION',
      'decision=',
      next,
      'plan=',
      roomShiftAutoPlan,
      'hitDistance=',
      transition.hitDistanceMeters,
    );
    roomShiftApplySpatialDecisionToMission(next);
  }

  roomShiftRefreshSpatialOverlay();
}

const roomShiftSpatialOverlay = document.createElement('div');
roomShiftSpatialOverlay.id = 'roomshift-w1b2-overlay';
Object.assign(roomShiftSpatialOverlay.style, {
  position: 'fixed',
  top: '72px',
  right: '18px',
  zIndex: '99999',
  background: 'rgba(5,14,24,0.88)',
  color: '#ffffff',
  border: '1px solid #29e7ff',
  borderRadius: '10px',
  padding: '10px 12px',
  fontFamily: 'monospace',
  fontSize: '13px',
  lineHeight: '1.45',
  pointerEvents: 'none',
  minWidth: '260px',
});
document.body.appendChild(roomShiftSpatialOverlay);

function roomShiftRefreshSpatialOverlay() {
  const rows = roomShiftLoadSpatialTransitions();
  const latestDistance = roomShiftLatestHitDistance();
  roomShiftSpatialOverlay.innerHTML =
    '<b>ROOMSHIFT W1B2 - AUTO SPATIAL</b><br>' +
    'corridor: ' + ROOMSHIFT_CORRIDOR_LENGTH_M.toFixed(2) + ' m<br>' +
    'world: <b>' + roomShiftStableDecision + '</b><br>' +
    'plan: <b>' + roomShiftAutoPlan + '</b><br>' +
    'latest hit: ' +
      (latestDistance === null ? 'none < 3m' : latestDistance.toFixed(3) + ' m') +
      '<br>' +
    'transitions: ' + rows.length +
      '<br><small>Rule: hit inside 3m => BLOCKED</small>';
}

function roomShiftSpatialPlannerReport() {
  const rows = roomShiftLoadSpatialTransitions();
  const plans = rows.map(r => r.plan);
  let aba = false;

  for (let i = 0; i + 2 < plans.length; i++) {
    if (
      plans[i] === 'LASER_BYPASS' &&
      plans[i + 1] === 'DRONE_DIVERSION' &&
      plans[i + 2] === 'LASER_BYPASS'
    ) {
      aba = true;
      break;
    }
  }

  return {
    schema: 'roomshift.iwsdk.w1b2.auto-spatial-planner.v1',
    evidenceClass: 'IWER_ENVIRONMENT_RAYCAST_AUTO_PLANNER',
    capturedAt: new Date().toISOString(),
    corridorLengthMeters: ROOMSHIFT_CORRIDOR_LENGTH_M,
    rule: 'HIT_WITHIN_CORRIDOR_EQUALS_BLOCKED',
    decisionWindowSamples: ROOMSHIFT_DECISION_WINDOW,
    requiredAgreementSamples: ROOMSHIFT_REQUIRED_AGREEMENT,
    currentDecision: roomShiftStableDecision,
    currentPlan: roomShiftAutoPlan,
    transitions: rows,
    automaticPlanABAObserved: aba,
    plannerInput: 'ENVIRONMENT_RAYCAST_ONLY',
    environmentIdentityUsedByPlanner: false,
    manualPlanSelectionUsed: false,
    viewerPoseLock: 'MANUAL_PROTOCOL_REQUIRED',
    sceneUnderstandingStatus: 'NO_GO_CURRENT_IWER_PATH',
    realHardwareValidation: 'NOT_PERFORMED',
  };
}

function roomShiftExportSpatialPlannerReport() {
  const report = roomShiftSpatialPlannerReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roomshift_w1b2_auto_spatial_planner.json';
  a.click();
  URL.revokeObjectURL(a.href);
  console.info('[ROOMSHIFT W1B2 REPORT]', report);
}

(window as any).roomshiftSpatialPlannerReport = roomShiftSpatialPlannerReport;
(window as any).roomshiftExportSpatialPlannerReport =
  roomShiftExportSpatialPlannerReport;
(window as any).roomshiftResetSpatialEvidence =
  roomShiftResetSpatialEvidence;

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'k') roomShiftExportSpatialPlannerReport();
  if (key === 'x') roomShiftResetSpatialEvidence();
});

roomShiftRefreshSpatialOverlay();


const roomShiftReticleMesh = new THREE.Mesh(
  new THREE.RingGeometry(0.045, 0.065, 32),
  new THREE.MeshBasicMaterial({
    color: 0x29e7ff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.95,
  }),
);
roomShiftReticleMesh.name = 'ROOMSHIFT_Environment_Raycast_Reticle';
const roomShiftReticle = world.createTransformEntity(roomShiftReticleMesh);
roomShiftReticle.addComponent(EnvironmentRaycastTarget, {
  space: RaycastSpace.Viewer,
  maxDistance: 3.0,
});

let roomShiftLastRaycastSample = 0;

function roomShiftCaptureRaycastSample() {
  const xrResult = roomShiftReticle.getValue(
    EnvironmentRaycastTarget,
    'xrHitTestResult',
  );
  const visible = Boolean(roomShiftReticle.object3D?.visible);
  const hasHit = Boolean(xrResult);

  let position: [number, number, number] | null = null;
  let distanceFromHead: number | null = null;

  if (hasHit && roomShiftReticle.object3D) {
    const p = new THREE.Vector3();
    roomShiftReticle.object3D.getWorldPosition(p);
    position = [p.x, p.y, p.z];

    const hp = new THREE.Vector3();
    world.playerHeadEntity?.object3D?.getWorldPosition(hp);
    distanceFromHead = hp.distanceTo(p);
  }

  const sample: RoomShiftRaycastSample = {
    at: new Date().toISOString(),
    hasHit,
    visible,
    position,
    distanceFromHead,
  };

  roomShiftRaycastSamples.push(sample);
  roomShiftUpdateSpatialDecision(sample);
  if (roomShiftRaycastSamples.length > 120) roomShiftRaycastSamples.shift();

  (window as any).roomshiftRaycastSamples = roomShiftRaycastSamples;

  if (hasHit) {
    console.info(
      '[ROOMSHIFT W1B1] ENV HIT',
      'distance=',
      distanceFromHead?.toFixed(3),
      'position=',
      position
    );
  }
}

function roomShiftRaycastReport() {
  const hits = roomShiftRaycastSamples.filter(s => s.hasHit);
  const distances = hits
    .map(s => s.distanceFromHead)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d));

  return {
    schema: 'roomshift.iwsdk.w1b1.environment-raycast.v1',
    evidenceClass: 'IWER_ENVIRONMENT_RAYCAST_PROBE',
    capturedAt: new Date().toISOString(),
    sampleCount: roomShiftRaycastSamples.length,
    hitSampleCount: hits.length,
    hitObserved: hits.length > 0,
    minHitDistance: distances.length ? Math.min(...distances) : null,
    maxHitDistance: distances.length ? Math.max(...distances) : null,
    latestHit: hits.length ? hits[hits.length - 1] : null,
    routeBlockedDecision: 'NOT_EVALUATED',
    missionPlannerConnected: false,
    sceneUnderstandingStatus: 'NO_GO_CURRENT_IWER_PATH',
    realHardwareValidation: 'NOT_PERFORMED',
  };
}

function roomShiftExportRaycastReport() {
  const report = roomShiftRaycastReport();
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'roomshift_w1b1_environment_raycast.json';
  a.click();
  URL.revokeObjectURL(a.href);
  console.info('[ROOMSHIFT W1B1 REPORT]', report);
}

(window as any).roomshiftRaycastReport = roomShiftRaycastReport;
(window as any).roomshiftExportRaycastReport = roomShiftExportRaycastReport;

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'j') {
    roomShiftExportRaycastReport();
  }
});

function roomShiftRaycastLoop() {
  const now = performance.now();
  if (now - roomShiftLastRaycastSample >= 250) {
    roomShiftLastRaycastSample = now;
    roomShiftCaptureRaycastSample();
  }
  requestAnimationFrame(roomShiftRaycastLoop);
}
requestAnimationFrame(roomShiftRaycastLoop);

console.info(
  'ROOMSHIFT W1B1 ENVIRONMENT RAYCAST READY | Look at room surfaces. Press J to export.'
);

console.info(
  'ROOMSHIFT W1B0 V0.2 SCENE PROBE READY | manifest sceneUnderstanding enabled'
);

const C={graphite:0x101722,graphite2:0x1a2533,cyan:0x29e7ff,red:0xff2748,amber:0xffad33,green:0x35f29a,blue:0x4a8cff};
const root=new THREE.Group(); root.name='ROOMSHIFT_W1A_ROOT'; root.position.set(0,1.05,-2.35); const rootEntity=world.createTransformEntity(root);
function box(n:string,s:THREE.Vector3,p:THREE.Vector3,c:number,o=1){const m=new THREE.Mesh(new THREE.BoxGeometry(s.x,s.y,s.z),new THREE.MeshBasicMaterial({color:c,transparent:o<1,opacity:o,depthWrite:o>=1}));m.name=n;m.position.copy(p);root.add(m);return m;}
function sphere(n:string,r:number,p:THREE.Vector3,c:number){const m=new THREE.Mesh(new THREE.SphereGeometry(r,24,16),new THREE.MeshBasicMaterial({color:c}));m.name=n;m.position.copy(p);root.add(m);return m;}
function roundRect(ctx:CanvasRenderingContext2D,x:number,y:number,w:number,h:number,r:number){const q=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+q,y);ctx.arcTo(x+w,y,x+w,y+h,q);ctx.arcTo(x+w,y+h,x,y+h,q);ctx.arcTo(x,y+h,x,y,q);ctx.arcTo(x,y,x+w,y,q);ctx.closePath();}
// ROOMSHIFT_W3B_HUD_TEXT_FIT_V0_1
function roomShiftFitCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxPx = 76,
  minPx = 44,
) {
  let px = maxPx;
  while (px > minPx) {
    ctx.font = `700 ${px}px Arial`;
    if (ctx.measureText(text).width <= maxWidth) return;
    px -= 2;
  }
  ctx.font = `700 ${minPx}px Arial`;
}

function roomShiftDrawTextCanvas(
  cv: HTMLCanvasElement,
  text: string,
  col = '#f3f8ff',
  bg = 'rgba(8,12,18,.78)',
) {
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = bg;
  roundRect(ctx, 20, 20, cv.width - 40, cv.height - 40, 42);
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = col;

  // Keep 60 px of horizontal safety margin on each side.
  roomShiftFitCanvasText(ctx, text, cv.width - 120);
  ctx.fillText(text, cv.width / 2, cv.height / 2);
}

function textSprite(
  t: string,
  sc = .42,
  col = '#f3f8ff',
  bg = 'rgba(8,12,18,.78)',
) {
  const cv = document.createElement('canvas');
  cv.width = 1280;
  cv.height = 256;

  roomShiftDrawTextCanvas(cv, t, col, bg);

  const tx = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tx, transparent: true }),
  );

  // Canvas is now 5:1 instead of 4:1; preserve its natural aspect ratio.
  sp.scale.set(sc * 5, sc, 1);
  sp.userData.canvas = cv;
  sp.userData.texture = tx;
  return sp;
}

function updateText(
  sp: THREE.Sprite,
  t: string,
  col = '#f3f8ff',
  bg = 'rgba(8,12,18,.78)',
) {
  const cv = sp.userData.canvas as HTMLCanvasElement;
  const tx = sp.userData.texture as THREE.CanvasTexture;

  roomShiftDrawTextCanvas(cv, t, col, bg);
  tx.needsUpdate = true;
}

box('Platform',new THREE.Vector3(2.25,.08,1.2),new THREE.Vector3(0,0,0),C.graphite);
box('Vault',new THREE.Vector3(.60,.52,.38),new THREE.Vector3(.42,.30,-.10),C.graphite2);
const core=sphere('Core',.13,new THREE.Vector3(.42,.30,-.32),C.cyan);
const cam=box('SecurityCamera',new THREE.Vector3(.24,.14,.18),new THREE.Vector3(-.78,.58,-.10),C.red);
const key=box('AccessKey',new THREE.Vector3(.22,.08,.12),new THREE.Vector3(-.78,.16,.15),C.green);
const decoy=sphere('Decoy',.11,new THREE.Vector3(.86,.16,.18),C.blue);
const drone=sphere('Drone',.14,new THREE.Vector3(.83,.62,-.10),0xdde6ef);
const lasers=new THREE.Group(); for(let i=-2;i<=2;i++){const b=new THREE.Mesh(new THREE.BoxGeometry(.018,.52,.018),new THREE.MeshBasicMaterial({color:C.red}));b.position.set(.08+i*.08,.31,.08);lasers.add(b);} root.add(lasers);
const routeA=box('RouteA',new THREE.Vector3(1.35,.018,.045),new THREE.Vector3(-.18,.10,.20),C.cyan,.92);
const routeB1=box('RouteB1',new THREE.Vector3(.75,.018,.045),new THREE.Vector3(.66,.10,.22),C.blue,.92);
const routeB2=box('RouteB2',new THREE.Vector3(.70,.018,.045),new THREE.Vector3(.59,.10,-.18),C.blue,.92); routeB2.rotation.y=-.48;
const blocker=box('PhysicalConstraint',new THREE.Vector3(.42,.48,.26),new THREE.Vector3(-.05,.28,.19),C.amber,.86);
const title=textSprite('ROOMSHIFT | STEAL THE CORE',.31);title.position.set(0,1.28,-.02);root.add(title);
const status=textSprite('WORLD A Â· ROUTE CLEAR',.27,'#35f29a');status.position.set(0,.99,-.02);root.add(status);
const plan=textSprite('PLAN A Â· LASER BYPASS',.27,'#29e7ff');plan.position.set(0,.74,-.02);root.add(plan);
const progress=textSprite('67% PRESERVED',.22);progress.position.set(0,.54,-.02);root.add(progress);
const magic=textSprite('THE ROOM CHANGED.',.25,'#ffad33','rgba(20,8,3,.88)');magic.position.set(0,.32,-.50);root.add(magic);
function worldButton(label:string,x:number,color:number,id:WorldId){const g=new THREE.Group();g.position.set(x,.08,.54);const plate=new THREE.Mesh(new THREE.BoxGeometry(.56,.09,.22),new THREE.MeshBasicMaterial({color}));g.add(plate);const s=textSprite(label,.095);s.position.set(0,.13,0);s.scale.set(.55,.14,1);g.add(s);root.add(g);const groupEntity=world.createTransformEntity(g,{parent:rootEntity});const e=world.createTransformEntity(plate,{parent:groupEntity});e.addComponent(RayInteractable);(plate as any).addEventListener('click',()=>setWorld(id,true));}
// W2A: manual A/B world selectors removed. World state now comes from Environment Raycast only.
const ce=world.createTransformEntity(cam,{parent:rootEntity});ce.addComponent(RayInteractable);(cam as any).addEventListener('click',()=>updateText(progress,'CAMERA DISABLED','#35f29a'));
for(const [m,msg,col] of [[key,'ACCESS KEY ACQUIRED','#35f29a'],[decoy,'DECOY READY','#4a8cff'],[core,'CORE EXTRACTED Â· 100%','#29e7ff']] as const){const e=world.createTransformEntity(m,{parent:rootEntity});e.addComponent(RayInteractable).addComponent(DistanceGrabbable,{movementMode:MovementMode.MoveFromTarget});(m as any).addEventListener('click',()=>updateText(progress,msg,col));}
let timer:number|undefined;
function planFor(b:boolean):PlanId{return b?'DRONE_DIVERSION':'LASER_BYPASS';}
function setWorld(id:WorldId,record:boolean){const b=id==='B_BLOCKED',p=planFor(b);blocker.visible=b;routeA.visible=!b;lasers.visible=!b;routeB1.visible=b;routeB2.visible=b;drone.visible=b;updateText(status,b?'WORLD B Â· ROUTE BLOCKED':`${id==='A_PRIME_CLEAR'?"WORLD Aâ€²":'WORLD A'} Â· ROUTE CLEAR`,b?'#ffad33':'#35f29a');updateText(plan,b?'PLAN B Â· DRONE DIVERSION':'PLAN A Â· LASER BYPASS',b?'#4a8cff':'#29e7ff');magic.visible=b;if(b){updateText(magic,'THE ROOM CHANGED.','#ffad33','rgba(20,8,3,.88)');clearTimeout(timer);timer=window.setTimeout(()=>updateText(magic,'MISSION REPAIRED.','#35f29a','rgba(3,18,12,.88)'),900);}if(record) recordEvidence(id,b,p);}
function loadEvents():EvidenceEvent[]{try{return JSON.parse(localStorage.getItem(STORAGE_KEY)??'[]')}catch{return[]}}
function recordEvidence(id:WorldId,b:boolean,p:PlanId){const ev=loadEvents();ev.push({seq:ev.length+1,at:new Date().toISOString(),seed:MISSION_SEED,mission:'STEAL_THE_CORE',world:id,routeBlocked:b,plan:p});localStorage.setItem(STORAGE_KEY,JSON.stringify(ev));console.info('[ROOMSHIFT W1A]',ev[ev.length - 1]);}
function report(){const ev=loadEvents(),x=ev.slice(-3);const pass=x.length===3&&x[0].world==='A_CLEAR'&&x[0].plan==='LASER_BYPASS'&&x[1].world==='B_BLOCKED'&&x[1].plan==='DRONE_DIVERSION'&&x[2].world==='A_PRIME_CLEAR'&&x[2].plan==='LASER_BYPASS'&&x.every(e=>e.seed===42&&e.mission==='STEAL_THE_CORE');return{schema:'roomshift.iwsdk.w1a.v1',evidenceClass:'IWER_CONTROLLED_SYNTHETIC_WORLD',missionSeed:42,events:ev,causalPattern:'A_CLEAR -> B_BLOCKED -> A_PRIME_CLEAR',abaPass:pass,liveSceneUnderstandingValidation:'NOT_PERFORMED',realHardwareValidation:'NOT_PERFORMED'};}
function exportEvidence(){const blob=new Blob([JSON.stringify(report(),null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='roomshift_w1a_evidence.json';a.click();URL.revokeObjectURL(a.href);}

// W2A semantic mission action wiring.
// Browser pointer, controller ray or later hand adapters may trigger the same semantic actions.
(cam as any).addEventListener('click', (event: any) => roomShiftHandleW2CSemanticPointer('DISABLE_CAMERA', roomShiftDisableCamera, event));
(key as any).addEventListener('click', (event: any) => roomShiftHandleW2CSemanticPointer('ACQUIRE_ACCESS_KEY', roomShiftAcquireAccessKey, event));
(decoy as any).addEventListener('click', (event: any) => roomShiftHandleW2CSemanticPointer('DRONE_DIVERSION', roomShiftExecuteDroneDiversion, event));
(core as any).addEventListener('click', (event: any) => roomShiftHandleW2CSemanticPointer('CORE', roomShiftExtractCore, event));

// Route A becomes the explicit local action for Plan A.
const routeAEntityW2A = world.createTransformEntity(routeA, { parent: rootEntity });
routeAEntityW2A.addComponent(RayInteractable);
(routeA as any).addEventListener('click', (event: any) => roomShiftHandleW2CSemanticPointer('LASER_BYPASS', roomShiftExecuteLaserBypass, event));

(window as any).roomshiftW1AReport=report;(window as any).roomshiftExportEvidence=exportEvidence;(window as any).roomshiftResetEvidence=()=>localStorage.removeItem(STORAGE_KEY);
window.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='e')exportEvidence();if(e.key.toLowerCase()==='r')(window as any).roomshiftResetEvidence();});
setWorld('A_CLEAR',false); roomShiftResetMissionIntegration(); console.info('ROOMSHIFT IWSDK W1A READY â€” select A CLEAR â†’ B BLOCKED â†’ Aâ€² CLEAR. Keyboard: 1,2,3. Export: E.');




// ROOMSHIFT_W2D_HELD_OUT_WORLDS
type RoomShiftW2DWorldRecord={
  holdoutId:string;
  capturedAt:string;
  decision:'CLEAR'|'BLOCKED';
  plan:'LASER_BYPASS'|'DRONE_DIVERSION';
  corridorLengthMeters:number;
  latestHitDistanceMeters:number|null;
  recentWindowSamples:number;
  recentHitSamples:number;
  recentNoHitSamples:number;
  spatialSignature:string;
  plannerInput:'ENVIRONMENT_RAYCAST_ONLY';
  environmentIdentityUsedByPlanner:false;
};

const ROOMSHIFT_W2D_TARGET=8;
const ROOMSHIFT_W2D_STORAGE_KEY='roomshift_w2d_heldout_worlds_v1';
let roomShiftW2DLastCaptureAt=0;

function roomShiftLoadW2DRecords():RoomShiftW2DWorldRecord[]{
  try{const v=JSON.parse(localStorage.getItem(ROOMSHIFT_W2D_STORAGE_KEY)??'[]');return Array.isArray(v)?v:[];}catch{return [];}
}
function roomShiftSaveW2DRecords(rows:RoomShiftW2DWorldRecord[]){localStorage.setItem(ROOMSHIFT_W2D_STORAGE_KEY,JSON.stringify(rows));}
function roomShiftW2DRecentWindow(){
  const rows=roomShiftRaycastSamples.slice(-ROOMSHIFT_DECISION_WINDOW);
  const hits=rows.filter(s=>s.hasHit);
  return{total:rows.length,hitCount:hits.length,noHitCount:rows.length-hits.length};
}
function roomShiftW2DSpatialSignature(){
  const w=roomShiftW2DRecentWindow();
  const d=roomShiftLatestHitDistance();
  const db=d===null||!Number.isFinite(d)?'NONE':(Math.round(d*20)/20).toFixed(2);
  return [roomShiftStableDecision,roomShiftAutoPlan,'d='+db,'hits='+w.hitCount+'/'+w.total].join('|');
}
function roomShiftW2DEligible(){
  const w=roomShiftW2DRecentWindow();
  return roomShiftStableDecision!=='UNKNOWN'&&roomShiftAutoPlan!=='NONE'&&w.total>=ROOMSHIFT_DECISION_WINDOW;
}
function roomShiftCaptureHeldOutWorld(){
  const rows=roomShiftLoadW2DRecords();
  if(rows.length>=ROOMSHIFT_W2D_TARGET){console.warn('[ROOMSHIFT W2D] 8 holdouts already captured');return;}
  if(!roomShiftW2DEligible()){console.warn('[ROOMSHIFT W2D] wait for stable W1B2 decision');return;}
  const now=performance.now();
  if(roomShiftW2DLastCaptureAt>0&&now-roomShiftW2DLastCaptureAt<2000){console.warn('[ROOMSHIFT W2D] wait 2s before next capture');return;}
  const w=roomShiftW2DRecentWindow();
  const id='H'+String(rows.length+1).padStart(2,'0');
  const decision=roomShiftStableDecision as 'CLEAR'|'BLOCKED';
  const plan=decision==='BLOCKED'?'DRONE_DIVERSION':'LASER_BYPASS';
  const row:RoomShiftW2DWorldRecord={
    holdoutId:id,capturedAt:new Date().toISOString(),decision,plan,
    corridorLengthMeters:ROOMSHIFT_CORRIDOR_LENGTH_M,
    latestHitDistanceMeters:roomShiftLatestHitDistance(),
    recentWindowSamples:w.total,recentHitSamples:w.hitCount,recentNoHitSamples:w.noHitCount,
    spatialSignature:roomShiftW2DSpatialSignature(),
    plannerInput:'ENVIRONMENT_RAYCAST_ONLY',
    environmentIdentityUsedByPlanner:false,
  };
  rows.push(row);roomShiftSaveW2DRecords(rows);roomShiftW2DLastCaptureAt=now;
  console.info('[ROOMSHIFT W2D] CAPTURED',row);
  roomShiftRefreshW2DOverlay();
}
function roomShiftResetW2D(){localStorage.removeItem(ROOMSHIFT_W2D_STORAGE_KEY);roomShiftW2DLastCaptureAt=0;roomShiftRefreshW2DOverlay();}
function roomShiftW2DReport(){
  const rows=roomShiftLoadW2DRecords();
  const clearCount=rows.filter(r=>r.decision==='CLEAR').length;
  const blockedCount=rows.filter(r=>r.decision==='BLOCKED').length;
  const signatures=Array.from(new Set(rows.map(r=>r.spatialSignature)));
  const allStable=rows.every(r=>r.recentWindowSamples>=ROOMSHIFT_DECISION_WINDOW&&(
    (r.decision==='BLOCKED'&&r.plan==='DRONE_DIVERSION'&&r.recentHitSamples>=ROOMSHIFT_REQUIRED_AGREEMENT)||
    (r.decision==='CLEAR'&&r.plan==='LASER_BYPASS'&&r.recentNoHitSamples>=ROOMSHIFT_REQUIRED_AGREEMENT)
  ));
  const pass=rows.length===8&&clearCount>0&&blockedCount>0&&signatures.length>=2&&allStable;
  return{
    schema:'roomshift.iwsdk.w2d.heldout-worlds.v1',
    evidenceClass:'IWER_HELD_OUT_SYNTHETIC_WORLD_GENERALIZATION',
    capturedAt:new Date().toISOString(),
    mission:'STEAL_THE_CORE',missionSeed:42,
    corridorLengthMeters:ROOMSHIFT_CORRIDOR_LENGTH_M,
    plannerInput:'ENVIRONMENT_RAYCAST_ONLY',
    holdoutTarget:8,
    holdoutDeclaration:'MANUAL_PROTOCOL_ENVIRONMENTS_NOT_USED_FOR_PLANNER_TUNING',
    viewerPoseConstancy:'MANUAL_PROTOCOL_REQUIRED',
    environmentIdentityUsedByPlanner:false,
    environmentNamesRecorded:false,
    records:rows,holdoutCount:rows.length,clearCount,blockedCount,
    distinctSpatialSignatures:signatures.length,
    bothDecisionClassesObserved:clearCount>0&&blockedCount>0,
    allStable,
    heldOutSyntheticWorldGeneralization:pass?'PASS':'FAIL',
    realHardwareValidation:'NOT_PERFORMED'
  };
}
function roomShiftExportW2DReport(){
  const report=roomShiftW2DReport();
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='roomshift_w2d_heldout_worlds.json';a.click();URL.revokeObjectURL(a.href);
}
const roomShiftW2DOverlay=document.createElement('div');
Object.assign(roomShiftW2DOverlay.style,{position:'fixed',right:'18px',bottom:'18px',zIndex:'2147483646',background:'rgba(5,14,24,.90)',color:'#fff',border:'1px solid #b785ff',borderRadius:'10px',padding:'10px 12px',fontFamily:'monospace',fontSize:'13px',lineHeight:'1.45',pointerEvents:'none',minWidth:'300px'});
document.body.appendChild(roomShiftW2DOverlay);
function roomShiftRefreshW2DOverlay(){
  const rows=roomShiftLoadW2DRecords();
  const next=rows.length<8?'H'+String(rows.length+1).padStart(2,'0'):'DONE';
  roomShiftW2DOverlay.innerHTML='<b>ROOMSHIFT W2D - HELD-OUT WORLDS</b><br>'+
    'captured: <b>'+rows.length+'/8</b><br>next: <b>'+next+'</b><br>'+
    'decision: <b>'+roomShiftStableDecision+'</b><br>plan: <b>'+roomShiftAutoPlan+'</b><br>'+
    'eligible: <b>'+(roomShiftW2DEligible()?'YES':'NO')+'</b><br><small>N=capture | G=reset | Y=export</small>';
}
window.setInterval(roomShiftRefreshW2DOverlay,250);
window.addEventListener('keydown',(e)=>{const k=e.key.toLowerCase();if(k==='n')roomShiftCaptureHeldOutWorld();if(k==='g')roomShiftResetW2D();if(k==='y')roomShiftExportW2DReport();});
(window as any).roomshiftW2D={capture:roomShiftCaptureHeldOutWorld,reset:roomShiftResetW2D,report:roomShiftW2DReport,export:roomShiftExportW2DReport};
roomShiftRefreshW2DOverlay();
console.info('[ROOMSHIFT W2D] READY | G reset | N capture | Y export');


// ROOMSHIFT_W2E_SPATIAL_STABILITY
type W2ED='CLEAR'|'BLOCKED';
type W2EP='IDLE'|'JITTER'|'JITTER_PASS'|'WAIT_TRANSITION'|'SETTLE_TRANSITION'|'TRANSITION_PASS'|'WAIT_RECOVERY'|'SETTLE_RECOVERY'|'COMPLETE'|'FAIL';
const W2E_JITTER_MS=12000,W2E_SETTLE_MS=5000,W2E_WAIT_MS=30000;
const w2e:any={phase:'IDLE' as W2EP,origin:null,opp:null,started:0,last:null,jSamples:0,jUnknown:0,jFlips:0,jPass:false,tFlips:0,tReached:false,tAt:0,tRebounds:0,tPass:false,rFlips:0,rReached:false,rAt:0,rRebounds:0,rPass:false,fail:'',events:[]};
function w2eStable():W2ED|null{return roomShiftStableDecision==='CLEAR'||roomShiftStableDecision==='BLOCKED'?roomShiftStableDecision:null;}
function w2ePlan(d:W2ED){return d==='CLEAR'?'LASER_BYPASS':'DRONE_DIVERSION';}
function w2eLog(kind:string,detail=''){w2e.events.push({at:new Date().toISOString(),kind,decision:roomShiftStableDecision,plan:roomShiftAutoPlan,detail});console.info('[ROOMSHIFT W2E]',kind,detail);}
function w2eFail(x:string){w2e.phase='FAIL';w2e.fail=x;w2eLog('FAIL',x);}
function w2eReset(){Object.assign(w2e,{phase:'IDLE',origin:null,opp:null,started:0,last:null,jSamples:0,jUnknown:0,jFlips:0,jPass:false,tFlips:0,tReached:false,tAt:0,tRebounds:0,tPass:false,rFlips:0,rReached:false,rAt:0,rRebounds:0,rPass:false,fail:'',events:[]});w2eLog('RESET');}
function w2eStartJitter(){if(w2e.phase!=='IDLE')return;const d=w2eStable();if(!d||roomShiftAutoPlan!==w2ePlan(d)){console.warn('[W2E] wait for stable valid W1B2');return;}w2e.origin=d;w2e.opp=d==='CLEAR'?'BLOCKED':'CLEAR';w2e.phase='JITTER';w2e.started=performance.now();w2e.last=d;w2eLog('JITTER_START','manual small-pose perturbation');}
function w2eArmTransition(){if(w2e.phase!=='JITTER_PASS')return;w2e.phase='WAIT_TRANSITION';w2e.started=performance.now();w2e.last=w2e.origin;w2eLog('TRANSITION_ARMED');}
function w2eArmRecovery(){if(w2e.phase!=='TRANSITION_PASS')return;w2e.phase='WAIT_RECOVERY';w2e.started=performance.now();w2e.last=w2e.opp;w2eLog('RECOVERY_ARMED');}
function w2eTick(){const now=performance.now(),d=w2eStable(); if(['IDLE','COMPLETE','FAIL'].includes(w2e.phase))return;
if(w2e.phase==='JITTER'){w2e.jSamples++;if(!d)w2e.jUnknown++;else{if(w2e.last&&d!==w2e.last){w2e.jFlips++;w2eLog('JITTER_FLIP',w2e.last+'->'+d);}w2e.last=d;}if(now-w2e.started>=W2E_JITTER_MS){const u=w2e.jSamples?w2e.jUnknown/w2e.jSamples:1;w2e.jPass=w2e.jFlips===0&&d===w2e.origin&&u<=.10;if(w2e.jPass){w2e.phase='JITTER_PASS';w2eLog('JITTER_PASS','unknownRate='+u.toFixed(3));}else w2eFail('JITTER_FAIL');}return;}
if(w2e.phase==='WAIT_TRANSITION'){if(now-w2e.started>W2E_WAIT_MS){w2eFail('TRANSITION_TIMEOUT');return;}if(d&&w2e.last&&d!==w2e.last){w2e.tFlips++;w2eLog('A_TO_B_FLIP',w2e.last+'->'+d);w2e.last=d;}if(d===w2e.opp){w2e.tReached=true;w2e.tAt=now;w2e.phase='SETTLE_TRANSITION';w2e.last=d;w2eLog('B_REACHED');}return;}
if(w2e.phase==='SETTLE_TRANSITION'){if(d&&w2e.last&&d!==w2e.last){w2e.tFlips++;w2e.tRebounds++;w2eLog('A_TO_B_REBOUND');w2e.last=d;}if(now-w2e.tAt>=W2E_SETTLE_MS){w2e.tPass=d===w2e.opp&&w2e.tFlips===1&&w2e.tRebounds===0;if(w2e.tPass){w2e.phase='TRANSITION_PASS';w2eLog('TRANSITION_PASS');}else w2eFail('TRANSITION_SETTLE_FAIL');}return;}
if(w2e.phase==='WAIT_RECOVERY'){if(now-w2e.started>W2E_WAIT_MS){w2eFail('RECOVERY_TIMEOUT');return;}if(d&&w2e.last&&d!==w2e.last){w2e.rFlips++;w2eLog('B_TO_A_FLIP',w2e.last+'->'+d);w2e.last=d;}if(d===w2e.origin){w2e.rReached=true;w2e.rAt=now;w2e.phase='SETTLE_RECOVERY';w2e.last=d;w2eLog('A_REACHED');}return;}
if(w2e.phase==='SETTLE_RECOVERY'){if(d&&w2e.last&&d!==w2e.last){w2e.rFlips++;w2e.rRebounds++;w2eLog('B_TO_A_REBOUND');w2e.last=d;}if(now-w2e.rAt>=W2E_SETTLE_MS){w2e.rPass=d===w2e.origin&&w2e.rFlips===1&&w2e.rRebounds===0;if(w2e.rPass){w2e.phase='COMPLETE';w2eLog('RECOVERY_PASS');}else w2eFail('RECOVERY_SETTLE_FAIL');}}}
function w2eReport(){const u=w2e.jSamples?w2e.jUnknown/w2e.jSamples:1,pass=w2e.phase==='COMPLETE'&&w2e.jPass&&w2e.tPass&&w2e.rPass;return{schema:'roomshift.iwsdk.w2e.spatial-stability.v1',evidenceClass:'IWER_SPATIAL_STABILITY_ANTI_FLAPPING',capturedAt:new Date().toISOString(),mission:'STEAL_THE_CORE',missionSeed:42,corridorLengthMeters:ROOMSHIFT_CORRIDOR_LENGTH_M,plannerInput:'ENVIRONMENT_RAYCAST_ONLY',jitterProtocol:'MANUAL_SMALL_HEADSET_POSE_PERTURBATION_FOR_12_SECONDS',jitterDurationMs:W2E_JITTER_MS,jitterSamples:w2e.jSamples,jitterUnknownSamples:w2e.jUnknown,jitterUnknownRate:u,jitterStableFlips:w2e.jFlips,jitterPass:w2e.jPass,originDecision:w2e.origin,oppositeDecision:w2e.opp,transitionStableFlips:w2e.tFlips,transitionReachedOpposite:w2e.tReached,transitionReboundFlips:w2e.tRebounds,transitionPass:w2e.tPass,recoveryStableFlips:w2e.rFlips,recoveryReachedOrigin:w2e.rReached,recoveryReboundFlips:w2e.rRebounds,recoveryPass:w2e.rPass,events:w2e.events,finalPhase:w2e.phase,failReason:w2e.fail,antiFlappingABA:pass?'PASS':'FAIL',environmentIdentityUsedByPlanner:false,smallPerturbationMagnitudeMachineVerified:false,viewerPoseRecoveryMachineVerified:false,realHardwareValidation:'NOT_PERFORMED'};}
function w2eExport(){const r=w2eReport(),b=new Blob([JSON.stringify(r,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='roomshift_w2e_spatial_stability.json';a.click();URL.revokeObjectURL(a.href);}
const w2ePanel=document.createElement('div');Object.assign(w2ePanel.style,{position:'fixed',left:'50%',bottom:'18px',transform:'translateX(-50%)',zIndex:'2147483645',background:'rgba(12,10,24,.92)',color:'#fff',border:'1px solid #ff79c6',borderRadius:'10px',padding:'10px 12px',fontFamily:'monospace',fontSize:'13px',lineHeight:'1.45',pointerEvents:'none',minWidth:'390px'});document.body.appendChild(w2ePanel);
function w2eUI(){let i='1 reset | 2 start jitter';if(w2e.phase==='JITTER')i='small pose perturbations now';if(w2e.phase==='JITTER_PASS')i='3 arm A->B, then switch';if(w2e.phase==='WAIT_TRANSITION')i='switch to opposite-class holdout';if(w2e.phase==='SETTLE_TRANSITION')i='hold still: settling B';if(w2e.phase==='TRANSITION_PASS')i='4 arm B->A, then return';if(w2e.phase==='WAIT_RECOVERY')i='return to original environment/pose';if(w2e.phase==='SETTLE_RECOVERY')i='hold still: settling A';if(w2e.phase==='COMPLETE')i='PASS | 5 export';if(w2e.phase==='FAIL')i='FAIL | 5 export | 1 reset';w2ePanel.innerHTML='<b>ROOMSHIFT W2E - SPATIAL STABILITY</b><br>phase: <b>'+w2e.phase+'</b><br>decision: <b>'+roomShiftStableDecision+'</b> | plan: <b>'+roomShiftAutoPlan+'</b><br>jitter flips: <b>'+w2e.jFlips+'</b><br>A->B flips/rebounds: <b>'+w2e.tFlips+'/'+w2e.tRebounds+'</b><br>B->A flips/rebounds: <b>'+w2e.rFlips+'/'+w2e.rRebounds+'</b><br><small>'+i+'</small>'; }
setInterval(w2eTick,100);setInterval(w2eUI,200);window.addEventListener('keydown',(e)=>{if(e.key==='1')w2eReset();if(e.key==='2')w2eStartJitter();if(e.key==='3')w2eArmTransition();if(e.key==='4')w2eArmRecovery();if(e.key==='5')w2eExport();});(window as any).roomshiftW2E={reset:w2eReset,jitter:w2eStartJitter,transition:w2eArmTransition,recovery:w2eArmRecovery,report:w2eReport,export:w2eExport};w2eUI();console.info('[ROOMSHIFT W2E] READY | 1 reset | 2 jitter | 3 A->B | 4 B->A | 5 export');


// ROOMSHIFT_W3A_COMPETITION_POLISH
// Presentation-only layer: read-only access to frozen planner state.
installRoomshiftCompetitionPolish(world,{
  getDecision:()=>roomShiftStableDecision,
  getPlan:()=>roomShiftAutoPlan,
});
