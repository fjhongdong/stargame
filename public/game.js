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
  let lastFrame = 0, lastHud = 0, inputPulse = false, splitPulse = false, ejectPulse = false, boostTouch = false, pointerMove = null;
  let touchVector = { x: 0, y: 0 }, joystickPointer = null, sound = false, audioContext;
  let previousStatus = '', previousRound = -1, lastScore = 0, lastUpgradeKey = '', lastShatteredAt = 0;
  let inputSeq = 0, lastInputAck = 0, rtt = null, fps = 0, frameCount = 0, fpsStarted = 0, lastSnapshotAt = 0;
  let renderedDust = 0, renderedCells = 0, camera = { x: NaN, y: NaN, scale: .95 };
  let bodyOverflowBefore = null;
  const keys = new Set(), drawnPlayers = new Map(), drawnDust = new Map(), particles = [], seenBlasts = new Set();
  const cellTracks = new Map(), dustTracks = new Map(), predictedCells = new Map(), inputHistory = [], domCache = new Map();
  const planetSprites = new Map(), dustSprites = new Map();
  const materializedDust = new Map();
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
      #gameOverlay{position:fixed;inset:0;z-index:1000;background:#070b15;color:#f2f5fc;font-family:inherit;overflow:hidden;isolation:isolate;touch-action:none}#gameOverlay[hidden]{display:none!important}#gameOverlay *{box-sizing:border-box}#gameOverlay button{font:inherit;cursor:pointer}#gameOverlay button:focus-visible{outline:2px solid #b7f4d5;outline-offset:5px}#gameOverlay button:disabled{cursor:not-allowed;opacity:.4}#gameOverlay svg{width:20px;height:20px;display:block}#gameCanvas{position:absolute;inset:0;width:100%;height:100%;display:block}#gameOverlay .sg-top{position:absolute;top:28px;left:34px;right:34px;display:flex;justify-content:space-between;align-items:center;pointer-events:none;gap:14px}#gameOverlay .sg-top>*{pointer-events:auto}.sg-brand{display:flex;align-items:center;gap:12px}.sg-symbol{width:38px;height:38px;border:1px solid #b8f3d450;border-radius:50%;display:grid;place-items:center;color:#b7f4d5;font-size:25px;box-shadow:0 0 28px #a0f9cb12}.sg-title{font-size:15px;font-weight:750;letter-spacing:2px}.sg-subtitle{font-size:9px;letter-spacing:2.2px;color:#84909f;margin-top:5px}.sg-round{position:absolute;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:17px;padding:11px 19px;background:#101722c9;border:1px solid #768b982b;border-radius:11px;backdrop-filter:blur(12px)}.sg-live-dot{width:6px;height:6px;background:#b9f6ca;border-radius:50%;box-shadow:0 0 10px #b9f6ca}.sg-round-label{font-size:10px;letter-spacing:2px;color:#a5b1bd}.sg-timer{font:600 21px ui-monospace,monospace;letter-spacing:2px}.sg-actions{display:flex;gap:9px}.sg-icon-btn{width:39px;height:39px;display:grid;place-items:center;background:#101722c9;border:1px solid #768b9835;border-radius:10px;color:#a6b1c0;backdrop-filter:blur(12px)}.sg-icon-btn:hover{color:#ddf8e9;border-color:#b9f6ca70}.sg-icon-btn[aria-pressed=false]{color:#687584}.sg-rank{position:absolute;left:34px;top:112px;width:198px;padding:18px 17px;border:1px solid #a4b8cc15;border-radius:13px;background:#0e1421b8;backdrop-filter:blur(16px)}.sg-eyebrow{color:#8c9aa8;font-size:9px;letter-spacing:2.2px;font-weight:650}.sg-rank-title{display:flex;justify-content:space-between;gap:10px;padding-bottom:13px;border-bottom:1px solid #afc4d912}.sg-rank-count{font:10px ui-monospace,monospace;color:#b9f6ca}.sg-rank-row{display:grid;grid-template-columns:15px 9px 1fr auto;gap:7px;align-items:center;font-size:11px;margin-top:15px;color:#b7c0ce}.sg-rank-row.me{color:#effcf4}.sg-rank-num{font:10px ui-monospace,monospace;color:#718092}.sg-player-dot{width:6px;height:6px;border-radius:50%;background:var(--planet);box-shadow:0 0 10px var(--planet)}.sg-rank-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sg-rank-score{font:11px ui-monospace,monospace;color:#f4f7fb}.sg-stat{position:absolute;right:34px;top:112px;width:159px;border:1px solid #a4b8cc15;border-radius:13px;background:#0e1421b8;padding:17px 18px;backdrop-filter:blur(16px)}.sg-score{font:500 36px ui-monospace,monospace;letter-spacing:-2px;margin:10px 0 4px}.sg-score-label{color:#738191;font-size:10px}.sg-health{display:flex;gap:4px;margin-top:18px}.sg-health i{height:3px;flex:1;border-radius:3px;background:#b9f6ca}.sg-health i.empty{background:#293242}.sg-hp-label{display:flex;justify-content:space-between;color:#84909f;font-size:9px;margin-top:7px;letter-spacing:1px}.sg-bottom{position:absolute;bottom:27px;left:34px;right:34px;display:flex;justify-content:space-between;align-items:end;pointer-events:none;gap:24px}.sg-controls{display:flex;gap:20px;color:#83909f;font-size:10px;align-items:center;line-height:1.9}.sg-control{display:flex;align-items:center;gap:7px}.sg-key{font:10px ui-monospace,monospace;display:inline-flex;align-items:center;justify-content:center;min-width:23px;height:23px;border:1px solid #61728455;border-radius:5px;color:#bac5d4;background:#101724aa;padding:0 6px}.sg-energy{width:210px;pointer-events:auto}.sg-energy-caption{display:flex;justify-content:space-between;margin-bottom:10px;font-size:9px;color:#9faab8;letter-spacing:1px}.sg-energy-track{height:4px;background:#273040;border-radius:10px;overflow:hidden}.sg-energy-fill{height:100%;width:60%;background:linear-gradient(90deg,#a68cff,#d4b5ff);box-shadow:0 0 12px #d4b5ff;transition:width .12s linear}.sg-blast-button{margin-top:12px;width:100%;display:flex;justify-content:center;align-items:center;gap:10px;background:#c9b5ff13;border:1px solid #ccb5ff50;border-radius:8px;color:#decfff;font-size:11px;padding:11px 12px;letter-spacing:1px}.sg-blast-button:hover{background:#c9b5ff26}.sg-blast-button svg{width:15px;height:15px}.sg-blast-button kbd{font:9px ui-monospace,monospace;padding:2px 5px;border:1px solid #ccb5ff40;border-radius:3px;color:#9e8fc1}.sg-room-code{position:absolute;bottom:29px;left:50%;transform:translateX(-50%);color:#667588;font:9px ui-monospace,monospace;letter-spacing:2px}.sg-panel-backdrop{position:absolute;inset:0;display:grid;place-items:center;padding:90px 24px;background:#05091366;backdrop-filter:blur(5px)}.sg-panel-backdrop[hidden]{display:none}.sg-panel{position:relative;width:100%;max-width:470px;border:1px solid #97afc32b;background:linear-gradient(145deg,#172130f5,#0d1421fa);box-shadow:0 30px 120px #0009;border-radius:22px;padding:33px}.sg-panel-topline{display:flex;align-items:center;justify-content:space-between;gap:10px}.sg-badge{font-size:9px;letter-spacing:2px;padding:6px 9px;border:1px solid #b9f6ca30;border-radius:5px;color:#b9f6ca;background:#b9f6ca08}.sg-panel h2{margin:20px 0 10px;font-size:30px;font-weight:600;letter-spacing:-.6px;line-height:1.25}.sg-panel-desc{font-size:12px;color:#8c9baa;line-height:1.9;margin:0}.sg-code-box{display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid #7a91a52e;border-radius:11px;background:#080e19a8;margin:22px 0;padding:15px 17px}.sg-code-label{font-size:9px;color:#7f90a1;letter-spacing:2px}.sg-code{font:500 26px ui-monospace,monospace;color:#d4b5ff;letter-spacing:6px;margin-top:6px}.sg-copy{border:0;background:#d4b5ff0e;color:#b9a4e8;width:37px;height:37px;border-radius:8px;display:grid;place-items:center}.sg-copy:hover{background:#d4b5ff22}.sg-roster-title{display:flex;justify-content:space-between;font-size:10px;color:#9ca9b8;margin:0 0 10px;letter-spacing:1px}.sg-roster{display:flex;flex-direction:column;gap:7px}.sg-roster-row{display:flex;align-items:center;gap:11px;padding:10px 11px;background:#d8e6f305;border:1px solid #a4b8cc10;border-radius:9px;font-size:12px}.sg-mini-planet{width:23px;height:23px;border-radius:50%;background:radial-gradient(circle at 30% 28%,#ffffffa8,var(--planet) 27%,#152237 95%);box-shadow:0 0 12px color-mix(in srgb,var(--planet) 18%,transparent);flex-shrink:0}.sg-roster-name{flex:1;color:#cbd6e3;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.sg-small-tag{font-size:8px;color:#7e8c9e;border:1px solid #7e8c9e35;border-radius:3px;padding:2px 4px;letter-spacing:1px;margin-left:6px}.sg-ready-status{font-size:9px;color:#7e8c9e;white-space:nowrap}.sg-ready-status.ready{color:#b9f6ca}.sg-panel-buttons{display:flex;gap:9px;margin-top:22px}.sg-primary,.sg-secondary{border-radius:9px;min-height:44px;padding:12px 17px;font-size:12px;letter-spacing:1px;border:1px solid transparent;flex:1}.sg-primary{background:#b9f6ca;color:#10221b;font-weight:700;box-shadow:0 0 28px #b9f6ca0b}.sg-primary:hover{background:#d2ffdf}.sg-secondary{background:#c5d4e806;border-color:#afc3d72b;color:#b0bece}.sg-secondary:hover{background:#c5d4e810;border-color:#afc3d75b}.sg-panel-note{text-align:center;font-size:10px;line-height:1.8;color:#6f8092;margin:13px 0 0}.sg-progress{width:30px;height:30px;border:2px solid #b9f6ca20;border-top-color:#b9f6ca;border-radius:50%;animation:sg-spin 1s linear infinite;margin-bottom:24px}@keyframes sg-spin{to{transform:rotate(360deg)}}.sg-status{position:absolute;top:87px;left:50%;transform:translateX(-50%);padding:7px 13px;border:1px solid #e2c18f3b;background:#171c26d9;color:#e4c698;font-size:10px;border-radius:6px;white-space:nowrap}.sg-status[hidden]{display:none}.sg-toast{position:absolute;left:50%;top:110px;transform:translateX(-50%);color:#c9f7dc;background:#101d1dec;border:1px solid #b9f6ca35;border-radius:8px;font-size:12px;padding:11px 19px;transition:opacity .2s;pointer-events:none;opacity:0}.sg-toast.show{opacity:1}.sg-result-place{font:500 70px ui-monospace,monospace;color:#d4b5ff;letter-spacing:-5px;margin:15px 0 6px}.sg-result-grid{display:flex;gap:20px;margin:20px 0;padding:17px 0;border-top:1px solid #a4b8cc20;border-bottom:1px solid #a4b8cc20}.sg-result-grid>div{flex:1}.sg-result-number{font:500 23px ui-monospace,monospace;color:#e6edf8;margin-bottom:6px}.sg-result-label{font-size:9px;color:#7f90a1;letter-spacing:1px}.sg-touch{display:none;position:absolute;inset:0;pointer-events:none}.sg-joystick{position:absolute;bottom:38px;left:27px;width:108px;height:108px;border:1px solid #b6cde42b;background:#b6cde407;border-radius:50%;pointer-events:auto;touch-action:none}.sg-joystick:before{content:'';position:absolute;inset:26px;border:1px dashed #b6cde424;border-radius:50%}.sg-joystick-knob{position:absolute;left:34px;top:34px;width:38px;height:38px;border:1px solid #b6cde46b;background:#b6cde415;border-radius:50%;box-shadow:0 0 22px #b6cde40b;pointer-events:none}.sg-touch-boost{position:absolute;bottom:153px;right:34px;pointer-events:auto;border:1px solid #b9f6ca50;color:#b9f6ca;background:#b9f6ca10;width:47px;height:47px;border-radius:50%;font-size:10px}.sg-mobile-hint{display:none}.sg-respawn{position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;color:#c7b7ed;font-size:12px;letter-spacing:2px}.sg-respawn strong{display:block;font:500 48px ui-monospace,monospace;margin-bottom:9px}.sg-respawn[hidden]{display:none}
      @media(max-width:700px){#gameOverlay .sg-top{top:18px;left:18px;right:18px}.sg-brand{gap:9px}.sg-symbol{width:30px;height:30px;font-size:21px}.sg-title{font-size:12px;letter-spacing:1px}.sg-subtitle{font-size:7px;letter-spacing:1.2px}.sg-round{top:54px;padding:8px 12px;gap:10px}.sg-round-label{font-size:8px}.sg-timer{font-size:17px}.sg-icon-btn{width:32px;height:32px;border-radius:8px}.sg-icon-btn svg{width:16px;height:16px}.sg-actions{gap:6px}.sg-rank{left:18px;top:119px;width:145px;padding:12px}.sg-rank-row{font-size:9px;gap:5px;margin-top:11px;grid-template-columns:11px 6px 1fr auto}.sg-rank-num,.sg-rank-score{font-size:9px}.sg-eyebrow{font-size:8px;letter-spacing:1.2px}.sg-rank-count{font-size:8px}.sg-rank-title{padding-bottom:9px}.sg-stat{right:18px;top:119px;width:112px;padding:12px}.sg-score{font-size:28px;margin-top:7px}.sg-score-label{font-size:8px}.sg-health{margin-top:12px}.sg-bottom{left:18px;right:24px;bottom:35px}.sg-controls{display:none}.sg-energy{width:105px;margin-left:auto}.sg-blast-button{border-radius:50%;width:84px;height:84px;flex-direction:column;padding:13px;gap:6px;font-size:10px;margin:13px auto 0;background:#bda1ff18;border-color:#ccb5ff73}.sg-blast-button svg{width:23px;height:23px}.sg-blast-button kbd{display:none}.sg-energy-caption{font-size:8px;letter-spacing:0}.sg-touch{display:block}.sg-room-code{bottom:13px;font-size:8px;letter-spacing:1px}.sg-panel-backdrop{padding:98px 18px 24px}.sg-panel{padding:24px;max-width:410px;border-radius:17px;max-height:calc(100dvh - 122px);overflow:auto}.sg-panel h2{font-size:26px;margin-top:17px}.sg-panel-desc{font-size:11px}.sg-code-box{margin:17px 0;padding:12px 14px}.sg-code{font-size:23px}.sg-roster-row{font-size:11px;padding:8px}.sg-panel-buttons{margin-top:18px}.sg-primary,.sg-secondary{padding:10px 9px;font-size:11px}.sg-status{top:103px;font-size:8px;padding:5px 9px}.sg-toast{top:102px;font-size:10px}.sg-result-place{font-size:50px}.sg-result-grid{margin:14px 0;padding:13px 0}.sg-result-number{font-size:20px}}
      @media(max-height:580px) and (min-width:701px){.sg-panel-backdrop{padding:65px 24px 20px}.sg-panel{max-height:calc(100vh - 85px);overflow:auto;padding:24px}.sg-panel h2{margin-top:12px}.sg-code-box{margin:13px 0}.sg-rank,.sg-stat{top:90px}.sg-bottom{bottom:18px}.sg-panel-buttons{margin-top:14px}.sg-roster-row{padding:7px 10px}}
      .sg-mass-label{font-size:9px;color:#b9f6ca;margin-top:10px;letter-spacing:1px}.sg-growth{margin-top:10px;height:3px;background:#283343;border-radius:5px;overflow:hidden}.sg-growth>i{display:block;background:#b9f6ca;height:100%;transition:width .2s}.sg-growth-caption{font-size:8px;color:#718295;margin-top:6px;line-height:1.6}.sg-upgrades{position:absolute;left:50%;bottom:113px;transform:translateX(-50%);width:min(670px,calc(100% - 60px));pointer-events:auto;padding:17px;border:1px solid #d4b5ff55;border-radius:15px;background:#101826f2;box-shadow:0 12px 60px #0008,0 0 70px #b79bff0b;backdrop-filter:blur(20px)}.sg-upgrades[hidden]{display:none}.sg-upgrade-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:13px}.sg-upgrade-title{font-size:13px;color:#e4d8ff;font-weight:650;letter-spacing:1px}.sg-upgrade-hint{font-size:9px;color:#8293a5}.sg-upgrade-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.sg-upgrade-card{position:relative;text-align:left;border:1px solid #a5b5cc26;background:linear-gradient(150deg,#27263d99,#131d2c80);color:#e6ddf8;border-radius:10px;padding:15px 13px;min-height:115px;transition:transform .15s,border-color .15s}.sg-upgrade-card:hover,.sg-upgrade-card:focus-visible{transform:translateY(-4px);border-color:#d4b5ff90;background:linear-gradient(150deg,#423257aa,#1b2835aa)}.sg-upgrade-card:nth-child(2){background:linear-gradient(150deg,#233c3890,#131d2c80)}.sg-upgrade-card:nth-child(3){background:linear-gradient(150deg,#34332b90,#131d2c80)}.sg-upgrade-icon{font-size:22px;line-height:1;display:block;margin-bottom:12px;color:#d4b5ff}.sg-upgrade-card:nth-child(2) .sg-upgrade-icon{color:#b9f6ca}.sg-upgrade-card:nth-child(3) .sg-upgrade-icon{color:#e4cd9c}.sg-upgrade-name{font-size:12px;font-weight:600;display:block;margin-bottom:7px}.sg-upgrade-desc{font-size:10px;color:#98a8b9;line-height:1.7;display:block}.sg-upgrade-key{position:absolute;right:10px;top:11px;color:#7c7a93;font:9px ui-monospace,monospace;border:1px solid #7c7a9344;padding:2px 5px;border-radius:3px}.sg-upgrade-active{position:absolute;right:34px;top:300px;width:159px;color:#8191a5;font-size:9px;line-height:1.9;pointer-events:none}.sg-upgrade-active b{color:#c8b6ef;font-weight:400}.sg-touch-utility{display:none;position:absolute;right:128px;bottom:40px;gap:10px;pointer-events:auto;flex-direction:column}.sg-touch-utility button{width:46px;height:46px;border:1px solid #b8d2ed44;background:#182435dc;color:#c1d2e5;border-radius:50%;font-size:10px}.sg-touch-utility button:first-child{border-color:#b9f6ca66;color:#b9f6ca}
      @media(max-width:700px){.sg-mass-label{font-size:8px;margin-top:7px}.sg-growth-caption{font-size:7px}.sg-upgrades{bottom:160px;width:calc(100% - 28px);padding:13px;border-radius:12px}.sg-upgrade-head{margin-bottom:10px;flex-wrap:wrap;gap:5px}.sg-upgrade-title{font-size:11px}.sg-upgrade-hint{font-size:8px}.sg-upgrade-cards{gap:7px}.sg-upgrade-card{padding:12px 9px;min-height:133px}.sg-upgrade-icon{font-size:21px;margin-bottom:12px}.sg-upgrade-name{font-size:10px}.sg-upgrade-desc{font-size:8px;line-height:1.6}.sg-upgrade-key{font-size:8px;padding:1px 4px;right:7px;top:8px}.sg-upgrade-active{top:305px;right:18px;width:112px;font-size:8px}.sg-touch-utility{display:flex}.sg-controls{display:none}}
      .sg-diagnostics{position:absolute;right:35px;top:80px;color:#8eaba0;font:9px ui-monospace,monospace;letter-spacing:.5px;pointer-events:none}.sg-map-hint{font-size:8px;color:#7f91a4}.sg-rank,.sg-stat,.sg-panel,.sg-upgrades{backdrop-filter:none}
      @media(max-width:700px){.sg-diagnostics{right:18px;top:59px;font-size:8px}.sg-upgrade-active{max-height:110px;overflow:hidden}}
      @media(prefers-reduced-motion:reduce){#gameOverlay *{transition:none!important}}
    `;
    document.head.appendChild(style);
    root.innerHTML = `
      <canvas id="gameCanvas" aria-label="星球大爆炸实时竞技场"></canvas>
      <div class="sg-top"><div class="sg-brand"><div class="sg-symbol">✳</div><div><div class="sg-title">星球大爆炸</div><div class="sg-subtitle">PLANET BOOM / LIVE ARENA</div></div></div><div class="sg-round"><i class="sg-live-dot"></i><span class="sg-round-label" id="sgRoundLabel">准备起航</span><span class="sg-timer" id="sgTimer">03:00</span></div><div class="sg-actions"><button class="sg-icon-btn" id="sgFullscreen" aria-label="进入全屏" aria-pressed="false" title="进入全屏">${icons.fullscreen}</button><button class="sg-icon-btn" id="sgSound" aria-label="开启游戏音效" aria-pressed="false" title="游戏音效">${icons.audio}</button><button class="sg-icon-btn" id="sgExit" aria-label="返回星际大厅" title="返回大厅">${icons.exit}</button></div></div>
      <div class="sg-rank"><div class="sg-rank-title"><span class="sg-eyebrow">实时排行榜</span><span class="sg-rank-count" id="sgPlayerCount">00 PLAYERS</span></div><div id="sgRanking"></div></div>
      <div class="sg-stat"><div class="sg-eyebrow">星球总质量</div><div class="sg-score" id="sgScore">036</div><div class="sg-score-label">吞噬星尘 · 大球吃小球</div><div class="sg-mass-label" id="sgLevel">LV. 1 / 初生星球</div><div class="sg-growth"><i id="sgGrowthFill"></i></div><div class="sg-growth-caption" id="sgGrowthText">成长后解锁随机强化</div><div class="sg-health" id="sgHealth"></div><div class="sg-hp-label"><span>星球护盾</span><span id="sgHp">100%</span></div></div>
      <div class="sg-bottom"><div class="sg-controls"><div class="sg-control"><span class="sg-key">W A S D</span><span>移动</span></div><div class="sg-control"><span class="sg-key">SPACE</span><span>分裂</span></div><div class="sg-control"><span class="sg-key">Q</span><span>吐球</span></div><div class="sg-control"><span class="sg-key">SHIFT</span><span>加速</span></div></div><div class="sg-energy"><div class="sg-energy-caption"><span>引力能量</span><span id="sgEnergyText">60 / 100</span></div><div class="sg-energy-track"><div class="sg-energy-fill" id="sgEnergyFill"></div></div><button id="sgBlast" class="sg-blast-button">${icons.bolt}<span>引力爆破</span><kbd>E</kbd></button></div></div>
      <div class="sg-diagnostics" id="sgDiagnostics">— FPS / — ms</div><div class="sg-room-code" id="sgRoomFooter"></div><div class="sg-status" id="sgStatus" hidden></div><div class="sg-toast" id="sgToast" role="status"></div><div class="sg-respawn" id="sgRespawn" hidden></div>
      <div class="sg-touch" id="sgTouch"><div class="sg-joystick" id="sgJoystick" aria-label="拖动摇杆移动"><div class="sg-joystick-knob" id="sgJoystickKnob"></div></div><button class="sg-touch-boost" id="sgTouchBoost" aria-label="按住加速">加速</button><div class="sg-touch-utility"><button id="sgTouchSplit">分裂</button><button id="sgTouchEject">吐球</button></div></div>
      <div class="sg-upgrade-active" id="sgUpgradeActive"></div><section class="sg-upgrades" id="sgUpgrades" hidden aria-label="选择星球强化"><div class="sg-upgrade-head"><span class="sg-upgrade-title" id="sgUpgradeTitle">星球进化 · 选择强化</span><span class="sg-upgrade-hint">选择强化 · 对局继续进行 · 按 1 / 2 / 3</span></div><div class="sg-upgrade-cards" id="sgUpgradeCards"></div></section>
      <div class="sg-panel-backdrop" id="sgPanelBackdrop"><section class="sg-panel" id="sgPanel" aria-live="polite"></section></div>
    `;
    canvas = $('gameCanvas');
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
    $('sgTouchSplit').addEventListener('pointerdown', (e) => { e.preventDefault(); split(); });
    $('sgTouchEject').addEventListener('pointerdown', (e) => { e.preventDefault(); eject(); });
    canvas.addEventListener('pointerdown', (e) => {
      if (!room || room.status !== 'playing' || e.pointerType === 'touch') return;
      if (e.button === 2) blast();
      else if (e.button === 0) { pointerMove = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); }
    });
    canvas.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch' && room?.status === 'playing') pointerMove = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') pointerMove = null; });
    canvas.addEventListener('pointercancel', () => { pointerMove = null; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    const joystick = $('sgJoystick');
    function moveJoystick(e) {
      const rect = joystick.getBoundingClientRect();
      let x = e.clientX - rect.left - rect.width / 2, y = e.clientY - rect.top - rect.height / 2;
      const length = Math.hypot(x, y), max = rect.width * .32;
      if (length > max) { x *= max / length; y *= max / length; }
      touchVector = { x: x / max, y: y / max };
      $('sgJoystickKnob').style.transform = `translate(${x}px,${y}px)`;
    }
    joystick.addEventListener('pointerdown', (e) => { e.preventDefault(); joystickPointer = e.pointerId; joystick.setPointerCapture(e.pointerId); moveJoystick(e); });
    joystick.addEventListener('pointermove', (e) => { if (joystickPointer === e.pointerId) moveJoystick(e); });
    const resetJoystick = () => { joystickPointer = null; touchVector = { x: 0, y: 0 }; $('sgJoystickKnob').style.transform = ''; };
    joystick.addEventListener('pointerup', resetJoystick);
    joystick.addEventListener('pointercancel', resetJoystick);
    $('sgTouchBoost').addEventListener('pointerdown', (e) => { e.preventDefault(); boostTouch = true; e.currentTarget.setPointerCapture(e.pointerId); });
    $('sgTouchBoost').addEventListener('pointerup', () => { boostTouch = false; });
    $('sgTouchBoost').addEventListener('pointercancel', () => { boostTouch = false; });
    addEventListener('resize', resize);
    addEventListener('orientationchange', resize);
    window.visualViewport?.addEventListener('resize', resize);
    addEventListener('keydown', (e) => {
      if (!active || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
      if (e.code === 'Space' && !e.repeat) split();
      if (e.code === 'KeyQ' && !e.repeat) eject();
      if (e.code === 'KeyE' && !e.repeat) blast();
      if (/^Digit[123]$/.test(e.code) && !e.repeat) chooseUpgrade(Number(e.code.slice(-1)) - 1);
      if (e.code === 'Escape') { if (room?.status === 'playing') toast('点击右上角退出图标可返回大厅'); }
      keys.add(e.code);
      if (!e.repeat) sendInput();
    });
    addEventListener('keyup', (e) => { keys.delete(e.code); if (active) sendInput(); });
    addEventListener('blur', () => { keys.clear(); boostTouch = false; pointerMove = null; resetJoystick(); });
    resize();
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
    width = innerWidth; height = innerHeight; dpr = Math.min(devicePixelRatio || 1, width < 700 ? 1 : 1.5);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    backgroundCanvas = null;
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
    room = null; myId = null; token = null; previousStatus = ''; previousRound = -1;
    lastScore = 0; lastUpgradeKey = ''; lastShatteredAt = 0; drawnPlayers.clear(); drawnDust.clear(); particles.length = 0; seenBlasts.clear();
    cellTracks.clear(); dustTracks.clear(); materializedDust.clear(); predictedCells.clear(); inputHistory.length = 0; domCache.clear();
    inputSeq = 0; lastInputAck = 0; rtt = null; fps = 0; frameCount = 0; fpsStarted = 0;
    camera = { x: NaN, y: NaN, scale: width < 700 ? .8 : .95 };
    inputPulse = false; splitPulse = false; ejectPulse = false;
    $('sgUpgrades').hidden = true;
    root.hidden = false;
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
    reconnecting = true; retries += 1; keys.clear();
    $('sgStatus').hidden = false; $('sgStatus').textContent = `网络暂时中断，正在重连… ${retries}/4`;
    clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (active) openSocket(true); }, retries * 750);
  }

  function showConnectionError(message) {
    reconnecting = false; clearTimeout(retryTimer);
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
    intentionalClose = true; active = false;
    clearTimeout(connectionTimer); clearTimeout(retryTimer); clearInterval(inputTimer); clearInterval(pingTimer); cancelAnimationFrame(raf);
    send({ type: 'leave' }); socket?.close(); socket = null;
    keys.clear(); touchVector = { x: 0, y: 0 }; boostTouch = false; pointerMove = null;
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
    const old = room;
    if (!Array.isArray(next.players)) next.players = [];
    if (!next.dustDelta) materializedDust.clear();
    for (const id of next.dustRemoved || []) materializedDust.delete(id);
    for (const dust of next.dust || []) materializedDust.set(dust.id, dust);
    next.dust = Array.from(materializedDust.values());
    ingestSnapshot(next, performance.now());
    room = next;
    if (!Array.isArray(room.players)) room.players = [];
    room.dust ||= []; room.blasts ||= [];
    const me = room.players.find((p) => p.id === myId);
    if (me?.shatteredAt > lastShatteredAt) { lastShatteredAt = me.shatteredAt; toast('撞击碎裂！守住核心，抢回碎片'); }
    if (me && old?.status === 'playing' && me.score > lastScore) {
      particles.push({ kind: 'score', x: me.x, y: me.y - 40, text: `+${me.score - lastScore}`, life: 1, color: '#b9f6ca' });
    }
    lastScore = me?.score || 0;
    for (const blast of room.blasts) {
      if (!seenBlasts.has(blast.id)) {
        seenBlasts.add(blast.id);
        if (blast.ownerId === myId && !window.StarAudio) playTone(100, .22, .04, 'sine');
      }
    }
    if (seenBlasts.size > 300) { seenBlasts.clear(); for (const blast of room.blasts) seenBlasts.add(blast.id); }
    if (room.status !== previousStatus || room.round !== previousRound) {
      if (room.status === 'playing') {
        $('sgPanelBackdrop').hidden = true;
        if (previousStatus !== 'playing') { toast(room.mode === 'practice' ? '训练开始 · 吞噬星尘变大，空格分裂，E 引爆' : '全员就绪 · 大球吃小球，成长解锁强化！'); window.StarAudio?.play('start'); }
        $('sgBlast').disabled = false;
      }
      previousStatus = room.status; previousRound = room.round;
    }
    updateHud(room.status !== old?.status || room.round !== old?.round);
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
    html = html.replace(/<\/p>$/, '<br>引力吸碎片 · 撞击会碎裂 · 守住核心再吸收</p>');
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
    const names = { speed: '光速引擎', growth: '星尘滋养', blast: '超新星回响', blastRange: '超新星回响', range: '超新星回响', energy: '能量核心', efficiency: '能量核心', magnet: '引力场', shield: '行星护盾', recovery: '恒星充能', regen: '恒星充能', cooldown: '脉冲加速' };
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
    $('sgRoundLabel').textContent = room?.status === 'playing' ? room.mode === 'practice' ? '训练模式' : 'LIVE MATCH' : room?.status === 'finished' ? 'ROUND COMPLETE' : '准备起航';
    $('sgTimer').textContent = formatTime(room?.remaining ?? 180);
    $('sgTimer').style.color = room?.status === 'playing' && room.remaining < 30 ? '#ffb4a6' : '';
    $('sgPlayerCount').textContent = `${String(players.length).padStart(2, '0')} PLAYERS`;
    setMarkup('sgRanking', players.slice(0, 6).map((p, i) => `<div class="sg-rank-row${p.id === myId ? ' me' : ''}"><span class="sg-rank-num">${i + 1}</span><span class="sg-player-dot" style="--planet:${safeColor(p.color)}"></span><span class="sg-rank-name">${esc(p.name)}${p.id === myId ? ' · 你' : ''}</span><span class="sg-rank-score">${Math.floor(p.mass ?? p.score ?? 0)}</span></div>`).join(''));
    $('sgScore').textContent = String(Math.floor(me?.mass ?? 36)).padStart(3, '0');
    $('sgLevel').textContent = `LV. ${me?.level || 1} / ${me?.cells?.length || 1} 颗星球`;
    const peak = me?.peakMass ?? me?.mass ?? 36, next = me ? me.nextUpgradeMass : 60;
    $('sgGrowthFill').style.width = `${next ? clamp(peak / next * 100, 0, 100) : 100}%`;
    const gravity = Math.max(0, ...(me?.cells || []).map((cell) => cell.gravityRadius || 0));
    $('sgGrowthText').textContent = `${next ? `巅峰 ${Math.floor(peak)} / ${next} · 三选一` : '所有强化已解锁'}${gravity ? ` · 引力 ${Math.round(gravity)}` : ''}`;
    const maxHp = me?.stats?.maxHp || 100, hp = clamp(me?.hp ?? maxHp, 0, maxHp), energy = clamp(me?.energy ?? 60, 0, 100);
    $('sgHp').textContent = `${Math.ceil(hp)} / ${maxHp}`;
    setMarkup('sgHealth', Array.from({ length: 5 }, (_, i) => `<i${hp / maxHp <= i / 5 ? ' class="empty"' : ''}></i>`).join(''));
    $('sgEnergyText').textContent = `${Math.floor(energy)} / 100`;
    $('sgEnergyFill').style.width = `${energy}%`;
    $('sgBlast').disabled = !room || room.status !== 'playing' || energy < (me?.stats?.blastCost || 30) || (me?.respawnIn || 0) > 0 || reconnecting || (me?.cooldown || 0) > 0;
    $('sgBlast').title = `消耗 ${me?.stats?.blastCost || 30} 能量${me?.cooldown > 0 ? ` · 冷却 ${me.cooldown.toFixed(1)} 秒` : ''}`;
    $('sgRoomFooter').textContent = room ? `${room.mode === 'practice' ? 'PRACTICE / AI TRAINING' : `ROOM / ${room.code}`}  ·  STAY CURIOUS, KEEP EXPLODING` : 'CONNECTING TO YOUR UNIVERSE';
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
  function blast() {
    const me = room?.players?.find((p) => p.id === myId);
    if (room?.status !== 'playing' || !me || me.respawnIn > 0) return;
    if (me.energy < (me.stats?.blastCost || 30)) { toast('能量不足 · 收集星尘补充能量'); return; }
    if (me.cooldown > 0) return;
    inputPulse = true; sendInput();
    window.StarAudio?.play('blast');
  }
  function split() {
    const me = room?.players?.find((p) => p.id === myId);
    if (room?.status !== 'playing' || !me || me.respawnIn > 0 || reconnecting) return;
    if (!(me.cells || [{ mass: me.mass }]).some((cell) => cell.mass >= 48)) { toast('单颗星球质量达到 48 后即可分裂'); return; }
    splitPulse = true; sendInput();
  }
  function eject() {
    if (room?.status !== 'playing' || reconnecting) return;
    ejectPulse = true; sendInput();
  }
  function sendInput() {
    if (!active || !room || room.status !== 'playing' || reconnecting) return;
    const input = getIntent(), view = getCamera(), seq = ++inputSeq;
    const at = performance.now();
    inputHistory.push({ seq, t: at, ...input });
    while (inputHistory.length > 60 || inputHistory[0]?.t < at - 2000) inputHistory.shift();
    send({ type: 'input', ...input, seq, viewport: { x: view.x, y: view.y, width: Math.min(3200, view.width), height: Math.min(2300, view.height) }, dustDeltas: true, supportsDustDelta: true, fire: inputPulse, split: splitPulse, eject: ejectPulse });
    inputPulse = false; splitPulse = false; ejectPulse = false;
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
    if (Math.hypot(touchVector.x, touchVector.y) > .1) { x = touchVector.x; y = touchVector.y; }
    else if (!x && !y && pointerMove) {
      const me = getOwnCenter(), view = getCamera();
      if (me) { const dx = (pointerMove.x - view.offsetX) / view.scale - me.x, dy = (pointerMove.y - view.offsetY) / view.scale - me.y, length = Math.hypot(dx, dy); if (length > 25 / view.scale) { x = dx / length; y = dy / length; } }
    }
    const length = Math.hypot(x, y); if (length > 1) { x /= length; y /= length; }
    return { x, y, boost: keys.has('ShiftLeft') || keys.has('ShiftRight') || boostTouch };
  }

  function getOwnCenter() {
    const me = room?.players?.find((p) => p.id === myId);
    if (!me) return null;
    let x = 0, y = 0, mass = 0;
    for (const cell of me.cells || []) { const p = predictedCells.get(cell.id); if (p) { const m = cell.mass || 1; x += p.x * m; y += p.y * m; mass += m; } }
    return mass ? { x: x / mass, y: y / mass } : { x: me.x, y: me.y };
  }

  function addTrack(map, key, point, at) {
    let track = map.get(key); if (!track) { track = []; map.set(key, track); }
    const previous = track[track.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y && !point.vx && !point.vy && !previous.vx && !previous.vy) return;
    const seconds = previous ? (at - previous.t) / 1000 : 0;
    track.push({ t: at, x: point.x, y: point.y, vx: Number.isFinite(point.vx) ? point.vx : seconds > 0 ? (point.x - previous.x) / seconds : 0, vy: Number.isFinite(point.vy) ? point.vy : seconds > 0 ? (point.y - previous.y) / seconds : 0 });
    if (track.length > 7) track.shift();
  }

  function sampleTrack(track, at, extrapolate = 90) {
    if (!track?.length) return null;
    const first = track[0], latest = track[track.length - 1];
    if (at <= first.t) return first;
    for (let i = 1; i < track.length; i++) if (track[i].t >= at) {
      const a = track[i - 1], b = track[i], f = clamp((at - a.t) / Math.max(1, b.t - a.t), 0, 1);
      if (Math.hypot(b.x - a.x, b.y - a.y) > 500) return b;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
    const dt = clamp(at - latest.t, 0, extrapolate) / 1000;
    return { x: latest.x + latest.vx * dt, y: latest.y + latest.vy * dt };
  }

  function ingestSnapshot(next, at) {
    if (next.arena?.width > 0) WORLD.width = next.arena.width;
    if (next.arena?.height > 0) WORLD.height = next.arena.height;
    const snapshotAt = Number.isFinite(next.serverTime) ? next.serverTime : (next.time || 0) * 1000;
    next._renderTime = snapshotAt;
    next._receivedAt = at;
    const cellsPresent = new Set(), dustPresent = new Set();
    for (const player of next.players) {
      for (const cell of player.cells || []) {
        const key = `${player.id}:${cell.id}`; cellsPresent.add(key); addTrack(cellTracks, key, cell, snapshotAt);
        if (player.id !== myId) continue;
        let predicted = predictedCells.get(cell.id);
        if (!predicted || player.respawnIn > 0 || next.round !== room?.round) {
          predicted = { x: cell.x, y: cell.y, correctionX: 0, correctionY: 0, impulseX: 0, impulseY: 0, history: [] };
          predictedCells.set(cell.id, predicted);
        } else {
          // Compare the packet with our past simulation, preserving immediate current input.
          const historyAt = at - clamp((rtt ?? 80) + 15, 12, 450);
          const historical = sampleTrack(predicted.history, historyAt, 0) || predicted;
          const dx = cell.x - historical.x, dy = cell.y - historical.y;
          if (Math.hypot(dx, dy) > 350) { predicted.x = cell.x; predicted.y = cell.y; predicted.correctionX = predicted.correctionY = 0; predicted.history.length = 0; }
          else if (Math.hypot(dx, dy) > 1.5) { predicted.correctionX = dx; predicted.correctionY = dy; }
        }
        const speed = (player.boosting ? 360 : 210) * (player.stats?.speed || 1) * Math.pow(36 / Math.max(1, cell.mass), .18);
        const velocity = Math.hypot(cell.vx || 0, cell.vy || 0);
        if (velocity > speed * 1.3) { const f = Math.max(0, 1 - speed / velocity); predicted.impulseX = (cell.vx || 0) * f; predicted.impulseY = (cell.vy || 0) * f; }
      }
    }
    for (const key of cellTracks.keys()) if (!cellsPresent.has(key)) cellTracks.delete(key);
    const own = next.players.find((p) => p.id === myId);
    const ownIds = new Set((own?.cells || []).map((c) => c.id));
    for (const id of predictedCells.keys()) if (!ownIds.has(id)) predictedCells.delete(id);
    if (Number.isFinite(own?.lastInputSeq)) { lastInputAck = own.lastInputSeq; while (inputHistory.length && inputHistory[0].seq <= lastInputAck) inputHistory.shift(); }
    for (const dust of next.dust) { dustPresent.add(dust.id); addTrack(dustTracks, dust.id, dust, snapshotAt); }
    for (const id of dustTracks.keys()) if (!dustPresent.has(id)) dustTracks.delete(id);
    lastSnapshotAt = at;
  }

  function predictOwn(dt, at) {
    const me = room?.players?.find((p) => p.id === myId);
    if (!me || room.status !== 'playing' || me.respawnIn > 0 || reconnecting || at - lastSnapshotAt > 650) return;
    const input = getIntent(), center = getOwnCenter(), moving = Math.hypot(input.x, input.y) > .01;
    if (!center) return;
    const targetX = center.x + input.x * 260, targetY = center.y + input.y * 260;
    for (const cell of me.cells || []) {
      const p = predictedCells.get(cell.id); if (!p) continue;
      const dx = targetX - p.x, dy = targetY - p.y, length = Math.hypot(dx, dy) || 1;
      const speed = (input.boost && me.energy > 1 && moving ? 360 : 210) * (me.stats?.speed || 1) * Math.pow(36 / Math.max(1, cell.mass), .18);
      const approach = Math.min(1, length / (moving ? 50 : 100));
      const correction = 1 - Math.exp(-dt * 9);
      p.x = clamp(p.x + (dx / length * speed * approach + p.impulseX) * dt + p.correctionX * correction, cell.radius, WORLD.width - cell.radius);
      p.y = clamp(p.y + (dy / length * speed * approach + p.impulseY) * dt + p.correctionY * correction, cell.radius, WORLD.height - cell.radius);
      p.correctionX *= 1 - correction; p.correctionY *= 1 - correction;
      p.impulseX *= Math.exp(-5 * dt); p.impulseY *= Math.exp(-5 * dt);
      p.history.push({ t: at, x: p.x, y: p.y, vx: 0, vy: 0 });
      while (p.history.length > 2 && p.history[0].t < at - 800) p.history.shift();
    }
  }

  function updateCamera(dt) {
    const me = room?.players?.find((p) => p.id === myId), center = getOwnCenter();
    const mobile = width < 700;
    let targetX = center?.x ?? WORLD.width / 2, targetY = center?.y ?? WORLD.height / 2;
    let targetScale = (mobile ? .8 : .95) / Math.pow(Math.max(36, me?.mass || 36) / 36, .1);
    if (me?.cells?.length > 1) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of me.cells) { const p = predictedCells.get(c.id) || c; minX = Math.min(minX, p.x - c.radius); maxX = Math.max(maxX, p.x + c.radius); minY = Math.min(minY, p.y - c.radius); maxY = Math.max(maxY, p.y + c.radius); }
      targetScale = Math.min(targetScale, width * .7 / Math.max(250, maxX - minX + 180), height * .65 / Math.max(200, maxY - minY + 180));
    }
    const minScale = Math.max(width / 3200, height / 2300, mobile ? .3 : .35);
    targetScale = clamp(targetScale, minScale, mobile ? 1 : 1.15);
    if (!Number.isFinite(camera.x) || Math.hypot(camera.x - targetX, camera.y - targetY) > 1600) { camera.x = targetX; camera.y = targetY; camera.scale = targetScale; }
    else { const follow = 1 - Math.exp(-dt * 9); camera.x += (targetX - camera.x) * follow; camera.y += (targetY - camera.y) * follow; camera.scale += (targetScale - camera.scale) * (1 - Math.exp(-dt * 3)); }
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
    const dt = Math.min((time - (lastFrame || time)) / 1000, .05); lastFrame = time;
    if (!fpsStarted) fpsStarted = time;
    frameCount++; if (time - fpsStarted >= 700) { fps = Math.round(frameCount * 1000 / (time - fpsStarted)); frameCount = 0; fpsStarted = time; }
    predictOwn(dt, time); updateCamera(dt);
    const view = getCamera();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); drawBackground();
    ctx.save(); ctx.translate(view.offsetX, view.offsetY); ctx.scale(view.scale, view.scale); drawArena(view);
    renderedDust = 0; renderedCells = 0;
    if (room) {
      const sampleAt = room._renderTime + Math.max(0, time - room._receivedAt) - 100;
      for (const dust of room.dust) {
        const position = sampleTrack(dustTracks.get(dust.id), sampleAt, 75) || dust;
        const radius = dust.fragment ? Math.sqrt(dust.value || 1) * 3 + 15 : 15;
        if (!visible(position.x, position.y, radius, view)) continue;
        drawDust(dust, position, time); renderedDust++;
      }
      for (const blast of room.blasts) if (visible(blast.x, blast.y, (blast.radius || 210) + 30, view)) drawBlast(blast, time);
      for (const player of room.players) {
        if (player.respawnIn > 0) continue;
        const cells = player.cells || [];
        let primary = cells[0]; for (const c of cells) if (!primary || c.mass > primary.mass) primary = c;
        for (const cell of cells) {
          const own = player.id === myId;
          const position = own ? predictedCells.get(cell.id) || cell : sampleTrack(cellTracks.get(`${player.id}:${cell.id}`), sampleAt) || cell;
          if (!visible(position.x, position.y, cell.radius * 2.3 + 35, view)) continue;
          if (own && primary === cell && cell.gravityRadius) drawGravity(position.x, position.y, cell.gravityRadius, player.color, time);
          drawPlanet(player, cell, position, time, primary === cell); renderedCells++;
        }
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]; p.life -= dt; p.y -= dt * 23;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        if (!visible(p.x, p.y, 30, view)) continue;
        ctx.globalAlpha = p.life; ctx.fillStyle = p.color; ctx.font = '600 13px ui-monospace,monospace'; ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y); ctx.globalAlpha = 1;
      }
    } else {
      drawPlanet({ id: 'dec1', color: palette[0], hp: 100 }, { radius: 43, mass: 80 }, { x: view.x - 330, y: view.y - 90 }, time, false, true);
      drawPlanet({ id: 'dec2', color: palette[3], hp: 100 }, { radius: 28, mass: 40 }, { x: view.x + 360, y: view.y + 170 }, time, false, true);
    }
    ctx.restore();
    if (room?.status === 'playing') drawMinimap(view);
    updateHud();
    raf = requestAnimationFrame(render);
  }

  function drawBackground() {
    if (!backgroundCanvas) {
      backgroundCanvas = document.createElement('canvas'); backgroundCanvas.width = Math.ceil(width); backgroundCanvas.height = Math.ceil(height);
      const b = backgroundCanvas.getContext('2d');
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
    const sprite = makeSprite(r * 4.3 + 8), c = sprite.c, p = sprite.center;
    c.translate(p, p);
    const halo = c.createRadialGradient(0, 0, r * .7, 0, 0, r * 2.1); halo.addColorStop(0, `${color}24`); halo.addColorStop(1, `${color}00`); c.fillStyle = halo; c.beginPath(); c.arc(0, 0, r * 2.1, 0, Math.PI * 2); c.fill();
    c.save(); c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.clip();
    const surface = c.createRadialGradient(-r * .4, -r * .45, 1, r * .23, r * .25, r * 1.6);
    surface.addColorStop(0, '#f4f6ff'); surface.addColorStop(.14, color); surface.addColorStop(.56, color); surface.addColorStop(.84, '#30394a'); surface.addColorStop(1, '#0b1320'); c.fillStyle = surface; c.fillRect(-r, -r, r * 2, r * 2);
    c.rotate(-.4); c.strokeStyle = '#ffffff38'; c.lineWidth = Math.max(.6, r * .025);
    for (let i = 0; i < 4; i++) { const y = -r * .7 + i * r * .43; c.beginPath(); c.ellipse(-r * .1, y, r * 1.05, r * .18, .08, 0, Math.PI * 2); c.stroke(); }
    for (const [x, y, rr] of [[-.42, -.16, .23], [.24, .34, .19], [.35, -.52, .12]]) { c.fillStyle = '#18203938'; c.beginPath(); c.ellipse(x * r, y * r, rr * r, rr * r * .7, .4, 0, Math.PI * 2); c.fill(); c.strokeStyle = '#f4edff40'; c.lineWidth = .7; c.stroke(); }
    c.restore(); c.strokeStyle = `${color}b0`; c.lineWidth = .8; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.stroke();
    c.save(); c.rotate(-.45); c.strokeStyle = `${color}55`; c.lineWidth = 1; c.beginPath(); c.ellipse(0, 0, r * 1.6, r * .4, 0, 0, Math.PI); c.stroke(); c.restore();
    sprite.radius = r; planetSprites.set(key, sprite); if (planetSprites.size > 64) planetSprites.delete(planetSprites.keys().next().value); return sprite;
  }

  function cachedDust(dust) {
    const color = dust.fragment || dust.ejected ? safeColor(dust.color) : '#c2e6cc';
    const radius = dust.fragment ? clamp(Math.round(Math.sqrt(dust.value || 1) * 2.15 / 2) * 2, 5, 34) : dust.ejected ? 4 : 1.5;
    const key = `${color}:${dust.fragment ? 'f' : 'd'}:${radius}`;
    if (dustSprites.has(key)) return dustSprites.get(key);
    const sprite = makeSprite(Math.max(18, radius * 5)), c = sprite.c;
    c.translate(sprite.center, sprite.center);
    const halo = c.createRadialGradient(0, 0, radius * .3, 0, 0, radius * 2.4); halo.addColorStop(0, `${color}77`); halo.addColorStop(1, `${color}00`); c.fillStyle = halo; c.beginPath(); c.arc(0, 0, radius * 2.4, 0, Math.PI * 2); c.fill();
    c.fillStyle = color;
    if (dust.fragment) { c.beginPath(); for (let i = 0; i < 7; i++) { const a = Math.PI * 2 / 7 * i, r = radius * (i % 2 ? .7 : 1); if (!i) c.moveTo(Math.cos(a) * r, Math.sin(a) * r); else c.lineTo(Math.cos(a) * r, Math.sin(a) * r); } c.closePath(); c.fill(); c.strokeStyle = '#ffffff66'; c.lineWidth = .7; c.stroke(); c.strokeStyle = '#20304199'; c.beginPath(); c.moveTo(-radius * .6, -radius * .2); c.lineTo(0, 0); c.lineTo(radius * .3, radius * .6); c.stroke(); }
    else if (dust.ejected) { c.beginPath(); c.arc(0, 0, radius, 0, Math.PI * 2); c.fill(); }
    else { c.rotate(Math.PI / 4); c.fillRect(-radius, -radius, radius * 2, radius * 2); }
    dustSprites.set(key, sprite); if (dustSprites.size > 48) dustSprites.delete(dustSprites.keys().next().value); return sprite;
  }

  function drawDust(dust, position, time) {
    const sprite = cachedDust(dust), speed = Math.hypot(dust.vx || 0, dust.vy || 0);
    if (speed > 25) { const length = clamp(speed * .07, 3, 27); ctx.strokeStyle = dust.fragment ? `${safeColor(dust.color)}55` : '#c2e6cc35'; ctx.lineWidth = dust.fragment ? 1.5 : .7; ctx.beginPath(); ctx.moveTo(position.x, position.y); ctx.lineTo(position.x - dust.vx / speed * length, position.y - dust.vy / speed * length); ctx.stroke(); }
    ctx.drawImage(sprite.canvas, position.x - sprite.center, position.y - sprite.center);
  }
  function drawGravity(x, y, radius, color, time) {
    color = safeColor(color); ctx.save(); ctx.translate(x, y); ctx.strokeStyle = `${color}25`; ctx.lineWidth = .7; ctx.setLineDash([2, 10]); ctx.beginPath(); ctx.arc(0, 0, radius, time * .00012, Math.PI * 2 + time * .00012); ctx.stroke(); ctx.setLineDash([]);
    const pulse = 1 - ((time * .00017) % 1); ctx.globalAlpha = (1 - pulse) * .12; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(0, 0, radius * (.55 + pulse * .45), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  function drawBlast(blast) {
    const color = safeColor(room.players.find((p) => p.id === blast.ownerId)?.color), r = Math.max(1, blast.radius || 1), progress = clamp(blast.progress || 0, 0, 1);
    ctx.save(); ctx.globalAlpha = 1 - progress * .6; ctx.strokeStyle = `${color}24`; ctx.lineWidth = 13; ctx.beginPath(); ctx.arc(blast.x, blast.y, r, 0, Math.PI * 2); ctx.stroke(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); ctx.strokeStyle = `${color}44`; ctx.lineWidth = .7; ctx.beginPath(); ctx.arc(blast.x, blast.y, Math.max(1, r - 8), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  function drawPlanet(player, cell, position, time, primary, decoration = false) {
    const color = safeColor(player.color), radius = Math.max(5, cell.radius || 24), me = player.id === myId, sprite = cachedPlanet(color, radius), scale = radius / sprite.radius;
    ctx.save();
    if (player.connected === false) ctx.globalAlpha = .5;
    else if (player.invulnerable > 0) ctx.globalAlpha = .75 + Math.sin(time * .015) * .2;
    if (player.boosting) { const velocity = Math.hypot(player.vx || 0, player.vy || 0); if (velocity > 0) { ctx.strokeStyle = `${color}33`; ctx.lineWidth = radius * .8; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(position.x, position.y); ctx.lineTo(position.x - player.vx / velocity * radius * 2.2, position.y - player.vy / velocity * radius * 2.2); ctx.stroke(); } }
    ctx.drawImage(sprite.canvas, position.x - sprite.center * scale, position.y - sprite.center * scale, sprite.canvas.width * scale, sprite.canvas.height * scale);
    if (me && !decoration) { ctx.strokeStyle = `${color}aa`; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.arc(position.x, position.y, radius + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(player.hp / (player.stats?.maxHp || 100), 0, 1)); ctx.stroke(); }
    if (cell.protected || cell.protectedFor > 0) { ctx.strokeStyle = `${color}aa`; ctx.lineWidth = 1.1; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.arc(position.x, position.y, radius + 11 + Math.sin(time * .008) * 2, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    if (!decoration && radius > 15) { ctx.font = `600 ${clamp(radius * .43, 10, 20)}px ui-monospace,monospace`; ctx.textAlign = 'center'; ctx.fillStyle = '#eff4ffb0'; ctx.fillText(Math.floor(cell.mass || player.mass || 0), position.x, position.y + radius * .15); }
    if (!decoration && primary) { ctx.font = `${me ? '600' : '400'} 11px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = me ? '#edf8f3' : '#a5b5c7'; ctx.fillText(`${player.name}${me ? ' · 你' : player.connected === false ? ' · 重连中' : ''}`, position.x, position.y + radius + 26); if (me) { ctx.fillStyle = '#b9f6ca'; ctx.beginPath(); ctx.moveTo(position.x - 3, position.y - radius - 18); ctx.lineTo(position.x + 3, position.y - radius - 18); ctx.lineTo(position.x, position.y - radius - 13); ctx.fill(); } }
    ctx.restore();
  }
  function drawMinimap(view) {
    const mobile = width < 700, w = mobile ? 105 : 160, h = w * WORLD.height / WORLD.width, x = mobile ? 18 : 34, y = height - (mobile ? 174 : 103) - h;
    ctx.save(); roundRect(x, y, w, h, 7); ctx.fillStyle = '#0c1622d9'; ctx.fill(); ctx.strokeStyle = '#a6c0d32b'; ctx.lineWidth = 1; ctx.stroke();
    ctx.save(); roundRect(x + 2, y + 2, w - 4, h - 4, 5); ctx.clip();
    ctx.strokeStyle = '#b9f6ca3a'; ctx.fillStyle = '#b9f6ca08'; const vx = x + (view.x - view.width / 2) / WORLD.width * w, vy = y + (view.y - view.height / 2) / WORLD.height * h, vw = view.width / WORLD.width * w, vh = view.height / WORLD.height * h; ctx.fillRect(vx, vy, vw, vh); ctx.strokeRect(vx, vy, vw, vh);
    for (const p of room.players) { if (p.respawnIn > 0) continue; const own = p.id === myId, center = own ? getOwnCenter() || p : p; ctx.fillStyle = own ? '#d2ffe0' : safeColor(p.color); ctx.globalAlpha = own ? 1 : .65; ctx.beginPath(); ctx.arc(x + center.x / WORLD.width * w, y + center.y / WORLD.height * h, own ? 2.5 : 1.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore(); ctx.globalAlpha = 1; ctx.fillStyle = '#78909d'; ctx.font = `${mobile ? 7 : 8}px ui-monospace,monospace`; ctx.textAlign = 'left'; ctx.fillText(`${WORLD.width} × ${WORLD.height} / 宇宙导航`, x, y - 7); ctx.restore();
  }

  window.StarGame = { connect, disconnect, onLobby: null, get isConnected() { return active && joined && !reconnecting; }, getDiagnostics() { const view = getCamera(); return { fps, ping: rtt === null ? null : Math.round(rtt), world: { ...WORLD }, view: { x: view.x, y: view.y, width: view.width, height: view.height, scale: view.scale }, self: getOwnCenter(), inputSeq, lastInputAck, renderedDust, renderedCells, inputHistoryLength: inputHistory.length, predictedCellCount: predictedCells.size, cellTrackCount: cellTracks.size, materializedDustCount: materializedDust.size, spriteCount: planetSprites.size + dustSprites.size, trackedDust: dustTracks.size }; } };
})();
