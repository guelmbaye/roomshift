import type { World } from '@iwsdk/core';

type PresentationSource = {
  getDecision: () => string;
  getPlan: () => string;
};

const ROOMSHIFT_W3A_VERSION = '0.4-capture-clean';

function isPresentationMode(): boolean {
  const q = new URLSearchParams(window.location.search);
  return q.get('presentation') === '1' || q.get('judge') === '1';
}


const ROOMSHIFT_DEBUG_PATTERNS = [
  'ROOMSHIFT W2C - HANDS FIRST',
  'ROOMSHIFT W2C.1',
  'ROOMSHIFT W1B2 - AUTO SPATIAL',
  'ROOMSHIFT W2D - HELD-OUT WORLDS',
  'ROOMSHIFT W2E - SPATIAL STABILITY',
];

let roomshiftDebugPanelsVisible = false;

function setRoomshiftDebugPanelsVisible(visible: boolean): void {
  roomshiftDebugPanelsVisible = visible;

  for (const el of Array.from(document.querySelectorAll<HTMLElement>('div'))) {
    if (el.id === 'roomshift-w3a-judge-hud') continue;
    if (el.closest('#roomshift-w3a-judge-hud')) continue;

    // Protect any DOM branch that may own the WebGL/XR rendering surface.
    if (el.querySelector('canvas, iframe, video, svg')) continue;

    const text = (el.innerText || '').trim().toUpperCase();
    if (!text) continue;
    if (!ROOMSHIFT_DEBUG_PATTERNS.some(p => text.includes(p))) continue;

    const r = el.getBoundingClientRect();

    // Only small overlay-like elements are eligible.
    // Never touch a full-page/container element.
    if (r.width < 100 || r.width > 620 || r.height < 35 || r.height > 420) continue;

    const style = getComputedStyle(el);
    if (
      style.position !== 'fixed' &&
      style.position !== 'absolute'
    ) continue;

    el.style.setProperty(
      'visibility',
      visible ? 'visible' : 'hidden',
      'important',
    );
    el.style.setProperty(
      'pointer-events',
      visible ? 'auto' : 'none',
      'important',
    );
  }
}

function installCaptureCleanDebugToggle(): void {
  setRoomshiftDebugPanelsVisible(false);

  // Some diagnostic panels are created after W3A, so reapply safely.
  window.setInterval(() => {
    setRoomshiftDebugPanelsVisible(roomshiftDebugPanelsVisible);
  }, 800);

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'd') return;

    setRoomshiftDebugPanelsVisible(!roomshiftDebugPanelsVisible);

    console.info(
      '[ROOMSHIFT W3A v0.4] engineering panels',
      roomshiftDebugPanelsVisible ? 'VISIBLE' : 'HIDDEN',
    );
  });
}

function buildHud(): HTMLElement {
  const old = document.getElementById('roomshift-w3a-judge-hud');
  old?.remove();

  const root = document.createElement('div');
  root.id = 'roomshift-w3a-judge-hud';
  root.innerHTML = `
  <style>
    #roomshift-w3a-judge-hud{
      position:fixed;inset:0;z-index:2147483000;pointer-events:none;
      font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;color:#fff
    }
    .rs-card{
      position:absolute;padding:12px 16px;border-radius:14px;
      background:rgba(4,10,16,.74);border:1px solid rgba(255,255,255,.15);
      backdrop-filter:blur(10px);box-shadow:0 8px 30px rgba(0,0,0,.18)
    }
    .rs-brand{left:20px;top:18px}
    .rs-route{right:20px;top:18px;min-width:235px}
    .rs-brand b{font-size:17px;letter-spacing:.12em}
    .rs-brand small,.rs-route small{display:block;color:#aeb8c4;letter-spacing:.09em}
    #rs-decision{margin-top:4px;font-size:23px;font-weight:850}
    #rs-plan{margin-top:3px;font-size:13px;color:#d7e1ea}
    .rs-tag{
      position:absolute;left:50%;bottom:18px;transform:translateX(-50%);
      padding:9px 16px;border-radius:999px;background:rgba(4,10,16,.68);
      border:1px solid rgba(255,255,255,.14);font-size:12px;font-weight:800;
      letter-spacing:.14em
    }
    .rs-toast{
      position:absolute;left:50%;top:31%;
      transform:translate(-50%,-50%) scale(.96);
      opacity:0;min-width:360px;text-align:center;padding:17px 26px;
      border-radius:18px;background:rgba(4,10,16,.90);
      border:2px solid #ffb020;box-shadow:0 18px 70px rgba(0,0,0,.35);
      transition:opacity .18s ease,transform .18s ease
    }
    .rs-toast.show{opacity:1;transform:translate(-50%,-50%) scale(1)}
    .rs-toast b{font-size:26px;letter-spacing:.06em}
    .rs-toast small{display:block;margin-top:5px;color:#ccd6df;font-size:14px}
  </style>
  <div class="rs-card rs-brand">
    <b>ROOMSHIFT</b>
    <small>STEAL THE CORE</small>
  </div>
  <div class="rs-card rs-route">
    <small>ROOM SCAN</small>
    <div id="rs-decision">ANALYZING…</div>
    <div id="rs-plan">Spatial route pending</div>
  </div>
  <div class="rs-toast" id="rs-toast">
    <b id="rs-toast-big">ROOM CHANGED</b>
    <small id="rs-toast-small">Replanning mission</small>
  </div>
  <div class="rs-tag">YOUR ROOM IS THE LEVEL</div>
  `;
  document.body.appendChild(root);
  return root;
}

export function installRoomshiftCompetitionPolish(
  world: World,
  source: PresentationSource,
): void {
  void world;

  if (!isPresentationMode()) {
    console.info('[ROOMSHIFT W3A v0.3] OFF; use ?presentation=1');
    return;
  }

  const hud = buildHud();
  installCaptureCleanDebugToggle();

  let lastDecision = '';
  let toastTimer: number | null = null;

  const showToast = (big: string, small: string, blocked: boolean) => {
    const t = hud.querySelector<HTMLElement>('#rs-toast');
    const b = hud.querySelector<HTMLElement>('#rs-toast-big');
    const s = hud.querySelector<HTMLElement>('#rs-toast-small');
    if (!t || !b || !s) return;

    b.textContent = big;
    s.textContent = small;
    t.style.borderColor = blocked ? '#ffb020' : '#00e5ff';
    t.classList.add('show');

    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove('show'), 2200);
  };

  const refresh = () => {
    const decision = source.getDecision();
    const plan = source.getPlan();

    const d = hud.querySelector<HTMLElement>('#rs-decision');
    const p = hud.querySelector<HTMLElement>('#rs-plan');

    if (d) {
      d.textContent =
        decision === 'BLOCKED'
          ? 'ROUTE BLOCKED'
          : decision === 'CLEAR'
            ? 'ROUTE CLEAR'
            : 'ANALYZING…';
      d.style.color = decision === 'BLOCKED' ? '#ffb020' : '#00e5ff';
    }

    if (p) {
      p.textContent =
        plan === 'DRONE_DIVERSION'
          ? 'PLAN B · DRONE DIVERSION'
          : plan === 'LASER_BYPASS'
            ? 'PLAN A · LASER BYPASS'
            : 'Spatial route pending';
    }

    if (
      (decision === 'CLEAR' || decision === 'BLOCKED') &&
      lastDecision &&
      decision !== lastDecision
    ) {
      if (decision === 'BLOCKED') {
        showToast(
          'ROOM CHANGED',
          'Old route invalid · Replanning → DRONE DIVERSION',
          true,
        );
      } else {
        showToast(
          'ROUTE RESTORED',
          'Spatial scan confirms LASER BYPASS',
          false,
        );
      }
    }

    if (decision === 'CLEAR' || decision === 'BLOCKED') {
      lastDecision = decision;
    }
  };

  refresh();
  window.setInterval(refresh, 150);

  console.info(
    '[ROOMSHIFT W3A v0.4] Capture-clean HUD active; zero XR scene mutation; D toggles engineering panels',
  );
}
