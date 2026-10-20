(() => {
  'use strict';

  const WORLD = { width: 12000, height: 8000 };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const palette = ['#d4b5ff', '#83d9ff', '#ffbd68', '#5eefa8'];
  const icons = {
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m14 6-6 6 6 6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m14 2-10 12h7l-1 8 10-12h-7z"/></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m11 4-6 5H2v6h3l6 5zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></svg>',
    exit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 5H5v14h4M12 12h9m-4-4 4 4-4 4"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>',
  };

  let root, canvas, ctx, socket, room, myId, token, currentOptions;
  let active = false, intentionalClose = false, joined = false, reconnecting = false;
  let pendingResolve, pendingReject, connectionTimer, retryTimer, retries = 0;
  let width = innerWidth, height = innerHeight, dpr = 1, raf, inputTimer, pingTimer, backgroundCanvas;
  let lastFrame = 0, lastHud = 0, inputPulse = false, rearPulse = false, splitPulse = false;
  let touchVector = { x: 0, y: 0 }, joystickPointer = null, sound = false, audioContext;
  let previousStatus = '', previousRound = -1, lastUpgradeKey = '', lastShatteredAt = 0;
  let inputSeq = 0, lastInputAck = 0, lastMovementSeq = 0, rtt = null, fps = 0, frameCount = 0, fpsStarted = 0, lastSnapshotAt = 0;
  let renderedDust = 0, renderedCells = 0, renderedMeteors = 0, camera = { x: NaN, y: NaN, scale: .95 };
  const canvasPixelBudget = 1920 * 1080;
  let renderScale = 1, renderQuality = { windowAt: 0, frames: 0, total: 0, slow: 0, warmUntil: 0, lastChange: 0, headroomSince: null };
  let bodyOverflowBefore = null;
  const keys = new Set(), drawnPlayers = new Map(), drawnDust = new Map(), particles = [], seenBlasts = new Set();
  const cellTracks = new Map(), dustTracks = new Map(), predictedCells = new Map(), inputHistory = [], domCache = new Map();
  const meteorTracks = new Map();
  let meteorPresentation = null;
  const planetSprites = new Map(), dustSprites = new Map();
  const materializedDust = new Map();
  const seenImpacts = new Map();
  const predictedContactEffects = new Map();
  const waveVisuals = new Map();
  const cancelledWaves = new Map(), seenWaveClashes = new Map();
  let clashBaselinePending = true, clashBaselineTime = null;
  const combatFeedback = new Map(), seenCombatEvents = new Map();
  let combatMarkerTimer;
  const seenWaveBlinks = new Map();
  const seenWaveHarvests = new Map();
  const blinkVisualDuration = 140;
  let blinkBaselinePending = true;
  const consumedBlinkWaves = new Map();
  let blinkConsumptionScope = null, blinkConsumptionRevision = 0;
  const remoteContactPositions = new Map();
  const remotePhysics = new Map(), contactEpisodes = new Map();
  const defaultMotion = { response: 6, drag: 2, stopSpeed: .5, restitution: .2, restingThreshold: 60, contactSlop: .01, physicsStep: 1 / 120, baseSpeed: 210, referenceMass: 36, speedExponent: .22 };
  const defaultSibling = { launchGrace: .9, rangeBase: 600, rangeScale: 2, attraction: 900, radialDamping: 12, maxAcceleration: 4000, fusionDuration: 1.2 };
  let siblingSettings = { ...defaultSibling }, siblingEnabled = false;
  let motionSettings = { ...defaultMotion }, simulationLead = 0;
  let renderTimeline = null;
  let predictionPaused = false;
  let remoteContactFrame = -1;
  const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
  const gameKeys = new Set([...movementKeys, 'Space', 'KeyE', 'KeyR', 'Digit1', 'Digit2', 'Digit3', 'Escape']);
  const stars = Array.from({ length: 240 }, (_, i) => ({
    x: Math.abs(Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1,
    y: Math.abs(Math.sin(i * 269.5 + 183.3) * 29813.3719) % 1,
    r: i % 13 === 0 ? 1.45 : i % 3 === 0 ? 0.85 : 0.5,
    a: 0.15 + ((i * 37) % 70) / 100,
  }));

  function install() {
    if (root) return;
    root = $('gameOverlay') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'gameOverlay', hidden: true }));
    const style = document.createElement('style');
    style.textContent = `
      #gameOverlay{position:fixed;inset:0;z-index:1000;background:#070b15;color:#f2f5fc;font-family:inherit;overflow:hidden;isolation:isolate;touch-action:none}#gameOverlay[hidden]{display:none!important}#gameOverlay *{box-sizing:border-box}#gameOverlay button{font:inherit;cursor:pointer}#gameOverlay button:focus-visible{outline:2px solid #b7f4d5;outline-offset:5px}#gameOverlay button:disabled{cursor:not-allowed;opacity:.4}#gameOverlay svg{width:20px;height:20px;display:block}#gameCanvas{position:absolute;inset:0;width:100%;height:100%;display:block}#gameOverlay .sg-top{position:absolute;top:28px;left:34px;right:34px;display:flex;justify-content:space-between;align-items:center;pointer-events:none;gap:14px}#gameOverlay .sg-top>*{pointer-events:auto}.sg-brand{display:flex;align-items:center;gap:12px}.sg-symbol{width:38px;height:38px;border:1px solid #b8f3d450;border-radius:50%;display:grid;place-items:center;color:#b7f4d5;font-size:25px;box-shadow:0 0 28px #a0f9cb12}.sg-title{font-size:15px;font-weight:750;letter-spacing:2px}.sg-subtitle{font-size:9px;letter-spacing:2.2px;color:#84909f;margin-top:5px}.sg-round{position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:17px;padding:11px 19px;background:#101722c9;border:1px solid #768b982b;border-radius:11px;backdrop-filter:blur(12px)}.sg-live-dot{width:6px;height:6px;background:#b9f6ca;border-radius:50%;box-shadow:0 0 10px #b9f6ca}.sg-round-label{font-size:10px;letter-spacing:2px;color:#a5b1bd}.sg-timer{font:600 21px ui-monospace,monospace;letter-spacing:2px}.sg-actions{display:flex;gap:9px}.sg-icon-btn{width:39px;height:39px;display:grid;place-items:center;background:#101722c9;border:1px solid #768b9835;border-radius:10px;color:#a6b1c0;backdrop-filter:blur(12px)}.sg-icon-btn:hover{color:#ddf8e9;border-color:#b9f6ca70}.sg-icon-btn[aria-pressed=false]{color:#687584}.sg-rank{position:absolute;left:34px;top:112px;width:198px;padding:18px 17px;border:1px solid #a4b8cc15;border-radius:13px;background:#0e1421b8;backdrop-filter:blur(16px)}.sg-eyebrow{color:#8c9aa8;font-size:9px;letter-spacing:2.2px;font-weight:650}.sg-rank-title{display:flex;justify-content:space-between;gap:10px;padding-bottom:13px;border-bottom:1px solid #afc4d912}.sg-rank-count{font:10px ui-monospace,monospace;color:#b9f6ca}.sg-rank-row{display:grid;grid-template-columns:15px 9px 1fr auto;gap:7px;align-items:center;font-size:11px;margin-top:15px;color:#b7c0ce}.sg-rank-row.me{color:#effcf4}.sg-rank-num{font:10px ui-monospace,monospace;color:#718092}.sg-player-dot{width:6px;height:6px;border-radius:50%;background:var(--planet);box-shadow:0 0 10px var(--planet)}.sg-rank-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sg-rank-score{font:11px ui-monospace,monospace;color:#f4f7fb}.sg-stat{position:absolute;right:34px;top:112px;width:159px;border:1px solid #a4b8cc15;border-radius:13px;background:#0e1421b8;padding:17px 18px;backdrop-filter:blur(16px)}.sg-score{font:500 36px ui-monospace,monospace;letter-spacing:-2px;margin:10px 0 4px}.sg-score-label{color:#738191;font-size:10px}.sg-bottom{position:absolute;bottom:27px;left:34px;right:34px;display:flex;justify-content:space-between;align-items:end;pointer-events:none;gap:24px}.sg-controls{display:flex;gap:20px;color:#83909f;font-size:10px;align-items:center;line-height:1.9}.sg-control{display:flex;align-items:center;gap:7px}.sg-key{font:10px ui-monospace,monospace;display:inline-flex;align-items:center;justify-content:center;min-width:23px;height:23px;border:1px solid #61728455;border-radius:5px;color:#bac5d4;background:#101724aa;padding:0 6px}.sg-energy{width:210px;pointer-events:auto}.sg-energy-caption{display:flex;justify-content:space-between;margin-bottom:10px;font-size:9px;color:#9faab8;letter-spacing:1px}.sg-energy-track{height:4px;background:#273040;border-radius:10px;overflow:hidden}.sg-energy-fill{height:100%;width:60%;background:linear-gradient(90deg,#a68cff,#d4b5ff);box-shadow:0 0 12px #d4b5ff;transition:width .12s linear}.sg-blast-button{margin-top:12px;width:100%;display:flex;justify-content:center;align-items:center;gap:10px;background:#c9b5ff13;border:1px solid #ccb5ff50;border-radius:8px;color:#decfff;font-size:11px;padding:11px 12px;letter-spacing:1px}.sg-blast-button:hover{background:#c9b5ff26}.sg-blast-button svg{width:15px;height:15px}.sg-blast-button kbd{font:9px ui-monospace,monospace;padding:2px 5px;border:1px solid #ccb5ff40;border-radius:3px;color:#9e8fc1}.sg-room-code{position:absolute;bottom:29px;left:50%;transform:translateX(-50%);color:#667588;font:9px ui-monospace,monospace;letter-spacing:2px}.sg-panel-backdrop{position:absolute;inset:0;display:grid;place-items:center;padding:90px 24px;background:#05091366;backdrop-filter:blur(5px)}.sg-panel-backdrop[hidden]{display:none}.sg-panel{position:relative;width:100%;max-width:470px;border:1px solid #97afc32b;background:linear-gradient(145deg,#172130f5,#0d1421fa);box-shadow:0 30px 120px #0009;border-radius:22px;padding:33px}.sg-panel-topline{display:flex;align-items:center;justify-content:space-between;gap:10px}.sg-badge{font-size:9px;letter-spacing:2px;padding:6px 9px;border:1px solid #b9f6ca30;border-radius:5px;color:#b9f6ca;background:#b9f6ca08}.sg-panel h2{margin:20px 0 10px;font-size:30px;font-weight:600;letter-spacing:-.6px;line-height:1.25}.sg-panel-desc{font-size:12px;color:#8c9baa;line-height:1.9;margin:0}.sg-code-box{display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid #7a91a52e;border-radius:11px;background:#080e19a8;margin:22px 0;padding:15px 17px}.sg-code-label{font-size:9px;color:#7f90a1;letter-spacing:2px}.sg-code{font:500 26px ui-monospace,monospace;color:#d4b5ff;letter-spacing:6px;margin-top:6px}.sg-copy{border:0;background:#d4b5ff0e;color:#b9a4e8;width:37px;height:37px;border-radius:8px;display:grid;place-items:center}.sg-copy:hover{background:#d4b5ff22}.sg-roster-title{display:flex;justify-content:space-between;font-size:10px;color:#9ca9b8;margin:0 0 10px;letter-spacing:1px}.sg-roster{display:flex;flex-direction:column;gap:7px}.sg-roster-row{display:flex;align-items:center;gap:11px;padding:10px 11px;background:#d8e6f305;border:1px solid #a4b8cc10;border-radius:9px;font-size:12px}.sg-mini-planet{width:23px;height:23px;border-radius:50%;background:radial-gradient(circle at 30% 28%,#ffffffa8,var(--planet) 27%,#152237 95%);box-shadow:0 0 12px color-mix(in srgb,var(--planet) 18%,transparent);flex-shrink:0}.sg-roster-name{flex:1;color:#cbd6e3;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.sg-small-tag{font-size:8px;color:#7e8c9e;border:1px solid #7e8c9e35;border-radius:3px;padding:2px 4px;letter-spacing:1px;margin-left:6px}.sg-ready-status{font-size:9px;color:#7e8c9e;white-space:nowrap}.sg-ready-status.ready{color:#b9f6ca}.sg-panel-buttons{display:flex;gap:9px;margin-top:22px}.sg-primary,.sg-secondary{border-radius:9px;min-height:44px;padding:12px 17px;font-size:12px;letter-spacing:1px;border:1px solid transparent;flex:1}.sg-primary{background:#b9f6ca;color:#10221b;font-weight:700;box-shadow:0 0 28px #b9f6ca0b}.sg-primary:hover{background:#d2ffdf}.sg-secondary{background:#c5d4e806;border-color:#afc3d72b;color:#b0bece}.sg-secondary:hover{background:#c5d4e810;border-color:#afc3d75b}.sg-panel-note{text-align:center;font-size:10px;line-height:1.8;color:#6f8092;margin:13px 0 0}.sg-progress{width:30px;height:30px;border:2px solid #b9f6ca20;border-top-color:#b9f6ca;border-radius:50%;animation:sg-spin 1s linear infinite;margin-bottom:24px}@keyframes sg-spin{to{transform:rotate(360deg)}}.sg-status{position:absolute;top:87px;left:50%;transform:translateX(-50%);padding:7px 13px;border:1px solid #e2c18f3b;background:#171c26d9;color:#e4c698;font-size:10px;border-radius:6px;white-space:nowrap}.sg-status[hidden]{display:none}.sg-toast{position:absolute;left:50%;top:110px;transform:translateX(-50%);color:#c9f7dc;background:#101d1dec;border:1px solid #b9f6ca35;border-radius:8px;font-size:12px;padding:11px 19px;transition:opacity .2s;pointer-events:none;opacity:0}.sg-toast.show{opacity:1}.sg-result-place{font:500 70px ui-monospace,monospace;color:#d4b5ff;letter-spacing:-5px;margin:15px 0 6px}.sg-result-grid{display:flex;gap:20px;margin:20px 0;padding:17px 0;border-top:1px solid #a4b8cc20;border-bottom:1px solid #a4b8cc20}.sg-result-grid>div{flex:1}.sg-result-number{font:500 23px ui-monospace,monospace;color:#e6edf8;margin-bottom:6px}.sg-result-label{font-size:9px;color:#7f90a1;letter-spacing:1px}.sg-touch{display:none;position:absolute;inset:0;pointer-events:none}.sg-joystick{position:absolute;bottom:38px;left:27px;width:108px;height:108px;border:1px solid #b6cde42b;background:#b6cde407;border-radius:50%;pointer-events:auto;touch-action:none}.sg-joystick:before{content:'';position:absolute;inset:26px;border:1px dashed #b6cde424;border-radius:50%}.sg-joystick-knob{position:absolute;left:34px;top:34px;width:38px;height:38px;border:1px solid #b6cde46b;background:#b6cde415;border-radius:50%;box-shadow:0 0 22px #b6cde40b;pointer-events:none}.sg-mobile-hint{display:none}.sg-respawn{position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;color:#c7b7ed;font-size:12px;letter-spacing:2px}.sg-respawn strong{display:block;font:500 48px ui-monospace,monospace;margin-bottom:9px}.sg-respawn[hidden]{display:none}
      @media(max-width:700px){#gameOverlay .sg-top{top:18px;left:18px;right:18px}.sg-brand{gap:9px}.sg-symbol{width:30px;height:30px;font-size:21px}.sg-title{font-size:12px;letter-spacing:1px}.sg-subtitle{font-size:7px;letter-spacing:1.2px}.sg-round{top:54px;padding:8px 12px;gap:10px}.sg-round-label{font-size:8px}.sg-timer{font-size:17px}.sg-icon-btn{width:32px;height:32px;border-radius:8px}.sg-icon-btn svg{width:16px;height:16px}.sg-actions{gap:6px}.sg-rank{left:18px;top:119px;width:145px;padding:12px}.sg-rank-row{font-size:9px;gap:5px;margin-top:11px;grid-template-columns:11px 6px 1fr auto}.sg-rank-num,.sg-rank-score{font-size:9px}.sg-eyebrow{font-size:8px;letter-spacing:1.2px}.sg-rank-count{font-size:8px}.sg-rank-title{padding-bottom:9px}.sg-stat{right:18px;top:119px;width:112px;padding:12px}.sg-score{font-size:28px;margin-top:7px}.sg-score-label{font-size:8px}.sg-bottom{left:18px;right:24px;bottom:35px}.sg-controls{display:none}.sg-energy{width:105px;margin-left:auto}.sg-blast-button{border-radius:50%;width:84px;height:84px;flex-direction:column;padding:13px;gap:6px;font-size:10px;margin:13px auto 0;background:#bda1ff18;border-color:#ccb5ff73}.sg-blast-button svg{width:23px;height:23px}.sg-blast-button kbd{display:none}.sg-energy-caption{font-size:8px;letter-spacing:0}.sg-touch{display:block}.sg-room-code{bottom:13px;font-size:8px;letter-spacing:1px}.sg-panel-backdrop{padding:98px 18px 24px}.sg-panel{padding:24px;max-width:410px;border-radius:17px;max-height:calc(100dvh - 122px);overflow:auto}.sg-panel h2{font-size:26px;margin-top:17px}.sg-panel-desc{font-size:11px}.sg-code-box{margin:17px 0;padding:12px 14px}.sg-code{font-size:23px}.sg-roster-row{font-size:11px;padding:8px}.sg-panel-buttons{margin-top:18px}.sg-primary,.sg-secondary{padding:10px 9px;font-size:11px}.sg-status{top:103px;font-size:8px;padding:5px 9px}.sg-toast{top:102px;font-size:10px}.sg-result-place{font-size:50px}.sg-result-grid{margin:14px 0;padding:13px 0}.sg-result-number{font-size:20px}}
      @media(max-height:580px) and (min-width:701px){.sg-panel-backdrop{padding:65px 24px 20px}.sg-panel{max-height:calc(100vh - 85px);overflow:auto;padding:24px}.sg-panel h2{margin-top:12px}.sg-code-box{margin:13px 0}.sg-rank,.sg-stat{top:90px}.sg-bottom{bottom:18px}.sg-panel-buttons{margin-top:14px}.sg-roster-row{padding:7px 10px}}
      .sg-mass-label{font-size:9px;color:#b9f6ca;margin-top:10px;letter-spacing:1px}.sg-growth{margin-top:10px;height:3px;background:#283343;border-radius:5px;overflow:hidden}.sg-growth>i{display:block;background:#b9f6ca;height:100%;transition:width .2s}.sg-growth-caption{font-size:8px;color:#718295;margin-top:6px;line-height:1.6}.sg-upgrades{position:absolute;left:50%;bottom:113px;transform:translateX(-50%);width:min(670px,calc(100% - 60px));pointer-events:auto;padding:17px;border:1px solid #d4b5ff55;border-radius:15px;background:#101826f2;box-shadow:0 12px 60px #0008,0 0 70px #b79bff0b;backdrop-filter:blur(20px)}.sg-upgrades[hidden]{display:none}.sg-upgrade-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px}.sg-upgrade-title{font-size:13px;color:#e4d8ff;font-weight:650;letter-spacing:1px}.sg-upgrade-hint{font-size:9px;color:#8293a5}.sg-upgrade-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.sg-upgrade-card{position:relative;text-align:left;border:1px solid #a5b5cc26;background:linear-gradient(150deg,#27263d99,#131d2c80);color:#e6ddf8;border-radius:10px;padding:15px 13px;min-height:115px;transition:transform .15s,border-color .15s}.sg-upgrade-card:hover,.sg-upgrade-card:focus-visible{transform:translateY(-4px);border-color:#d4b5ff90;background:linear-gradient(150deg,#423257aa,#1b2835aa)}.sg-upgrade-card:nth-child(2){background:linear-gradient(150deg,#233c3890,#131d2c80)}.sg-upgrade-card:nth-child(3){background:linear-gradient(150deg,#34332b90,#131d2c80)}.sg-upgrade-icon{font-size:22px;line-height:1;display:block;margin-bottom:12px;color:#d4b5ff}.sg-upgrade-card:nth-child(2) .sg-upgrade-icon{color:#b9f6ca}.sg-upgrade-card:nth-child(3) .sg-upgrade-icon{color:#e4cd9c}.sg-upgrade-name{font-size:12px;font-weight:600;display:block;margin-bottom:7px}.sg-upgrade-desc{font-size:10px;color:#98a8b9;line-height:1.7;display:block}.sg-upgrade-key{position:absolute;right:10px;top:11px;color:#7c7a93;font:9px ui-monospace,monospace;border:1px solid #7c7a9344;padding:2px 5px;border-radius:3px}.sg-upgrade-active{position:absolute;right:34px;top:300px;width:159px;color:#8191a5;font-size:9px;line-height:1.9;pointer-events:none}.sg-upgrade-active b{color:#c8b6ef;font-weight:400}.sg-touch-utility{display:none;position:absolute;right:128px;bottom:40px;gap:10px;pointer-events:auto;flex-direction:column}.sg-touch-utility button{width:46px;height:46px;border:1px solid #b8d2ed44;background:#182435dc;color:#c1d2e5;border-radius:50%;font-size:10px}.sg-touch-utility button:first-child{border-color:#b9f6ca66;color:#b9f6ca}
      @media(max-width:700px){.sg-mass-label{font-size:8px;margin-top:7px}.sg-growth-caption{font-size:7px}.sg-upgrades{bottom:160px;width:calc(100% - 28px);padding:13px;border-radius:12px}.sg-upgrade-head{margin-bottom:10px;flex-wrap:wrap;gap:5px}.sg-upgrade-title{font-size:11px}.sg-upgrade-hint{font-size:8px}.sg-upgrade-cards{gap:7px}.sg-upgrade-card{padding:12px 9px;min-height:133px}.sg-upgrade-icon{font-size:21px;margin-bottom:12px}.sg-upgrade-name{font-size:10px}.sg-upgrade-desc{font-size:8px;line-height:1.6}.sg-upgrade-key{font-size:8px;padding:1px 4px;right:7px;top:8px}.sg-upgrade-active{top:305px;right:18px;width:112px;font-size:8px}.sg-touch-utility{display:flex}.sg-controls{display:none}}
      .sg-diagnostics{position:absolute;right:35px;top:80px;color:#8eaba0;font:9px ui-monospace,monospace;letter-spacing:.5px;pointer-events:none}.sg-map-hint{font-size:8px;color:#7f91a4}.sg-rank,.sg-stat,.sg-panel,.sg-upgrades{backdrop-filter:none}
      @media(max-width:700px){.sg-diagnostics{right:18px;top:59px;font-size:8px}.sg-upgrade-active{max-height:110px;overflow:hidden}}
      @media(prefers-reduced-motion:reduce){#gameOverlay *{transition:none!important}}
    `;
    document.head.appendChild(style);
    style.textContent += `.sg-wave-actions{display:flex;gap:7px}.sg-wave-actions .sg-blast-button{min-width:0;font-size:10px;letter-spacing:0;padding:11px 7px;gap:5px}.sg-rear-blast svg{transform:rotate(180deg)}.sg-rear-blast:disabled{opacity:.4}@media(max-width:700px){.sg-wave-actions{display:block}.sg-wave-actions .sg-blast-button{font-size:10px;padding:13px;gap:6px}.sg-wave-actions .sg-rear-blast{position:fixed;right:128px;bottom:96px;width:46px;height:46px;padding:5px;margin:0;gap:3px;font-size:8px}#sgRearBlast{padding:5px;gap:3px;font-size:9px;line-height:1.1}#sgRearBlast svg{width:14px;height:14px;flex-shrink:0}#sgRearBlast span{white-space:nowrap;font-size:9px;line-height:1.1}}.sg-wave-feedback{position:absolute;top:153px;left:50%;transform:translateX(-50%);max-width:calc(100% - 40px);padding:10px 17px;border:1px solid #d4b5ff77;border-radius:9px;background:#151c2fed;color:#eadfff;font-size:12px;white-space:nowrap;pointer-events:none}.sg-wave-feedback[hidden]{display:none}.sg-wave-feedback[data-tone=victim]{border-color:#ffb69e88;color:#ffd2bd}@media(max-width:700px){.sg-wave-feedback{top:141px;font-size:10px;padding:8px 12px}}`;
    style.textContent += `.sg-dyson-status{margin-bottom:12px;padding:10px 11px;border:1px solid #b9f6ca44;border-radius:8px;background:#122626e8;color:#c7ffe1;font-size:10px;line-height:1.65;letter-spacing:.2px}.sg-dyson-status[hidden]{display:none}.sg-dyson-status[data-phase=ready]{border-color:#ddc1ff99;color:#eddbff;background:#241e35ed}.sg-dyson-status[data-phase=cooldown]{color:#94a7b7;border-color:#9db6cb22;background:#101923dc}.sg-dyson-status strong{display:block;font-weight:600}.sg-dyson-status small{color:#91bba8;font-size:9px}#sgTouchSplit[data-combo=ready]{background:#352643;border-color:#dec1ff;color:#f0dcff;box-shadow:0 0 18px #d4b5ff22}@media(max-width:700px){.sg-dyson-status{position:fixed;left:50%;bottom:186px;transform:translateX(-50%);width:max-content;max-width:calc(100% - 32px);padding:7px 12px;font-size:10px;text-align:center}.sg-dyson-status small{font-size:9px}#sgTouchSplit{font-size:9px;padding:3px;line-height:1.2}}`;
    style.textContent += `.sg-combo-prompt{--combo:#8feaff;position:absolute;left:50%;bottom:118px;transform:translateX(-50%);display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;min-width:290px;max-width:calc(100% - 40px);padding:13px 17px 17px;border:1px solid var(--combo);border-radius:12px;background:#0c1c2bf2;box-shadow:0 0 0 3px #8feaff0d;color:var(--combo);pointer-events:none}.sg-combo-prompt[hidden]{display:none}.sg-combo-prompt[data-kind=dyson]{--combo:#e4bdff;background:#241a32f2}.sg-combo-key{display:grid;place-items:center;min-width:47px;height:35px;padding:0 9px;border:1px solid var(--combo);border-bottom-width:3px;border-radius:6px;background:#ffffff0c;font-size:13px;font-weight:700}.sg-combo-prompt strong{font-size:17px;letter-spacing:2px;display:block}.sg-combo-prompt small{display:block;font-size:9px;color:#a6b8ca;margin-top:4px;letter-spacing:.3px}.sg-combo-time{font:600 20px ui-monospace,monospace}.sg-combo-track{position:absolute;left:17px;right:17px;bottom:7px;height:2px;background:#7ca2ba26}.sg-combo-track i{display:block;height:100%;background:var(--combo)}#sgTouchSplit[data-combo=blink]{color:#c2f9ff;background:#174353;border-color:#8feaff;box-shadow:0 0 0 3px #8feaff20}#gameOverlay[data-combo-raised=true] .sg-combo-prompt{bottom:300px}@media(max-width:700px){.sg-combo-prompt{bottom:193px;min-width:270px;gap:10px;padding:10px 13px 15px}.sg-combo-prompt strong{font-size:15px}.sg-combo-key{min-width:40px;height:33px;font-size:11px}.sg-combo-time{font-size:17px}#gameOverlay[data-combo-raised=true] .sg-combo-prompt{bottom:375px}}@media(max-height:500px){#gameOverlay .sg-combo-prompt{bottom:150px;min-width:240px;padding-top:8px;padding-bottom:12px}#gameOverlay[data-combo-raised=true] .sg-combo-prompt{bottom:auto;top:82px}}`;
    root.innerHTML = `
      <canvas id="gameCanvas" aria-label="星球大爆炸实时竞技场"></canvas>
      <div class="sg-top"><div class="sg-brand"><div class="sg-symbol">✳</div><div><div class="sg-title">星球大爆炸</div><div class="sg-subtitle">PLANET BOOM / LIVE ARENA</div></div></div><div class="sg-round"><i class="sg-live-dot"></i><span class="sg-round-label" id="sgRoundLabel">准备起航</span><span class="sg-timer" id="sgTimer">03:00</span></div><div class="sg-actions"><button class="sg-icon-btn" id="sgFullscreen" aria-label="进入全屏" aria-pressed="false" title="进入全屏">${icons.fullscreen}</button><button class="sg-icon-btn" id="sgSound" aria-label="开启游戏音效" aria-pressed="false" title="游戏音效">${icons.audio}</button><button class="sg-icon-btn" id="sgExit" aria-label="返回星际大厅" title="返回大厅">${icons.exit}</button></div></div>
      <div class="sg-rank"><div class="sg-rank-title"><span class="sg-eyebrow">实时排行榜</span><span class="sg-rank-count" id="sgPlayerCount">00 PLAYERS</span></div><div id="sgRanking"></div></div>
      <div class="sg-stat"><div class="sg-eyebrow">星球总质量</div><div class="sg-score" id="sgScore">036</div><div class="sg-score-label">引力吸收 · 碰撞碎裂</div><div class="sg-mass-label" id="sgLevel">LV. 1 / 初生星球</div><div class="sg-growth"><i id="sgGrowthFill"></i></div><div class="sg-growth-caption" id="sgGrowthText">成长后解锁随机强化</div></div>
      <div class="sg-bottom"><div class="sg-controls"><div class="sg-control"><span class="sg-key">方向键 / WASD</span><span>推进 · 松键滑行</span></div><div class="sg-control"><span class="sg-key">SPACE</span><span id="sgSplitLabel">分裂 / 命中连招</span></div></div><div class="sg-energy"><div class="sg-dyson-status" id="sgDysonStatus" role="status" hidden></div><div class="sg-energy-caption"><span>引力能量</span><span id="sgEnergyText">60 / 100</span></div><div class="sg-energy-track"><div class="sg-energy-fill" id="sgEnergyFill"></div></div><div class="sg-wave-actions"><button id="sgBlast" class="sg-blast-button">${icons.bolt}<span>前向波</span><kbd>E</kbd></button><button id="sgRearBlast" class="sg-blast-button sg-rear-blast" aria-label="向后发射引力波，R">${icons.bolt}<span>后向波</span><kbd>R</kbd></button></div></div></div>
      <div class="sg-diagnostics" id="sgDiagnostics">— FPS / — ms</div><div class="sg-room-code" id="sgRoomFooter"></div><div class="sg-status" id="sgStatus" hidden></div><div class="sg-toast" id="sgToast" role="status"></div><div class="sg-respawn" id="sgRespawn" hidden></div><div class="sg-wave-feedback" id="sgWaveFeedback" role="status" aria-live="polite" hidden></div>
      <div class="sg-combo-prompt" id="sgComboPrompt" role="status" hidden><span class="sg-combo-key" id="sgComboKey">空格</span><div><strong id="sgComboAction">瞬移</strong><small id="sgComboDescription">瞬移后消耗冲击波</small></div><b class="sg-combo-time" id="sgComboTime"></b><span class="sg-combo-track"><i id="sgComboFill"></i></span></div>
      <div class="sg-touch" id="sgTouch"><div class="sg-joystick" id="sgJoystick" aria-label="拖动摇杆移动"><div class="sg-joystick-knob" id="sgJoystickKnob"></div></div><div class="sg-touch-utility"><button id="sgTouchSplit">分裂</button></div></div>
      <div class="sg-upgrade-active" id="sgUpgradeActive"></div><section class="sg-upgrades" id="sgUpgrades" hidden aria-label="选择星球强化"><div class="sg-upgrade-head"><span class="sg-upgrade-title" id="sgUpgradeTitle">星球进化 · 选择强化</span><span class="sg-upgrade-hint">选择强化 · 对局继续进行 · 按 1 / 2 / 3</span></div><div class="sg-upgrade-cards" id="sgUpgradeCards"></div></section>
      <div class="sg-panel-backdrop" id="sgPanelBackdrop"><section class="sg-panel" id="sgPanel" aria-live="polite"></section></div>
    `;
    canvas = $('gameCanvas');
    canvas.tabIndex = 0;
    ctx = canvas.getContext('2d', { alpha: false });
    $('sgExit').addEventListener('click', () => disconnect());
    $('sgFullscreen').addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => { syncFullscreen(); resize(); });
    $('sgSound').addEventListener('click', () => {
      sound = window.StarAudio ? !window.StarAudio.enabled : !sound;
      window.StarAudio?.setEnabled?.(sound);
      $('sgSound').setAttribute('aria-pressed', String(sound));
      $('sgSound').setAttribute('aria-label', sound ? '关闭游戏音效' : '开启游戏音效');
      if (sound) { if (window.StarAudio) window.StarAudio.play('click'); else playTone(440, .08, .025); }
    });
    $('sgBlast').addEventListener('pointerdown', (e) => { e.preventDefault(); blast(); });
    $('sgRearBlast').addEventListener('pointerdown', (e) => { e.preventDefault(); blast(true); });
    $('sgTouchSplit').addEventListener('pointerdown', (e) => { e.preventDefault(); split(); });
    const joystick = $('sgJoystick');
    function moveJoystick(e) {
      const rect = joystick.getBoundingClientRect();
      let x = e.clientX - rect.left - rect.width / 2, y = e.clientY - rect.top - rect.height / 2;
      const length = Math.hypot(x, y), max = rect.width * .32;
      if (length > max) { x *= max / length; y *= max / length; }
      touchVector = { x: x / max, y: y / max };
      $('sgJoystickKnob').style.transform = `translate(${x}px,${y}px)`;
    }
    joystick.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      e.preventDefault(); joystickPointer = e.pointerId; joystick.setPointerCapture(e.pointerId); moveJoystick(e); sendInput();
    });
    joystick.addEventListener('pointermove', (e) => { if (joystickPointer === e.pointerId) moveJoystick(e); });
    const releaseJoystick = () => { resetJoystick(); sendInput(); };
    joystick.addEventListener('pointerup', releaseJoystick);
    joystick.addEventListener('pointercancel', releaseJoystick);
    joystick.addEventListener('lostpointercapture', releaseJoystick);
    const releaseHeldPointer = (e) => {
      let released = false;
      if (joystickPointer === e.pointerId) { resetJoystick(); released = true; }
      if (released) sendInput();
    };
    addEventListener('pointerup', releaseHeldPointer);
    addEventListener('pointercancel', releaseHeldPointer);
    addEventListener('resize', resize);
    addEventListener('orientationchange', resize);
    window.visualViewport?.addEventListener('resize', resize);
    addEventListener('keydown', (e) => {
      if (!active || isEditable(e.target)) return;
      const code = keyboardCode(e);
      if (!gameKeys.has(code)) return;
      if (code !== 'Escape') e.preventDefault();
      if (code === 'Space' && !e.repeat) split();
      if (code === 'KeyE' && !e.repeat) blast();
      if (code === 'KeyR' && !e.repeat) blast(true);
      if (/^Digit[123]$/.test(code) && !e.repeat) chooseUpgrade(Number(code.slice(-1)) - 1);
      if (code === 'Escape') { if (room?.status === 'playing') toast('点击右上角退出图标可返回大厅'); }
      keys.add(code);
      if (!e.repeat) sendInput();
    });
    addEventListener('keyup', (e) => { const code = keyboardCode(e); if (keys.delete(code) && active) sendInput(); });
    addEventListener('blur', () => resetHeldInputs());
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetHeldInputs(); resetRenderQuality(); });
    resize();
  }

  function resetJoystick() {
    joystickPointer = null; touchVector = { x: 0, y: 0 };
    if ($('sgJoystickKnob')) $('sgJoystickKnob').style.transform = '';
  }
  function resetHeldInputs(sendStop = true) {
    keys.clear();
    resetJoystick();
    inputPulse = false; rearPulse = false; splitPulse = false;
    if (sendStop) sendInput();
  }

  function isEditable(target) { return Boolean(target?.isContentEditable || target?.closest?.('input, textarea, select')); }
  function keyboardCode(event) {
    if (gameKeys.has(event.code)) return event.code;
    const key = event.key || '';
    if (/^[wasder]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[123]$/.test(key)) return `Digit${key}`;
    if (key === ' ' || key === 'Spacebar') return 'Space';
    if (['Up', 'Down', 'Left', 'Right'].includes(key)) return `Arrow${key}`;
    return key;
  }
  function hasMovementKey() { for (const key of movementKeys) if (keys.has(key)) return true; return false; }
  function focusGame() {
    if (!active || root?.hidden) return;
    try { canvas?.focus({ preventScroll: true }); } catch (_) { canvas?.focus(); }
  }

  function syncFullscreen() {
    const full = document.fullscreenElement === root, button = $('sgFullscreen');
    if (!button) return;
    button.setAttribute('aria-pressed', String(full));
    button.setAttribute('aria-label', full ? '退出全屏' : '进入全屏'); button.title = full ? '退出全屏' : '进入全屏';
  }
  function requestFullscreen() {
    if (!root?.requestFullscreen || document.fullscreenElement) return;
    try { root.requestFullscreen({ navigationUI: 'hide' })?.catch?.(() => {}); } catch (_) { /* The full viewport remains usable when native fullscreen is unavailable. */ }
  }
  function toggleFullscreen() {
    if (document.fullscreenElement === root) { try { document.exitFullscreen?.()?.catch?.(() => {}); } catch (_) {} }
    else requestFullscreen();
  }

  function resize() {
    if (!canvas) return;
    if (width !== innerWidth || height !== innerHeight) backgroundCanvas = null;
    width = innerWidth; height = innerHeight;
    resetRenderQuality(); applyCanvasResolution();
  }
  function applyCanvasResolution() {
    if (!canvas) return;
    const maximum = Math.min(devicePixelRatio || 1, width < 700 ? 1 : 1.5, Math.sqrt(canvasPixelBudget / Math.max(1, width * height)));
    dpr = maximum * renderScale;
    const backingWidth = Math.max(1, Math.floor(width * dpr)), backingHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth; canvas.height = backingHeight; backgroundCanvas = null;
    }
  }
  function resetRenderQuality(resetScale = false) {
    const now = performance.now();
    if (resetScale) renderScale = 1;
    renderQuality = { windowAt: now, frames: 0, total: 0, slow: 0, warmUntil: now + 2000, lastChange: now, headroomSince: null };
  }
  function updateRenderQuality(at, interval) {
    const q = renderQuality;
    if (room?.status !== 'playing' || reconnecting || document.hidden || interval <= 0 || interval > 250 || at < q.warmUntil) {
      q.windowAt = at; q.frames = q.total = q.slow = 0; q.headroomSince = null;
      return;
    }
    q.frames++; q.total += interval; if (interval > 24) q.slow++;
    if (at - q.windowAt < 1200 || q.frames < 8) return;
    const average = q.total / q.frames, slowFraction = q.slow / q.frames;
    if (average > 24 && slowFraction > .25 && at - q.lastChange >= 1500 && renderScale > .65) {
      renderScale = Math.max(.65, Math.round((renderScale - .15) * 100) / 100);
      applyCanvasResolution(); q.lastChange = at; q.warmUntil = at + 1200; q.headroomSince = null;
    } else if (average < 18 && slowFraction < .05) {
      q.headroomSince ??= q.windowAt;
      if (renderScale < 1 && at - q.headroomSince >= 12000 && at - q.lastChange >= 12000) {
        renderScale = Math.min(1, Math.round((renderScale + .05) * 100) / 100);
        applyCanvasResolution(); q.lastChange = at; q.warmUntil = at + 1500; q.headroomSince = at;
      }
    } else q.headroomSince = null;
    q.windowAt = at; q.frames = q.total = q.slow = 0;
  }

  function showPanel(html) { $('sgPanelBackdrop').hidden = false; $('sgPanel').innerHTML = html; }
  function loadingPanel(message = '正在连接星际网络') {
    showPanel(`<div class="sg-progress"></div><div class="sg-eyebrow">ESTABLISHING CONNECTION</div><h2>${esc(message)}</h2><p class="sg-panel-desc">正在为你的星球寻找一片宇宙。<br>连接成功后即可进入房间。</p><div class="sg-panel-buttons"><button class="sg-secondary" id="sgCancelConnect">返回大厅</button></div>`);
    $('sgCancelConnect').onclick = () => disconnect();
  }

  async function connect(mode, options = {}) {
    install();
    if (active) closeSession(false);
    currentOptions = { ...options, mode };
    active = true; joined = false; reconnecting = false; intentionalClose = false; retries = 0;
    resetRenderQuality(true); applyCanvasResolution();
    resetHeldInputs(false);
    resetWaveFeedback(); resetWaveClashes(); resetMeteors(); resetBlinkConsumption();
    renderTimeline = null;
    predictionPaused = false;
    room = null; myId = null; token = null; previousStatus = ''; previousRound = -1;
    lastUpgradeKey = ''; lastShatteredAt = 0; drawnPlayers.clear(); drawnDust.clear(); particles.length = 0; seenBlasts.clear();
    cellTracks.clear(); dustTracks.clear(); materializedDust.clear(); seenImpacts.clear(); waveVisuals.clear(); remotePhysics.clear(); contactEpisodes.clear(); predictedContactEffects.clear(); predictedCells.clear(); inputHistory.length = 0; domCache.clear();
    inputSeq = 0; lastInputAck = 0; lastMovementSeq = 0; rtt = null; fps = 0; frameCount = 0; fpsStarted = 0;
    camera = { x: NaN, y: NaN, scale: width < 700 ? .8 : .95 };
    inputPulse = false; rearPulse = false; splitPulse = false;
    $('sgUpgrades').hidden = true;
    root.hidden = false;
    focusGame();
    bodyOverflowBefore = document.body.style.overflow; document.body.style.overflow = 'hidden';
    requestFullscreen();
    sound = window.StarAudio ? window.StarAudio.enabled : sound;
    $('sgSound').setAttribute('aria-pressed', String(sound));
    $('sgSound').setAttribute('aria-label', sound ? '关闭游戏音效' : '开启游戏音效');
    document.body.dataset.starGameActive = 'true';
    loadingPanel();
    updateHud(true);
    cancelAnimationFrame(raf); lastFrame = 0; raf = requestAnimationFrame(render);
    clearInterval(inputTimer); inputTimer = setInterval(sendInput, 50);
    clearInterval(pingTimer); pingTimer = setInterval(() => { if (joined) send({ type: 'ping', time: Date.now() }); }, 2000);
    return new Promise((resolve, reject) => {
      pendingResolve = resolve; pendingReject = reject;
      connectionTimer = setTimeout(() => failConnection('连接超时，请检查网络后重试。'), 12000);
      openSocket(false);
    });
  }

  function openSocket(reconnect) {
    const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws${reconnect && token ? `?token=${encodeURIComponent(token)}` : ''}`;
    try { socket = new WebSocket(url); } catch (_) { failConnection('无法连接游戏服务器，请通过网站地址打开游戏。'); return; }
    const thisSocket = socket;
    if (reconnect) { clearTimeout(connectionTimer); connectionTimer = setTimeout(() => { if (reconnecting && socket === thisSocket) thisSocket.close(); }, 4500); }
    socket.addEventListener('open', () => {
      if (socket !== thisSocket || !active) return;
      if (!reconnect) {
        const base = { name: currentOptions.name || '流浪星球', skin: currentOptions.skin ?? 0 };
        if (currentOptions.mode === 'join') send({ type: 'join', ...base, code: String(currentOptions.code || '').trim().toUpperCase() });
        else if (currentOptions.mode === 'quick') send({ type: 'quick', ...base });
        else send({ type: 'create', ...base, mode: currentOptions.mode === 'practice' ? 'practice' : 'online' });
      }
    });
    socket.addEventListener('message', (event) => {
      if (socket !== thisSocket || !active) return;
      let data; try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.type === 'welcome') { myId = data.id; if (data.reconnectToken) token = data.reconnectToken; }
      else if (data.type === 'joined') {
        myId = data.id; if (data.reconnectToken) token = data.reconnectToken;
        joined = true; reconnecting = false; retries = 0;
        clearTimeout(connectionTimer); $('sgStatus').hidden = true;
        send({ type: 'ping', time: Date.now() });
        if (pendingResolve) { const resolve = pendingResolve; pendingResolve = null; pendingReject = null; resolve({ id: myId, code: data.code }); }
      } else if (data.type === 'state' && data.room) receiveRoom(data.room);
      else if (data.type === 'pong' && Number.isFinite(data.time)) { const sample = Date.now() - data.time; if (sample >= 0 && sample < 15000) rtt = rtt === null ? sample : rtt * .7 + sample * .3; }
      else if (data.type === 'error') {
        if (!joined) failConnection(data.message || '进入房间失败，请重试。');
        else if (reconnecting) showConnectionError(data.message || '重连失败，房间可能已关闭。');
        else toast(data.message || '操作未完成，请重试');
      }
    });
    socket.addEventListener('close', () => {
      if (socket !== thisSocket || !active || intentionalClose) return;
      clearTimeout(connectionTimer);
      if (!joined) { failConnection('服务器连接已断开，请稍后重试。'); return; }
      attemptReconnect();
    });
    socket.addEventListener('error', () => { /* close handles browser socket failures. */ });
  }

  function attemptReconnect() {
    if (!active) return;
    if (!token || retries >= 4) { showConnectionError('与星际网络的连接已中断。请返回大厅重新出发。'); return; }
    reconnecting = true; retries += 1; resetHeldInputs(false); resetWaveFeedback(); resetWaveClashes(); resetMeteors(); resetBlinkConsumption();
    predictedCells.clear(); remotePhysics.clear(); contactEpisodes.clear(); predictedContactEffects.clear(); inputHistory.length = 0; waveVisuals.clear(); renderTimeline = null;
    $('sgStatus').hidden = false; $('sgStatus').textContent = `网络暂时中断，正在重连… ${retries}/4`;
    clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (active) openSocket(true); }, retries * 750);
  }

  function showConnectionError(message) {
    reconnecting = false; clearTimeout(retryTimer); resetWaveFeedback(); resetWaveClashes(); resetMeteors(); resetBlinkConsumption();
    waveVisuals.clear();
    remotePhysics.clear(); contactEpisodes.clear(); predictedContactEffects.clear(); renderTimeline = null;
    resetHeldInputs(false);
    intentionalClose = true; socket?.close();
    showPanel(`<div class="sg-eyebrow">CONNECTION LOST</div><h2>信号暂时消失了</h2><p class="sg-panel-desc">${esc(message)}</p><div class="sg-panel-buttons"><button class="sg-primary" id="sgErrorExit">返回大厅</button></div>`);
    $('sgErrorExit').onclick = () => disconnect();
    $('sgStatus').hidden = true;
  }

  function failConnection(message) {
    clearTimeout(connectionTimer);
    const reject = pendingReject; pendingResolve = null; pendingReject = null;
    closeSession(false);
    if (reject) reject(new Error(message));
    else dispatchLobby(message);
  }

  function send(data) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
  function closeSession(notify = true) {
    intentionalClose = true; active = false; resetWaveFeedback(); resetWaveClashes(); resetMeteors(); resetBlinkConsumption();
    waveVisuals.clear();
    remotePhysics.clear(); contactEpisodes.clear(); predictedContactEffects.clear(); remoteContactPositions.clear(); renderTimeline = null;
    clearTimeout(connectionTimer); clearTimeout(retryTimer); clearInterval(inputTimer); clearInterval(pingTimer); cancelAnimationFrame(raf);
    send({ type: 'leave' }); socket?.close(); socket = null;
    resetHeldInputs(false);
    if (root) root.hidden = true;
    if (bodyOverflowBefore !== null) { document.body.style.overflow = bodyOverflowBefore; bodyOverflowBefore = null; }
    if (document.fullscreenElement === root) { try { document.exitFullscreen?.()?.catch?.(() => {}); } catch (_) {} }
    delete document.body.dataset.starGameActive;
    if (pendingReject) { pendingReject(new Error('已取消连接')); pendingReject = null; pendingResolve = null; }
    if (notify) dispatchLobby();
  }
  function disconnect() { closeSession(true); }
  function dispatchLobby(reason) {
    dispatchEvent(new CustomEvent('stargame:lobby', { detail: { reason } }));
    if (typeof window.StarGame.onLobby === 'function') window.StarGame.onLobby({ reason });
  }

  function receiveRoom(next) {
    const old = room, previousConsumption = blinkConsumptionRevision;
    if (!Array.isArray(next.players)) next.players = [];
    if (!next.dustDelta) materializedDust.clear();
    for (const id of next.dustRemoved || []) materializedDust.delete(id);
    for (const dust of next.dust || []) materializedDust.set(dust.id, dust);
    next.dust = Array.from(materializedDust.values());
    ingestSnapshot(next, performance.now());
    room = next;
    if (!Array.isArray(room.players)) room.players = [];
    room.dust ||= []; room.blasts ||= [];
    cacheMeteorTracks(room, old);
    const me = room.players.find((p) => p.id === myId);
    if (me?.shatteredAt > lastShatteredAt) { lastShatteredAt = me.shatteredAt; toast('撞击碎裂！守住核心，抢回碎片'); }
    emitContactEffects(room, old);
    receiveWaveFeedback(room, old);
    receiveMeteorFeedback(room, old);
    receiveWaveBlinkFeedback(room, old);
    receiveWaveHarvestFeedback(room, old);
    receiveWaveClashes(room, old);
    cacheWaveVisuals(room, old);
    for (const blast of room.blasts) {
      if (cancelledWaves.has(blast.id) || consumedBlinkWaves.has(blast.id)) continue;
      if (!seenBlasts.has(blast.id)) {
        seenBlasts.add(blast.id);
        if (blast.ownerId === myId && !window.StarAudio) playTone(100, .22, .04, 'sine');
      }
    }
    if (seenBlasts.size > 300) { seenBlasts.clear(); for (const blast of room.blasts) seenBlasts.add(blast.id); }
    if (room.status !== previousStatus || room.round !== previousRound) {
      if (room.status === 'playing') {
        $('sgPanelBackdrop').hidden = true;
        focusGame();
        if (previousStatus !== 'playing') { toast(room.endless ? '无尽训练开始 · 无时间限制，随时可返回大厅' : '全员就绪 · 引力吸收，碰撞碎裂，成长解锁强化！'); window.StarAudio?.play('start'); }
        $('sgBlast').disabled = false;
      }
      previousStatus = room.status; previousRound = room.round;
    }
    updateHud(room.status !== old?.status || room.round !== old?.round || previousConsumption !== blinkConsumptionRevision);
  }

  function resetBlinkConsumption() {
    consumedBlinkWaves.clear(); blinkConsumptionScope = null; blinkConsumptionRevision = 0;
  }
  function consumeBlinkWave(id, at) {
    if (!id) return;
    if (!consumedBlinkWaves.has(id)) { consumedBlinkWaves.set(id, at); blinkConsumptionRevision++; }
    waveVisuals.delete(id); seenBlasts.delete(id);
    while (consumedBlinkWaves.size > 512) consumedBlinkWaves.delete(consumedBlinkWaves.keys().next().value);
  }
  function receiveBlinkConsumption(current) {
    const scope = `${current.code}:${current.round}`;
    if (scope !== blinkConsumptionScope) { resetBlinkConsumption(); blinkConsumptionScope = scope; }
    for (const player of current.players) {
      if (player.lastWaveBlink?.waveId) consumeBlinkWave(player.lastWaveBlink.waveId, player.lastWaveBlink.at);
      // A packet can coalesce several core teleports while lastWaveBlink holds
      // only the newest event. This event ID is defined by the server contract.
      for (const cell of player.cells || []) if (typeof cell.lastWaveBlinkId === 'string' && cell.lastWaveBlinkId.startsWith('blink:')) consumeBlinkWave(cell.lastWaveBlinkId.slice(6), current.time);
    }
    for (const blast of current.blasts || []) if (blast.blinkUsed) consumeBlinkWave(blast.id, current.time);
  }

  function resetWaveFeedback() {
    combatFeedback.clear(); seenCombatEvents.clear(); seenWaveBlinks.clear(); seenWaveHarvests.clear(); blinkBaselinePending = true; clearTimeout(combatMarkerTimer);
    const prompt = $('sgComboPrompt'); if (prompt) prompt.hidden = true;
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].kind === 'wave-blink' || particles[i].kind === 'wave-harvest') particles.splice(i, 1);
    const marker = $('sgWaveFeedback'); if (marker) marker.hidden = true;
  }
  function receiveWaveBlinkFeedback(current, previous) {
    const sameRoom = previous?.code === current.code && previous?.round === current.round;
    if (!sameRoom) { seenWaveBlinks.clear(); blinkBaselinePending = true; }
    const baseline = blinkBaselinePending || previous?.status !== 'playing';
    blinkBaselinePending = false;
    const now = performance.now();
    for (const player of current.players) {
      const event = player.lastWaveBlink;
      if (!event?.id || seenWaveBlinks.has(event.id)) continue;
      seenWaveBlinks.set(event.id, event.at);
      const age = Math.max(0, peekRenderSimulationTime(now) / 1000 + simulationLead - event.at);
      if (baseline || current.status !== 'playing' || age > .6 || player.dyson?.sourceCellId === event.sourceCellId) continue;
      const ref = player.id === myId ? predictedCells.get(event.sourceCellId) : remotePhysics.get(`${player.id}:${event.sourceCellId}`);
      const radius = ref?.model?.radius || 24, position = ref?.model || event, from = ref?.blinkFrom || { x: event.fromX, y: event.fromY };
      if (age < .22 && Number.isFinite(from.x) && Number.isFinite(position.x)) particles.push({ kind: 'wave-blink',
        x: from.x, y: from.y, toX: position.x, toY: position.y, radius, color: safeColor(player.color),
        duration: .22, life: .22 - age, updatedAt: now });
      if (player.id === myId) {
        const marker = $('sgWaveFeedback');
        if (marker) {
          marker.dataset.kind = 'blink'; marker.dataset.mode = 'blink'; marker.dataset.tone = 'shooter'; marker.textContent = '波前瞬移 · 冲击波已消耗'; marker.hidden = false;
          clearTimeout(combatMarkerTimer); combatMarkerTimer = setTimeout(() => { marker.hidden = true; }, 1000);
        }
      }
    }
    while (seenWaveBlinks.size > 128) seenWaveBlinks.delete(seenWaveBlinks.keys().next().value);
    if (particles.length > 180) particles.splice(0, particles.length - 180);
  }
  function receiveWaveHarvestFeedback(current, previous) {
    const baseline = previous?.code !== current.code || previous?.round !== current.round || previous?.status !== 'playing';
    if (baseline) seenWaveHarvests.clear();
    const now = performance.now();
    for (const player of current.players) {
      const event = player.lastWaveHarvest;
      if (!event?.id || seenWaveHarvests.has(event.id)) continue;
      seenWaveHarvests.set(event.id, event.at);
      const age = Math.max(0, current.time - event.at);
      if (baseline || age > .3) continue;
      // A few short returning sparks communicate pickup without a counter,
      // an expanding ring, or animating thousands of natural dust particles.
      for (const point of (event.points || []).slice(0, 6)) {
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        particles.push({ kind: 'wave-harvest', ownerId: player.id, sourceCellId: event.sourceCellId,
          x: point.x, y: point.y, radius: 1.4, color: safeColor(player.color), duration: .24, life: .24 - age, updatedAt: now });
      }
    }
    while (seenWaveHarvests.size > 128) seenWaveHarvests.delete(seenWaveHarvests.keys().next().value);
    if (particles.length > 180) particles.splice(0, particles.length - 180);
  }
  function resetWaveClashes() {
    cancelledWaves.clear(); seenWaveClashes.clear(); clashBaselinePending = true; clashBaselineTime = null;
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].clashId) particles.splice(i, 1);
  }
  function receiveWaveClashes(current, previous) {
    const sameRoom = previous?.code === current.code && previous?.round === current.round;
    if (!sameRoom) resetWaveClashes();
    const baseline = clashBaselinePending || !sameRoom || previous?.status !== 'playing';
    if (clashBaselinePending) { clashBaselineTime = current.time; clashBaselinePending = false; }
    const now = performance.now();
    for (const clash of current.waveClashes || []) {
      if (!clash?.id) continue;
      // Cancellation has no presentation delay: even an interpolated remote
      // front and its cached tail cease as soon as authority cancels them.
      for (const id of clash.waveIds || []) { cancelledWaves.set(id, clash.at); waveVisuals.delete(id); }
      if (seenWaveClashes.has(clash.id)) continue;
      seenWaveClashes.set(clash.id, clash.at);
      const age = current.time - clash.at;
      if (baseline || current.status !== 'playing' || clash.at < clashBaselineTime || !Number.isFinite(age) || age < -.02 || age > .8 || !Number.isFinite(clash.x) || !Number.isFinite(clash.y)) continue;
      const colors = [safeColor(clash.colors?.[0]), safeColor(clash.colors?.at(-1))];
      const radius = clamp(clash.radius || 28, 18, 48), duration = .42;
      particles.push({ kind: 'wave-clash', clashId: clash.id, x: clash.x, y: clash.y, radius, colors, duration, life: duration - clamp(age, 0, duration - .1), updatedAt: now });
      for (let i = 0; i < 6; i++) {
        const life = .2 + i % 2 * .06;
        if (age >= life) continue;
        const angle = i * Math.PI / 3 + .3, speed = 35 + i % 3 * 14, vx = Math.cos(angle) * speed, vy = Math.sin(angle) * speed;
        const elapsed = Math.max(0, age), decay = Math.exp(-3 * elapsed), travel = (1 - decay) / 3;
        particles.push({ kind: 'chip', clashId: clash.id, x: clash.x + vx * travel, y: clash.y + vy * travel, vx: vx * decay, vy: vy * decay, rotation: angle, size: 1.2, duration: life, life: life - elapsed, updatedAt: now, color: colors[i % 2] });
      }
      const latestHit = Math.max(-Infinity, ...current.players.filter(player => player.id === myId || player.lastWaveHit?.ownerId === myId).map(player => player.lastWaveHit?.at ?? -Infinity));
      if (clash.ownerIds?.includes(myId) && clash.at >= latestHit) {
        const marker = $('sgWaveFeedback');
        if (marker) {
          marker.dataset.kind = 'clash'; marker.dataset.mode = 'clash'; marker.dataset.tone = 'shooter'; marker.textContent = '引力波抵消'; marker.hidden = false;
          clearTimeout(combatMarkerTimer); combatMarkerTimer = setTimeout(() => { marker.hidden = true; }, 1100);
        }
      }
    }
    for (const [id, at] of seenWaveClashes) if (current.time - at > 5) seenWaveClashes.delete(id);
    for (const [id, at] of cancelledWaves) if (current.time - at > 5) cancelledWaves.delete(id);
    while (seenWaveClashes.size > 128) seenWaveClashes.delete(seenWaveClashes.keys().next().value);
    while (cancelledWaves.size > 512) cancelledWaves.delete(cancelledWaves.keys().next().value);
    if (particles.length > 180) particles.splice(0, particles.length - 180);
  }
  function receiveWaveFeedback(current, previous) {
    if (previous?.code !== current.code || previous?.round !== current.round) resetWaveFeedback();
    const now = performance.now();
    for (const player of current.players) {
      const hit = player.lastWaveHit;
      if (!hit?.id || seenCombatEvents.has(hit.id)) continue;
      seenCombatEvents.set(hit.id, hit.at);
      const previousHit = previous?.players?.find(p => p.id === player.id)?.lastWaveHit;
      const age = current.time - hit.at;
      if (previousHit?.id === hit.id || previous?.status !== 'playing' || current.status !== 'playing' || previous.round !== current.round || !Number.isFinite(age) || age < -.02 || age > .8) continue;
      const body = drawnPlayers.get(`${player.id}:${hit.cellId}`) || { x: player.x, y: player.y, radius: player.radius || 24 };
      const cellIds = hit.hitCellIds || [hit.cellId];
      combatFeedback.set(player.id, { hit, cellIds, startedAt: now - Math.max(0, age) * 1000, recentUntil: now + 2800, fallback: { ...body } });
      const directionLength = Math.hypot(hit.directionX, hit.directionY) || 1, dx = (hit.directionX || 0) / directionLength, dy = (hit.directionY || 0) / directionLength;
      const x = body.x - dx * body.radius, y = body.y - dy * body.radius;
      for (let i = 0; i < 5; i++) {
        const tangent = (i - 2) * 27, duration = .2 + i % 2 * .08;
        if (age >= duration) continue;
        particles.push({ kind: 'chip', x, y, vx: dx * (40 + i * 11) - dy * tangent, vy: dy * (40 + i * 11) + dx * tangent, rotation: i, size: 1.3, life: duration - Math.max(0, age), duration, updatedAt: now, color: '#ffd3b5' });
      }
      if (player.id === myId || hit.ownerId === myId) {
        const marker = $('sgWaveFeedback'), victim = player.id === myId;
        if (marker) {
          marker.dataset.kind = 'wave'; marker.dataset.tone = victim ? 'victim' : 'shooter';
          marker.dataset.mode = hit.mode || 'forward';
          const lost = Math.max(0, hit.lostMass || 0).toFixed(1).replace(/\.0$/, '');
          marker.textContent = victim ? `遭到引力波击退${hit.lostMass > 0 ? ` · 震落 ${lost} 质量的碎片` : ''}` : `引力波命中 · 击退 ${player.name}${hit.lostMass > 0 ? ` · 震落 ${lost} 质量的碎片` : ''}`;
          marker.hidden = false; clearTimeout(combatMarkerTimer);
          combatMarkerTimer = setTimeout(() => { marker.hidden = true; }, 1300);
        }
      }
    }
    for (const [id, at] of seenCombatEvents) if (current.time - at > 5) seenCombatEvents.delete(id);
    while (seenCombatEvents.size > 128) seenCombatEvents.delete(seenCombatEvents.keys().next().value);
    while (combatFeedback.size > 64) combatFeedback.delete(combatFeedback.keys().next().value);
    if (particles.length > 180) particles.splice(0, particles.length - 180);
  }

  function receiveMeteorFeedback(current, previous) {
    const now = performance.now();
    for (const player of current.players) {
      const hit = player.lastMeteorHit;
      if (!hit?.id || seenCombatEvents.has(hit.id)) continue;
      seenCombatEvents.set(hit.id, hit.at);
      const previousHit = previous?.players?.find(p => p.id === player.id)?.lastMeteorHit, age = current.time - hit.at;
      if (previousHit?.id === hit.id || previous?.status !== 'playing' || current.status !== 'playing' || previous.round !== current.round || previous.code !== current.code || !Number.isFinite(age) || age < -.02 || age > .8) continue;
      const body = drawnPlayers.get(`${player.id}:${hit.cellId}`) || { x: player.x, y: player.y, radius: player.radius || 24 };
      const existing = combatFeedback.get(player.id);
      if (!existing || hit.at >= existing.hit.at) combatFeedback.set(player.id, { kind: 'meteor', hit, cellIds: hit.hitCellIds || [hit.cellId], startedAt: now - Math.max(0, age) * 1000, recentUntil: now + 2800, fallback: { ...body } });
      const length = Math.hypot(hit.directionX, hit.directionY) || 1, dx = (hit.directionX || 0) / length, dy = (hit.directionY || 0) / length;
      const x = body.x - dx * body.radius, y = body.y - dy * body.radius;
      for (let i = 0; i < 6; i++) {
        const duration = .22 + i % 2 * .08;
        if (age >= duration) continue;
        const tangent = (i - 2.5) * 24;
        particles.push({ kind: 'chip', x, y, vx: dx * (55 + i * 9) - dy * tangent, vy: dy * (55 + i * 9) + dx * tangent, rotation: i, size: 1.4, life: duration - Math.max(0, age), duration, updatedAt: now, color: '#ffc987' });
      }
      if (player.id === myId && hit.at >= (player.lastWaveHit?.at ?? -Infinity)) {
        const marker = $('sgWaveFeedback');
        if (marker) {
          const lost = Math.max(0, hit.lostMass || 0).toFixed(1).replace(/\.0$/, '');
          marker.dataset.kind = 'meteor'; marker.dataset.mode = 'impact'; marker.dataset.tone = 'victim';
          marker.textContent = `流星撞击${hit.lostMass > 0 ? ` · 震落 ${lost} 质量的碎片` : ''}`;
          marker.hidden = false; clearTimeout(combatMarkerTimer); combatMarkerTimer = setTimeout(() => { marker.hidden = true; }, 1300);
        }
      }
    }
    while (seenCombatEvents.size > 128) seenCombatEvents.delete(seenCombatEvents.keys().next().value);
    while (combatFeedback.size > 64) combatFeedback.delete(combatFeedback.keys().next().value);
    if (particles.length > 180) particles.splice(0, particles.length - 180);
  }

  function emitContactEffects(current, previous) {
    if (previous?.round !== current.round) { seenImpacts.clear(); predictedContactEffects.clear(); }
    const events = new Map();
    for (const player of current.players) {
      const impact = player.lastImpact;
      if (!impact?.id) continue;
      let event = events.get(impact.id);
      if (!event) { event = { impact, colors: [], players: [] }; events.set(impact.id, event); }
      event.colors.push(safeColor(player.color));
      event.players.push(player.id);
    }
    const at = performance.now();
    trimPredictedContactEffects(at);
    for (const { impact, colors, players } of events.values()) {
      if (seenImpacts.has(impact.id)) continue;
      seenImpacts.set(impact.id, impact.at);
      const age = current.time - impact.at;
      // A first snapshot establishes a baseline; old contacts never replay on join.
      if (current.status !== 'playing' || previous?.status !== 'playing' || previous.round !== current.round || !Number.isFinite(age) || age < -.02 || age > .35 || !Number.isFinite(impact.x) || !Number.isFinite(impact.y)) continue;
      const predicted = predictedContactEffects.get(players.sort().join('|'));
      const match = predicted?.find(effect => !effect.confirmed && at - effect.at < 900 &&
        Math.hypot(effect.x - impact.x, effect.y - impact.y) < Math.max(80, (impact.speed || 0) * .4));
      if (match) { match.confirmed = true; continue; }
      const near = players.includes(myId) || [...remotePhysics.values()].some(proxy =>
        players.includes(proxy.player?.id) && proxy.islandUntil > at);
      const visualAge = near ? Math.max(0, age, (peekRenderSimulationTime(at) + simulationLead * 1000) / 1000 - impact.at) : 0;
      spawnContactParticles(impact, colors, visualAge);
    }
    for (const [id, at] of seenImpacts) if (current.time - at > 5) seenImpacts.delete(id);
    while (seenImpacts.size > 128) seenImpacts.delete(seenImpacts.keys().next().value);
  }

  function trimPredictedContactEffects(at) {
    for (const [key, events] of predictedContactEffects) {
      const recent = events.filter(event => at - event.at < 1000);
      if (recent.length) predictedContactEffects.set(key, recent); else predictedContactEffects.delete(key);
    }
    while (predictedContactEffects.size > 128) predictedContactEffects.delete(predictedContactEffects.keys().next().value);
  }

  function emitPredictedContact(a, b, impact) {
    const at = impact.at ?? performance.now();
    if ((!a.own && !b.own && !(a.ref?.islandUntil > at) && !(b.ref?.islandUntil > at)) || impact.speed <= 12) return;
    trimPredictedContactEffects(at);
    const key = [a.player.id, b.player.id].sort().join('|'), recent = predictedContactEffects.get(key) || [];
    if (recent.some(effect => at - effect.at < 200 && Math.hypot(effect.x - impact.x, effect.y - impact.y) < 80)) return;
    recent.push({ at, x: impact.x, y: impact.y, confirmed: false });
    predictedContactEffects.set(key, recent.slice(-4));
    const radius = Math.min(32, Math.min(a.cell.radius, b.cell.radius) * .65);
    spawnContactParticles({ ...impact, at: at / 1000, radius }, [safeColor(a.player.color), safeColor(b.player.color)]);
  }

  function spawnContactParticles(impact, colors, age = 0) {
    const updatedAt = performance.now();
    const speed = Math.max(0, impact.speed || 0);
    if (!impact.fractured && speed <= 12) return;
    const strength = clamp(Math.max(impact.fractured ? .3 : 0, (speed - 12) / 360), 0, 1);
    const normalLength = Math.hypot(impact.normalX, impact.normalY) || 1, nx = (impact.normalX || 0) / normalLength, ny = (impact.normalY || 0) / normalLength;
    const angle = Math.atan2(ny, nx), radius = clamp(impact.radius || 8, 4, 32) * (.7 + strength * .5), duration = .12 + strength * .18;
    if (age < duration) particles.push({ kind: 'contact', x: impact.x, y: impact.y, radius, angle, strength, life: duration - age, duration, updatedAt, color: colors[0] });
    const count = 2 + Math.round(strength * 6);
    for (let i = 0; i < count; i++) {
      const variance = .4 + Math.abs(Math.sin(i * 2.7 + impact.at * 4.3)) * .6;
      const normal = (i % 2 ? 1 : -1) * (12 + strength * 65) * variance;
      const tangent = (i % 4 < 2 ? 1 : -1) * (20 + strength * 125) * variance;
      const life = .14 + strength * .25 + i % 2 * .03;
      const vx = nx * normal - ny * tangent, vy = ny * normal + nx * tangent, decay = Math.exp(-age * 3), travel = (1 - decay) / 3;
      if (age < life) particles.push({ kind: 'chip', x: impact.x + vx * travel, y: impact.y + vy * travel, vx: vx * decay, vy: vy * decay, rotation: angle + i + age * 2, size: 1 + strength * 1.7 + i % 2 * .4, life: life - age, duration: life, updatedAt, color: colors[i % colors.length] });
    }
    if (particles.length > 180) particles.splice(0, particles.length - 180);
  }

  function updateRoomPanel() {
    if (!room || reconnecting) return;
    const players = room.players.filter((p) => p.connected !== false);
    const me = players.find((p) => p.id === myId), host = room.hostId === myId;
    const allReady = players.length >= 2 && players.every((p) => p.ready || p.bot);
    const finished = room.status === 'finished';
    const sorted = [...players].sort(comparePlayers);
    const place = Math.max(1, sorted.findIndex((p) => p.id === myId) + 1);
    const winner = sorted.find((p) => p.id === room.winnerId) || sorted[0];
    const panel = $('sgPanel');
    // Preserve keyboard focus while authoritative room updates arrive.
    const focused = document.activeElement?.id;
    const roster = players.map((p) => `<div class="sg-roster-row"><span class="sg-mini-planet" style="--planet:${safeColor(p.color)}"></span><span class="sg-roster-name">${esc(p.name)}${p.id === myId ? '<span class="sg-small-tag">你</span>' : ''}${p.id === room.hostId ? '<span class="sg-small-tag">房主</span>' : ''}${p.bot ? '<span class="sg-small-tag">AI</span>' : ''}</span><span class="sg-ready-status${p.ready || p.bot ? ' ready' : ''}">${finished ? `${Math.floor(p.mass || 0)} 质量` : p.ready || p.bot ? '● 已准备' : '等待准备'}</span></div>`).join('');
    let html = `${finished ? `<div class="sg-panel-topline"><span class="sg-eyebrow">ROUND COMPLETE</span><span class="sg-badge">${room.mode === 'practice' ? '训练完成' : '本局结束'}</span></div><h2>${place === 1 ? '你就是宇宙的中心。' : '每一次引爆，都是新生。'}</h2><div class="sg-result-place">#${place}<span style="font-size:18px;color:#7d899b;letter-spacing:0"> / ${players.length}</span></div><p class="sg-panel-desc">${esc(winner?.name || '星际旅人')} 获得本局第一名</p><div class="sg-result-grid"><div><div class="sg-result-number">${me?.score || 0}</div><div class="sg-result-label">获得星尘</div></div><div><div class="sg-result-number">${players.length}</div><div class="sg-result-label">参赛星球</div></div><div><div class="sg-result-number">${room.round || 1}</div><div class="sg-result-label">探索轮次</div></div></div>` : `<div class="sg-panel-topline"><span class="sg-eyebrow">YOUR NEXT UNIVERSE</span><span class="sg-badge">在线房间 · ${players.length} / 8</span></div><h2>${host ? '宇宙已就位。<br>就差你的朋友。' : '你已进入这片宇宙。'}</h2><p class="sg-panel-desc">${host ? '把房间码发给朋友，一起开启星际混战。' : '准备好你的星球，等待房主开启对局。'}</p><div class="sg-code-box"><div><div class="sg-code-label">房间邀请码 / ROOM CODE</div><div class="sg-code">${esc(room.code)}</div></div><button class="sg-copy" id="sgCopyCode" title="复制房间码" aria-label="复制房间码">${icons.copy}</button></div>`}<div class="sg-roster-title"><span>${finished ? '本局星球' : '已抵达星球'}</span><span>${players.length} ${players.length === 1 ? 'PLAYER' : 'PLAYERS'}</span></div><div class="sg-roster">${roster}</div><div class="sg-panel-buttons"><button class="sg-secondary" id="sgRoomExit">返回大厅</button>${host ? `<button class="sg-primary" id="sgStartRound" ${allReady || (room.mode === 'practice' && finished) ? '' : 'disabled'}>${finished ? '再来一局' : '开始引爆'} ↗</button>` : `<button class="sg-primary" id="sgReady">${me?.ready ? '取消准备' : finished ? '准备下一局' : '我准备好了'}${me?.ready ? ' ✓' : ''}</button>`}</div><p class="sg-panel-note">${room.mode === 'practice' ? '训练模式中的其他星球由 AI 控制。' : host ? players.length < 2 ? '至少需要 2 名玩家。邀请朋友，或等待新星球加入。' : allReady ? '所有星球已准备就绪，可以出发了。' : '等待所有玩家准备后，房主即可开始。' : me?.ready ? '你已准备就绪，等待房主开始。' : '点击准备，告诉同伴你已就绪。'}</p>`;
    html = html.replace(/<\/p>$/, '<br>碰撞等分成 3 / 4 份 · 唯一核心可控 · E 向前发射引力波</p>');
    if (domCache.get('roomPanel') !== html) {
      domCache.set('roomPanel', html); panel.innerHTML = html;
      if ($('sgCopyCode')) $('sgCopyCode').onclick = copyCode;
      $('sgRoomExit').onclick = () => disconnect();
      if ($('sgStartRound')) $('sgStartRound').onclick = () => send({ type: 'start' });
      if ($('sgReady')) $('sgReady').onclick = () => send({ type: 'ready', ready: !me?.ready });
      if (focused && $(focused)) $(focused).focus({ preventScroll: true });
    }
    $('sgPanelBackdrop').hidden = false;
  }

  async function copyCode() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(room.code);
      else {
        const input = document.createElement('textarea'); input.value = room.code; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.appendChild(input); input.select();
        if (!document.execCommand('copy')) throw new Error('copy unavailable'); input.remove();
      }
      toast(`已复制房间码 ${room.code}，快去邀请朋友`);
    } catch (_) { toast(`房间码：${room.code} · 长按或手动复制`); }
  }

  function setMarkup(id, value) { if (domCache.get(id) !== value) { domCache.set(id, value); $(id).innerHTML = value; } }
  function safeColor(color) { return /^#[a-f\d]{6}$/i.test(color || '') ? color : palette[0]; }
  function comparePlayers(a, b) { return (b.mass ?? 0) - (a.mass ?? 0) || (b.score ?? 0) - (a.score ?? 0) || (b.kills ?? 0) - (a.kills ?? 0) || String(a.id).localeCompare(String(b.id)); }
  function updateUpgrades() {
    const me = room?.players?.find((p) => p.id === myId), choices = me?.upgradeChoices || [];
    const show = room?.status === 'playing' && choices.length > 0;
    $('sgUpgrades').hidden = !show;
    $('sgUpgradeActive').hidden = room?.status !== 'playing';
    if (show) {
      const key = `${me.level}:${choices.map((c) => c.id).join(',')}`;
      if (key !== lastUpgradeKey) {
        lastUpgradeKey = key;
        $('sgUpgradeTitle').textContent = `星球进化 · LV. ${me.level || 1} · 选择 1 项强化`;
        const symbols = ['✧', '⌁', '◈'];
        $('sgUpgradeCards').innerHTML = choices.slice(0, 3).map((choice, i) => `<button class="sg-upgrade-card" data-choice="${i}" aria-label="选择${esc(choice.title)}：${esc(choice.description)}"><span class="sg-upgrade-key">${i + 1}</span><span class="sg-upgrade-icon">${symbols[i]}</span><span class="sg-upgrade-name">${esc(choice.title)}</span><span class="sg-upgrade-desc">${esc(choice.description)}</span></button>`).join('');
        $('sgUpgradeCards').querySelectorAll('button').forEach((button) => { button.onclick = () => chooseUpgrade(Number(button.dataset.choice)); });
      }
    } else lastUpgradeKey = '';
    const names = { speed: '光速引擎', growth: '星尘滋养', blast: '超新星回响', blastRange: '超新星回响', range: '超新星回响', energy: '能量核心', efficiency: '能量核心', magnet: '引力场', recovery: '恒星充能', regen: '恒星充能', cooldown: '星波调谐' };
    setMarkup('sgUpgradeActive', (me?.upgrades || []).length ? `<span class="sg-eyebrow">已获得强化</span><br>${me.upgrades.map((u) => `<b>✧ ${esc(u.title || names[u.id] || u.id)}</b>${u.count > 1 ? ` ×${u.count}` : ''}`).join('<br>')}` : '');
  }
  function chooseUpgrade(index) {
    const me = room?.players?.find((p) => p.id === myId), choice = me?.upgradeChoices?.[index];
    if (!choice || room?.status !== 'playing' || reconnecting) return;
    send({ type: 'upgrade', upgradeId: choice.id });
    window.StarAudio?.play('upgrade');
    toast(`已选择强化 · ${choice.title}`);
  }
  function formatTime(seconds) { const n = Math.max(0, Math.ceil(Number(seconds) || 0)); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
  function updateHud(force = false) {
    if (!root) return;
    const now = performance.now();
    if (!force && now - lastHud < 200) return;
    lastHud = now;
    if (room?.status === 'lobby' || room?.status === 'finished') updateRoomPanel();
    updateUpgrades();
    const me = room?.players?.find((p) => p.id === myId);
    const players = [...(room?.players || [])].filter((p) => p.connected !== false).sort(comparePlayers);
    const endless = room ? room.endless === true : currentOptions?.mode === 'practice';
    $('sgRoundLabel').textContent = endless ? '无尽训练' : room?.status === 'playing' ? 'LIVE MATCH' : room?.status === 'finished' ? 'ROUND COMPLETE' : '准备起航';
    $('sgTimer').textContent = endless ? '∞' : formatTime(room?.remaining ?? 180);
    $('sgTimer').setAttribute('aria-label', endless ? '无尽训练，无时间限制' : '对局剩余时间');
    $('sgTimer').title = endless ? '无时间限制，可随时返回大厅' : '';
    $('sgTimer').style.color = !endless && room?.status === 'playing' && room.remaining < 30 ? '#ffb4a6' : '';
    $('sgPlayerCount').textContent = `${String(players.length).padStart(2, '0')} PLAYERS`;
    setMarkup('sgRanking', players.slice(0, 6).map((p, i) => `<div class="sg-rank-row${p.id === myId ? ' me' : ''}"><span class="sg-rank-num">${i + 1}</span><span class="sg-player-dot" style="--planet:${safeColor(p.color)}"></span><span class="sg-rank-name">${esc(p.name)}${p.id === myId ? ' · 你' : ''}</span><span class="sg-rank-score">${Math.floor(p.mass ?? p.score ?? 0)}</span></div>`).join(''));
    $('sgScore').textContent = String(Math.floor(me?.mass ?? 36)).padStart(3, '0');
    const ownCells = (me?.cells || []).filter(cell => !cell.dysonId && (predictedCells.get(cell.id)?.model.mass ?? cell.mass) > 0);
    $('sgLevel').textContent = me?.dyson ? `LV. ${me.level || 1} / 戴森球${ownCells.length ? ` + ${ownCells.length} 颗核心` : ''}` : `LV. ${me?.level || 1} / ${ownCells.length || 1} 颗星球`;
    const peak = me?.peakMass ?? me?.mass ?? 36, next = me ? me.nextUpgradeMass : 60;
    $('sgGrowthFill').style.width = `${next ? clamp(peak / next * 100, 0, 100) : 100}%`;
    const gravity = Math.max(0, ...ownCells.map((cell) => effectiveCell(me, cell)?.gravityRadius || 0));
    $('sgGrowthText').textContent = `${next ? `巅峰 ${Math.floor(peak)} / ${next} · 三选一` : '所有强化已解锁'}${gravity ? ` · 引力 ${Math.round(gravity)}` : ''}`;
    const energy = clamp(me?.energy ?? 60, 0, 100);
    $('sgEnergyText').textContent = `${Math.floor(energy)} / 100`;
    $('sgEnergyFill').style.width = `${energy}%`;
    const multipleCores = (me?.cells || []).filter(cell => cell.mass > 0).length > 1;
    const waveDisabled = Boolean(me?.dyson) || multipleCores || !room || room.status !== 'playing' || energy < (me?.stats?.blastCost || 30) || (me?.respawnIn || 0) > 0 || reconnecting || (me?.cooldown || 0) > 0;
    $('sgBlast').disabled = waveDisabled; $('sgRearBlast').disabled = waveDisabled;
    $('sgBlast').title = multipleCores ? '分身融合为单颗后可释放冲击波' : `沿前进方向发射 · 消耗 ${me?.stats?.blastCost || 30} 能量${me?.cooldown > 0 ? ` · 冷却 ${me.cooldown.toFixed(1)} 秒` : ''}`;
    $('sgRearBlast').title = multipleCores ? '分身融合为单颗后可释放冲击波' : '向后反击，不改变移动方向 · 与前向波共用能量和冷却';
    updateDysonHud(me, now);
    $('sgRoomFooter').textContent = room ? `${endless ? 'ENDLESS TRAINING / 无尽训练' : `ROOM / ${room.code}`}  ·  STAY CURIOUS, KEEP EXPLODING` : 'CONNECTING TO YOUR UNIVERSE';
    $('sgDiagnostics').textContent = `${fps > 0 ? fps : '—'} FPS / ${rtt === null ? '—' : Math.round(rtt)} ms`;
    const respawn = me?.respawnIn || 0;
    $('sgRespawn').hidden = respawn <= 0 || room?.status !== 'playing';
    if (respawn > 0) $('sgRespawn').innerHTML = `<strong>${Math.ceil(respawn)}</strong>星球重生中`;
    const showGameplay = room?.status === 'playing';
    $('sgTouch').style.visibility = showGameplay ? 'visible' : 'hidden';
    document.querySelector('#gameOverlay .sg-bottom').style.visibility = showGameplay ? 'visible' : 'hidden';
  }

  function toast(message) {
    if (!root) return;
    $('sgToast').textContent = message; $('sgToast').classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => $('sgToast')?.classList.remove('show'), 2800);
  }
  function blast(rear = false) {
    const me = room?.players?.find((p) => p.id === myId);
    if (room?.status !== 'playing' || !me || me.respawnIn > 0 || me.dyson || reconnecting) return;
    if ((me.cells || []).filter(cell => cell.mass > 0).length > 1) { toast('分身融合为单颗后可释放冲击波'); return; }
    if (me.energy < (me.stats?.blastCost || 30)) { toast('能量不足 · 收集星尘补充能量'); return; }
    if (me.cooldown > 0) return;
    inputPulse = !rear; rearPulse = rear; sendInput();
    window.StarAudio?.play('blast');
  }
  function split() {
    const me = room?.players?.find((p) => p.id === myId);
    if (room?.status !== 'playing' || !me || me.respawnIn > 0 || reconnecting) return;
    if (me.dyson) {
      const shell = dysonPose(me, performance.now());
      if (!shell || shell.exitAt != null || shell.exitWait > 0) return;
      splitPulse = true; sendInput(); return;
    }
    const combo = comboReady(me);
    if (!combo && !(me.cells || [{ mass: me.mass }]).some((cell) => cell.mass >= 48)) {
      toast('单颗星球质量达到 48 后即可分裂'); return;
    }
    if (combo?.kind === 'blink') {
      const ref = predictedCells.get(combo.ready.sourceCellId);
      if (ref) ref.blinkPending = { at: performance.now(), directionX: combo.ready.directionX, directionY: combo.ready.directionY };
    }
    splitPulse = true; sendInput();
  }

  function dysonComboRemaining(player, at = performance.now()) {
    if (!player?.dysonReady || player.dyson || reconnecting || !renderTimeline || consumedBlinkWaves.has(player.dysonReady.waveId)) return 0;
    return Math.max(0, player.dysonReady.expiresAt - (peekRenderSimulationTime(at) / 1000 + simulationLead));
  }
  function waveBlinkRemaining(player, at = performance.now()) {
    const ready = player?.waveBlinkReady;
    if (!ready || player.dyson || reconnecting || !renderTimeline || cancelledWaves.has(ready.waveId) || consumedBlinkWaves.has(ready.waveId) || player.lastWaveBlink?.waveId === ready.waveId) return 0;
    if (!(player.cells || []).some(cell => cell.id === ready.sourceCellId && cell.mass > 0 && !cell.dysonId)) return 0;
    return Math.max(0, ready.expiresAt - (peekRenderSimulationTime(at) / 1000 + simulationLead));
  }
  function comboReady(player, at = performance.now()) {
    const dyson = dysonComboRemaining(player, at);
    if (dyson > 0) return { kind: 'dyson', remaining: dyson, duration: room?.dysonRules?.window || .9, ready: player.dysonReady };
    const blink = waveBlinkRemaining(player, at);
    if (blink > 0) return { kind: 'blink', remaining: blink, duration: (player.waveBlinkReady.distance || 420) / (player.waveBlinkReady.speed || 600), ready: player.waveBlinkReady };
    return null;
  }
  function comboTargetPose(player, at = lastFrame || performance.now()) {
    const combo = comboReady(player, at);
    if (!combo) return null;
    if (combo.kind === 'blink') {
      const ready = combo.ready, visual = waveVisuals.get(ready.waveId);
      const blast = visual?.blast || { ...ready, id: ready.waveId, ownerId: player.id };
      const pose = wavePose(blast, at);
      if (!pose.active) return null;
      const source = player.cells.find(cell => cell.id === ready.sourceCellId), model = predictedCells.get(ready.sourceCellId)?.model;
      return { ...pose, kind: 'blink', radius: (model?.radius ?? source?.radius ?? 24) + 10 };
    }
    const target = room.players.find(other => other.id === combo.ready.targetId);
    const cell = target?.cells?.find(cell => cell.id === combo.ready.targetCellId && !cell.dysonId);
    if (!cell) return null;
    const own = target.id === myId, ref = own ? predictedCells.get(cell.id) : remotePhysics.get(`${target.id}:${cell.id}`);
    if (ref?.model?._consumed) return null;
    const position = own ? ref : ref?.presented ? ref.visual : ref?.model;
    return { kind: 'dyson', x: position?.x ?? cell.x, y: position?.y ?? cell.y, radius: (ref?.model?.radius ?? cell.radius) + 14 };
  }
  function dysonPose(player, at = lastFrame || performance.now()) {
    const shell = player?.dyson;
    if (!shell || reconnecting || !renderTimeline) return null;
    const target = room?.players?.find(p => p.id === shell.targetId);
    const cell = target?.cells?.find(c => c.id === shell.targetCellId && !c.dysonId);
    const ref = cell && (target.id === myId ? predictedCells.get(cell.id) : remotePhysics.get(`${target.id}:${cell.id}`));
    const position = target?.id === myId ? ref : ref?.presented ? ref.visual : ref?.model;
    const seconds = peekRenderSimulationTime(at) / 1000 + simulationLead;
    const exitPreview = shell.exitPreview && { ...shell.exitPreview,
      x: shell.exitPreview.x + (position?.x ?? shell.x) - shell.x,
      y: shell.exitPreview.y + (position?.y ?? shell.y) - shell.y };
    return { ...shell, x: position?.x ?? shell.x, y: position?.y ?? shell.y,
      radius: ref?.model?.mass > 0 ? ref.model.radius + (room?.dysonRules?.returnClearance ?? 16) : shell.radius || (cell?.radius ?? 24) + (room?.dysonRules?.returnClearance ?? 16),
      exitPreview, exitWait: Math.max(0, (shell.canExitAt ?? shell.startedAt + (room?.dysonRules?.minActive ?? .6)) - seconds),
      exitRemaining: shell.exitAt != null ? Math.max(0, shell.exitAt - seconds) : null,
      elapsed: Math.max(0, seconds - shell.startedAt), remaining: Math.max(0, shell.endsAt - seconds) };
  }
  function updateDysonHud(player, at) {
    const status = $('sgDysonStatus'), button = $('sgTouchSplit'), label = $('sgSplitLabel');
    if (!status || !button) return;
    const shell = dysonPose(player, at), combo = comboReady(player, at), ready = combo?.kind === 'dyson' ? combo.remaining : 0;
    const cooldown = Math.max(0, (player?.dysonCooldown || 0) - Math.max(0, at - (room?._receivedAt ?? at)) / 1000);
    // Ready actions use the central keycap; do not stack the older status card
    // underneath it on touch screens. Active and recovery states stay compact.
    status.hidden = room?.status !== 'playing' || reconnecting || Boolean(combo) || Boolean(shell) || !cooldown;
    status.dataset.phase = shell ? 'active' : ready ? 'ready' : 'cooldown';
    if (shell) setMarkup('sgDysonStatus', `<strong>戴森球 · ${shell.remaining.toFixed(1)} 秒</strong><small>已截获 ${Math.floor(shell.capturedMass || 0)} 质量 · 方向键 / 摇杆选择回归侧</small>`);
    else if (ready) setMarkup('sgDysonStatus', `<strong>命中连招 · ${ready.toFixed(1)} 秒</strong><small>按空格 / 点击分裂 → 戴森球</small>`);
    else if (cooldown) setMarkup('sgDysonStatus', `<strong>戴森球恢复 · ${cooldown.toFixed(1)} 秒</strong>`);
    const exiting = shell?.exitAt != null, exitReady = shell && !exiting && shell.exitWait <= 0;
    button.disabled = Boolean(shell && !exitReady) || reconnecting;
    button.dataset.combo = shell ? exitReady ? 'ready' : 'active' : ready ? 'ready' : combo ? 'blink' : '';
    button.textContent = shell ? exiting ? '还原中' : exitReady ? '还原' : '环绕中' : ready ? '戴森球' : combo ? '瞬移' : '分裂';
    button.setAttribute('aria-label', shell ? exiting ? '戴森球出口已锁定，正在还原' : exitReady ? '提前还原，出壳后再次点击分裂' : '戴森球环绕中，稍后可提前还原' : ready ? '发动戴森球连招' : combo ? '瞬移到波前' : '主动分裂');
    if (label) label.textContent = shell ? exiting ? '还原后再按空格分裂' : exitReady ? '提前还原 · 方向键选侧' : '戴森球环绕中' : ready ? '戴森球连招' : combo ? '瞬移到波前' : '分裂 / 波前连招';
    const prompt = $('sgComboPrompt');
    if (prompt) {
      prompt.hidden = room?.status !== 'playing' || reconnecting || !combo && !shell;
      root.dataset.comboRaised = String(Boolean(player?.upgradeChoices?.length));
      if (combo || shell) {
        prompt.dataset.kind = shell ? 'dyson' : combo.kind;
        $('sgComboKey').textContent = width < 700 ? '点击' : '空格';
        $('sgComboAction').textContent = shell ? exiting ? '正在还原' : exitReady ? '提前还原' : '戴森球环绕中' : ready ? '戴森球' : '瞬移';
        $('sgComboDescription').textContent = shell ? exiting ? '出口已锁定 · 出壳后再按空格分裂' : exitReady ? `已截获 ${Math.floor(shell.capturedMass || 0)} 质量 · 方向键 / 摇杆选侧` : '短暂环绕后可提前还原 · 方向键 / 摇杆选侧' : ready ? '包围目标 · 截获碎片' : '瞬移后消耗冲击波';
        const remaining = shell ? exiting ? shell.exitRemaining : exitReady ? shell.remaining : shell.exitWait : combo.remaining;
        const duration = shell ? exiting ? room?.dysonRules?.exitWindup || .3 : exitReady ? shell.endsAt - shell.startedAt : room?.dysonRules?.minActive || .6 : combo.duration;
        $('sgComboTime').textContent = `${remaining.toFixed(1)}s`;
        $('sgComboFill').style.width = `${clamp(remaining / duration * 100, 0, 100)}%`;
      }
    }
  }
  function clearDysonSourceContacts(key) {
    for (const pair of contactEpisodes.keys()) if (pair.split('|').includes(key)) contactEpisodes.delete(pair);
    remoteContactPositions.delete(key); drawnPlayers.delete(key);
  }
  function planetPresentation(ref, fallback, at) {
    const base = ref ? ref.player?.id === myId ? ref : ref.presented ? ref.visual : ref.model : fallback;
    const warp = ref?.blinkVisual;
    if (!warp) {
      if (ref?.blinkPending) {
        const progress = clamp((at - ref.blinkPending.at) / 180, 0, 1);
        if (progress >= 1) ref.blinkPending = null;
        else return { ...(base || fallback), blinkAnticipation: Math.sin(progress * Math.PI) * .14,
          warpAngle: Math.atan2(ref.blinkPending.directionY, ref.blinkPending.directionX) };
      }
      return base || fallback;
    }
    const progress = clamp((at - warp.startedAt) / warp.duration, 0, 1);
    if (progress >= 1) { ref.blinkVisual = null; return base || fallback; }
    // This is a short draw-only warp. The physical model, contacts and dust
    // collection stay at the authoritative destination throughout the effect.
    const ease = progress * progress * (3 - 2 * progress), remaining = 1 - ease;
    return { ...(base || fallback), x: base.x + (warp.fromX - warp.toX) * remaining,
      y: base.y + (warp.fromY - warp.toY) * remaining, warpProgress: progress,
      warpAngle: Math.atan2(warp.toY - warp.fromY, warp.toX - warp.fromX) };
  }
  function newBlinkPresentation(ref, model, at) {
    if (!ref) return null;
    const from = planetPresentation(ref, ref.model, at);
    return { startedAt: at, duration: blinkVisualDuration, fromX: from.x, fromY: from.y, toX: model.x, toY: model.y };
  }
  function sendInput() {
    if (!active || !room || room.status !== 'playing' || reconnecting) return;
    const input = getIntent(), view = getCamera(), seq = ++inputSeq;
    const at = performance.now();
    inputHistory.push({ seq, t: at, ...input });
    if (Math.hypot(input.x, input.y) > 0) lastMovementSeq = seq;
    while (inputHistory.length > 60 || inputHistory[0]?.t < at - 2000) inputHistory.shift();
    send({ type: 'input', ...input, seq, viewport: { x: view.x, y: view.y, width: Math.min(3200, view.width), height: Math.min(2300, view.height) }, dustDeltas: true, supportsDustDelta: true, fire: inputPulse, rearFire: rearPulse, split: splitPulse });
    inputPulse = false; rearPulse = false; splitPulse = false;
  }

  function playTone(frequency, duration, volume, type = 'sine') {
    if (!sound) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume();
      const osc = audioContext.createOscillator(), gain = audioContext.createGain();
      osc.type = type; osc.frequency.setValueAtTime(frequency, audioContext.currentTime); osc.frequency.exponentialRampToValueAtTime(frequency * .45, audioContext.currentTime + duration);
      gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
      osc.connect(gain); gain.connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime + duration);
    } catch (_) { /* Audio is optional. */ }
  }

  function getIntent() {
    let x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    let y = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
    if (!hasMovementKey() && Math.hypot(touchVector.x, touchVector.y) > .1) { x = touchVector.x; y = touchVector.y; }
    const length = Math.hypot(x, y); if (length > 1) { x /= length; y /= length; }
    return { x, y };
  }

  function getOwnCenter() {
    const me = room?.players?.find((p) => p.id === myId);
    if (!me) return null;
    let x = 0, y = 0, mass = 0;
    const shell = dysonPose(me, lastFrame || performance.now());
    if (shell) return { x: shell.x, y: shell.y };
    for (const cell of me.cells || []) { if (cell.dysonId) continue; const p = predictedCells.get(cell.id); if (p) { const m = p.model?.mass ?? cell.mass; if (m <= 0) continue; x += p.x * m; y += p.y * m; mass += m; } }
    return mass ? { x: x / mass, y: y / mass } : { x: me.x, y: me.y };
  }

  function addTrack(map, key, point, at) {
    let track = map.get(key); if (!track) { track = []; map.set(key, track); }
    const previous = track[track.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y && previous.mass === point.mass && !point.vx && !point.vy && !previous.vx && !previous.vy) return;
    const seconds = previous ? (at - previous.t) / 1000 : 0;
    track.push({ t: at, x: point.x, y: point.y, mass: point.mass, radius: point.radius, vx: Number.isFinite(point.vx) ? point.vx : seconds > 0 ? (point.x - previous.x) / seconds : 0, vy: Number.isFinite(point.vy) ? point.vy : seconds > 0 ? (point.y - previous.y) / seconds : 0 });
    if (track.length > 7) track.shift();
  }

  function sampleTrack(track, at, extrapolate = 90) {
    if (!track?.length) return null;
    const first = track[0], latest = track[track.length - 1];
    if (at <= first.t) return first;
    for (let i = 1; i < track.length; i++) if (track[i].t >= at) {
      const a = track[i - 1], b = track[i], f = clamp((at - a.t) / Math.max(1, b.t - a.t), 0, 1);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 500) return b;
      const mass = Number.isFinite(a.mass) && Number.isFinite(b.mass) ? a.mass + (b.mass - a.mass) * f : undefined;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, mass, radius: mass === undefined ? undefined : 4 * Math.sqrt(Math.max(0, mass)) };
    }
    const dt = clamp(at - latest.t, 0, extrapolate) / 1000;
    return { x: latest.x + latest.vx * dt, y: latest.y + latest.vy * dt, mass: latest.mass, radius: latest.radius };
  }

  function resetMeteors() { meteorTracks.clear(); meteorPresentation = null; renderedMeteors = 0; }
  function cacheMeteorTracks(current, previous) {
    if (previous?.code !== current.code || previous?.round !== current.round) resetMeteors();
    const snapshotAt = current._renderTime, present = new Set();
    const impacts = new Set(current.players.map(player => player.lastMeteorHit?.meteorId).filter(Boolean));
    for (const meteor of current.meteors || []) {
      if (impacts.has(meteor?.id)) continue;
      if (!meteor?.id || ![meteor.x, meteor.y, meteor.vx, meteor.vy].every(Number.isFinite)) continue;
      present.add(meteor.id);
      let track = meteorTracks.get(meteor.id);
      // An immutable anchor keeps a straight flight continuous across rounded
      // snapshots. Packet timing only extends how far the path is confirmed.
      if (!track) {
        track = { x: meteor.x, y: meteor.y, vx: meteor.vx, vy: meteor.vy, t: snapshotAt, bornAt: meteor.bornAt };
        meteorTracks.set(meteor.id, track);
      }
      if (track.pendingImpact && snapshotAt > track.pendingImpact.time + motionSettings.physicsStep * 2000) {
        // A genuinely later live state can disprove a visual-only prediction.
        // An older in-flight packet cannot resurrect a head already touching us.
        track.ignoredBody = `${track.pendingImpact.playerId}:${track.pendingImpact.cellId}`;
        track.pendingImpact = null; track.lastPose = null;
      }
      track.latestAt = snapshotAt; track.latestX = meteor.x; track.latestY = meteor.y;
    }
    for (const id of meteorTracks.keys()) if (!present.has(id)) meteorTracks.delete(id);
    while (meteorTracks.size > 128) meteorTracks.delete(meteorTracks.keys().next().value);
  }
  function meteorPose(meteor, at) {
    const track = meteorTracks.get(meteor.id);
    if (!track) return null;
    if (!meteorPresentation) meteorPresentation = { lead: simulationLead, at };
    const frameTime = Math.max(0, (at - meteorPresentation.at) / 1000);
    if (frameTime) {
      const error = clamp(simulationLead, 0, .25) - meteorPresentation.lead;
      meteorPresentation.lead += clamp(error * (1 - Math.exp(-frameTime * 2)), -frameTime * .05, frameTime * .05);
      meteorPresentation.at = at;
    }
    // Lead uses the same downlink estimate as nearby bodies. Easing its phase
    // limits clock drift to 5%, rather than jumping a fast head when ping changes.
    const lead = meteorPresentation.lead * 1000;
    const sampleAt = Math.min(renderSimulationTime(at) + lead, track.latestAt + lead + 250);
    if (Number.isFinite(track.bornAt) && sampleAt < track.bornAt * 1000) return null;
    const dt = (sampleAt - track.t) / 1000, x = track.x + track.vx * dt, y = track.y + track.vy * dt;
    if (x < 0 || y < 0 || x > WORLD.width || y > WORLD.height) return null;
    if (track.pendingImpact) return null;
    const pose = { x, y, vx: track.vx, vy: track.vy, time: sampleAt };
    if (meteorTouchesVisibleBody(meteor, pose, track, at)) return null;
    track.lastPose = pose;
    return pose;
  }
  function meteorTouchesVisibleBody(meteor, pose, track, at) {
    const previous = track.lastPose || { x: track.latestX, y: track.latestY, time: track.latestAt };
    const elapsed = Math.max(0, (pose.time - previous.time) / 1000);
    let contact;
    for (const player of room?.players || []) for (const cell of player.cells || []) {
      if (cell.dysonId) continue;
      const key = `${player.id}:${cell.id}`, own = player.id === myId, proxy = own ? predictedCells.get(cell.id) : remotePhysics.get(key);
      if (!proxy || proxy.model?._consumed) continue;
      const position = own ? proxy : remoteContactFrame === at ? remoteContactPositions.get(key) || proxy.visual : proxy.visual;
      if (!position) continue;
      const radius = (proxy.model?.radius ?? cell.radius) + (meteor.radius || 4);
      if (track.ignoredBody === key) {
        if (Math.hypot(pose.x - position.x, pose.y - position.y) <= radius + 1) continue;
        track.ignoredBody = null;
      }
      const drawn = track.lastPose ? drawnPlayers.get(key) : null;
      const start = drawn || (track.lastPose ? { x: position.x - (proxy.model?.vx || 0) * elapsed, y: position.y - (proxy.model?.vy || 0) * elapsed } : cell);
      const sx = previous.x - start.x, sy = previous.y - start.y;
      const vx = (pose.x - previous.x) - (position.x - start.x), vy = (pose.y - previous.y) - (position.y - start.y);
      const c = sx * sx + sy * sy - radius * radius, a = vx * vx + vy * vy, b = 2 * (sx * vx + sy * vy);
      let fraction = c <= 0 ? 0 : Infinity;
      const discriminant = b * b - 4 * a * c;
      if (c > 0 && a > 1e-9 && b < 0 && discriminant >= 0) fraction = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (fraction < 0 || fraction > 1 || (contact && fraction >= contact.fraction)) continue;
      contact = { playerId: player.id, cellId: cell.id, fraction, time: previous.time + (pose.time - previous.time) * fraction };
    }
    if (!contact) return false;
    track.pendingImpact = contact;
    return true;
  }

  function renderSimulationTime(at) {
    if (!renderTimeline) return room?._renderTime || 0;
    const clock = renderTimeline, dt = Math.max(0, (at - clock.at) / 1000);
    if (dt) {
      // Packet arrival jitter changes the clock's target, never its position.
      // Small continuous rate changes preserve a monotonic world reference.
      const error = clock.target + at - clock.targetAt - (clock.time + dt * 1000);
      const desiredRate = clamp(1 + error / 1000, .9, 1.1);
      clock.rate += (desiredRate - clock.rate) * (1 - Math.exp(-dt * 2));
      clock.time += dt * 1000 * clock.rate; clock.at = at;
    }
    return clock.time;
  }
  function peekRenderSimulationTime(at) {
    if (!renderTimeline) return room?._renderTime || 0;
    return renderTimeline.time + Math.max(0, at - renderTimeline.at) * renderTimeline.rate;
  }

  function movementSpeed(cell, player) {
    return motionSettings.baseSpeed * (player.stats?.speed || 1) * Math.pow(motionSettings.referenceMass / Math.max(.000001, cell.mass), motionSettings.speedExponent);
  }
  function cellState(cell) { return { ...cell, vx: cell.vx || 0, vy: cell.vy || 0, mergeIn: cell.mergeIn || 0, mass: cell.mass, radius: 4 * Math.sqrt(Math.max(0, cell.mass)) }; }
  function advanceOwnCell(state, cell, player, input, elapsed, groupMass) {
    const moving = Math.hypot(input.x, input.y) > 0;
    const speed = movementSpeed(groupMass ? { mass: groupMass } : cell, player);
    const rate = moving ? motionSettings.response : motionSettings.drag, dt = Math.max(0, elapsed), decay = Math.exp(-rate * dt);
    const targetX = input.x * speed, targetY = input.y * speed;
    const initialX = state.vx || 0, initialY = state.vy || 0;
    // Exact integration matches the server across different render/tick rates.
    // Keys provide thrust; released controls coast with drag rather than snap.
    state.x += targetX * dt + (initialX - targetX) * (1 - decay) / rate;
    state.y += targetY * dt + (initialY - targetY) * (1 - decay) / rate;
    state.vx = targetX + (initialX - targetX) * decay;
    state.vy = targetY + (initialY - targetY) * decay;
    if (!moving && !state._siblingAwake && Math.hypot(state.vx, state.vy) < motionSettings.stopSpeed) state.vx = state.vy = 0;
    if (state.x < cell.radius) { state.x = cell.radius; if (state.vx < 0) state.vx *= Math.abs(state.vx) > motionSettings.restingThreshold ? -motionSettings.restitution : 0; }
    if (state.x > WORLD.width - cell.radius) { state.x = WORLD.width - cell.radius; if (state.vx > 0) state.vx *= Math.abs(state.vx) > motionSettings.restingThreshold ? -motionSettings.restitution : 0; }
    if (state.y < cell.radius) { state.y = cell.radius; if (state.vy < 0) state.vy *= Math.abs(state.vy) > motionSettings.restingThreshold ? -motionSettings.restitution : 0; }
    if (state.y > WORLD.height - cell.radius) { state.y = WORLD.height - cell.radius; if (state.vy > 0) state.vy *= Math.abs(state.vy) > motionSettings.restingThreshold ? -motionSettings.restitution : 0; }
    return Math.hypot(state.vx, state.vy);
  }

  function replayOwnCell(cell, player, acknowledged, at) {
    const state = { x: cell.x, y: cell.y, vx: cell.vx || 0, vy: cell.vy || 0 };
    const snapshotAt = at - simulationLead * 1000;
    let command = acknowledged || player.steering || { x: 0, y: 0 };
    for (const input of inputHistory) if (input.t <= snapshotAt) command = input;
    const pending = inputHistory.filter(input => input.t > snapshotAt && input.t <= at);
    // Both local authority and remote contact proxies represent server-now.
    // The snapshot is one downlink old, not an entire input round trip old.
    // Local controls remain immediate in the persistent prediction model.
    advanceOwnCell(state, cell, player, command, Math.max(0, ((pending[0]?.t ?? at) - snapshotAt) / 1000));
    for (let i = 0; i < pending.length; i++) {
      const duration = Math.max(0, ((pending[i + 1]?.t ?? at) - pending[i].t) / 1000);
      advanceOwnCell(state, cell, player, pending[i], Math.min(2, duration));
    }
    return state;
  }

  function clearFusion(cell) { cell.fusionId = cell.fusionRole = cell.fusionPartnerId = cell.fusionTargetId = cell.fusionDonorId = null; cell.fusionProgress = cell.fusionTime = 0; }
  function siblingGravityRange(a, b) { return siblingSettings.rangeBase + siblingSettings.rangeScale * (a.radius + b.radius); }
  function fusionPairs(cells) {
    const lookup = new Map(cells.map(cell => [cell.id, cell]));
    const pairs = [];
    for (const donor of cells) if (donor.fusionRole === 'donor') {
      const receiver = lookup.get(donor.fusionTargetId);
      if (receiver && receiver.fusionDonorId === donor.id && receiver.fusionId === donor.fusionId) pairs.push({ donor, receiver });
      else clearFusion(donor);
    }
    for (const cell of cells) if (cell.fusionRole === 'receiver' && !lookup.has(cell.fusionDonorId)) clearFusion(cell);
    return pairs;
  }

  /** Internal sibling forces are equal and opposite; opponents never enter here. */
  function applySiblingGravity(cells, dt) {
    const ordered = [...cells].sort((a, b) => a.id.localeCompare(b.id));
    for (const cell of cells) cell._siblingAwake = Boolean(cell.fusionId);
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i], b = ordered[j];
      if (a.mergeIn > 0 || b.mergeIn > 0 || (a.fusionId && a.fusionId === b.fusionId)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const distance = Math.hypot(dx, dy), range = siblingGravityRange(a, b);
      if (distance > range || distance < 1e-9) continue;
      const nx = dx / distance, ny = dy / distance;
      const mass = a.mass + b.mass, reducedMass = a.mass * b.mass / mass;
      const separating = Math.max(0, (b.vx - a.vx) * nx + (b.vy - a.vy) * ny);
      const acceleration = Math.min(siblingSettings.maxAcceleration,
        siblingSettings.attraction * Math.pow(mass / 72, 0.15) * (1 - 0.5 * distance / range) + siblingSettings.radialDamping * separating);
      const impulse = reducedMass * acceleration * dt;
      a.vx += nx * impulse / a.mass; a.vy += ny * impulse / a.mass;
      b.vx -= nx * impulse / b.mass; b.vy -= ny * impulse / b.mass;
      a._siblingAwake = b._siblingAwake = true;
    }
  }

  /** Contact starts a stable one-to-one absorption; every intermediate step conserves mass, COM and momentum. */
  function advanceSiblingFusion(cells, dt) {
    const existing = fusionPairs(cells);
    const ordered = [...cells].sort((a, b) => a.id.localeCompare(b.id));
    const contacts = [];
    for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i], b = ordered[j];
      if (a.fusionId || b.fusionId || a.mergeIn > 0 || b.mergeIn > 0) continue;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      if (distance <= a.radius + b.radius + 0.5) contacts.push({ a, b, distance });
    }
    contacts.sort((a, b) => a.distance - b.distance || a.a.id.localeCompare(b.a.id) || a.b.id.localeCompare(b.b.id));
    for (const { a, b } of contacts) {
      if (a.fusionId || b.fusionId) continue;
      const receiver = a.mass >= b.mass ? a : b, donor = receiver === a ? b : a;
      const id = `${receiver.id}:${donor.id}`;
      const mass = receiver.mass + donor.mass;
      const vx = (receiver.mass * receiver.vx + donor.mass * donor.vx) / mass;
      const vy = (receiver.mass * receiver.vy + donor.mass * donor.vy) / mass;
      for (const [cell, partner, role] of [[receiver, donor, 'receiver'], [donor, receiver, 'donor']]) {
        cell.fusionId = id; cell.fusionRole = role; cell.fusionPartnerId = partner.id;
        cell.fusionProgress = 0; cell.fusionTime = siblingSettings.fusionDuration;
        cell.vx = vx; cell.vy = vy;
      }
      donor.fusionTargetId = receiver.id; receiver.fusionDonorId = donor.id;
      existing.push({ donor, receiver });
    }
    const removed = new Set();
    for (const { donor, receiver } of existing) {
      const time = donor.fusionTime;
      if (!(time > 0)) continue;
      const step = Math.min(time, Math.max(0, dt)), fraction = step / time;
      const mass = donor.mass + receiver.mass;
      const cx = (donor.mass * donor.x + receiver.mass * receiver.x) / mass;
      const cy = (donor.mass * donor.y + receiver.mass * receiver.y) / mass;
      const vx = (donor.mass * donor.vx + receiver.mass * receiver.vx) / mass;
      const vy = (donor.mass * donor.vy + receiver.mass * receiver.vy) / mass;
      const dx = (donor.x - receiver.x) * (1 - fraction), dy = (donor.y - receiver.y) * (1 - fraction);
      const transfer = donor.mass * fraction;
      donor.mass -= transfer; receiver.mass += transfer;
      donor.x = cx + dx * receiver.mass / mass; donor.y = cy + dy * receiver.mass / mass;
      receiver.x = cx - dx * donor.mass / mass; receiver.y = cy - dy * donor.mass / mass;
      donor.vx = receiver.vx = vx; donor.vy = receiver.vy = vy;
      donor.radius = 4 * Math.sqrt(donor.mass); receiver.radius = 4 * Math.sqrt(receiver.mass);
      donor.fusionTime = receiver.fusionTime = Math.max(0, time - step);
      donor.fusionProgress = receiver.fusionProgress = 1 - donor.fusionTime / siblingSettings.fusionDuration;
      if (donor.fusionTime <= 1e-9) {
        removed.add(donor); receiver._completedFusionId = donor._completedFusionId = donor.fusionId; receiver._fusionCompletedAt = performance.now();
        donor.mass = donor.radius = 0; donor._consumed = true; clearFusion(receiver);
      }
    }

    return removed.size;
  }

  function advanceCellGroup(cells, player, input, dt, beforeMove) {
    for (const cell of cells) cell.mergeIn = Math.max(0, (cell.mergeIn || 0) - dt);
    cells = cells.filter(cell => cell.mass > 0);
    if (cells.length === 1) {
      const cell = cells[0];
      if (siblingEnabled) cell._siblingAwake = Boolean(cell.fusionId);
      beforeMove?.(cell);
      advanceOwnCell(cell, cell, player, input, dt);
      if (siblingEnabled && (cell.fusionRole === 'donor' || cell.fusionRole === 'receiver')) clearFusion(cell);
      return;
    }
    if (siblingEnabled) applySiblingGravity(cells, dt);
    const masses = new Map();
    for (const receiver of cells) if (receiver.mass > 0 && receiver.fusionRole === 'receiver') {
      const donor = cells.find(c => c.id === receiver.fusionDonorId && c.mass > 0 && c.fusionId === receiver.fusionId);
      if (!donor) continue;
      const mass = receiver.mass + donor.mass, vx = (receiver.vx * receiver.mass + donor.vx * donor.mass) / mass, vy = (receiver.vy * receiver.mass + donor.vy * donor.mass) / mass;
      receiver.vx = donor.vx = vx; receiver.vy = donor.vy = vy; masses.set(receiver.id, mass); masses.set(donor.id, mass);
    }
    for (const cell of cells) if (cell.mass > 0) {
      beforeMove?.(cell, masses.get(cell.id));
      advanceOwnCell(cell, cell, player, input, dt, masses.get(cell.id));
    }
    if (siblingEnabled) advanceSiblingFusion(cells, dt);
    for (const cell of cells) if (cell.mass > 0) advanceOwnCell(cell, cell, player, input, 0);
  }
  function replayPlayerCells(player, acknowledged, at, own) {
    const cells = (player.cells || []).filter(cell => !cell.dysonId).map(cellState), snapshotAt = at - simulationLead * 1000;
    let command = player.steering || { x: 0, y: 0 };
    if (own) for (const input of inputHistory) if (input.t <= snapshotAt) command = input;
    const pending = own ? inputHistory.filter(input => input.t > snapshotAt && input.t <= at) : [];
    let cursor = snapshotAt;
    for (const input of [...pending, { t: at }]) {
      const duration = Math.max(0, (input.t - cursor) / 1000), steps = Math.max(1, Math.ceil(duration / motionSettings.physicsStep));
      for (let i = 0; i < steps; i++) advanceCellGroup(cells, player, command, duration / steps);
      command = input; cursor = input.t;
    }
    return new Map(cells.map(cell => [cell.id, cell]));
  }
  function syncModelGeometry(ref, cell, target, previous, externalChange) {
    const model = ref.model, fields = ['fusionId', 'fusionRole', 'fusionPartnerId', 'fusionTargetId', 'fusionDonorId', 'fusionProgress', 'fusionTime'];
    model.id = cell.id;
    const launch = cell.mergeIn > (previous?.mergeIn || 0) + .05;
    const fusionConfirmed = target.fusionId && model.fusionId !== target.fusionId && model._completedFusionId !== target.fusionId;
    const fusionFinished = !cell.fusionId && previous?.fusionId && model.fusionId;
    if (!Number.isFinite(model.mass) || externalChange || launch || fusionConfirmed || fusionFinished) {
      model.mass = target.mass; model.radius = 4 * Math.sqrt(Math.max(0, target.mass));
      model.mergeIn = target.mergeIn;
      for (const field of fields) model[field] = target[field];
      if (externalChange || launch) { delete model._consumed; delete model._completedFusionId; }
    } else if (!model._consumed && !model.fusionId && !cell.fusionId && !model._completedFusionId) {
      model.mass = cell.mass; model.radius = 4 * Math.sqrt(Math.max(0, cell.mass));
    }
    model.mergeIn ??= target.mergeIn;
    model.radius = 4 * Math.sqrt(Math.max(0, model.mass));
  }
  function effectiveCell(player, cell, at = lastFrame) {
    if (cell.dysonId) return null;
    const own = player.id === myId, proxy = own ? predictedCells.get(cell.id) : remotePhysics.get(`${player.id}:${cell.id}`), model = proxy?.model;
    const mass = model?.mass ?? cell.mass;
    if (model?._consumed || mass <= 0) return null;
    const radius = 4 * Math.sqrt(Math.max(0, mass));
    const gravityExtra = (cell.gravityRadius || 0) - cell.radius - 3 * Math.sqrt(cell.mass);
    const geometry = model || cell;
    return { ...cell, mass, radius, mergeIn: geometry.mergeIn ?? cell.mergeIn, fusionId: geometry.fusionId, fusionRole: geometry.fusionRole, fusionPartnerId: geometry.fusionPartnerId, fusionProgress: geometry.fusionProgress || 0,
      _fusionCompletedAt: model?._fusionCompletedAt,
      gravityRadius: cell.gravityRadius ? radius + 3 * Math.sqrt(mass) + gravityExtra : 0 };
  }

  function ingestSnapshot(next, at) {
    receiveBlinkConsumption(next);
    if (next.arena?.width > 0) WORLD.width = next.arena.width;
    if (next.arena?.height > 0) WORLD.height = next.arena.height;
    motionSettings = { ...defaultMotion, ...next.motion };
    siblingEnabled = Boolean(next.sibling); siblingSettings = { ...defaultSibling, ...next.sibling };
    const snapshotAt = Number.isFinite(next.simulationTime) ? next.simulationTime : Number.isFinite(next.serverTime) ? next.serverTime : (next.time || 0) * 1000;
    if (!renderTimeline || !room || next.round !== room.round || next.code !== room.code || snapshotAt < room._renderTime) {
      renderTimeline = { time: snapshotAt, at, target: snapshotAt, targetAt: at, rate: 1 };
    } else {
      renderTimeline.target = snapshotAt; renderTimeline.targetAt = at;
    }
    if (room?.status === 'playing' && at - lastSnapshotAt > 650) predictionPaused = true;
    next._renderTime = snapshotAt; next._receivedAt = at;
    const own = next.players.find((p) => p.id === myId), previousOwn = room?.players?.find((p) => p.id === myId);
    const acknowledged = inputHistory.find((input) => input.seq === own?.lastInputSeq);
    const inputRoundTrip = acknowledged ? Math.max(0, at - acknowledged.t - (own.inputAge || 0) * 1000) : 0;
    simulationLead = clamp((rtt ?? inputRoundTrip) / 2000, 0, .25);
    const cellsPresent = new Set(), dustPresent = new Set();
    if (room && (next.round !== room.round || next.code !== room.code)) { remotePhysics.clear(); contactEpisodes.clear(); predictedContactEffects.clear(); }
    for (const player of next.players) {
      const previousPlayer = room?.players?.find((p) => p.id === player.id);
      const authorityCells = replayPlayerCells(player, acknowledged, at, player.id === myId);
      for (const cell of player.cells || []) {
        const key = `${player.id}:${cell.id}`; cellsPresent.add(key);
        if (cell.dysonId) {
          // The source keeps its mass and ID while orbiting, but is not a body.
          // Its presentation comes from the target's current-time proxy.
          const model = cellState(cell), ownCell = player.id === myId;
          const oldRef = ownCell ? predictedCells.get(cell.id) : remotePhysics.get(key);
          const ref = oldRef || { visual: { x: cell.x, y: cell.y }, presented: false };
          Object.assign(ref, { model, authority: { ...model }, modelAt: at, authorityAt: at, cell, player, offsetX: 0, offsetY: 0, correctionX: 0, correctionY: 0, contactUntil: 0, normals: [] });
          if (ownCell) { ref.x = cell.x; ref.y = cell.y; predictedCells.set(cell.id, ref); } else remotePhysics.set(key, ref);
          const previousShell = room?.players?.find(p => p.id === player.id)?.cells?.find(c => c.id === cell.id)?.dysonId;
          if (previousShell !== cell.dysonId) clearDysonSourceContacts(key);
          continue;
        }
        const previousCell = previousPlayer?.cells?.find((c) => c.id === cell.id);
        const blinked = Boolean(cell.lastWaveBlinkId && cell.lastWaveBlinkId !== previousCell?.lastWaveBlinkId) || Boolean(player.lastWaveBlink?.id && player.lastWaveBlink.id !== previousPlayer?.lastWaveBlink?.id && player.lastWaveBlink.sourceCellId === cell.id);
        if (blinked) {
          clearDysonSourceContacts(key); cellTracks.delete(key);
          for (const track of meteorTracks.values()) if (track.pendingImpact?.playerId === player.id && track.pendingImpact.cellId === cell.id) { track.pendingImpact = null; track.ignoredBody = key; }
        }
        addTrack(cellTracks, key, cell, snapshotAt);
        const dysonReturned = Boolean(previousCell?.dysonId) || Boolean(player.lastDysonEnd?.id && player.lastDysonEnd.id !== previousPlayer?.lastDysonEnd?.id && player.lastDysonEnd.sourceCellId === cell.id);
        if (dysonReturned) clearDysonSourceContacts(key);
        const relocated = previousCell && Math.hypot(cell.x - previousCell.x, cell.y - previousCell.y) > 350;
        const fractured = previousCell && !cell.fusionId && !previousCell.fusionId && cell.mass < previousCell.mass * .8;
        const waveHit = player.lastWaveHit;
        const cellWaveImpulse = cell.lastWaveHitId && cell.lastWaveHitId !== previousCell?.lastWaveHitId;
        const newWaveImpulse = cellWaveImpulse || (waveHit?.id && waveHit.id !== previousPlayer?.lastWaveHit?.id && next.time - waveHit.at <= .8 && (waveHit.hitCellIds || [waveHit.cellId]).includes(cell.id));
        const meteorHit = player.lastMeteorHit;
        const cellMeteorImpulse = cell.lastMeteorHitId && cell.lastMeteorHitId !== previousCell?.lastMeteorHitId;
        const newMeteorImpulse = cellMeteorImpulse || (meteorHit?.id && meteorHit.id !== previousPlayer?.lastMeteorHit?.id && next.time - meteorHit.at <= .8 && (meteorHit.hitCellIds || [meteorHit.cellId]).includes(cell.id));
        const newHitImpulse = newWaveImpulse || newMeteorImpulse;
        if (player.id === myId) {
          const model = authorityCells.get(cell.id);
          let p = predictedCells.get(cell.id);
          const structural = !p || dysonReturned || blinked || player.respawnIn > 0 || next.round !== room?.round || (relocated && !predictionPaused);
          if (structural) {
            const blinkVisual = blinked ? newBlinkPresentation(p, model, at) : null;
            p = { x: model.x, y: model.y, vx: model.vx, vy: model.vy, offsetX: 0, offsetY: 0, model, normals: [], contactUntil: 0,
              blinkVisual, blinkFrom: blinkVisual ? { x: blinkVisual.fromX, y: blinkVisual.fromY } : null };
            predictedCells.set(cell.id, p);
          } else {
            // Keep one continuous local simulation. Replacing it at 15 Hz and
            // hiding the replacement in a fading offset creates speed pulses.
            if (fractured) { p.model.vx = cell.vx || 0; p.model.vy = cell.vy || 0; }
            const newImpact = player.lastImpact?.id && player.lastImpact.id !== previousPlayer?.lastImpact?.id;
            const revised = player.collisionRevision !== previousPlayer?.collisionRevision && player.dysonRevision === previousPlayer?.dysonRevision && player.waveBlinkRevision === previousPlayer?.waveBlinkRevision;
            const velocityError = Math.hypot(model.vx - p.model.vx, model.vy - p.model.vy);
            if ((newHitImpulse && velocityError > 1) || (newImpact && velocityError > 1) || (p.contactUntil <= at && revised && velocityError > motionSettings.restingThreshold)) {
              // A server-only impact is real momentum, unlike ordinary ACK
              // phase noise. Apply it once without moving the visible body.
              p.model.vx = model.vx; p.model.vy = model.vy;
              p.modelAt = at;
              p.correctionX = p.correctionY = 0; p.contactUntil = at + 180; p.normals = [];
            }
          }
          if (structural) p.modelAt = at;
          syncModelGeometry(p, cell, model, previousCell, fractured || newHitImpulse);
          p.authority = { ...model }; p.authorityAt = at; p.cell = cell; p.player = player;
          p.stopConfirmed = Boolean(acknowledged && !acknowledged.x && !acknowledged.y);
        } else {
          const steering = player.steering || { x: 0, y: 0 };
          const target = authorityCells.get(cell.id);
          let proxy = remotePhysics.get(key);
          if (!proxy || dysonReturned || blinked || (relocated && !predictionPaused) || next.round !== room?.round) {
            const blinkVisual = blinked ? newBlinkPresentation(proxy, target, at) : null;
            proxy = { model: { ...target }, authority: { ...target }, visual: { x: target.x, y: target.y }, presented: false, offsetX: 0, offsetY: 0, island: false, islandUntil: 0, contactUntil: 0, normals: [],
              blinkVisual, blinkFrom: blinkVisual ? { x: blinkVisual.fromX, y: blinkVisual.fromY } : null };
            remotePhysics.set(key, proxy);
          } else {
            proxy.authority = target;
            const newImpact = player.lastImpact?.id && player.lastImpact.id !== previousPlayer?.lastImpact?.id;
            if (fractured || newHitImpulse || newImpact) { proxy.model.vx = target.vx; proxy.model.vy = target.vy; proxy.modelAt = at; }
          }
          syncModelGeometry(proxy, cell, target, previousCell, fractured || newHitImpulse);
          proxy.cell = cell; proxy.player = player; proxy.steering = steering;
          proxy.modelAt ??= at; proxy.authorityAt = at;
        }
      }
      const refs = (player.cells || []).map(cell => player.id === myId ? predictedCells.get(cell.id) : remotePhysics.get(`${player.id}:${cell.id}`)).filter(Boolean);
      for (const ref of refs) if (!ref.cell.dysonId && ref.modelAt === at && ref.model.fusionId) {
        const partner = refs.find(other => other.model.id === ref.model.fusionPartnerId && other.model.fusionId === ref.model.fusionId);
        if (!partner || partner.modelAt >= at) continue;
        // A real impulse is received between frames. Keep its coupled fusion
        // pair on one epoch without treating the briefly older partner as orphaned.
        if (partner.authority && !partner.model._consumed && !partner.model._completedFusionId) {
          for (const field of ['mass', 'radius', 'mergeIn', 'fusionId', 'fusionRole', 'fusionPartnerId', 'fusionTargetId', 'fusionDonorId', 'fusionProgress', 'fusionTime']) partner.model[field] = partner.authority[field];
        }
        partner.modelAt = at;
      }
      const total = refs.reduce((sum, ref) => sum + Math.max(0, ref.model.mass || 0), 0), expected = player.cells.reduce((sum, cell) => sum + cell.mass, 0);
      if (total > 0 && Math.abs(total - expected) > .005) for (const ref of refs) { ref.model.mass *= expected / total; ref.model.radius = 4 * Math.sqrt(ref.model.mass); }
    }
    for (const key of cellTracks.keys()) if (!cellsPresent.has(key)) cellTracks.delete(key);
    for (const key of remotePhysics.keys()) if (!cellsPresent.has(key)) remotePhysics.delete(key);
    while (remotePhysics.size > 128) remotePhysics.delete(remotePhysics.keys().next().value);
    const ownIds = new Set((own?.cells || []).map((c) => c.id));
    for (const id of predictedCells.keys()) if (!ownIds.has(id)) predictedCells.delete(id);
    if (Number.isFinite(own?.lastInputSeq)) {
      lastInputAck = own.lastInputSeq;
      while (inputHistory.length > 1 && inputHistory[0].seq < lastInputAck) inputHistory.shift();
    }
    for (const dust of next.dust) { dustPresent.add(dust.id); addTrack(dustTracks, dust.id, dust, snapshotAt); }
    for (const id of dustTracks.keys()) if (!dustPresent.has(id)) dustTracks.delete(id);
    lastSnapshotAt = at;
  }

  function followAuthority(body, dt, at) {
    const ref = body.ref, target = ref.authority, model = body.position;
    if (!target) return;
    if (ref.modelAt < ref.authorityAt) {
      // A packet may arrive between two render frames. Keep the correction
      // already in progress until both states reach the same simulation time.
      if (body.own) { model.x += (ref.correctionX || 0) * dt; model.y += (ref.correctionY || 0) * dt; }
      return;
    }
    let dx = target.x - model.x, dy = target.y - model.y, dvx = target.vx - model.vx, dvy = target.vy - model.vy;
    if (ref.contactUntil > at) {
      // Old snapshots cannot pull a resting contact back through the surface.
      for (const normal of ref.normals || []) {
        const closingPosition = dx * normal.x + dy * normal.y;
        if (closingPosition < 0) { dx -= normal.x * closingPosition; dy -= normal.y * closingPosition; }
        const closingVelocity = dvx * normal.x + dvy * normal.y;
        if (closingVelocity < 0) { dvx -= normal.x * closingVelocity; dvy -= normal.y * closingVelocity; }
      }
    }
    if (ref.contactUntil <= at) {
      // ACK timing is quantized by the server tick. Filter that phase error
      // into a bounded correction velocity, separate from physical momentum.
      const error = Math.hypot(dx, dy), limit = 30;
      const scale = error > 0 ? Math.min(2, limit / error) : 0;
      const blend = 1 - Math.exp(-dt * 8);
      ref.correctionX = (ref.correctionX || 0) + (dx * scale - (ref.correctionX || 0)) * blend;
      ref.correctionY = (ref.correctionY || 0) + (dy * scale - (ref.correctionY || 0)) * blend;
      if (body.steering?.x || body.steering?.y) {
        const speed = Math.hypot(model.vx, model.vy), nx = speed > 1e-7 ? model.vx / speed : 0, ny = speed > 1e-7 ? model.vy / speed : 0;
        const opposing = ref.correctionX * nx + ref.correctionY * ny;
        if (opposing < -speed * .2) { ref.correctionX -= nx * (opposing + speed * .2); ref.correctionY -= ny * (opposing + speed * .2); }
      }
      if (ref.stopConfirmed && Math.hypot(model.vx, model.vy, target.vx, target.vy) < motionSettings.stopSpeed && error < .03 && Math.hypot(ref.correctionX, ref.correctionY) < .15) {
        model.x = target.x; model.y = target.y; ref.correctionX = ref.correctionY = 0;
        return;
      }
      model.x = clamp(model.x + ref.correctionX * dt, body.cell.radius, WORLD.width - body.cell.radius);
      model.y = clamp(model.y + ref.correctionY * dt, body.cell.radius, WORLD.height - body.cell.radius);
      return;
    }
    ref.correctionX = ref.correctionY = 0;
    const blend = 1 - Math.exp(-dt * 10), error = Math.hypot(dx, dy), limit = (ref.contactUntil > at ? 30 : 100) * dt;
    const correction = error > 0 ? Math.min(blend, limit / error) : 0;
    model.x = clamp(model.x + dx * correction, body.cell.radius, WORLD.width - body.cell.radius);
    model.y = clamp(model.y + dy * correction, body.cell.radius, WORLD.height - body.cell.radius);
    model.vx += dvx * blend; model.vy += dvy * blend;
  }

  function physicsBodies() {
    const bodies = [];
    for (const player of room?.players || []) {
      if (player.respawnIn > 0) continue;
      for (const cell of player.cells || []) {
        if (cell.dysonId) continue;
        const key = `${player.id}:${cell.id}`, own = player.id === myId;
        let ref = own ? predictedCells.get(cell.id) : remotePhysics.get(key);
        if (!ref) {
          if (own) continue;
          ref = { model: cellState(cell), visual: { x: cell.x, y: cell.y }, presented: false, offsetX: 0, offsetY: 0, island: false, islandUntil: 0, contactUntil: 0, normals: [], cell, player, steering: player.steering || { x: 0, y: 0 } };
          remotePhysics.set(key, ref);
        }
        const position = ref.model || ref;
        if (position._consumed || position.mass <= 0) continue;
        position.vx ||= 0; position.vy ||= 0;
        bodies.push({ key, cell: position, player, own, ref, position, previousX: position._frameX ?? position.x, previousY: position._frameY ?? position.y });
      }
    }
    return bodies;
  }

  function predictOwn(dt, at) {
    const me = room?.players?.find((p) => p.id === myId);
    if (!me || room.status !== 'playing' || me.respawnIn > 0 || reconnecting) return;
    if (at - lastSnapshotAt > 650) { predictionPaused = true; return; }
    const input = getIntent(), bodies = physicsBodies();
    if (!bodies.length) return;
    let elapsed = Math.max(0, dt, ...bodies.map(body => (at - (body.ref.modelAt ?? at)) / 1000));
    if (predictionPaused || elapsed > 1) {
      // A stale connection is a paused prediction epoch. A new state may
      // correct it gradually, but cannot turn unseen wall time into one leap.
      for (const body of bodies) {
        const ref = body.ref, visible = body.own ? ref : ref.visual;
        body.position.x = visible?.x ?? body.position.x; body.position.y = visible?.y ?? body.position.y;
        if (ref.authority) { body.position.vx = ref.authority.vx; body.position.vy = ref.authority.vy; }
        ref.modelAt = Math.max(at, ref.authorityAt || at);
        ref.offsetX = ref.offsetY = ref.correctionX = ref.correctionY = 0;
        ref.normals = []; ref.contactUntil = 0; body.motion = null;
      }
      predictionPaused = false; elapsed = 0;
    }
    const steps = Math.max(1, Math.ceil(elapsed / motionSettings.physicsStep)), step = elapsed / steps;
    const groups = new Map();
    for (const body of bodies) { const group = groups.get(body.player.id) || []; group.push(body); groups.set(body.player.id, group); }
    for (let i = 0; i < steps; i++) {
      const endAt = at - (steps - i - 1) * step * 1000, startAt = endAt - step * 1000;
      const activeBodies = [];
      for (const all of groups.values()) {
        const group = all.filter(body => (body.ref.modelAt ?? startAt) <= endAt + 1e-7);
        if (!group.length) continue;
        activeBodies.push(...group);
        const steering = group[0].own ? input : group[0].ref.steering;
        const commonAt = Math.max(startAt, Math.min(endAt, Math.max(...group.map(body => body.ref.modelAt ?? startAt))));
        for (const body of group) {
          const ref = body.ref; body.steering = steering;
          if (ref.modelAt < commonAt) advanceOwnCell(body.position, body.cell, body.player, steering, (commonAt - ref.modelAt) / 1000);
        }
        const groupElapsed = Math.max(0, (endAt - commonAt) / 1000);
        advanceCellGroup(group.map(body => body.position), group[0].player, steering, groupElapsed, (cell, combinedMass) => {
          const body = group.find(item => item.position === cell), speed = movementSpeed(combinedMass ? { mass: combinedMass } : cell, body.player);
          body.previousX = cell.x; body.previousY = cell.y;
          body.motion = { x: cell.x, y: cell.y, vx: cell.vx, vy: cell.vy, targetX: steering.x * speed, targetY: steering.y * speed, rate: Math.hypot(steering.x, steering.y) > 0 ? motionSettings.response : motionSettings.drag, dt: groupElapsed };
        });
        const authorityGroup = group.filter(body => body.ref.authority);
        if (authorityGroup.length) {
          const authorityAt = Math.max(...authorityGroup.map(body => body.ref.authorityAt));
          if (endAt > authorityAt) {
            advanceCellGroup(authorityGroup.map(body => body.ref.authority), group[0].player, steering, (endAt - authorityAt) / 1000);
            for (const body of authorityGroup) body.ref.authorityAt = endAt;
          }
        }
        for (const body of group) {
          body.ref.modelAt = Math.max(body.ref.modelAt || 0, endAt);
          if (body.cell.mass <= 0) continue;
          followAuthority(body, groupElapsed, at);
          if (body.motion) Object.assign(body.motion, { freeX: body.position.x, freeY: body.position.y, freeVx: body.position.vx, freeVy: body.position.vy });
        }
      }
      collidePredictedBodies(at, step, activeBodies);
    }
    publishVisibleBodies(at, dt, bodies.filter(body => body.cell.mass > 0));
  }

  function separateCircles(a, b, nx, ny, depth) {
    const inverseA = 1 / Math.max(1, a.cell.mass), inverseB = 1 / Math.max(1, b.cell.mass), total = inverseA + inverseB;
    function move(body, dx, dy) { const r = body.cell.radius; body.position.x = clamp(body.position.x + dx, r, WORLD.width - r); body.position.y = clamp(body.position.y + dy, r, WORLD.height - r); }
    const ax = a.position.x, ay = a.position.y, bx = b.position.x, by = b.position.y;
    move(a, nx * depth * inverseA / total, ny * depth * inverseA / total);
    move(b, -nx * depth * inverseB / total, -ny * depth * inverseB / total);
    let remaining = depth - ((a.position.x - ax - b.position.x + bx) * nx + (a.position.y - ay - b.position.y + by) * ny);
    if (remaining > .00001) {
      const x = a.position.x, y = a.position.y; move(a, nx * remaining, ny * remaining);
      remaining -= (a.position.x - x) * nx + (a.position.y - y) * ny;
      if (remaining > .00001) move(b, -nx * remaining, -ny * remaining);
    }
  }

  function validPredictedTrajectory(body) {
    const m = body.motion, p = body.position, r = body.cell.radius;
    return m && m.dt > 0 && Math.abs(p.x - m.freeX) + Math.abs(p.y - m.freeY) + Math.abs(p.vx - m.freeVx) + Math.abs(p.vy - m.freeVy) <= 1e-7 && p.x > r && p.x < WORLD.width - r && p.y > r && p.y < WORLD.height - r;
  }
  function predictedTrajectoryAt(m, seconds) {
    if (m.sweepTime === undefined) {
      const integral = (1 - Math.exp(-m.rate * m.dt)) / m.rate;
      // Reconciliation changes position independently of physical momentum.
      m.driftX = (m.freeX - (m.x + m.targetX * m.dt + (m.vx - m.targetX) * integral)) / m.dt;
      m.driftY = (m.freeY - (m.y + m.targetY * m.dt + (m.vy - m.targetY) * integral)) / m.dt;
      m.sweepTime = 0; m.sweepX = m.x; m.sweepY = m.y; m.sweepVx = m.vx; m.sweepVy = m.vy;
    }
    const elapsed = Math.max(0, seconds - m.sweepTime), decay = Math.exp(-m.rate * elapsed), integral = (1 - decay) / m.rate;
    return { x: m.sweepX + m.targetX * elapsed + (m.sweepVx - m.targetX) * integral + m.driftX * elapsed,
      y: m.sweepY + m.targetY * elapsed + (m.sweepVy - m.targetY) * integral + m.driftY * elapsed,
      vx: m.targetX + (m.sweepVx - m.targetX) * decay, vy: m.targetY + (m.sweepVy - m.targetY) * decay,
      driftX: m.driftX, driftY: m.driftY };
  }
  function resolvePredictedRemainder(a, b, fraction, restitution) {
    const am = a.motion, bm = b.motion, radius = a.cell.radius + b.cell.radius;
    if (!validPredictedTrajectory(a) || !validPredictedTrajectory(b) || Math.abs(am.dt - bm.dt) > 1e-8) return false;
    const startTime = Math.max(am.sweepTime || 0, bm.sweepTime || 0), startA = predictedTrajectoryAt(am, startTime), startB = predictedTrajectoryAt(bm, startTime);
    if (Math.hypot(startA.x - startB.x, startA.y - startB.y) < radius - 1e-6) return false;
    let seconds = am.dt * fraction;
    for (let i = 0; i < 5; i++) {
      const ap = predictedTrajectoryAt(am, seconds), bp = predictedTrajectoryAt(bm, seconds), dx = ap.x - bp.x, dy = ap.y - bp.y;
      const error = dx * dx + dy * dy - radius * radius;
      if (Math.abs(error) < 1e-8) break;
      const derivative = 2 * (dx * (ap.vx + ap.driftX - bp.vx - bp.driftX) + dy * (ap.vy + ap.driftY - bp.vy - bp.driftY));
      if (Math.abs(derivative) < 1e-10) return false;
      seconds = clamp(seconds - error / derivative, startTime, am.dt);
    }
    const ap = predictedTrajectoryAt(am, seconds), bp = predictedTrajectoryAt(bm, seconds), distance = Math.hypot(ap.x - bp.x, ap.y - bp.y);
    if (Math.abs(distance - radius) > 1e-5) return false;
    const nx = (ap.x - bp.x) / distance, ny = (ap.y - bp.y) / distance;
    const closing = -((ap.vx - bp.vx) * nx + (ap.vy - bp.vy) * ny);
    if (closing <= 1e-7) return false;
    if (restitution > 0) emitPredictedContact(a, b, { x: ap.x - nx * a.cell.radius, y: ap.y - ny * a.cell.radius,
      normalX: nx, normalY: ny, speed: closing, at: performance.now() });
    const inverseA = 1 / Math.max(1, a.cell.mass), inverseB = 1 / Math.max(1, b.cell.mass);
    const impulse = (1 + (closing > motionSettings.restingThreshold ? restitution : 0)) * closing / (inverseA + inverseB);
    const remaining = am.dt - seconds;
    for (const [body, magnitude, contact] of [[a, impulse * inverseA, ap], [b, -impulse * inverseB, bp]]) {
      const decay = Math.exp(-body.motion.rate * remaining), displacement = (1 - decay) / body.motion.rate;
      body.position.x += magnitude * nx * displacement; body.position.y += magnitude * ny * displacement;
      body.position.vx += magnitude * nx * decay; body.position.vy += magnitude * ny * decay;
      Object.assign(body.motion, { sweepTime: seconds, sweepX: contact.x, sweepY: contact.y, sweepVx: contact.vx + magnitude * nx, sweepVy: contact.vy + magnitude * ny,
        freeX: body.position.x, freeY: body.position.y, freeVx: body.position.vx, freeVy: body.position.vy });
    }
    return true;
  }

  function collidePredictedBodies(at, dt, suppliedBodies) {
    const contacted = new Set(), bodies = (suppliedBodies || physicsBodies()).filter(body => body.cell.mass > 0), slop = motionSettings.contactSlop;
    function eligible(a, b) { return a.player !== b.player || !(a.cell.fusionId && a.cell.fusionId === b.cell.fusionId); }
    function reach(body, axis) {
      const m = body.motion;
      if (!m) return 0;
      // Inertial velocity stays between its initial and target components;
      // include later contact impulses and the maximum correction velocity.
      const velocity = axis === 'x' ? 'vx' : 'vy', target = axis === 'x' ? 'targetX' : 'targetY', swept = axis === 'x' ? 'sweepVx' : 'sweepVy';
      // Fusion can add endpoint drift beyond reconciliation's 30-unit limit.
      // Its displacement plus twice the inertial envelope bounds that path too.
      return Math.abs(body.position[axis] - m[axis]) + 2 * (Math.max(Math.abs(m[velocity]), Math.abs(m[target]), Math.abs(m[swept] || 0), Math.abs(body.position[velocity])) + 30) * m.dt;
    }
    for (let iteration = 0; iteration < 5; iteration++) {
      let corrected = false;
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        if (!eligible(a, b)) continue;
        const pa = a.position, pb = b.position, radius = a.cell.radius + b.cell.radius;
        if (Math.abs(pa.x - pb.x) > radius + slop + reach(a, 'x') + reach(b, 'x') || Math.abs(pa.y - pb.y) > radius + slop + reach(a, 'y') + reach(b, 'y')) continue;
        const key = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
        const old = contactEpisodes.get(key), fresh = !old || at - old.lastTouch > 250;
        const sharedImpact = a.player.lastImpact?.id && a.player.lastImpact.id === b.player.lastImpact?.id && room.time - a.player.lastImpact.at < .35;
        let dx = pa.x - pb.x, dy = pa.y - pb.y, distance = Math.hypot(dx, dy), nx = distance > 1e-7 ? dx / distance : 1, ny = distance > 1e-7 ? dy / distance : 0;
        let hit = distance <= radius + slop, sweptHit = false;
        if (iteration === 0 && validPredictedTrajectory(a) && validPredictedTrajectory(b)) {
          const startTime = Math.max(a.motion.sweepTime || 0, b.motion.sweepTime || 0), startA = predictedTrajectoryAt(a.motion, startTime), startB = predictedTrajectoryAt(b.motion, startTime);
          const sx = startA.x - startB.x, sy = startA.y - startB.y, vx = dx - sx, vy = dy - sy;
          const aa = vx * vx + vy * vy, bb = 2 * (sx * vx + sy * vy), cc = sx * sx + sy * sy - radius * radius, discriminant = bb * bb - 4 * aa * cc;
          if (aa > 1e-9 && cc >= -slop && discriminant >= 0) {
            const impact = (-bb - Math.sqrt(discriminant)) / (2 * aa);
            if (impact >= -1e-7 && impact <= 1) {
              const ix = sx + vx * clamp(impact, 0, 1), iy = sy + vy * clamp(impact, 0, 1), length = Math.hypot(ix, iy) || 1;
              if (vx * ix + vy * iy < 0) {
                nx = ix / length; ny = iy / length; hit = true; sweptHit = true;
                const fraction = (startTime + (a.motion.dt - startTime) * clamp(impact, 0, 1)) / a.motion.dt;
                resolvePredictedRemainder(a, b, fraction, fresh && !sharedImpact ? motionSettings.restitution : 0);
                dx = pa.x - pb.x; dy = pa.y - pb.y;
                const depth = radius - (dx * nx + dy * ny);
                if (depth > 1e-7) { separateCircles(a, b, nx, ny, depth); corrected = true; }
                dx = pa.x - pb.x; dy = pa.y - pb.y; distance = Math.hypot(dx, dy);
              }
            }
          }
        }
        if (!hit) continue;
        // Slop supports resting bodies, but must not cancel a fast approach
        // before actual contact; the relative sweep supplies that contact.
        if (!sweptHit && distance > radius + 1e-7 && -((pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny) > motionSettings.restingThreshold) continue;
        if (distance < radius - 1e-7) { separateCircles(a, b, nx, ny, radius - distance); corrected = true; }
        const normalVelocity = (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny;
        if (fresh && !sharedImpact && normalVelocity < -12) emitPredictedContact(a, b, {
          x: pa.x - nx * a.cell.radius, y: pa.y - ny * a.cell.radius,
          normalX: nx, normalY: ny, speed: -normalVelocity, at });
        if (normalVelocity < -1e-7) {
          const restitution = fresh && !sharedImpact && -normalVelocity > motionSettings.restingThreshold ? motionSettings.restitution : 0;
          const inverseA = 1 / Math.max(1, a.cell.mass), inverseB = 1 / Math.max(1, b.cell.mass), impulse = -(1 + restitution) * normalVelocity / (inverseA + inverseB);
          pa.vx += impulse * inverseA * nx; pa.vy += impulse * inverseA * ny;
          pb.vx -= impulse * inverseB * nx; pb.vy -= impulse * inverseB * ny;
        }
        contactEpisodes.set(key, { lastTouch: at });
        for (const [body, x, y] of [[a, nx, ny], [b, -nx, -ny]]) {
          body.ref.contactUntil = at + 180; body.ref.normals = [{ x, y }];
          if (body.own) contacted.add(body.cell.id); else body.ref.islandUntil = at + 400;
        }
      }
      if (!corrected) break;
    }
    for (const [key, episode] of contactEpisodes) if (at - episode.lastTouch > 700) contactEpisodes.delete(key);
    while (contactEpisodes.size > 512) contactEpisodes.delete(contactEpisodes.keys().next().value);
    constrainClientContactVelocities(bodies);
    if (!suppliedBodies) publishVisibleBodies(at, dt, bodies);
    return contacted;
  }

  function constrainClientContactVelocities(bodies) {
    const slop = motionSettings.contactSlop, touching = [];
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (a.player === b.player && a.cell.fusionId && a.cell.fusionId === b.cell.fusionId) continue;
      const dx = a.position.x - b.position.x, dy = a.position.y - b.position.y, radius = a.cell.radius + b.cell.radius;
      if (Math.abs(dx) > radius + slop || Math.abs(dy) > radius + slop) continue;
      const distance = Math.hypot(dx, dy), gap = distance - radius;
      if (gap <= slop) touching.push({ a, b, gap, nx: distance > 1e-9 ? dx / distance : 1, ny: distance > 1e-9 ? dy / distance : 0 });
    }
    function walls(body) {
      const p = body.position, r = body.cell.radius;
      const response = (v, gap) => Math.abs(v) <= motionSettings.restingThreshold ? 0 : gap <= 1e-7 ? -v * motionSettings.restitution : v;
      if (p.x <= r + slop && p.vx < 0) p.vx = response(p.vx, p.x - r);
      if (p.x >= WORLD.width - r - slop && p.vx > 0) p.vx = response(p.vx, WORLD.width - r - p.x);
      if (p.y <= r + slop && p.vy < 0) p.vy = response(p.vy, p.y - r);
      if (p.y >= WORLD.height - r - slop && p.vy > 0) p.vy = response(p.vy, WORLD.height - r - p.y);
    }
    for (let iteration = 0; iteration < 128; iteration++) {
      for (const body of bodies) walls(body);
      let closing = 0;
      for (const { a, b, gap, nx, ny } of touching) {
        const pa = a.position, pb = b.position, relative = (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny;
        if (relative >= -1e-6 || (gap > 1e-7 && -relative > motionSettings.restingThreshold)) continue;
        closing = Math.max(closing, -relative);
        const inverseA = 1 / Math.max(1, a.cell.mass), inverseB = 1 / Math.max(1, b.cell.mass), impulse = -relative / (inverseA + inverseB);
        pa.vx += impulse * inverseA * nx; pa.vy += impulse * inverseA * ny;
        pb.vx -= impulse * inverseB * nx; pb.vy -= impulse * inverseB * ny;
      }
      if (closing < 1e-5) break;
    }
    for (const body of bodies) walls(body);
  }

  function publishVisibleBodies(at, dt, bodies) {
    const ownBodies = bodies.filter((body) => body.own), visualBodies = [];
    remoteContactPositions.clear(); remoteContactFrame = at;
    for (const body of bodies) {
      const ref = body.ref, model = body.position;
      if (body.own) {
        ref.offsetX = (ref.offsetX || 0) * Math.exp(-dt * 12); ref.offsetY = (ref.offsetY || 0) * Math.exp(-dt * 12);
        ref.x = model.x + ref.offsetX; ref.y = model.y + ref.offsetY; ref.vx = model.vx; ref.vy = model.vy;
        visualBodies.push({ ...body, position: ref });
      } else {
        for (const own of ownBodies) {
          const relativeSpeed = Math.hypot(model.vx - own.position.vx, model.vy - own.position.vy);
          // Proximity scopes immediate contact feedback. Every displayed body
          // keeps the same clock and solid collisions at every distance.
          if (Math.hypot(model.x - own.position.x, model.y - own.position.y) < body.cell.radius + own.cell.radius + Math.max(110, relativeSpeed * (simulationLead + .5))) ref.islandUntil = at + 400;
        }
        if (!ref.presented) {
          ref.offsetX = ref.offsetY = 0; ref.presented = true;
        }
        ref.island = ref.islandUntil > at;
        ref.offsetX *= Math.exp(-dt * 12); ref.offsetY *= Math.exp(-dt * 12);
        ref.visual.x = model.x + ref.offsetX; ref.visual.y = model.y + ref.offsetY;
        visualBodies.push({ ...body, position: ref.visual });
        remoteContactPositions.set(body.key, ref.visual);
      }
    }
    // Rendering offsets do not participate in impulses or authority replay.
    // Enforce only geometry here, so smoothing can never show bodies crossing.
    for (let iteration = 0; iteration < 4; iteration++) for (let i = 0; i < visualBodies.length; i++) for (let j = i + 1; j < visualBodies.length; j++) {
      const a = visualBodies[i], b = visualBodies[j];
      if (a.player === b.player && a.cell.fusionId && a.cell.fusionId === b.cell.fusionId) continue;
      const pa = a.position, pb = b.position, radius = a.cell.radius + b.cell.radius;
      const mx = a.ref.model?.x ?? pa.x, my = a.ref.model?.y ?? pa.y, ox = b.ref.model?.x ?? pb.x, oy = b.ref.model?.y ?? pb.y;
      if ((Math.abs(mx - ox) > radius + 2 || Math.abs(my - oy) > radius + 2) && (Math.abs(pa.x - pb.x) > radius || Math.abs(pa.y - pb.y) > radius)) continue;
      const physicalDistance = Math.hypot(mx - ox, my - oy);
      let dx = pa.x - pb.x, dy = pa.y - pb.y, distance = Math.hypot(dx, dy);
      if (physicalDistance <= radius + 2) {
        const nx = physicalDistance > 1e-7 ? (mx - ox) / physicalDistance : 1, ny = physicalDistance > 1e-7 ? (my - oy) / physicalDistance : 0;
        const depth = radius - (dx * nx + dy * ny); if (depth > 1e-7) separateCircles(a, b, nx, ny, depth);
      } else if (distance < radius) separateCircles(a, b, distance > 1e-7 ? dx / distance : 1, distance > 1e-7 ? dy / distance : 0, radius - distance);
    }
    for (const body of visualBodies) {
      // Store the independent display error after a positional-only projection.
      if (body.own) { body.ref.offsetX = body.ref.x - body.ref.model.x; body.ref.offsetY = body.ref.y - body.ref.model.y; }
      else { body.ref.offsetX = body.ref.visual.x - body.ref.model.x; body.ref.offsetY = body.ref.visual.y - body.ref.model.y; }
    }
  }

  function updateCamera(dt) {
    const me = room?.players?.find((p) => p.id === myId), center = getOwnCenter();
    const mobile = width < 700;
    let targetX = center?.x ?? WORLD.width / 2, targetY = center?.y ?? WORLD.height / 2;
    let targetScale = (mobile ? .8 : .95) / Math.pow(Math.max(36, me?.mass || 36) / 36, .1);
    const shell = dysonPose(me, lastFrame || performance.now());
    const focusId = shell?.id || null;
    const blinkId = me?.lastWaveBlink?.id || null;
    if (camera.dysonId !== focusId || camera.blinkId !== blinkId) {
      const warp = predictedCells.get(me?.lastWaveBlink?.sourceCellId)?.blinkVisual;
      if (camera.blinkId !== blinkId && warp && Number.isFinite(camera.x)) {
        camera.warp = { startedAt: warp.startedAt, duration: warp.duration,
          fromOffsetX: camera.x - targetX, fromOffsetY: camera.y - targetY,
          toOffsetX: camera.warp?.toOffsetX ?? camera.x - (camera.targetX ?? targetX),
          toOffsetY: camera.warp?.toOffsetY ?? camera.y - (camera.targetY ?? targetY) };
      } else if (camera.dysonId !== focusId) camera.warp = null;
      // A deliberate transformation changes the focus, not its physical speed.
      camera.targetX = targetX; camera.targetY = targetY; camera.dysonId = focusId; camera.blinkId = blinkId;
    }
    if (shell) targetScale = Math.min(targetScale, width * .72 / (shell.radius * 2 + 160), height * .62 / (shell.radius * 2 + 160));
    if (!shell && me?.cells?.length > 1) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of me.cells) { if (c.dysonId) continue; const p = predictedCells.get(c.id) || c, model = p.model || c; if (model.mass <= 0) continue; const r = model.radius ?? c.radius; minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r); minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r); }
      targetScale = Math.min(targetScale, width * .7 / Math.max(250, maxX - minX + 180), height * .65 / Math.max(200, maxY - minY + 180));
    }
    const minScale = Math.max(width / 3200, height / 2300, mobile ? .3 : .35);
    targetScale = clamp(targetScale, minScale, mobile ? 1 : 1.15);
    if (camera.warp) {
      const warp = camera.warp, progress = clamp(((lastFrame || performance.now()) - warp.startedAt) / warp.duration, 0, 1);
      const ease = progress * progress * (3 - 2 * progress);
      camera.x = targetX + warp.fromOffsetX * (1 - ease) + warp.toOffsetX * ease;
      camera.y = targetY + warp.fromOffsetY * (1 - ease) + warp.toOffsetY * ease;
      camera.scale += (targetScale - camera.scale) * (1 - Math.exp(-dt * 3));
      // End on the pre-existing follow lag, rather than adding a second slow
      // camera catch-up after the source has already arrived.
      if (progress >= 1) camera.warp = null;
    } else if (!Number.isFinite(camera.x) || Math.hypot(camera.x - targetX, camera.y - targetY) > 1600) { camera.x = targetX; camera.y = targetY; camera.scale = targetScale; }
    else {
      const previousX = camera.targetX ?? targetX, previousY = camera.targetY ?? targetY;
      const decay = Math.exp(-dt * 9), integral = (1 - decay) / 9;
      const velocityX = dt > 0 ? (targetX - previousX) / dt : 0, velocityY = dt > 0 ? (targetY - previousY) / dt : 0;
      // Follow a moving target through the whole frame, including long frames.
      // Treating its final position as stationary makes the camera lurch ahead.
      camera.x = targetX + (camera.x - previousX) * decay - velocityX * integral;
      camera.y = targetY + (camera.y - previousY) * decay - velocityY * integral;
      camera.scale += (targetScale - camera.scale) * (1 - Math.exp(-dt * 3));
    }
    camera.targetX = targetX; camera.targetY = targetY;
    camera.scale = Math.max(camera.scale, minScale);
    const halfW = width / 2 / camera.scale, halfH = height / 2 / camera.scale;
    camera.x = clamp(camera.x, Math.min(halfW - 35, WORLD.width / 2), Math.max(WORLD.width - halfW + 35, WORLD.width / 2));
    camera.y = clamp(camera.y, Math.min(halfH - 35, WORLD.height / 2), Math.max(WORLD.height - halfH + 35, WORLD.height / 2));
  }

  function getCamera() {
    const x = Number.isFinite(camera.x) ? camera.x : getOwnCenter()?.x ?? WORLD.width / 2;
    const y = Number.isFinite(camera.y) ? camera.y : getOwnCenter()?.y ?? WORLD.height / 2;
    return { x, y, scale: camera.scale, offsetX: width / 2 - x * camera.scale, offsetY: height / 2 - y * camera.scale, width: width / camera.scale, height: height / camera.scale };
  }
  function visible(x, y, radius, view) { return x + radius >= view.x - view.width / 2 && x - radius <= view.x + view.width / 2 && y + radius >= view.y - view.height / 2 && y - radius <= view.y + view.height / 2; }

  function render(time) {
    if (!active || !ctx) return;
    const interval = time - (lastFrame || time), dt = Math.max(0, interval / 1000); lastFrame = time;
    updateRenderQuality(time, interval);
    if (!fpsStarted) fpsStarted = time;
    frameCount++; if (time - fpsStarted >= 700) { fps = Math.round(frameCount * 1000 / (time - fpsStarted)); frameCount = 0; fpsStarted = time; }
    predictOwn(dt, time); updateCamera(dt);
    const view = getCamera();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); drawBackground();
    ctx.save(); ctx.translate(view.offsetX, view.offsetY); ctx.scale(view.scale, view.scale); drawArena(view);
    renderedDust = 0; renderedCells = 0; renderedMeteors = 0;
    if (room) {
      const sampleAt = renderSimulationTime(time) - 100;
      for (const dust of room.dust) {
        const position = sampleTrack(dustTracks.get(dust.id), sampleAt, 75) || dust;
        const radius = dust.fragment ? Math.sqrt(dust.value || 1) * 4 * 1.3 + 30 : 15;
        if (!visible(position.x, position.y, radius, view)) continue;
        drawDust(dust, position, time); renderedDust++;
      }
      for (const meteor of room.meteors || []) {
        const pose = meteorPose(meteor, time);
        if (!pose) continue;
        const extent = (meteor.tailLength || 90) + (meteor.radius || 4) * 2;
        if (!visible(pose.x, pose.y, extent, view)) continue;
        drawMeteor(meteor, pose); renderedMeteors++;
      }
      for (const [id, entry] of waveVisuals) {
        if (entry.missingSince !== null && time - entry.missingSince > 100) { waveVisuals.delete(id); continue; }
        const blast = entry.blast;
        const pose = wavePose(blast, time);
        if (!pose.active) continue;
        const extent = Math.hypot((blast.width || 160) / 2, (blast.curvature || 30) + pose.tail) + (blast.thickness || 20) + 10;
        if (visible(pose.x, pose.y, extent, view)) drawBlast(blast, time, pose);
      }
      drawnPlayers.clear();
      for (const player of room.players) {
        if (player.respawnIn > 0) continue;
        const cells = (player.cells || []).map(cell => effectiveCell(player, cell, time)).filter(Boolean);
        let primary = cells[0]; for (const c of cells) if (!primary || c.mass > primary.mass) primary = c;
        for (const cell of cells) {
          const own = player.id === myId;
          const ref = own ? predictedCells.get(cell.id) : remotePhysics.get(`${player.id}:${cell.id}`);
          const position = planetPresentation(ref, cell, time);
          drawnPlayers.set(`${player.id}:${cell.id}`, { x: position.x, y: position.y, radius: cell.radius });
          if (own && position.warpProgress === undefined && cell.gravityRadius && visible(position.x, position.y, cell.gravityRadius, view)) drawGravity(position.x, position.y, cell.gravityRadius, player.color, time, primary === cell);
          if (!visible(position.x, position.y, cell.radius * 2.3 + 35, view)) continue;
          if (position.warpProgress !== undefined || position.blinkAnticipation > 0) {
            const stretch = position.warpProgress !== undefined ? Math.sin(position.warpProgress * Math.PI) : position.blinkAnticipation;
            ctx.save(); ctx.translate(position.x, position.y); ctx.rotate(position.warpAngle);
            ctx.scale(1 + stretch * .8, 1 - stretch * .7); ctx.rotate(-position.warpAngle); ctx.translate(-position.x, -position.y);
            ctx.globalAlpha = position.warpProgress !== undefined ? 1 - stretch * .7 : 1;
            drawPlanet(player, cell, position, time, primary === cell); ctx.restore();
          } else drawPlanet(player, cell, position, time, primary === cell);
          renderedCells++;
        }
      }
      for (const player of room.players) {
        const shell = dysonPose(player, time);
        if (!shell) continue;
        if (visible(shell.x, shell.y, shell.radius + 45, view)) drawDyson(player, shell, time);
        if (shell.exitPreview && visible(shell.exitPreview.x, shell.exitPreview.y, shell.exitPreview.radius + 40, view)) drawDysonExit(player, shell);
      }
      drawComboTarget(time, view);
      drawWaveFeedback(time, view);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i], particleDt = p.updatedAt === undefined ? dt : Math.max(0, (time - p.updatedAt) / 1000);
        if (p.updatedAt !== undefined) p.updatedAt = Math.max(p.updatedAt, time);
        p.life -= particleDt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        if (p.kind === 'chip') {
          p.x += p.vx * particleDt; p.y += p.vy * particleDt; p.rotation += particleDt * 2;
          p.vx *= Math.exp(-particleDt * 3); p.vy *= Math.exp(-particleDt * 3);
          if (!visible(p.x, p.y, 10, view)) continue;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.globalAlpha = p.life / p.duration * .8; ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.moveTo(-p.size, -p.size * .35); ctx.lineTo(p.size * .7, -p.size); ctx.lineTo(p.size, p.size * .6); ctx.closePath(); ctx.fill(); ctx.restore();
        } else if (p.kind === 'wave-clash') {
          const progress = 1 - p.life / p.duration, radius = 5 + p.radius * progress;
          if (!visible(p.x, p.y, radius + 8, view)) continue;
          ctx.save(); ctx.translate(p.x, p.y); ctx.globalAlpha = (1 - progress) ** 3; ctx.fillStyle = '#f5ffff';
          ctx.beginPath(); ctx.arc(0, 0, 2 + 6 * (1 - progress), 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = (1 - progress) * .85; ctx.lineWidth = (1.8 - progress) / camera.scale;
          for (let side = 0; side < 2; side++) {
            ctx.strokeStyle = p.colors[side]; ctx.beginPath(); ctx.arc(0, 0, radius, side * Math.PI - 1.25, side * Math.PI + 1.25); ctx.stroke();
          }
          ctx.restore();
        } else if (p.kind === 'wave-blink') {
          const progress = 1 - p.life / p.duration, ease = 1 - (1 - progress) ** 3;
          const dx = p.toX - p.x, dy = p.toY - p.y, distance = Math.hypot(dx, dy);
          const x = p.x + dx * ease, y = p.y + dy * ease, tail = Math.min(110, distance * .4) * (1 - progress);
          if (!visible(x, y, tail + 12, view)) continue;
          ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(dy, dx)); ctx.globalAlpha = (1 - progress) * .4;
          ctx.fillStyle = p.color; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-tail, -Math.min(8, p.radius * .24) * (1 - progress)); ctx.lineTo(-tail * .65, 0); ctx.lineTo(-tail, Math.min(8, p.radius * .24) * (1 - progress)); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#d4faff'; ctx.lineWidth = 1 / camera.scale; ctx.beginPath(); ctx.moveTo(-tail * .7, 0); ctx.lineTo(8, 0); ctx.stroke(); ctx.restore();
        } else if (p.kind === 'wave-harvest') {
          const progress = 1 - p.life / p.duration, player = room.players.find(player => player.id === p.ownerId);
          const ref = p.ownerId === myId ? predictedCells.get(p.sourceCellId) : remotePhysics.get(`${p.ownerId}:${p.sourceCellId}`);
          const target = player?.dyson ? dysonPose(player, time) : ref?.model;
          if (!target) { particles.splice(i, 1); continue; }
          const ease = progress * progress, dx = target.x - p.x, dy = target.y - p.y;
          const x = p.x + dx * ease, y = p.y + dy * ease;
          if (!visible(x, y, 18, view)) continue;
          const distance = Math.hypot(dx, dy) || 1, tail = Math.min(16, distance * .08);
          ctx.save(); ctx.globalAlpha = Math.sin(progress * Math.PI) * .8; ctx.strokeStyle = p.color; ctx.lineWidth = 1.4 / camera.scale;
          ctx.beginPath(); ctx.moveTo(x - dx / distance * tail, y - dy / distance * tail); ctx.lineTo(x, y); ctx.stroke(); ctx.restore();
        } else if (p.kind === 'contact') {
          const progress = 1 - p.life / p.duration, radius = 2 + p.radius * progress;
          if (!visible(p.x, p.y, radius, view)) continue;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.angle);
          ctx.globalAlpha = (1 - progress) ** 2 * (.35 + p.strength * .65); ctx.fillStyle = '#f1fbff';
          ctx.beginPath(); ctx.ellipse(0, 0, Math.max(.5, p.radius * .22 * (1 - progress)), Math.max(1, p.radius * .6 * (1 - progress)), 0, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = (1 - progress) * (.25 + p.strength * .5); ctx.strokeStyle = p.color; ctx.lineWidth = .8 + p.strength * .7;
          ctx.beginPath(); ctx.arc(0, 0, radius, -.7, .7); ctx.stroke();
          ctx.beginPath(); ctx.arc(0, 0, radius, Math.PI - .7, Math.PI + .7); ctx.stroke(); ctx.restore();
        }
      }
    } else {
      drawPlanet({ id: 'dec1', color: palette[0] }, { radius: 43, mass: 80 }, { x: view.x - 330, y: view.y - 90 }, time, false, true);
      drawPlanet({ id: 'dec2', color: palette[3] }, { radius: 28, mass: 40 }, { x: view.x + 360, y: view.y + 170 }, time, false, true);
    }
    ctx.restore();
    if (room?.status === 'playing') drawMinimap(view);
    updateHud();
    raf = requestAnimationFrame(render);
  }

  function drawBackground() {
    if (!backgroundCanvas) {
      backgroundCanvas = document.createElement('canvas'); backgroundCanvas.width = canvas.width; backgroundCanvas.height = canvas.height;
      const b = backgroundCanvas.getContext('2d');
      b.scale(dpr, dpr);
      const glow = b.createRadialGradient(width * .62, height * .45, 0, width * .62, height * .45, width * .75);
      glow.addColorStop(0, '#142127'); glow.addColorStop(.5, '#0b151f'); glow.addColorStop(1, '#070b14'); b.fillStyle = glow; b.fillRect(0, 0, width, height);
      for (const star of stars) { b.globalAlpha = star.a * .7; b.fillStyle = '#adc3d4'; b.fillRect(star.x * width, star.y * height, star.r, star.r); }
      b.globalAlpha = 1;
    }
    ctx.drawImage(backgroundCanvas, 0, 0, width, height);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawArena(view) {
    const left = Math.max(0, view.x - view.width / 2), right = Math.min(WORLD.width, view.x + view.width / 2);
    const top = Math.max(0, view.y - view.height / 2), bottom = Math.min(WORLD.height, view.y + view.height / 2);
    ctx.lineWidth = .65 / view.scale; ctx.strokeStyle = '#7896aa0d'; ctx.beginPath();
    for (let x = Math.floor(left / 100) * 100; x <= right; x += 100) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
    for (let y = Math.floor(top / 100) * 100; y <= bottom; y += 100) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
    ctx.stroke();
    ctx.fillStyle = '#9dbdce26';
    for (let x = Math.ceil(left / 500) * 500; x < right; x += 500) for (let y = Math.ceil(top / 500) * 500; y < bottom; y += 500) { ctx.fillRect(x - 3, y - .5, 6, 1); ctx.fillRect(x - .5, y - 3, 1, 6); }
    if (left < 5 || top < 5 || right > WORLD.width - 5 || bottom > WORLD.height - 5) { ctx.strokeStyle = '#b9edcf66'; ctx.lineWidth = 2 / view.scale; ctx.strokeRect(0, 0, WORLD.width, WORLD.height); }
  }

  function makeSprite(size) { const c = document.createElement('canvas'); c.width = c.height = Math.ceil(size); return { canvas: c, c: c.getContext('2d'), center: c.width / 2 }; }
  function cachedPlanet(color, radius) {
    const r = clamp(Math.round(radius / 6) * 6, 12, 54), key = `${color}:${r}`;
    if (planetSprites.has(key)) return planetSprites.get(key);
    const sprite = makeSprite(r * 2.6 + 8), c = sprite.c, p = sprite.center;
    c.translate(p, p);
    const halo = c.createRadialGradient(0, 0, r * .95, 0, 0, r * 1.25); halo.addColorStop(0, `${color}16`); halo.addColorStop(1, `${color}00`); c.fillStyle = halo; c.beginPath(); c.arc(0, 0, r * 1.25, 0, Math.PI * 2); c.fill();
    c.save(); c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.clip();
    const surface = c.createRadialGradient(-r * .4, -r * .45, 1, r * .23, r * .25, r * 1.6);
    surface.addColorStop(0, '#f4f6ff'); surface.addColorStop(.14, color); surface.addColorStop(.56, color); surface.addColorStop(.84, '#30394a'); surface.addColorStop(1, '#0b1320'); c.fillStyle = surface; c.fillRect(-r, -r, r * 2, r * 2);
    c.rotate(-.4); c.strokeStyle = '#ffffff38'; c.lineWidth = Math.max(.6, r * .025);
    for (let i = 0; i < 4; i++) { const y = -r * .7 + i * r * .43; c.beginPath(); c.ellipse(-r * .1, y, r * 1.05, r * .18, .08, 0, Math.PI * 2); c.stroke(); }
    for (const [x, y, rr] of [[-.42, -.16, .23], [.24, .34, .19], [.35, -.52, .12]]) { c.fillStyle = '#18203938'; c.beginPath(); c.ellipse(x * r, y * r, rr * r, rr * r * .7, .4, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#f4edff40'; c.lineWidth = .7; c.stroke(); }
    c.restore(); c.strokeStyle = `${color}b0`; c.lineWidth = .8; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke();
    sprite.radius = r; planetSprites.set(key, sprite); if (planetSprites.size > 64) planetSprites.delete(planetSprites.keys().next().value); return sprite;
  }

  function cachedDust(dust) {
    const color = dust.fragment ? safeColor(dust.color) : '#c2e6cc';
    const radius = dust.fragment ? clamp(Math.round(4 * Math.sqrt(dust.value || 1) / 6) * 6, 6, 54) : 1.5;
    const key = `${color}:${dust.fragment ? 'f' : 'd'}:${radius}`;
    if (dustSprites.has(key)) return dustSprites.get(key);
    const sprite = makeSprite(dust.fragment ? radius * 2.6 + 8 : Math.max(18, radius * 5)), c = sprite.c;
    c.translate(sprite.center, sprite.center);
    if (dust.fragment) {
      // Free fragments and the surviving core use the same mass-to-radius scale.
      const planet = cachedPlanet(color, radius), scale = radius / planet.radius;
      c.drawImage(planet.canvas, -planet.center * scale, -planet.center * scale, planet.canvas.width * scale, planet.canvas.height * scale);
      c.save(); c.beginPath(); c.arc(0, 0, radius, 0, Math.PI * 2); c.clip();
      c.strokeStyle = '#142031bb'; c.lineWidth = Math.max(1, radius * .075); c.lineJoin = 'round'; c.beginPath();
      c.moveTo(-radius * .9, -radius * .35); c.lineTo(-radius * .15, -radius * .12); c.lineTo(radius * .05, radius * .15); c.lineTo(radius * .55, radius * .9);
      c.moveTo(-radius * .15, -radius * .12); c.lineTo(radius * .55, -radius * .7); c.stroke();
      c.strokeStyle = '#ffffff55'; c.lineWidth = .7; c.stroke(); c.restore();
    } else {
      const halo = c.createRadialGradient(0, 0, radius * .3, 0, 0, radius * 2.4); halo.addColorStop(0, `${color}77`); halo.addColorStop(1, `${color}00`); c.fillStyle = halo; c.beginPath(); c.arc(0, 0, radius * 2.4, 0, Math.PI * 2); c.fill();
      c.fillStyle = color;
      c.rotate(Math.PI / 4); c.fillRect(-radius, -radius, radius * 2, radius * 2);
    }
    sprite.radius = radius;
    dustSprites.set(key, sprite); if (dustSprites.size > 48) dustSprites.delete(dustSprites.keys().next().value); return sprite;
  }

  function drawDust(dust, position, time) {
    const sprite = cachedDust(dust), speed = Math.hypot(dust.vx || 0, dust.vy || 0);
    if (speed > 25) { const length = clamp(speed * .07, 3, 27); ctx.strokeStyle = dust.fragment ? `${safeColor(dust.color)}55` : '#c2e6cc35'; ctx.lineWidth = dust.fragment ? 1.5 : .7; ctx.beginPath(); ctx.moveTo(position.x, position.y); ctx.lineTo(position.x - dust.vx / speed * length, position.y - dust.vy / speed * length); ctx.stroke(); }
    const scale = dust.fragment ? 4 * Math.sqrt(dust.value || 1) / sprite.radius : 1;
    ctx.drawImage(sprite.canvas, position.x - sprite.center * scale, position.y - sprite.center * scale, sprite.canvas.width * scale, sprite.canvas.height * scale);
  }
  function drawMeteor(meteor, pose) {
    const speed = Math.hypot(pose.vx, pose.vy), radius = clamp(meteor.radius || 4, 2, 6);
    const tail = Number.isFinite(meteor.tailLength) && meteor.tailLength > 0 ? meteor.tailLength : clamp(speed * (room?.meteor?.tailScale ?? .22), room?.meteor?.minTail ?? 40, room?.meteor?.maxTail ?? 75), color = safeColor(meteor.color || '#ffc987');
    ctx.save(); ctx.translate(pose.x, pose.y); ctx.rotate(Math.atan2(pose.vy, pose.vx));
    ctx.fillStyle = color; ctx.globalAlpha = .1;
    ctx.beginPath(); ctx.moveTo(-tail, 0); ctx.quadraticCurveTo(-tail * .35, -radius * .7, 0, -radius * 1.3); ctx.lineTo(0, radius * 1.3); ctx.quadraticCurveTo(-tail * .35, radius * .7, -tail, 0); ctx.fill();
    ctx.globalAlpha = .35;
    ctx.beginPath(); ctx.moveTo(-tail * .88, 0); ctx.lineTo(0, -radius * .55); ctx.lineTo(0, radius * .55); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = .13; ctx.beginPath(); ctx.arc(0, 0, radius * 1.9, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = .95; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff5dd'; ctx.beginPath(); ctx.arc(radius * .15, 0, radius * .48, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawGravity(x, y, radius, color, time, primary = true) {
    color = safeColor(color); ctx.save(); ctx.translate(x, y); ctx.strokeStyle = `${color}${primary ? '25' : '17'}`; ctx.lineWidth = primary ? .7 : .5; ctx.setLineDash([2, 10]); ctx.beginPath(); ctx.arc(0, 0, radius, time * .00012, Math.PI * 2 + time * .00012); ctx.stroke(); ctx.setLineDash([]);
    const pulse = 1 - ((time * .00017) % 1); ctx.globalAlpha = (1 - pulse) * (primary ? .12 : .06); ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(0, 0, radius * (.55 + pulse * .45), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  function drawDyson(player, shell, time) {
    const color = safeColor(player.color), radius = shell.radius, phase = shell.elapsed * 1.15;
    ctx.save(); ctx.translate(shell.x, shell.y);
    // A sparse orbital cage leaves the target visible; it has no solid body.
    ctx.strokeStyle = color; ctx.lineWidth = 1.3 / camera.scale;
    ctx.globalAlpha = .45; ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.stroke();
    for (let plane = 0; plane < 3; plane++) {
      const rotation = plane * Math.PI / 3 + .2, flatten = .4 + plane * .08;
      ctx.save(); ctx.rotate(rotation);
      ctx.globalAlpha = .6; ctx.beginPath(); ctx.ellipse(0, 0, radius, radius * flatten, 0, 0, Math.PI * 2); ctx.stroke();
      for (let panel = 0; panel < 6; panel++) {
        const angle = phase * (plane === 1 ? -1 : 1) + panel * Math.PI / 3;
        const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius * flatten;
        ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(Math.cos(angle) * flatten, -Math.sin(angle)));
        ctx.globalAlpha = .9; ctx.fillStyle = color; ctx.fillRect(-4.5, -1.8, 9, 3.6);
        ctx.globalAlpha = .85; ctx.fillStyle = '#f3fff8'; ctx.fillRect(-2.7, -.5, 5.4, 1); ctx.restore();
      }
      ctx.restore();
    }
    ctx.globalAlpha = .9; ctx.fillStyle = color; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${player.name || '星球'} · 戴森球`, 0, -radius - 12);
    ctx.restore();
  }
  function drawDysonExit(player, shell) {
    const exit = shell.exitPreview;
    if (!exit) return;
    const color = safeColor(player.color), radius = exit.radius || 24;
    const progress = 1 - clamp((shell.exitRemaining ?? .3) / (room?.dysonRules?.exitWindup || .3), 0, 1);
    // Every observer sees the same server-selected legal exit. A light cage
    // and a connection line reveal the commitment without hiding the victim.
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.2 / camera.scale; ctx.globalAlpha = .45;
    ctx.setLineDash([4 / camera.scale, 5 / camera.scale]); ctx.beginPath(); ctx.moveTo(shell.x, shell.y); ctx.lineTo(exit.x, exit.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.translate(exit.x, exit.y); ctx.globalAlpha = .8;
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2 + Math.PI / 4, reach = radius + 5;
      ctx.save(); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(reach, -5); ctx.lineTo(reach, 5); ctx.stroke(); ctx.restore();
    }
    ctx.globalAlpha = .15 + progress * .2; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, radius * (.9 + progress * .1), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = .9; ctx.fillStyle = '#eddbff'; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('还原落点', 0, -radius - 13); ctx.restore();
  }
  function drawComboTarget(time, view) {
    const player = room.players.find(player => player.id === myId), target = comboTargetPose(player, time);
    if (!target) return;
    if (!visible(target.x, target.y, target.radius + 30, view)) { drawComboDirection(target, view); return; }
    if (target.kind === 'blink') {
      // A directional cue belongs to a travelling wave; a large circular
      // target made each launch look like another planet or a shield.
      ctx.save(); ctx.translate(target.x, target.y); ctx.rotate(Math.atan2(target.directionY, target.directionX));
      ctx.strokeStyle = '#c2f7ff'; ctx.lineWidth = 1.5 / view.scale; ctx.globalAlpha = .85;
      ctx.beginPath(); ctx.moveTo(10, -5); ctx.lineTo(16, 0); ctx.lineTo(10, 5); ctx.stroke();
      ctx.restore(); return;
    }
    const pulse = (Math.sin(time * .009) + 1) * .5, radius = target.radius + pulse * 3;
    const color = target.kind === 'dyson' ? '#e4bdff' : '#8feaff';
    ctx.save(); ctx.translate(target.x, target.y); ctx.strokeStyle = color; ctx.lineWidth = 2 / view.scale; ctx.globalAlpha = .8 + pulse * .2;
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2;
      ctx.beginPath(); ctx.arc(0, 0, radius, angle + .15, angle + .95); ctx.stroke();
      const r = radius + 11 + pulse * 3;
      ctx.save(); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(r + 5, -4); ctx.lineTo(r, 0); ctx.lineTo(r + 5, 4); ctx.stroke(); ctx.restore();
    }
    ctx.fillStyle = color; ctx.font = '600 11px system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(target.kind === 'dyson' ? '空格 · 戴森球' : '空格 · 瞬移', 0, -radius - 15); ctx.restore();
  }
  function drawComboDirection(target, view) {
    const dx = (target.x - view.x) * view.scale, dy = (target.y - view.y) * view.scale;
    const top = Math.min(130, height * .25), bottom = Math.min(height - 24, Math.max(height / 2 + 24, height - (width < 700 ? 180 : 100)));
    const reachX = width / 2 - 30, reachY = dy >= 0 ? bottom - height / 2 : height / 2 - top;
    const fraction = Math.min(reachX / Math.max(.001, Math.abs(dx)), reachY / Math.max(.001, Math.abs(dy)));
    const x = width / 2 + dx * fraction, y = height / 2 + dy * fraction, angle = Math.atan2(dy, dx);
    const color = target.kind === 'dyson' ? '#e4bdff' : '#8feaff';
    // This screen-edge pointer shows direction only; the world-space landing
    // reticle stays at the real wave front or target position.
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.translate(x, y); ctx.rotate(angle);
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-6, -5); ctx.lineTo(-6, 5); ctx.closePath(); ctx.fill();
    ctx.rotate(-angle); ctx.translate(-Math.cos(angle) * 22, -Math.sin(angle) * 22);
    roundRect(-17, -10, 34, 20, 5); ctx.fillStyle = '#0c1928ed'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = .7; ctx.stroke();
    ctx.fillStyle = color; ctx.font = '10px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(target.kind === 'dyson' ? '目标' : '波前', 0, 0); ctx.restore();
  }
  function cacheWaveVisuals(current, previous) {
    if (previous?.code !== current.code || previous?.round !== current.round) waveVisuals.clear();
    const present = new Set(), own = current.players.find(player => player.id === myId), candidate = own?.waveBlinkReady;
    const visibleWaves = [...current.blasts];
    if (candidate && !visibleWaves.some(blast => blast.id === candidate.waveId)) visibleWaves.push({ ...candidate, id: candidate.waveId, ownerId: myId, color: own.color });
    for (const blast of visibleWaves) {
      if (cancelledWaves.has(blast.id) || consumedBlinkWaves.has(blast.id)) { waveVisuals.delete(blast.id); continue; }
      present.add(blast.id);
      const previousVisual = waveVisuals.get(blast.id);
      const travel = blast.travel ?? (blast.distance || 420) * (blast.progress || 0), speed = Math.max(1, blast.speed || 600);
      waveVisuals.set(blast.id, { blast, receivedAt: current._receivedAt, simulationAt: current._renderTime,
        launchAt: previousVisual?.launchAt ?? (Number.isFinite(blast.launchAt) ? blast.launchAt * 1000 : current._renderTime - travel / speed * 1000),
        missingSince: null, timeline: previousVisual?.timeline, completed: previousVisual?.completed || false });
    }
    for (const [id, entry] of waveVisuals) {
      if (present.has(id)) continue;
      if (entry.blast.ownerId === myId) waveVisuals.delete(id);
      else if (entry.missingSince === null) entry.missingSince = current._receivedAt;
    }
    while (waveVisuals.size > 128) waveVisuals.delete(waveVisuals.keys().next().value);
  }
  function wavePose(blast, time) {
    const dx = Number.isFinite(blast.directionX) ? blast.directionX : 1, dy = Number.isFinite(blast.directionY) ? blast.directionY : 0, length = Math.hypot(dx, dy) || 1;
    const directionX = dx / length, directionY = dy / length, speed = Math.max(0, blast.speed || 600);
    const distance = blast.distance || 420, travel = blast.travel ?? distance * (blast.progress || 0);
    const visual = waveVisuals.get(blast.id);
    const timeline = visual?.timeline ?? simulationLead;
    if (visual && visual.timeline === undefined) visual.timeline = timeline;
    const simulationAt = visual?.simulationAt ?? room?._renderTime ?? 0;
    const launchAt = visual?.launchAt ?? simulationAt - travel / Math.max(1, speed) * 1000;
    const sampleAt = Math.min(renderSimulationTime(time) + timeline * 1000, simulationAt + (timeline + .25) * 1000);
    const renderedTravel = speed * (sampleAt - launchAt) / 1000, front = clamp(renderedTravel, 0, distance);
    const originX = blast.originX ?? blast.x - directionX * travel, originY = blast.originY ?? blast.y - directionY * travel;
    if (visual && renderedTravel >= distance) visual.completed = true;
    return { x: originX + directionX * front, y: originY + directionY * front, directionX, directionY, progress: front / distance, tail: Math.min(Math.max(34, (blast.sourceRadius || 24) * 2), front), active: !cancelledWaves.has(blast.id) && !consumedBlinkWaves.has(blast.id) && !visual?.completed && renderedTravel >= 0 && renderedTravel < distance };
  }
  function drawBlast(blast, time, pose = wavePose(blast, time)) {
    if (!pose.active) return;
    const color = safeColor(blast.color || room.players.find((p) => p.id === blast.ownerId)?.color), halfWidth = (blast.width || 160) / 2, thickness = blast.thickness || 20, curve = blast.curvature || 30;
    const opacity = Math.min(1, (1 - pose.progress) * 5);
    ctx.save(); ctx.translate(pose.x, pose.y); ctx.rotate(Math.atan2(pose.directionY, pose.directionX)); ctx.lineCap = 'round';
    if (pose.tail > 1) {
      ctx.globalAlpha = opacity * .045; ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(-curve, -halfWidth); ctx.quadraticCurveTo(curve, 0, -curve, halfWidth); ctx.lineTo(-curve - pose.tail, halfWidth * .6); ctx.quadraticCurveTo(curve - pose.tail, 0, -curve - pose.tail, -halfWidth * .6); ctx.closePath(); ctx.fill();
    }
    // A tapered crescent keeps its exact authoritative front while avoiding
    // the old uniform luminous tube and the large circular launch reticle.
    ctx.globalAlpha = opacity * .25; ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(-curve, -halfWidth); ctx.quadraticCurveTo(curve, 0, -curve, halfWidth);
    ctx.lineTo(-curve - thickness * .15, halfWidth); ctx.quadraticCurveTo(curve - thickness * 2, 0, -curve - thickness * .15, -halfWidth); ctx.closePath(); ctx.fill();
    // This curve is the server's swept wave front: (x,y) + perp*u*width/2 - direction*curvature*u².
    ctx.beginPath(); ctx.moveTo(-curve, -halfWidth); ctx.quadraticCurveTo(curve, 0, -curve, halfWidth);
    ctx.globalAlpha = opacity * .1; ctx.strokeStyle = color; ctx.lineWidth = thickness; ctx.stroke();
    ctx.globalAlpha = opacity * .7; ctx.lineWidth = Math.max(1.5 / camera.scale, thickness * .12); ctx.stroke();
    ctx.globalAlpha = opacity * .95; ctx.strokeStyle = '#e6fbff'; ctx.lineWidth = 1.05 / camera.scale; ctx.stroke(); ctx.restore();
  }
  function drawPlanet(player, cell, position, time, primary, decoration = false) {
    const color = safeColor(player.color), radius = cell.fusionRole === 'donor' ? Math.max(.01, cell.radius) : Math.max(4, cell.radius || 24), me = player.id === myId, sprite = cachedPlanet(color, radius), scale = radius / sprite.radius;
    ctx.save();
    if (player.connected === false) ctx.globalAlpha = .5;
    else if (player.invulnerable > 0) ctx.globalAlpha = .75 + Math.sin(time * .015) * .2;
    if (cell.fusionRole === 'donor') ctx.globalAlpha *= Math.min(1, cell.mass);
    ctx.drawImage(sprite.canvas, position.x - sprite.center * scale, position.y - sprite.center * scale, sprite.canvas.width * scale, sprite.canvas.height * scale);
    const feedback = combatFeedback.get(player.id), hitAge = feedback ? (time - feedback.startedAt) / 1000 : Infinity;
    if (!decoration && feedback?.cellIds.includes(cell.id) && hitAge >= 0 && hitAge < .16) {
      ctx.globalAlpha = .45 * (1 - hitAge / .16); ctx.fillStyle = '#fff0df';
      ctx.beginPath(); ctx.arc(position.x, position.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = `${color}dd`; ctx.lineWidth = .95 / Math.max(.3, camera.scale); ctx.beginPath(); ctx.arc(position.x, position.y, radius, 0, Math.PI * 2); ctx.stroke();
    if (cell.protected || cell.protectedFor > 0) { ctx.strokeStyle = `${color}aa`; ctx.lineWidth = 1.1; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.arc(position.x, position.y, radius + 11 + Math.sin(time * .008) * 2, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    if (cell.fusionRole === 'receiver') {
      ctx.strokeStyle = `${color}aa`; ctx.lineWidth = 1.4 / camera.scale;
      ctx.beginPath(); ctx.arc(position.x, position.y, radius + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cell.fusionProgress); ctx.stroke();
    } else if (cell._fusionCompletedAt && time - cell._fusionCompletedAt < 350) {
      const progress = (time - cell._fusionCompletedAt) / 350;
      ctx.globalAlpha *= 1 - progress; ctx.strokeStyle = color; ctx.lineWidth = 1.3 / camera.scale;
      ctx.beginPath(); ctx.arc(position.x, position.y, radius + 3 + progress * 10, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (!decoration && radius > 15) { ctx.font = `600 ${clamp(radius * .43, 10, 20)}px ui-monospace,monospace`; ctx.textAlign = 'center'; ctx.fillStyle = '#eff4ffb0'; ctx.fillText(Math.floor(cell.mass || player.mass || 0), position.x, position.y + radius * .15); }
    if (me && primary && !decoration) {
      const velocity = Math.hypot(player.vx || 0, player.vy || 0);
      const facing = player.direction || (velocity >= 5 ? { x: player.vx / velocity, y: player.vy / velocity } : { x: 1, y: 0 });
      ctx.save(); ctx.translate(position.x, position.y); ctx.rotate(Math.atan2(facing.y, facing.x)); ctx.strokeStyle = `${color}cc`; ctx.lineWidth = 1.2 / Math.max(.3, camera.scale); ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(radius + 8, -3.5); ctx.lineTo(radius + 14, 0); ctx.lineTo(radius + 8, 3.5); ctx.stroke(); ctx.restore();
    }
    if (!decoration && primary) { ctx.font = `${me ? '600' : '400'} 11px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = me ? '#edf8f3' : '#a5b5c7'; ctx.fillText(`${player.name}${me ? ' · 你' : player.connected === false ? ' · 重连中' : ''}`, position.x, position.y + radius + 26);  }
    ctx.restore();
  }
  function drawWaveFeedback(time, view) {
    for (const [id, feedback] of combatFeedback) {
      if (time > feedback.recentUntil) { combatFeedback.delete(id); continue; }
      const age = (time - feedback.startedAt) / 1000;
      if (age < 0 || age > .48) continue;
      const position = drawnPlayers.get(`${id}:${feedback.hit.cellId}`) || feedback.fallback;
      if (!visible(position.x, position.y, position.radius + 25, view)) continue;
      const progress = age / .48;
      ctx.save(); ctx.globalAlpha = (1 - progress) * .85; ctx.strokeStyle = '#ffd4b1'; ctx.lineWidth = (2 - progress) / camera.scale;
      ctx.beginPath(); ctx.arc(position.x, position.y, position.radius + 4 + progress * 14, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
  }
  function drawMinimap(view) {
    const mobile = width < 700, w = mobile ? 105 : 160, h = w * WORLD.height / WORLD.width, x = mobile ? 18 : 34, y = height - (mobile ? 174 : 103) - h;
    ctx.save(); roundRect(x, y, w, h, 7); ctx.fillStyle = '#0c1622d9'; ctx.fill(); ctx.strokeStyle = '#a6c0d32b'; ctx.lineWidth = 1; ctx.stroke();
    ctx.save(); roundRect(x + 2, y + 2, w - 4, h - 4, 5); ctx.clip();
    ctx.strokeStyle = '#b9f6ca3a'; ctx.fillStyle = '#b9f6ca08'; const vx = x + (view.x - view.width / 2) / WORLD.width * w, vy = y + (view.y - view.height / 2) / WORLD.height * h, vw = view.width / WORLD.width * w, vh = view.height / WORLD.height * h; ctx.fillRect(vx, vy, vw, vh); ctx.strokeRect(vx, vy, vw, vh);
    for (const p of room.players) { if (p.respawnIn > 0) continue; const own = p.id === myId, center = own ? getOwnCenter() || p : dysonPose(p) || p; ctx.fillStyle = own ? '#d2ffe0' : safeColor(p.color); ctx.globalAlpha = own ? 1 : .65; ctx.beginPath(); ctx.arc(x + center.x / WORLD.width * w, y + center.y / WORLD.height * h, own ? 2.5 : 1.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore(); ctx.globalAlpha = 1; ctx.fillStyle = '#78909d'; ctx.font = `${mobile ? 7 : 8}px ui-monospace,monospace`; ctx.textAlign = 'left'; ctx.fillText(`${WORLD.width} × ${WORLD.height} / 宇宙导航`, x, y - 7); ctx.restore();
  }

  window.StarGame = { connect, disconnect, onLobby: null, get isConnected() { return active && joined && !reconnecting; }, getDiagnostics() { const view = getCamera(); return { fps, ping: rtt === null ? null : Math.round(rtt), renderDpr: dpr, renderScale, canvasPixels: (canvas?.width || 0) * (canvas?.height || 0), canvasWidth: canvas?.width || 0, canvasHeight: canvas?.height || 0, world: { ...WORLD }, view: { x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale }, self: getOwnCenter(), inputSeq, lastInputAck, renderedDust, renderedCells, renderedMeteors, meteorTrackCount: meteorTracks.size, inputHistoryLength: inputHistory.length, predictedCellCount: predictedCells.size, cellTrackCount: cellTracks.size, materializedDustCount: materializedDust.size, spriteCount: planetSprites.size + dustSprites.size, trackedDust: dustTracks.size }; } };
})();
