/* Авторизация (email + пароль) и облачная синхронизация состояния через Supabase.
   Подключается ПОСЛЕ основного скрипта index.html и vendor/supabase.js.
   Если Supabase не настроен (placeholder в supabase-config.js) — модуль ничего
   не делает, приложение остаётся полностью оффлайн, как раньше. */
(function(){
  var CFG = window.SUPABASE_CONFIG || {};
  var configured = CFG.url && CFG.anonKey &&
    CFG.url.indexOf('YOUR_') < 0 && CFG.anonKey.indexOf('YOUR_') < 0;

  var STORE_KEY = 'trustboard.v4';   // тот же ключ, что и в основном скрипте
  function gate(){ return document.getElementById('authGate'); }
  function showGate(){ var g=gate(); if(g) g.style.display='flex'; }
  function hideGate(){ var g=gate(); if(g) g.style.display='none'; }
  function setMsg(t,err){ var m=document.getElementById('authMsg'); if(m){ m.textContent=t||''; m.style.color=err?'#e05555':'var(--muted)'; } }

  if(!configured){
    // Оффлайн-режим: убираем экран входа, приложение работает без аккаунта.
    document.addEventListener('DOMContentLoaded', hideGate);
    if(document.readyState!=='loading') hideGate();
    return;
  }

  if(typeof supabase==='undefined' || !supabase.createClient){
    console.warn('[auth] supabase-js не загружен — вход недоступен');
    document.addEventListener('DOMContentLoaded', hideGate);
    return;
  }

  var client = supabase.createClient(CFG.url, CFG.anonKey, {
    auth:{ persistSession:true, autoRefreshToken:true, storageKey:'john.auth' }
  });
  window._sb = client;

  var currentUser = null, syncTimer = null;

  /* ---------- синхронизация ---------- */
  function localState(){ try{ return localStorage.getItem(STORE_KEY); }catch(e){ return null; } }

  var lastSync = null;                    // updated_at облачной версии, которую мы уже применили/записали
  try{ lastSync = localStorage.getItem('tb.lastSync'); }catch(e){}
  function _stampSync(s){ lastSync=s; try{ localStorage.setItem('tb.lastSync', s); }catch(e){} }
  function busyEditing(){
    var a=document.activeElement;
    return !!(a && (a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.isContentEditable));
  }

  async function pull(initial){
    if(!currentUser) return;
    try{
      if(initial){
        try{
          var _lu=localStorage.getItem('tb.lastUser');
          if(_lu && _lu!==currentUser.id){ // другой аккаунт на этом устройстве — чужие метки не применимы
            try{localStorage.removeItem('tb.dirty');}catch(e){}
            try{localStorage.removeItem('tb.lastSync');}catch(e){}
            lastSync=null; _lastPushed=null;
          }
        }catch(e){}
        try{ if(localStorage.getItem('tb.dirty')==='1' && lastSync){ await push(); try{localStorage.setItem('tb.lastUser',currentUser.id);}catch(e){} return; } }catch(e){}
      }
      var res = await client.from('app_state').select('data,updated_at').eq('user_id', currentUser.id).maybeSingle();
      if(res.error){ console.warn('[auth] pull', res.error.message); return; }
      if(res.data && res.data.data){
        var stamp = res.data.updated_at || '';
        if(!initial){
          if(stamp && stamp===lastSync) return;   // облако не менялось с прошлого раза
          if(syncTimer || busyEditing()) return;  // есть неотправленные правки или юзер печатает — не затираем
          try{ if(localStorage.getItem('tb.dirty')==='1'){ push(); return; } }catch(e){}
        }
        // страховка: при входе, перед первой перезаписью облаком, сохраняем локальную копию
        if(initial){ try{ var cur=localStorage.getItem(STORE_KEY); if(cur && cur.length>200) localStorage.setItem('tb.preloginBackup', JSON.stringify({at:Date.now(),data:cur})); }catch(e){} }
        var raw = (typeof res.data.data==='string') ? res.data.data : JSON.stringify(res.data.data);
        if(raw===localState()){ _stampSync(stamp); return; }   // содержимое совпадает — только отметим версию
        try{ localStorage.setItem(STORE_KEY, raw); }catch(e){}
        _stampSync(stamp); _lastPushed=raw;
        try{ window._lastSaved=raw; }catch(e){}  // кэш дедупликации save() в главном скрипте
        try{ localStorage.removeItem('tb.dirty'); }catch(e){}
        try{ localStorage.setItem('tb.lastUser',currentUser.id); }catch(e){}
        if(typeof load==='function') load();
        if(typeof renderAll==='function') renderAll();
      }else{
        await push();   // на сервере пусто — заливаем текущее локальное как первое состояние
      }
    }catch(e){ console.warn('[auth] pull ex', e); }
  }

  var _lastPushed=null,_pushing=false;
  async function push(){
    if(!currentUser) return;
    if(_pushing) return; // не гоняем два push параллельно
    var payload = localState();
    if(payload==null) return;
    if(payload===_lastPushed){
      if(localState()===payload){ try{ localStorage.removeItem('tb.dirty'); }catch(e){} } // уже в облаке
      return;
    }
    _pushing=true;
    try{
      // конфликт: облако менялось после нашей последней синхронизации (другое устройство)?
      try{
        var chk = await client.from('app_state').select('updated_at').eq('user_id', currentUser.id).maybeSingle();
        if(!chk.error && chk.data && chk.data.updated_at && chk.data.updated_at!==lastSync){
          var full = await client.from('app_state').select('data').eq('user_id', currentUser.id).maybeSingle();
          if(!full.error && full.data && full.data.data){
            var rw=(typeof full.data.data==='string')?full.data.data:JSON.stringify(full.data.data);
            if(rw && rw.length>200) localStorage.setItem('tb.conflictBackup', JSON.stringify({at:Date.now(),data:rw}));
          }
        }
      }catch(e){}
      var stamp = new Date().toISOString();
      var res = await client.from('app_state').upsert(
        { user_id: currentUser.id, data: payload, updated_at: stamp },
        { onConflict: 'user_id' }
      );
      if(res.error) console.warn('[auth] push', res.error.message);
      else{
        _stampSync(stamp); _lastPushed=payload;
        if(localState()===payload){ try{ localStorage.removeItem('tb.dirty'); }catch(e){} } // за время отправки могли появиться новые правки
        try{ localStorage.setItem('tb.lastUser',currentUser.id); }catch(e){}
        try{ publishSharedCal(); }catch(e){}
      }
    }catch(e){ console.warn('[auth] push ex', e); }
    finally{ _pushing=false; }
  }

  /* ---------- команда: календарная выжимка для ролей (v1.83) ---------- */
  var _teamShareNeeded=null,_lastSharedPub=null;
  async function _refreshShareNeeded(){
    try{
      if(!currentUser){_teamShareNeeded=false;return;}
      var r=await client.from('team_links').select('share,status').eq('owner_id',currentUser.id).eq('status','accepted');
      _teamShareNeeded=(r.data||[]).some(function(x){return String(x.share||'').indexOf('calendar')>=0;});
    }catch(e){_teamShareNeeded=false;}
  }
  function _buildSharedCal(){
    try{
      var now=Date.now(),H=60*86400000,evs=[];
      var MM=(typeof meetings!=='undefined'&&Array.isArray(meetings))?meetings:[];
      var TT=(typeof tasks!=='undefined'&&Array.isArray(tasks))?tasks:[];
      var PP=(typeof people!=='undefined'&&Array.isArray(people))?people:[];
      MM.forEach(function(m){ if(m.done||!m.at)return; if(m.at<now-86400000||m.at>now+H)return; evs.push({k:m.call?'созвон':'встреча',t:String(m.t||''),at:m.at,end:m.end||null,loc:String(m.loc||'')}); });
      TT.forEach(function(t){ if(t.done||!t.due)return; if(t.due<now-86400000||t.due>now+H)return; evs.push({k:'дело',t:String(t.text||''),at:t.due,end:t.dend||null}); });
      evs.sort(function(a,b){return a.at-b.at;});
      var bds=[];
      PP.forEach(function(p){ if(!p.born)return; var b=String(p.born).split('-'); if(b.length<3)return; var d=(typeof daysToBday==='function')?daysToBday(p.born):null; bds.push({nm:String(p.nm||''),born:String(p.born),days:(d==null?9999:d)}); });
      bds.sort(function(a,b){return a.days-b.days;});
      return JSON.stringify({evs:evs.slice(0,100),bds:bds.slice(0,300),at:now});
    }catch(e){ return null; }
  }
  async function publishSharedCal(force){
    if(!currentUser)return;
    if(_teamShareNeeded===null)await _refreshShareNeeded();
    if(!_teamShareNeeded)return;
    var payload=_buildSharedCal(); if(!payload)return;
    if(!force&&payload===_lastSharedPub)return;
    try{
      var r=await client.from('shared_cal').upsert({owner_id:currentUser.id,data:payload,updated_at:new Date().toISOString()},{onConflict:'owner_id'});
      if(!r.error)_lastSharedPub=payload;
    }catch(e){}
  }

  /* ---------- команда: приглашения и просмотр (v1.81) ---------- */
  window.johnLoc={
    _t:null,
    _geo:function(){ var C=window.Capacitor; return C&&C.Plugins&&C.Plugins.Geolocation; },
    ensurePerm: async function(){
      try{ var G=this._geo(); if(!G)return false;
        var p=await G.checkPermissions();
        if(p.location==='prompt'||p.location==='prompt-with-rationale')p=await G.requestPermissions();
        return p.location==='granted';
      }catch(e){ return false; }
    },
    _once: async function(){
      try{ var G=this._geo(); if(!G||!currentUser)return;
        var pos=await G.getCurrentPosition({enableHighAccuracy:true,timeout:15000});
        await client.from('locations').upsert({user_id:currentUser.id,lat:pos.coords.latitude,lng:pos.coords.longitude,acc:pos.coords.accuracy,sharing:true,updated_at:new Date().toISOString()},{onConflict:'user_id'});
        this._recHist(pos.coords);
      }catch(e){}
    },
    _watchId:null,_lastPush:0,_bgWatch:null,_hb:null,_lastCoords:null,_lastGood:null,_rej:0,_lastNet:0,_natKey:null,_liveMode:false,_liveChk:0,
    _bg:function(){ var C=window.Capacitor; return C&&C.Plugins&&C.Plugins.BackgroundGeolocation; },
    _prefs:function(){ var C=window.Capacitor; return C&&C.Plugins&&C.Plugins.Preferences; },
    _rand:function(){ try{ var a=new Uint8Array(32); (window.crypto||crypto).getRandomValues(a); return Array.prototype.map.call(a,function(b){return ('0'+b.toString(16)).slice(-2);}).join(''); }catch(e){ return 'k'+Date.now()+Math.random().toString(36).slice(2); } },
    // Долгоживущий ключ устройства для НАТИВНОЙ отправки позиции при выгрузке приложения.
    // Один ключ на пользователя (PK user_id): первое устройство создаёт, остальные читают тот же.
    _ensureKey: async function(){
      if(!currentUser)return null;
      if(this._natKey)return this._natKey;
      try{
        var r=await client.from('locator_keys').select('key').eq('user_id',currentUser.id).maybeSingle();
        var key=r&&r.data&&r.data.key;
        if(!key){
          key=this._rand();
          var ins=await client.from('locator_keys').upsert({user_id:currentUser.id,key:key,updated_at:new Date().toISOString()},{onConflict:'user_id'}).select('key').maybeSingle();
          if(ins&&ins.error){ var r2=await client.from('locator_keys').select('key').eq('user_id',currentUser.id).maybeSingle(); key=(r2&&r2.data&&r2.data.key)||key; } // гонка двух устройств
        }
        this._natKey=key; return key;
      }catch(e){ return null; }
    },
    // Зеркалим key/url/on в нативное хранилище (Capacitor Preferences → UserDefaults),
    // откуда AppDelegate читает их на пробуждении CoreLocation (даже после force-quit).
    _mirrorNative: async function(on){
      try{ var P=this._prefs(); if(!P)return;
        if(on){
          var key=await this._ensureKey(); if(!key)return;
          var url=(window.SUPABASE_CONFIG&&window.SUPABASE_CONFIG.url)||'';
          await P.set({key:'locator.key',value:String(key)});
          await P.set({key:'locator.url',value:String(url)});
          await P.set({key:'locator.on',value:'1'});
        } else { await P.set({key:'locator.on',value:'0'}); }
      }catch(e){}
    },
    // location-push токен (его выдаёт натив через startMonitoringLocationPushes, кладёт в Preferences).
    // Грузим в location_push_tokens — по нему сервер шлёт location-пуш, будящий закрытое приложение.
    _lastPushTok:null,
    _uploadPushToken: async function(){
      try{ var P=this._prefs(); if(!P||!currentUser)return;
        var r=await P.get({key:'locator.pushtoken'}); var tok=r&&r.value;
        if(!tok||this._lastPushTok===tok)return; this._lastPushTok=tok;
        await client.from('location_push_tokens').upsert({user_id:currentUser.id,token:tok,updated_at:new Date().toISOString()},{onConflict:'user_id'});
      }catch(e){}
    },
    // Владелец, пока смотрит карту, зовёт это со списком видимых — сервер ставит им «живой режим».
    reqLive: async function(targets){
      try{ if(!currentUser||!targets||!targets.length)return;
        var s=await client.auth.getSession(); var tok=s&&s.data&&s.data.session&&s.data.session.access_token; if(!tok)return;
        var url=((window.SUPABASE_CONFIG&&window.SUPABASE_CONFIG.url)||'')+'/functions/v1/live-req';
        await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify({targets:targets})});
      }catch(e){}
    },
    _pushLoc:function(lat,lng,acc){
      try{ if(!currentUser)return;
        // «Живой режим»: если за мной сейчас следят (владелец открыл карту) — пишем чаще (~2с), иначе 8с.
        // Проверяем не чаще раза в 15с; работает и в фоне (натив зовёт _pushLoc на каждый фикс).
        var _n0=Date.now();
        if(_n0-(this._liveChk||0)>15000){ this._liveChk=_n0; var _self=this;
          client.from('live_watch').select('until').eq('target_id',currentUser.id).maybeSingle().then(function(r){
            var u=r&&r.data&&r.data.until; _self._liveMode=!!(u&&new Date(u).getTime()>Date.now());
          },function(){}); }
        // РЭБ/GPS-спуфинг: отсекаем явный мусор и «телепорты», но НЕ замораживаем реально движущегося.
        if(acc!=null && acc>2000) return;                      // явный мусор (Wi-Fi/соты ~100-500м проходят)
        var now=Date.now(), lg=this._lastGood, teleport=false;
        if(lg){ var d=this._dist(lg.lat,lg.lng,lat,lng), dt=Math.max(1,(now-lg.t)/1000); if(d>150 && d/dt>35) teleport=true; } // прыжок на нереальной скорости
        if(teleport){
          this._rej=(this._rej||0)+1;
          if(this._rej>=2 && now-(this._lastNet||0)>20000){ this._lastNet=now; this._netFix(); } // сверимся с Wi-Fi/сотами
          if(this._rej<5) return;                              // держим последнюю достоверную; 5 подряд → перемещение реальное, переякориваемся
        }
        this._rej=0;
        this._lastGood={lat:lat,lng:lng,t:now};
        this._lastCoords={lat:lat,lng:lng,acc:acc};
        if(now-(this._lastPush||0)<(this._liveMode?2000:8000))return; this._lastPush=now;
        client.from('locations').upsert({user_id:currentUser.id,lat:lat,lng:lng,acc:acc,sharing:true,updated_at:new Date().toISOString()},{onConflict:'user_id'}).then(function(){});
        this._recHist({latitude:lat,longitude:lng,accuracy:acc});
      }catch(e){}
    },
    // Когда GPS глушат (фиксы подряд отвергаются) — берём грубую позицию по Wi-Fi/сотам:
    // её РЭБ не подменяет. Проходит через тот же фильтр правдоподобности (телепорт/мусор отсекутся).
    _netFix:function(){ var self=this, G=this._geo(); if(!G||!G.getCurrentPosition)return;
      try{ var p=G.getCurrentPosition({enableHighAccuracy:false,timeout:8000,maximumAge:0});
        if(p&&p.then)p.then(function(pos){ try{ if(pos&&pos.coords)self._pushLoc(pos.coords.latitude,pos.coords.longitude,pos.coords.accuracy); }catch(e){} },function(){}); }catch(e){}
    },
    // Heartbeat: пере-штампует последнюю позицию раз в ~45с, чтобы «на связи» оставалось свежим,
    // даже если охранник стоит на месте (в фоне непрерывность держит натив distanceFilter:0).
    _heartbeat:function(){
      try{ if(!currentUser||!this._lastCoords)return; var now=Date.now(); if(now-(this._lastPush||0)<40000)return; this._lastPush=now;
        var L=this._lastCoords;
        client.from('locations').upsert({user_id:currentUser.id,lat:L.lat,lng:L.lng,acc:L.acc,sharing:true,updated_at:new Date().toISOString()},{onConflict:'user_id'}).then(function(){});
      }catch(e){}
    },
    start: async function(){
      var self=this; self._lastPush=0; self._lastGood=null; self._lastCoords=null; self._lastHist=null; self._rej=0; self._lastNet=0; // сброс кэша — heartbeat не опубликует старую/чужую точку
      try{localStorage.setItem('tb.locOn','1');}catch(e){} // запомнить — авто-возобновление при перезапуске
      try{ self._mirrorNative(true); }catch(e){} // ключ+url в натив — чтобы натив слал позицию, когда приложение выгружено
      try{ setTimeout(function(){ self._uploadPushToken(); },3500); }catch(e){} // location-push токен (натив регистрирует async)
      if(self._hb){clearInterval(self._hb);self._hb=null;}
      self._hb=setInterval(function(){ self._heartbeat(); },45000);
      // ФОНОВАЯ геолокация — обновляет позицию даже когда телефон заблокирован / приложение свёрнуто
      var BG=this._bg();
      if(BG&&BG.addWatcher){
        try{
          if(self._bgWatch){ try{await BG.removeWatcher({id:self._bgWatch});}catch(e){} self._bgWatch=null; }
          self._bgWatch=await BG.addWatcher({
            backgroundMessage:'Локатор включён — служба безопасности видит вас',
            backgroundTitle:'John · вы на связи',
            // distanceFilter:0 → натив шлёт фиксы непрерывно даже стоя на месте (плагин: 0 = kCLDistanceFilterNone);
            // частоту записей в БД ограничивает троттл 8с в _pushLoc.
            requestPermissions:true, stale:false, distanceFilter:0
          },function(loc,err){
            try{
              if(err){ if(err.code==='NOT_AUTHORIZED'){ try{if(window.toast)window.toast('Разрешите геолокацию «Всегда» в Настройках');}catch(_){}} return; }
              if(!loc)return;
              self._pushLoc(loc.latitude,loc.longitude,loc.accuracy);
            }catch(e){}
          });
          return true;
        }catch(e){ /* если фоновый плагин не поднялся — обычный foreground-путь ниже */ }
      }
      // fallback: обычный foreground-watch (обновляет только пока приложение открыто)
      var ok=await this.ensurePerm(); if(!ok){ if(self._hb){clearInterval(self._hb);self._hb=null;} return false; }
      var G=this._geo(); if(!G)return false;
      await this._once();
      if(self._watchId){ try{await G.clearWatch({id:self._watchId});}catch(e){} self._watchId=null; }
      if(self._t){clearInterval(self._t);self._t=null;}
      try{
        self._watchId=await G.watchPosition({enableHighAccuracy:true,timeout:30000},function(pos,err){
          try{ if(err||!pos||!currentUser)return; self._pushLoc(pos.coords.latitude,pos.coords.longitude,pos.coords.accuracy); }catch(e){}
        });
      }catch(e){ self._t=setInterval(function(){ self._once(); },30000); }
      return true;
    },
    stop: async function(){
      try{localStorage.removeItem('tb.locOn');}catch(e){} // выключили вручную — не возобновлять
      try{ this._mirrorNative(false); }catch(e){} // натив тоже перестаёт слать (locator.on=0)
      this._natKey=null;
      if(this._hb){clearInterval(this._hb);this._hb=null;}
      var BG=this._bg();
      if(this._bgWatch&&BG&&BG.removeWatcher){ try{await BG.removeWatcher({id:this._bgWatch});}catch(e){} this._bgWatch=null; }
      var G=this._geo();
      if(this._watchId&&G){ try{await G.clearWatch({id:this._watchId});}catch(e){} this._watchId=null; }
      if(this._t){clearInterval(this._t);this._t=null;}
      this._lastCoords=null;this._lastHist=null;this._lastGood=null;this._rej=0; // не оставлять кэш координат между сессиями/пользователями
      try{ if(currentUser)await client.from('locations').update({sharing:false,updated_at:new Date().toISOString()}).eq('user_id',currentUser.id); }catch(e){}
    },
    isSharing: async function(){
      try{ if(!currentUser)return false; var r=await client.from('locations').select('sharing').eq('user_id',currentUser.id); return !!(r.data&&r.data[0]&&r.data[0].sharing); }catch(e){ return false; }
    },
    others: async function(){
      try{ var r=await client.from('locations').select('*').eq('sharing',true).neq('user_id',currentUser?currentUser.id:''); return r.data||[]; }catch(e){ return []; }
    },
    allShared: async function(){
      try{ var r=await client.from('locations').select('*').eq('sharing',true); return r.data||[]; }catch(e){ return []; }
    },
    // все видимые (свои + участники по RLS), включая offline (sharing=false) — для «последнее место»
    allKnown: async function(){
      try{ var r=await client.from('locations').select('*'); return r.data||[]; }catch(e){ return []; }
    },
    // ——— История передвижений ———
    _lastHist:null,
    _dist:function(a,b,c,d){ var R=6371000,p=Math.PI/180;
      var s1=Math.sin((c-a)*p/2),s2=Math.sin((d-b)*p/2);
      var h=s1*s1+Math.cos(a*p)*Math.cos(c*p)*s2*s2;
      return 2*R*Math.asin(Math.min(1,Math.sqrt(h))); },
    _recHist:function(coords){
      try{
        if(!currentUser||!coords)return;
        var now=Date.now(),lh=this._lastHist;
        if(lh){ var far=this._dist(lh.lat,lh.lng,coords.latitude,coords.longitude)>25; var old=(now-lh.ts)>90000; if(!far&&!old)return; }
        this._lastHist={lat:coords.latitude,lng:coords.longitude,ts:now};
        client.from('location_history').insert({user_id:currentUser.id,lat:coords.latitude,lng:coords.longitude,acc:coords.accuracy}).then(function(){},function(){});
      }catch(e){}
    },
    // точки маршрута между fromISO..toISO (RLS отдаёт только видимых мне пользователей)
    history: async function(fromISO,toISO){
      try{ if(!currentUser)return [];
        var q=client.from('location_history').select('user_id,lat,lng,ts').order('ts',{ascending:true}).limit(5000);
        if(fromISO)q=q.gte('ts',fromISO);
        if(toISO)q=q.lte('ts',toISO);
        var r=await q; return r.data||[];
      }catch(e){ return []; }
    },
    myId: function(){ return currentUser?currentUser.id:null; }
  };
  // первый вход: спросить уведомления и геолокацию
  window.johnFirstRunPerms=async function(){
    try{ if(localStorage.getItem('tb.permsAsked')==='1')return; }catch(e){}
    try{ localStorage.setItem('tb.permsAsked','1'); }catch(e){}
    try{ if(window.johnPush&&johnPush.register)await johnPush.register(); }catch(e){}
    try{ if(window.johnLoc&&johnLoc.ensurePerm)await johnLoc.ensurePerm(); }catch(e){}
  };
  window.johnPush={
    register: async function(){
      try{
        var C=window.Capacitor,PN=C&&C.Plugins&&C.Plugins.PushNotifications;
        if(!PN||!currentUser)return;
        var st=await PN.checkPermissions();
        if(st.receive==='prompt'||st.receive==='prompt-with-rationale')st=await PN.requestPermissions();
        if(st.receive!=='granted')return;
        if(window.johnPush._lsn){ await PN.register(); return; }
        window.johnPush._lsn=true;
        PN.addListener('registration',function(t){
          try{ localStorage.setItem('tb.pushDbg','token '+String(t.value||'').slice(0,10)); }catch(e){}
          try{ client.from('push_tokens').upsert({user_id:currentUser.id,token:t.value,platform:'ios',updated_at:new Date().toISOString()},{onConflict:'user_id,token'}).then(function(){}); }catch(e){}
        });
        PN.addListener('registrationError',function(e){ try{ localStorage.setItem('tb.pushDbg','err '+JSON.stringify(e).slice(0,120)); }catch(_){} });
        PN.addListener('pushNotificationReceived',function(n){ try{ if(typeof window._secOnPush==='function')window._secOnPush(n); }catch(e){} });
        await PN.register();
      }catch(e){}
    },
    sendAlert: async function(code){
      try{
        var s=await client.auth.getSession();
        var tok=s&&s.data&&s.data.session&&s.data.session.access_token;
        if(!tok)return {ok:false};
        var r=await fetch(CFG.url+'/functions/v1/sec-alert',{method:'POST',headers:{'Content-Type':'application/json',apikey:CFG.anonKey,Authorization:'Bearer '+tok},body:JSON.stringify({code:code})});
        var j=null;try{j=await r.json();}catch(e){}
        return r.ok?(j||{ok:true}):{ok:false,error:j&&j.error};
      }catch(e){ return {ok:false}; }
    }
  };
  window.johnTeam={
    me:function(){ return currentUser?{id:currentUser.id,email:currentUser.email}:null; },
    invite:async function(email){
      if(!currentUser) return {error:'нет входа'};
      email=String(email||'').trim().toLowerCase();
      if(!email||email.indexOf('@')<1) return {error:'Введите корректный email'};
      if(email===String(currentUser.email||'').toLowerCase()) return {error:'Это ваш собственный email'};
      var r=await client.from('team_links').insert({owner_id:currentUser.id,owner_email:currentUser.email,member_email:email});
      if(r.error){ if(/duplicate|unique/i.test(r.error.message)) return {error:'Этот email уже приглашён'}; return {error:r.error.message}; }
      return {ok:true};
    },
    list:async function(){
      if(!currentUser) return {mine:[],forMe:[]};
      var mine=await client.from('team_links').select('*').eq('owner_id',currentUser.id).order('created_at');
      var forMe=await client.from('team_links').select('*').eq('member_email',String(currentUser.email||'').toLowerCase()).neq('owner_id',currentUser.id).order('created_at');
      return {mine:(mine.data||[]),forMe:(forMe.data||[])};
    },
    respond:async function(id,accept){
      if(!currentUser) return false;
      var upd=accept?{status:'accepted',member_id:currentUser.id,accepted_at:new Date().toISOString()}:{status:'declined',member_id:currentUser.id};
      var r=await client.from('team_links').update(upd).eq('id',id);
      return !r.error;
    },
    setLink:async function(id,fields){
      if(!currentUser) return false;
      var upd={};
      ['access','share','features','role_label'].forEach(function(k){ if(fields&&fields[k]!==undefined) upd[k]=fields[k]; });
      var r=await client.from('team_links').update(upd).eq('id',id).eq('owner_id',currentUser.id);
      try{ _teamShareNeeded=null; _refreshShareNeeded().then(function(){publishSharedCal(true);}); }catch(e){}
      return !r.error;
    },
    remove:async function(id){
      if(!currentUser) return false;
      var r=await client.from('team_links').delete().eq('id',id);
      try{ _teamShareNeeded=null; _refreshShareNeeded(); }catch(e){}
      return !r.error;
    },
    ownerCal:async function(ownerId){
      if(!currentUser) return null;
      try{
        var r=await client.from('shared_cal').select('data,updated_at').eq('owner_id',ownerId).maybeSingle();
        if(r.error||!r.data||!r.data.data) return null;
        var raw=(typeof r.data.data==='string')?r.data.data:JSON.stringify(r.data.data);
        return {cal:JSON.parse(raw),updated_at:r.data.updated_at};
      }catch(e){ return null; }
    },
    logAction:async function(ownerId,kind,payload){
      if(!currentUser) return false;
      try{
        var r=await client.from('team_actions').insert({owner_id:ownerId,member_id:currentUser.id,member_email:currentUser.email,kind:kind,payload:payload||{}});
        return !r.error;
      }catch(e){ return false; }
    },
    myActions:async function(ownerId){
      if(!currentUser) return [];
      try{
        var r=await client.from('team_actions').select('*').eq('member_id',currentUser.id).eq('owner_id',ownerId).order('created_at',{ascending:false}).limit(100);
        return r.data||[];
      }catch(e){ return []; }
    },
    ownerActions:async function(){
      if(!currentUser) return [];
      try{
        var r=await client.from('team_actions').select('*').eq('owner_id',currentUser.id).order('created_at',{ascending:false}).limit(50);
        return r.data||[];
      }catch(e){ return []; }
    },
    markActionsSeen:async function(){
      if(!currentUser) return;
      try{ await client.from('team_actions').update({seen:true}).eq('owner_id',currentUser.id).eq('seen',false); }catch(e){}
    },
    createUser:async function(email,password,access,roleLabel,share,features){
      if(!currentUser) return {error:'нет входа'};
      email=String(email||'').trim().toLowerCase();
      if(!email||email.indexOf('@')<1) return {error:'Введите корректный email'};
      if(!password||String(password).length<6) return {error:'Пароль минимум 6 символов'};
      if(email===String(currentUser.email||'').toLowerCase()) return {error:'Это ваш собственный email'};
      var tmp;
      try{ tmp=supabase.createClient(CFG.url,CFG.anonKey,{auth:{persistSession:false,autoRefreshToken:false,storageKey:'john.tmp'}}); }
      catch(e){ return {error:'Не удалось подготовить клиент'}; }
      var su=await tmp.auth.signUp({email:email,password:String(password)});
      if(su.error){
        if(/already registered|already been/i.test(su.error.message)) return {error:'exists'};
        return {error:errText(su.error)};
      }
      if(!su.data||!su.data.session||!su.data.user) return {error:'Аккаунт создан, но без сессии — проверьте, что подтверждение email выключено'};
      var memberId=su.data.user.id;
      var ins=await client.from('team_links').insert({owner_id:currentUser.id,owner_email:currentUser.email,member_email:email,access:access||'',role_label:roleLabel||null,share:share||'',features:features||''}).select().maybeSingle();
      if(ins.error&&/features/.test(ins.error.message)){ // колонка ещё не добавлена — создаём без ограничений функций
        ins=await client.from('team_links').insert({owner_id:currentUser.id,owner_email:currentUser.email,member_email:email,access:access||'',role_label:roleLabel||null,share:share||''}).select().maybeSingle();
      }
      if(ins.error||!ins.data){ try{await tmp.auth.signOut();}catch(e){} return {error:'Аккаунт создан, но связка не записана'+(ins.error?': '+ins.error.message:'')}; }
      var acc=await tmp.from('team_links').update({status:'accepted',member_id:memberId,accepted_at:new Date().toISOString()}).eq('id',ins.data.id);
      try{ await tmp.auth.signOut(); }catch(e){}
      try{ _teamShareNeeded=null; _refreshShareNeeded().then(function(){publishSharedCal(true);}); }catch(e){}
      if(acc.error) return {ok:true,warn:'Доступ активируется, когда коллега войдёт и подтвердит'};
      return {ok:true};
    },
    memberState:async function(uid){
      if(!currentUser) return null;
      var r=await client.from('app_state').select('data,updated_at').eq('user_id',uid).maybeSingle();
      if(r.error||!r.data||!r.data.data) return null;
      var raw=(typeof r.data.data==='string')?r.data.data:JSON.stringify(r.data.data);
      try{ return {state:JSON.parse(raw),updated_at:r.data.updated_at}; }catch(e){ return null; }
    }
  };
  async function checkTeamInvites(){
    try{
      if(!currentUser) return;
      var forMe=await client.from('team_links').select('*').eq('member_email',String(currentUser.email||'').toLowerCase()).eq('status','pending');
      var rows=(forMe.data||[]).filter(function(x){return x.owner_id!==currentUser.id;});
      if(!rows.length) return;
      var inv=rows[0];
      if(typeof uiConfirm==='function'){
        uiConfirm('Пользователь '+inv.owner_email+' приглашает вас в команду. Он получит доступ ПРОСМОТРА всех ваших данных в этом приложении (проекты, дела, встречи, люди). Принять?',
          function(){ window.johnTeam.respond(inv.id,true).then(function(ok){ if(typeof toast==='function') toast(ok?'Приглашение принято':'Не удалось принять'); }); });
      }
    }catch(e){}
  }

  /* ---------- ежедневная резервная копия (одна строка, обновляется раз в день) ---------- */
  var BK_HOUR=9, _bkBusy=false, _bkLastCheck=0;
  function _bkDueTs(){ var d=new Date(); d.setHours(BK_HOUR,0,0,0); if(Date.now()<d.getTime()) d.setDate(d.getDate()-1); return d.getTime(); }
  async function dailyBackupTick(){
    if(!currentUser||_bkBusy) return;
    var now=Date.now(); if(now-_bkLastCheck<15*60*1000) return; _bkLastCheck=now; // проверяем не чаще раза в 15 минут
    _bkBusy=true;
    try{
      var due=_bkDueTs();
      var st=await client.from('app_state_daily').select('updated_at').eq('user_id',currentUser.id).maybeSingle();
      if(st.error) return;
      if(st.data&&st.data.updated_at&&new Date(st.data.updated_at).getTime()>=due) return; // копия за этот день уже есть (с любого устройства)
      var payload=localState(); if(payload==null||payload.length<200) return;
      await client.from('app_state_daily').upsert(
        {user_id:currentUser.id,data:payload,updated_at:new Date().toISOString()},{onConflict:'user_id'});
    }catch(e){}
    finally{_bkBusy=false;}
  }
  window.johnDailyBackup={
    hour:BK_HOUR,
    status:async function(){ if(!currentUser)return null;
      try{var r=await client.from('app_state_daily').select('updated_at').eq('user_id',currentUser.id).maybeSingle();
        return (r.data&&r.data.updated_at)?r.data.updated_at:null;}catch(e){return null;} },
    restore:async function(){ if(!currentUser)return false;
      try{
        var r=await client.from('app_state_daily').select('data').eq('user_id',currentUser.id).maybeSingle();
        if(!r.data||!r.data.data) return false;
        var raw=(typeof r.data.data==='string')?r.data.data:JSON.stringify(r.data.data);
        try{var cur=localStorage.getItem(STORE_KEY);if(cur&&cur.length>200)localStorage.setItem('tb.conflictBackup',JSON.stringify({at:Date.now(),data:cur}));}catch(e){}
        localStorage.setItem(STORE_KEY,raw);
        try{window._lastSaved=raw;}catch(e){}
        try{localStorage.setItem('tb.dirty','1');}catch(e){}
        _lastPushed=null;
        if(typeof load==='function')load();
        if(typeof renderAll==='function')renderAll();
        push(); // восстановленное становится текущим и уезжает в облако (второе устройство подтянет)
        return true;
      }catch(e){return false;} }
  };

  function scheduleSync(){
    if(!currentUser) return;
    if(syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function(){ syncTimer=null; push(); }, 1500);
  }

  // Перехватываем save() основного скрипта — после каждой записи планируем отправку.
  if(typeof window.save==='function'){
    var _origSave = window.save;
    window.save = function(){ var r=_origSave.apply(this, arguments); try{ if(r!==false) scheduleSync(); }catch(e){} return r; };
  }
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='hidden') push(); });

  // Живая синхронизация: подтягиваем облако при возврате в приложение и раз в минуту фоном.
  var lastPullAt = 0;
  function livePull(){ if(!currentUser) return; var now=Date.now(); if(now-lastPullAt<8000) return; lastPullAt=now; pull(); }
  // Возврат в приложение: если локатор включён — пере-арм вотчер (оживляет молча умерший фон-трекер), троттл 30с.
  var _locRearmAt=0;
  function _locRearm(){ try{ if(currentUser && window.johnLoc && localStorage.getItem('tb.locOn')==='1'){ var n=Date.now(); if(n-_locRearmAt>30000){ _locRearmAt=n; johnLoc.start(); } } }catch(e){} }
  document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='visible'){ livePull(); _locRearm(); } });
  window.addEventListener('focus', function(){ livePull(); _locRearm(); });
  try{ if(window.Capacitor&&Capacitor.Plugins&&Capacitor.Plugins.App){ Capacitor.Plugins.App.addListener('appStateChange',function(st){ if(st&&st.isActive){ livePull(); _locRearm(); } }); } }catch(e){}
  var _featLastCheck=0;
  setInterval(function(){ if(document.visibilityState!=='hidden'){ livePull(); try{dailyBackupTick();}catch(e){}
    if(Date.now()-_featLastCheck>5*60*1000){ _featLastCheck=Date.now(); try{applyMyFeatures();}catch(e){} try{loadHelpOwners();}catch(e){} } } }, 60000);

  /* ---------- поток авторизации ---------- */
  async function onAuthed(){ _applyCachedFeatures(); hideGate(); updateAccountUI(); await pull(true); try{dailyBackupTick();}catch(e){} try{setTimeout(checkTeamInvites,1200);}catch(e){} try{_refreshShareNeeded().then(function(){publishSharedCal();});}catch(e){} try{applyMyFeatures();}catch(e){} try{loadHelpOwners();}catch(e){} try{ if(typeof window.johnMergeGiftActs==='function') setTimeout(window.johnMergeGiftActs,2500); }catch(e){} try{ setTimeout(function(){ if(window.johnFirstRunPerms)window.johnFirstRunPerms(); },1500); }catch(e){} try{ setTimeout(function(){ if(window.johnPush&&johnPush.register)johnPush.register(); },1800); }catch(e){} try{ setTimeout(function(){ try{ if(localStorage.getItem('tb.locOn')==='1'&&window.johnLoc)johnLoc.start(); }catch(e){} },2200); }catch(e){} }
  async function loadHelpOwners(){
    try{
      if(!currentUser)return;
      var r=await client.from('team_links').select('owner_id,owner_email,share,status').eq('member_email',String(currentUser.email||'').toLowerCase()).eq('status','accepted');
      var rows=(r.data||[]).filter(function(x){return String(x.share||'').indexOf('calendar')>=0;});
      window.johnHelpOwners=rows.map(function(x){return {id:x.owner_id,email:x.owner_email};});
      if(typeof window.johnMountHelpNav==='function')window.johnMountHelpNav();
      // выжимка владельца — в общий календарь сотрудника
      if(rows.length&&window.johnTeam){
        var o=rows[0];
        var cal=await window.johnTeam.ownerCal(o.owner_id);
        if(cal&&cal.cal){
          window._helpCal={ownerId:o.owner_id,email:o.owner_email,evs:cal.cal.evs||[],bds:cal.cal.bds||[],at:cal.updated_at};
          try{ if(typeof renderCal==='function'&&typeof currentView!=='undefined'&&currentView==='cal')renderCal(); }catch(e){}
        }
      }else{ window._helpCal=null; }
    }catch(e){}
  }
  function _featKey(){ return 'tb.myFeat.'+String((currentUser&&currentUser.email)||'').toLowerCase(); }
  async function applyMyFeatures(){
    try{
      if(!currentUser)return;
      var key=_featKey();
      var r=await client.from('team_links').select('features,status').eq('member_email',String(currentUser.email||'').toLowerCase()).eq('status','accepted');
      var rows=(r.data||[]);
      if(!rows.length){ try{localStorage.setItem(key,'unlimited');localStorage.setItem('tb.myFeatNow','unlimited');}catch(e){} try{if(typeof window.johnResetFeatures==='function')window.johnResetFeatures();}catch(e){} return; }
      var anyUnlimited=rows.some(function(x){return !String(x.features||'').trim();});
      if(anyUnlimited){ try{localStorage.setItem(key,'unlimited');localStorage.setItem('tb.myFeatNow','unlimited');}catch(e){} try{if(typeof window.johnResetFeatures==='function')window.johnResetFeatures();}catch(e){} return; } // связка без ограничений — полное приложение
      var un={};rows.forEach(function(x){String(x.features||'').split(',').filter(Boolean).forEach(function(f){un[f]=1;});});
      var list=Object.keys(un);
      try{localStorage.setItem(key,list.join(','));localStorage.setItem('tb.myFeatNow',list.join(','));}catch(e){}
      if(list.length&&typeof window.johnApplyFeatures==='function')window.johnApplyFeatures(list.join(','));
      if(un['sec'])try{ window.johnPush.register(); }catch(e){}
      if(un['sec'])try{ if(typeof window._secStartPoll==='function')window._secStartPoll(); }catch(e){}
    }catch(e){}
  }
  function _applyCachedFeatures(){
    try{
      var mf=localStorage.getItem(_featKey());
      if(mf&&mf!=='unlimited'&&typeof window.johnApplyFeatures==='function')window.johnApplyFeatures(mf);
    }catch(e){}
  }

  function updateAccountUI(){
    var box=document.getElementById('acctBox');
    var em=document.getElementById('acctEmail');
    if(em) em.textContent = currentUser ? (currentUser.email||'') : '';
    if(box) box.style.display = currentUser ? 'flex' : 'none';
  }

  function errText(e){
    var m=(e&&e.message)||'Ошибка';
    if(/Invalid login/i.test(m)) return 'Неверный email или пароль';
    if(/already registered|already been registered/i.test(m)) return 'Этот email уже зарегистрирован';
    if(/at least 6|Password should be/i.test(m)) return 'Пароль минимум 6 символов';
    if(/valid email|Unable to validate email/i.test(m)) return 'Введите корректный email';
    if(/rate limit|too many/i.test(m)) return 'Слишком много попыток, подождите';
    if(/expired|invalid.*otp|otp.*invalid|token has expired/i.test(m)) return 'Код неверный или устарел — запросите новый';
    if(/user not found|signups not allowed/i.test(m)) return 'Аккаунт с таким email не найден';
    return m;
  }

  function creds(){
    var e=(document.getElementById('authEmail')||{}).value||'';
    var p=(document.getElementById('authPass')||{}).value||'';
    return { email:e.trim(), pass:p };
  }

  async function doLogin(){
    var c=creds(); if(!c.email||!c.pass){ setMsg('Введите email и пароль', true); return; }
    setMsg('Вход…');
    var r = await client.auth.signInWithPassword({ email:c.email, password:c.pass });
    if(r.error){ setMsg(errText(r.error), true); return; }
    currentUser = r.data.user; setMsg(''); onAuthed();
  }

  async function doReset(){
    var c=creds(); if(!c.email){ setMsg('Введите email — пришлём код для входа', true); return; }
    setMsg('Отправляю код…');
    var r = await client.auth.signInWithOtp({ email:c.email, options:{ shouldCreateUser:false } });
    if(r.error){ setMsg(errText(r.error), true); return; }
    var w=document.getElementById('authOtpWrap'); if(w) w.style.display='';
    var p2=document.getElementById('authPass2'); if(p2) p2.style.display='none';
    setMsg('Код отправлен на '+c.email+'. Введите код из письма и НОВЫЙ пароль (в поле «Пароль»), затем «Войти по коду».');
    try{ var o=document.getElementById('authOtp'); if(o) o.focus(); }catch(e){}
  }
  async function doOtpLogin(){
    var c=creds();
    var code=((document.getElementById('authOtp')||{}).value||'').trim();
    if(!c.email||!code){ setMsg('Нужны email и код из письма', true); return; }
    if(!c.pass||c.pass.length<6){ setMsg('Придумайте НОВЫЙ пароль (минимум 6 символов) и введите его в поле «Пароль»', true); return; }
    setMsg('Проверяю код…');
    var r = await client.auth.verifyOtp({ email:c.email, token:code, type:'email' });
    if(r.error){ setMsg(errText(r.error), true); return; }
    currentUser = r.data.user;
    try{
      var u = await client.auth.updateUser({ password:c.pass });
      if(u.error){ setMsg('Вошли, но пароль не сменился: '+errText(u.error), true); }
    }catch(e){}
    var w=document.getElementById('authOtpWrap'); if(w) w.style.display='none';
    setMsg(''); onAuthed();
  }

  async function doLogout(){
    try{ localStorage.removeItem('tb.myFeatNow'); if(window.johnResetFeatures)window.johnResetFeatures(); }catch(e){}
    try{ if(window._secStopAll)window._secStopAll(); }catch(e){}
    try{ if(window.johnLoc&&johnLoc.stop) await johnLoc.stop(); }catch(e){} // остановить фон-GPS + heartbeat, снять sharing (пока сессия жива)
    try{ await push(); }catch(e){}
    try{ localStorage.removeItem('tb.dirty'); }catch(e){}
    try{ await client.auth.signOut(); }catch(e){}
    currentUser=null; updateAccountUI(); showGate();
  }

  async function doDelete(){
    if(!currentUser) return;
    if(!window.confirm('Удалить аккаунт и все облачные данные без возможности восстановления?')) return;
    try{ await client.from('app_state').delete().eq('user_id', currentUser.id); }catch(e){}
    try{ var r=await client.rpc('delete_current_user'); if(r&&r.error) console.warn('[auth] delete', r.error.message); }catch(e){}
    try{ await client.auth.signOut(); }catch(e){}
    currentUser=null; updateAccountUI(); showGate();
    setMsg('Аккаунт удалён.');
  }

  async function refreshSession(){
    try{
      var s = await client.auth.getSession();
      var sess = s && s.data && s.data.session;
      if(sess && sess.user){ currentUser=sess.user; onAuthed(); }
      else{ currentUser=null; showGate(); }
    }catch(e){ showGate(); }
  }

  function on(id, fn){ var el=document.getElementById(id); if(el) el.addEventListener('click', function(ev){ ev.preventDefault(); fn(); }); }

  function wire(){
    on('authLoginBtn', doLogin);
    on('authResetBtn', doReset);
    on('authOtpBtn', doOtpLogin);
    on('acctLogoutBtn', doLogout);
    on('acctDeleteBtn', doDelete);
    var pass=document.getElementById('authPass');
    if(pass) pass.addEventListener('keydown', function(e){ if(e.key==='Enter') doLogin(); });
  }

  // наружу — для кнопок в настройках, если понадобится
  window.johnAuth = { logout:doLogout, del:doDelete, reset:doReset, user:function(){ return currentUser; }, get client(){ return client; } };

  function start(){ wire(); refreshSession(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
