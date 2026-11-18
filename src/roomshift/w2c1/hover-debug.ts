import {
  Hovered,
  Pressed,
  RayInteractable,
  createSystem,
  type World,
} from '@iwsdk/core';

/**
 * W2C.1 observational pointer debug.
 *
 * This system observes the exact IWSDK RayInteractable that receives Hovered
 * and Pressed. It never calls ROOMSHIFT mission actions.
 */
export class RoomshiftHoverDebugSystem extends createSystem({
  hoveredTargets: { required: [RayInteractable, Hovered] },
  pressedTargets: { required: [RayInteractable, Pressed] },
}) {
  private panel: HTMLDivElement | null = null;
  private lastText = '';

  init(): void {
    const old = document.getElementById('roomshift-w2c1-hover-debug');
    old?.remove();

    const panel = document.createElement('div');
    panel.id = 'roomshift-w2c1-hover-debug';
    panel.style.position = 'fixed';
    panel.style.left = '50%';
    panel.style.top = '12px';
    panel.style.transform = 'translateX(-50%)';
    panel.style.zIndex = '2147483647';
    panel.style.padding = '10px 16px';
    panel.style.minWidth = '250px';
    panel.style.borderRadius = '8px';
    panel.style.border = '2px solid #777';
    panel.style.background = 'rgba(5, 14, 20, 0.92)';
    panel.style.color = '#fff';
    panel.style.font = '700 14px/1.4 monospace';
    panel.style.whiteSpace = 'pre';
    panel.style.pointerEvents = 'none';
    panel.textContent = 'ROOMSHIFT W2C.1\nTARGET: NONE\nHOVER: NO\nPRESSED: NO';
    document.body.appendChild(panel);
    this.panel = panel;

    console.info('[ROOMSHIFT W2C.1] Hover/Pressed instrumentation armed');
  }

  private describe(entity: any): string {
    const raw =
      entity?.object3D?.name ||
      entity?.object3D?.userData?.roomshiftTargetId ||
      entity?.object3D?.userData?.targetId ||
      entity?.name ||
      (entity?.id != null ? `ENTITY_${String(entity.id)}` : 'UNNAMED_INTERACTABLE');

    const upper = String(raw).trim().toUpperCase();

    if (upper.includes('SECURITY') || upper.includes('CAMERA')) return 'SECURITY_CAMERA';
    if (upper.includes('ACCESS') || upper.includes('KEY')) return 'ACCESS_KEY';
    if (upper.includes('DECOY') || upper.includes('DRONE')) return 'DECOY';
    if (upper.includes('CORE')) return 'CORE';

    return upper || 'UNNAMED_INTERACTABLE';
  }

  update(): void {
    let hovered: any = null;
    let pressed: any = null;

    for (const entity of this.queries.hoveredTargets.entities) {
      hovered = entity;
      break;
    }
    for (const entity of this.queries.pressedTargets.entities) {
      pressed = entity;
      break;
    }

    const active = pressed ?? hovered;
    const target = active ? this.describe(active) : 'NONE';
    const isHover = hovered != null;
    const isPressed = pressed != null;

    const text =
      `ROOMSHIFT W2C.1\n` +
      `TARGET: ${target}\n` +
      `HOVER: ${isHover ? 'YES' : 'NO'}\n` +
      `PRESSED: ${isPressed ? 'YES' : 'NO'}`;

if (text === this.lastText) return;
    this.lastText = text;

    if (this.panel) {
      this.panel.textContent = text;
      this.panel.style.borderColor = isPressed ? '#ffd54a' : isHover ? '#00e676' : '#777';
    }

    console.info(
      `[ROOMSHIFT W2C.1] target=${target} hover=${isHover ? 'YES' : 'NO'} pressed=${isPressed ? 'YES' : 'NO'}`,
    );
  }

  destroy(): void {
    this.panel?.remove();
    this.panel = null;
    super.destroy();
  }
}

export function installRoomshiftHoverDebug(world: World): void {
  world.registerSystem(RoomshiftHoverDebugSystem, { priority: 999 });
  console.info('[ROOMSHIFT W2C.1] Debug system registered');
}
