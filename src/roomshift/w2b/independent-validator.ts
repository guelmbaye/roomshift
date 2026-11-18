export type RoomShiftValidatorPlan =
  | 'NONE'
  | 'LASER_BYPASS'
  | 'DRONE_DIVERSION';

export type RoomShiftValidatorDecision =
  | 'UNKNOWN'
  | 'CLEAR'
  | 'BLOCKED';

export type RoomShiftValidatorStage =
  | 'DISABLE_CAMERA'
  | 'ACQUIRE_ACCESS_KEY'
  | 'EXECUTE_PLAN'
  | 'EXTRACT_CORE'
  | 'COMPLETE';

export type RoomShiftOutcomeCode =
  | 'IN_PROGRESS'
  | 'FAIL_CORE_BEFORE_PREREQUISITES'
  | 'FAIL_REQUIRED_PLAN_NOT_EXECUTED'
  | 'FAIL_STATE_INCONSISTENT'
  | 'SUCCESS';

export interface RoomShiftOutcomeSnapshot {
  spatialDecision: RoomShiftValidatorDecision;
  activePlan: RoomShiftValidatorPlan;
  stage: RoomShiftValidatorStage;
  progress: number;

  cameraDisabled: boolean;
  accessKeyAcquired: boolean;
  laserBypassExecuted: boolean;
  droneDiversionExecuted: boolean;

  coreExtractionAttempted: boolean;
  coreExtracted: boolean;
}

export interface RoomShiftOutcomeResult {
  code: RoomShiftOutcomeCode;
  terminal: boolean;
  success: boolean;
  reason: string;
}

/**
 * Independent validator.
 *
 * It receives only a read-only runtime snapshot.
 * It does not select a plan, mutate mission state, move entities, update the HUD,
 * or declare success on behalf of the mission controller.
 */
export function evaluateRoomShiftIndependentOutcome(
  s: Readonly<RoomShiftOutcomeSnapshot>,
): RoomShiftOutcomeResult {
  if (s.coreExtractionAttempted && (!s.cameraDisabled || !s.accessKeyAcquired)) {
    return {
      code: 'FAIL_CORE_BEFORE_PREREQUISITES',
      terminal: false,
      success: false,
      reason: 'Core extraction attempted before the preserved mission prefix was completed.',
    };
  }

  if (s.coreExtractionAttempted && !s.coreExtracted) {
    if (s.activePlan === 'DRONE_DIVERSION' && !s.droneDiversionExecuted) {
      return {
        code: 'FAIL_REQUIRED_PLAN_NOT_EXECUTED',
        terminal: false,
        success: false,
        reason: 'Blocked route requires Drone Diversion before Core extraction.',
      };
    }

    if (s.activePlan === 'LASER_BYPASS' && !s.laserBypassExecuted) {
      return {
        code: 'FAIL_REQUIRED_PLAN_NOT_EXECUTED',
        terminal: false,
        success: false,
        reason: 'Clear route requires Laser Bypass before Core extraction.',
      };
    }
  }

  if (s.coreExtracted) {
    const planSatisfied =
      (s.activePlan === 'DRONE_DIVERSION' && s.droneDiversionExecuted) ||
      (s.activePlan === 'LASER_BYPASS' && s.laserBypassExecuted);

    if (
      !s.cameraDisabled ||
      !s.accessKeyAcquired ||
      !planSatisfied ||
      s.progress !== 100 ||
      s.stage !== 'COMPLETE'
    ) {
      return {
        code: 'FAIL_STATE_INCONSISTENT',
        terminal: true,
        success: false,
        reason: 'Core is marked extracted but the runtime state does not satisfy the mission contract.',
      };
    }

    return {
      code: 'SUCCESS',
      terminal: true,
      success: true,
      reason: 'Independent runtime snapshot satisfies the complete ROOMSHIFT mission contract.',
    };
  }

  return {
    code: 'IN_PROGRESS',
    terminal: false,
    success: false,
    reason: 'Mission is still in progress.',
  };
}
