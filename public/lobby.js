/* Planet Boom lobby: no external assets or tracking. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const storage = { get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem(key, value); } catch { /* private browsing */ } } };
  const skinNames = ['薄荷新星', '紫雾行星', '落日橘星', '极光蓝星'];
  const modes = { quick: ['快速匹配','开始匹配'], create: ['好友开黑','创建好友房间'], practice: ['自由练习','进入练习场'] };
  let mode = 'quick', skin = Math.max(0, Math.min(3, Number(storage.get('pb-skin','0')) || 0));
  let busy = false, toastTimer, sound = storage.get('pb-sound','false') === 'true';
  let reducedMotion = storage.get('pb-motion', String(matchMedia('(prefers-reduced-motion: reduce)').matches)) === 'true';
  let audio;
  window.StarAudio = { get enabled() { return sound; }, setEnabled: setSound, play(kind='click') {
    if (!sound) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const tones = {start:[330,660,.24],blast:[90,34,.3],collect:[720,1100,.1],upgrade:[440,880,.35],click:[450,550,.07]};
      const [from,to,duration] = tones[kind] || tones.click;
      const osc = audio.createOscillator(), gain = audio.createGain();
      osc.type=kind==='blast'?'triangle':'sine';osc.frequency.setValueAtTime(from,audio.currentTime);osc.frequency.exponentialRampToValueAtTime(to,audio.currentTime+duration);
      gain.gain.setValueAtTime(kind==='blast'?.10:.045,audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+duration);
      osc.connect(gain);gain.connect(audio.destination);osc.start();osc.stop(audio.currentTime+duration);
    } catch { /* audio optional */ }
  }};
  function toast(message) { clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,3800); }
  function saveName() { let name=$('#nickname').value.trim().slice(0,12); if(!name) name='星际旅人';$('#nickname').value=name;$('#headerName').textContent=name;storage.set('pb-name',name);return name; }
  $('#nickname').value=storage.get('pb-name','星际旅人');saveName();
  $('#nickname').addEventListener('input',()=>{$('#headerName').textContent=$('#nickname').value.trim()||'星际旅人';});
  $('#nickname').addEventListener('change',saveName);
  $('#randomName').addEventListener('click',()=>{const names=['银河小土豆','炸毛的月亮','薄荷宇航员','快乐小行星','宇宙蹦迪王','流浪的团子','星屑收集员','一颗大橘星'];$('#nickname').value=names[Math.floor(Math.random()*names.length)];saveName();window.StarAudio.play();});
  function selectSkin(index) { skin=index;storage.set('pb-skin',String(index));$$('.skin-option').forEach((b)=>{const active=Number(b.dataset.skin)===index;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('#previewPlanet').className=`preview-planet skin-${index}`;$('#skinName').textContent=skinNames[index];$('.planet-caption small').textContent=`NO. 00${index+1}`; }
  selectSkin(skin);$$('.skin-option').forEach(b=>b.addEventListener('click',()=>{selectSkin(Number(b.dataset.skin));window.StarAudio.play();}));
  function selectMode(next) { mode=next;$$('.mode-card').forEach(b=>{const active=b.dataset.mode===next;b.classList.toggle('selected',active);b.setAttribute('aria-pressed',String(active));});$('#selectedModeLabel').textContent=modes[next][0];$('#launchButton').childNodes[0].textContent=modes[next][1]; }
  $$('.mode-card').forEach(b=>b.addEventListener('click',()=>{selectMode(b.dataset.mode);window.StarAudio.play();}));
  async function launch(next,code) {
    if(busy) return;
    busy=true;const launchButton=$('#launchButton');launchButton.disabled=true;launchButton.childNodes[0].textContent='正在接入宇宙…';$('#joinError').textContent='';
    try {
      if(!window.StarGame) throw new Error('游戏资源尚未就绪，请稍后重试。');
      await window.StarGame.connect(next,{name:saveName(),skin,code});
      $$('dialog[open]').forEach(d=>d.close());document.body.classList.add('playing');window.StarAudio.play('start');
    } catch(e) { const message=e.message||'连接失败，请稍后重试。'; if(next==='join')$('#joinError').textContent=message;else toast(message); }
    finally { busy=false;launchButton.disabled=false;launchButton.childNodes[0].textContent=modes[mode][1]; }
  }
  $('#launchButton').addEventListener('click',()=>launch(mode));
  window.addEventListener('stargame:lobby',e=>{document.body.classList.remove('playing');if(e.detail?.reason)toast(e.detail.reason);refreshStats();});
  function openDialog(id) { const dialog=$(id);if(!dialog.open)dialog.showModal();window.StarAudio.play(); }
  const actions={home(){window.scrollTo({top:0,behavior:reducedMotion?'instant':'smooth'});},planet(){ $('.pilot-panel').scrollIntoView({behavior:reducedMotion?'instant':'smooth',block:'center'});$('#nickname').focus({preventScroll:true});},guide(){openDialog('#guideDialog');},settings(){openDialog('#settingsDialog');},quick(){selectMode('quick');launch('quick');},practice(){selectMode('practice');launch('practice');},create(){selectMode('create');launch('create');},join(){openDialog('#joinDialog');$('#roomCode').focus();}};
  $$('[data-action]').forEach(b=>b.addEventListener('click',()=>actions[b.dataset.action]?.()));
  $$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
  $('#roomCode').addEventListener('input',()=>{$('#roomCode').value=$('#roomCode').value.toUpperCase().replace(/[^A-Z0-9]/g,'');});
  $('#joinForm').addEventListener('submit',e=>{e.preventDefault();if(!busy)launch('join',$('#roomCode').value.trim().toUpperCase());});
  function setSound(value) { sound=value;storage.set('pb-sound',String(value));$('#soundToggle').checked=value;$('#soundButton').setAttribute('aria-pressed',String(value));$('#soundButton').setAttribute('aria-label',value?'关闭音效':'开启音效');$('.mute-line').hidden=value; }
  setSound(sound);$('#soundButton').addEventListener('click',()=>{setSound(!sound);window.StarAudio.play();toast(sound?'游戏音效已开启':'游戏音效已关闭');});$('#soundToggle').addEventListener('change',e=>{setSound(e.target.checked);window.StarAudio.play();});
  function setMotion(value) { reducedMotion=value;storage.set('pb-motion',String(value));$('#motionToggle').checked=value;document.body.classList.toggle('reduced-motion',value); }
  setMotion(reducedMotion);$('#motionToggle').addEventListener('change',e=>setMotion(e.target.checked));
  document.addEventListener('keydown',e=>{if((e.key==='?'||e.key==='/')&&!document.body.classList.contains('playing')&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();openDialog('#guideDialog');}});
  async function refreshStats(){try{const response=await fetch('/api/stats');if(!response.ok)throw new Error();const stats=await response.json();const players=stats.players??stats.playerCount??stats.humans??0;$('#serviceStatus').innerHTML='<span class="signal-dot"></span><span>星际网络已就绪'+(players>0?` · ${Number(players)} 人在线`:'')+'</span>';}catch{$('#serviceStatus').innerHTML='<span class="signal-dot" style="background:#d5a56f"></span><span>服务器暂未连接</span>';}}
  refreshStats();setInterval(()=>{if(!document.body.classList.contains('playing'))refreshStats();},30000);
  // The lobby illustration is drawn procedurally, matching the live planets.
  const canvas=$('#heroCanvas'),ctx=canvas.getContext('2d');
  let w=0,h=0,dpr=1,lastFrame=0;
  const rand=(seed)=>{let x=Math.sin(seed*127.1+311.7)*43758.5453;return x-Math.floor(x);};
  function resize(){const r=canvas.getBoundingClientRect();w=r.width;h=r.height;dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);}
  new ResizeObserver(resize).observe(canvas);resize();
  function planet(x,y,r,color,seed,time,ring=false) {
    ctx.save();ctx.translate(x,y);ctx.rotate(-.3);
    const aura=ctx.createRadialGradient(0,0,r*.5,0,0,r*1.6);aura.addColorStop(0,color+'22');aura.addColorStop(1,color+'00');ctx.fillStyle=aura;ctx.beginPath();ctx.arc(0,0,r*1.6,0,Math.PI*2);ctx.fill();
    if(ring){ctx.strokeStyle='#bedca333';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(0,0,r*1.65,r*.5,-.2,Math.PI,2*Math.PI);ctx.stroke();}
    const glow=ctx.createRadialGradient(-r*.4,-r*.45,r*.04,r*.2,r*.25,r*1.1);glow.addColorStop(0,'#e6f6bd');glow.addColorStop(.18,color);glow.addColorStop(.52,'#52755b');glow.addColorStop(.85,'#192e34');glow.addColorStop(1,'#12212b');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.beginPath();ctx.arc(0,0,r-.5,0,Math.PI*2);ctx.clip();
    for(let n=0;n<15;n++){let angle=rand(seed+n)*Math.PI*2,dist=Math.sqrt(rand(seed+n+40))*r*.85,cx=Math.cos(angle)*dist,cy=Math.sin(angle)*dist,cr=r*(.04+rand(n+seed+90)*.13);ctx.save();ctx.translate(cx,cy);ctx.scale(1,.8+rand(n+200)*.25);const cg=ctx.createRadialGradient(cr*.1,cr*.2,cr*.1,0,0,cr);cg.addColorStop(0,'#1b332517');cg.addColorStop(.65,'#243a3522');cg.addColorStop(.87,'#172e3b66');cg.addColorStop(1,'#c5dc9a24');ctx.fillStyle=cg;ctx.beginPath();ctx.arc(0,0,cr,0,Math.PI*2);ctx.fill();ctx.restore();}
    ctx.strokeStyle='#e2efca09';for(let n=0;n<12;n++){ctx.lineWidth=rand(n+350)*1.5;ctx.beginPath();ctx.ellipse(-r*.2,r*(rand(n+300)-.5)*2,r*(.3+rand(n+400)),r*.15,-.5,0,Math.PI);ctx.stroke();}ctx.restore();
    ctx.strokeStyle='#b5ebc525';ctx.lineWidth=.8;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();
    if(ring){ctx.strokeStyle='#d5edb182';ctx.lineWidth=1.2;ctx.beginPath();ctx.ellipse(0,0,r*1.65,r*.5,-.2,0,Math.PI);ctx.stroke();ctx.strokeStyle='#a6d9af26';ctx.lineWidth=5;ctx.beginPath();ctx.ellipse(0,0,r*1.62,r*.48,-.2,0,Math.PI);ctx.stroke();}
    ctx.restore();
  }
  function draw(now){requestAnimationFrame(draw);if(!w||document.hidden||document.body.classList.contains('playing'))return;if(now-lastFrame<(reducedMotion?500:33))return;lastFrame=now;const t=reducedMotion?0:now*.0002;ctx.clearRect(0,0,w,h);let bg=ctx.createLinearGradient(0,0,w,h);bg.addColorStop(0,'#122322');bg.addColorStop(.55,'#132c32');bg.addColorStop(1,'#142431');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
    let neb=ctx.createRadialGradient(w*.8,h*.4,0,w*.8,h*.4,w*.6);neb.addColorStop(0,'#467b7133');neb.addColorStop(1,'#10232b00');ctx.fillStyle=neb;ctx.fillRect(0,0,w,h);
    for(let n=0;n<100;n++){const x=rand(n+1)*w,y=rand(n+103)*h,a=.15+rand(n+205)*.5;ctx.fillStyle=`rgba(199,222,212,${a*(.8+.2*Math.sin(t+n))})`;const r=rand(n+600)>.96?1.3:.5;ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill();if(n%23===0){ctx.strokeStyle='#c9eccb44';ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(x-3,y);ctx.lineTo(x+3,y);ctx.moveTo(x,y-3);ctx.lineTo(x,y+3);ctx.stroke();}}
    ctx.save();ctx.strokeStyle='#91bba714';ctx.lineWidth=1;ctx.setLineDash([2,7]);ctx.beginPath();ctx.ellipse(w*.73,h*.57,w*.39,h*.58,-.37,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.strokeStyle='#8bb9b314';ctx.beginPath();ctx.ellipse(w*.73,h*.53,w*.31,h*.61,-.37,0,Math.PI*2);ctx.stroke();ctx.restore();
    const mainX=w*.77,mainY=h*.50+Math.sin(t)*5,r=Math.min(h*.29,w*.19);planet(mainX,mainY,r,'#abc887',71,t,true);
    ctx.save();ctx.filter='hue-rotate(140deg)';planet(w*.57,h*.21+Math.sin(t+2)*4,r*.25,'#b5bdd5',23,t);ctx.restore();
    ctx.save();ctx.filter='hue-rotate(300deg)';planet(w*.95,h*.82+Math.sin(t+4)*3,r*.31,'#b4b47c',41,t);ctx.restore();
    for(let n=0;n<8;n++){const x=w*(.51+rand(n+701)*.47),y=h*(.13+rand(n+770)*.76);if(Math.hypot(x-mainX,y-mainY)<r*1.5)continue;ctx.fillStyle=n%2?'#d5d9b977':'#6ea89c99';ctx.save();ctx.translate(x,y+Math.sin(t+n)*3);ctx.rotate(n);ctx.beginPath();ctx.moveTo(-3,-3);ctx.lineTo(2,-4);ctx.lineTo(5,1);ctx.lineTo(1,4);ctx.lineTo(-4,2);ctx.closePath();ctx.fill();ctx.restore();}
    ctx.fillStyle='#b9f678';const sx=w*.88,sy=h*.18;ctx.fillRect(sx-2,sy-.5,4,1);ctx.fillRect(sx-.5,sy-2,1,4);
  }requestAnimationFrame(draw);
})();
