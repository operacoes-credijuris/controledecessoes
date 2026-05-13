/* ======================================================
   SUPABASE CLIENT
====================================================== */
/* Config vem do PHP (window.CJ_CONFIG); fallback hardcoded mantém compat se servido como HTML estático */
const _CJ_CFG = (typeof window !== 'undefined' && window.CJ_CONFIG) || {};
const _SB_URL = (_CJ_CFG.supabase && _CJ_CFG.supabase.url) || 'https://uekoindsadcthbdkkbjt.supabase.co';
const _SB_KEY = (_CJ_CFG.supabase && _CJ_CFG.supabase.publishable_key) || 'sb_publishable_mU_fyDVVG1xrt60gOwdrsA_TLgrz1H_';
// Tokens carregados dinamicamente do Supabase (tabela configuracoes) — não hardcodar aqui
const _ADVBOX_BASE = _CJ_CFG.advbox_base || 'https://app.advbox.com.br/api/v1';
const _secrets=(()=>{let _a='';return{setAdvbox:v=>{_a=v;},advbox:()=>_a};})();
let sb=null;
(function(){
  try{
    const lib=window.supabase||window.Supabase;
    if(!lib||!lib.createClient)throw new Error('Supabase CDN não carregou');
    sb=lib.createClient(_SB_URL,_SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,storageKey:'cj-auth'}});
  }catch(e){
    console.error('[Credijuris] Supabase init error:',e);
  }
})();
const TABLES={cessoes:'cessoes_ativas',rpv:'rpv_complementar',requerimentos:'diversos',encerrados:'encerrados',contatos:'contatos'};
const CACHE={cessoes:[],rpv:[],requerimentos:[],encerrados:[],contatos:[]};
let _currentUserId=null;
let _realtimeChannel=null;
let CACHE_AUX=[];
let curAuxId=null;

/* ======================================================
   CORE DATA
====================================================== */
const PG = {cessoes:1,rpv:1,requerimentos:1,encerrados:1,contatos:1};
const PS = {cessoes:0,rpv:0,requerimentos:0,encerrados:0,contatos:0};

function load(k){return(CACHE[k]||[]).slice();}
function save(k,d){const prev=(CACHE[k]||[]).slice();CACHE[k]=d.slice();_sbSync(k,d,prev);}

async function _sbSync(k,d,prev){
  const tbl=TABLES[k];
  if(!tbl||!_currentUserId)return;
  try{
    const newIds=new Set(d.map(r=>r.id));
    const delIds=(prev||[]).filter(r=>!newIds.has(r.id)).map(r=>r.id);
    if(delIds.length){const{error}=await sb.from(tbl).delete().in('id',delIds);if(error)throw error;}
    // Upsert apenas registros novos ou alterados (compara sem _advboxMovCount)
    const prevMap=new Map((prev||[]).map(r=>{const{_advboxMovCount,...clean}=r;return[r.id,JSON.stringify(clean)];}));
    const changed=d.filter(r=>{const{_advboxMovCount,...clean}=r;return prevMap.get(r.id)!==JSON.stringify(clean);});
    if(changed.length){
      const rows=changed.map(r=>{
        const{_advboxMovCount,...clean}=r; // nunca persiste campo interno no banco
        return{id:r.id,data:clean,updated_at:new Date().toISOString(),user_id:_currentUserId};
      });
      const{error}=await sb.from(tbl).upsert(rows,{onConflict:'id'});
      if(error)throw error;
    }
  }catch(e){
    console.error('[Credijuris] sync error',tbl,e);
    CACHE[k]=prev; // rollback: restaura estado anterior
    showToast('Erro ao salvar dados. Alteração revertida.');
  }
}

async function _loadAllFromSupabase(){
  for(const[mod,tbl]of Object.entries(TABLES)){
    try{
      const{data,error}=await sb.from(tbl).select('data');
      CACHE[mod]=(!error&&data)?data.map(r=>r.data).filter(Boolean):[];
    }catch(e){
      console.error('[Credijuris] load error',tbl,e);
      CACHE[mod]=[];
    }
  }
}

/* Coalesce de eventos realtime — agrupa múltiplos eventos no mesmo módulo
   numa janela curta antes de fazer reload+render, reduzindo custo. */
const _rtPending=new Set();
let _rtTimer=null;
function _rtSchedule(mod){
  _rtPending.add(mod);
  if(_rtTimer)return;
  _rtTimer=setTimeout(async()=>{
    const mods=[..._rtPending];_rtPending.clear();_rtTimer=null;
    for(const m of mods){
      const tbl=TABLES[m];if(!tbl)continue;
      try{
        const{data,error}=await sb.from(tbl).select('data');
        if(!error&&data)CACHE[m]=data.map(r=>r.data).filter(Boolean);
      }catch(e){console.error('[Credijuris] realtime reload error',tbl,e);}
    }
    updateDash();
    /* Não interrompe edição inline ativa */
    const editing=document.activeElement&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
    if(!editing){
      if(topTab==='acompanhamento'&&mods.includes(subTab))render(subTab);
      else if(topTab==='contatos'&&mods.includes('contatos'))render('contatos');
    }
    const consPaneVisible=document.getElementById('crt-pane-consolidado')?.classList.contains('on')
      &&document.getElementById('pane-carteiras')?.classList.contains('on');
    if(consPaneVisible&&!editing)_crtRenderConsolidado();
    /* Re-render de carteiras/investidores se estiver visível */
    const invPaneVisible=document.getElementById('crt-pane-investidores')?.classList.contains('on')
      &&document.getElementById('pane-carteiras')?.classList.contains('on');
    if(invPaneVisible&&!editing){_crtPopulateInvestidores();_crtRenderOperacoes(_crtAcSelected||null);}
  },350);
}
function _setupRealtime(){
  try{
    if(_realtimeChannel){try{sb.removeChannel(_realtimeChannel);}catch(e){}}
    /* Channel name único por sessão evita conflito com canais residuais. */
    const ch=sb.channel('cj-realtime-'+(_currentUserId||'anon')+'-'+Date.now());
    for(const[mod,tbl]of Object.entries(TABLES)){
      ch.on('postgres_changes',{event:'*',schema:'public',table:tbl},()=>_rtSchedule(mod));
    }
    // Realtime para Órgãos Auxiliares (debounced)
    let _auxTimer=null;
    ch.on('postgres_changes',{event:'*',schema:'public',table:'contatos_auxiliares'},()=>{
      if(_auxTimer)return;
      _auxTimer=setTimeout(async()=>{_auxTimer=null;await loadAuxiliares();},350);
    });
    ch.subscribe(status=>{
      if(status==='CHANNEL_ERROR'||status==='TIMED_OUT'){
        console.warn('[Credijuris] realtime status:',status);
      }
    });
    _realtimeChannel=ch;
  }catch(e){console.error('[Credijuris] realtime setup error',e);}
}

/* ======================================================
   AUTH
====================================================== */
async function doLogin(){
  const email=document.getElementById('login-email').value.trim();
  const pass=document.getElementById('login-password').value;
  const errEl=document.getElementById('lc-err');
  const btn=document.getElementById('login-btn');
  if(!sb){errEl.textContent='Conexão com o banco de dados indisponível. Recarregue a página.';errEl.style.display='block';return;}
  if(!email||!pass){errEl.textContent='Preencha e-mail e senha.';errEl.style.display='block';return;}
  btn.disabled=true;btn.innerHTML='<span class="spin" style="vertical-align:middle"></span> Entrando…';
  errEl.style.display='none';
  try{
    const{data,error}=await sb.auth.signInWithPassword({email,password:pass});
    btn.disabled=false;btn.textContent='Entrar';
    if(error){
      errEl.textContent=error.message.includes('Invalid login')||error.message.includes('invalid_credentials')?'E-mail ou senha incorretos.':error.message;
      errEl.style.display='block';
      return;
    }
    if(!data.session){errEl.textContent='Sessão não retornada. Tente novamente.';errEl.style.display='block';return;}
    await _onAuthenticated(data.session);
  }catch(e){
    btn.disabled=false;btn.textContent='Entrar';
    errEl.textContent='Erro ao conectar: '+e.message;
    errEl.style.display='block';
  }
}

async function doLogout(){
  /* Cleanup defensivo: garante reset de estado mesmo se signOut falhar (rede). */
  try{if(sb)await sb.auth.signOut();}
  catch(e){console.warn('[Credijuris] signOut error:',e);}
  finally{
    _currentUserId=null;
    Object.keys(CACHE).forEach(k=>CACHE[k]=[]);
    if(_realtimeChannel){try{await sb.removeChannel(_realtimeChannel);}catch(e){}_realtimeChannel=null;}
  }
}

async function _loadAdvboxToken(){
  if(!sb)return;
  try{
    const{data,error}=await sb.from('configuracoes').select('valor').eq('chave','advbox_token').single();
    if(!error&&data?.valor)_secrets.setAdvbox(data.valor||'');
  }catch(e){console.warn('[Credijuris] _loadAdvboxToken:',e);}
}

async function _onAuthenticated(session){
  _currentUserId=session.user.id;
  document.getElementById('login-screen').style.display='none';
  const ls=document.getElementById('loading-screen');
  ls.style.display='flex';
  await Promise.all([_loadAllFromSupabase(),_loadAdvboxToken()]);
  ls.style.display='none';
  document.getElementById('logout-btn').style.display='';
  _fLoad();
  _setupRealtime();
  updateDash();
  /* Se a seção ativa for carteiras, _initSidebar() rodou antes dos dados chegarem.
     Agora o CACHE está cheio — reinicializa o tab de investidores completamente. */
  if((localStorage.getItem('cj-sidebar-active')||'exec')==='carteiras')
    crtNav('investidores');
  loadAuxiliares();
  _prmInit();
  _autoSyncInit();
}

async function _initApp(){
  const ls=document.getElementById('login-screen');
  if(!sb){
    ls.style.display='flex';
    const e=document.getElementById('lc-err');
    e.textContent='Não foi possível conectar ao Supabase. Verifique sua conexão e recarregue.';
    e.style.display='block';
    return;
  }
  sb.auth.onAuthStateChange(async(event,session)=>{
    if(event==='SIGNED_OUT'||event==='USER_DELETED'){
      _currentUserId=null;
      Object.keys(CACHE).forEach(k=>CACHE[k]=[]);
      /* Limpa todas as chaves cj-* per-session, exceto preferências persistentes
         (cj-theme, cj-sidebar-state que devem sobreviver ao logout). */
      ['cj-user-filters','cj-sidebar-lasttab','cj-sub-tab','cj-sidebar-active','cj-parametros']
        .forEach(k=>{try{localStorage.removeItem(k);}catch(e){}});
      if(_realtimeChannel){try{await sb.removeChannel(_realtimeChannel);}catch(e){}_realtimeChannel=null;}
      document.getElementById('logout-btn').style.display='none';
      ls.style.display='flex';
    } else if(event==='TOKEN_REFRESHED'&&session){
      _currentUserId=session.user.id;
      /* Token novo → realtime channel pode ter sido invalidado. Recria. */
      if(_realtimeChannel){
        try{await sb.removeChannel(_realtimeChannel);}catch(e){}
        _realtimeChannel=null;
        _setupRealtime();
      }
    }
  });
  try{
    const{data:{session}}=await sb.auth.getSession();
    if(session){await _onAuthenticated(session);}
    else{ls.style.display='flex';}
  }catch(e){
    console.error('[Credijuris] getSession error:',e);
    ls.style.display='flex';
  }
}

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2)}
/* localStorage seguro: try/catch + namespace por user_id quando disponível.
   Fallback transparente se localStorage estiver bloqueado (Safari privado). */
function _lsKey(k){return _currentUserId?`${k}::${_currentUserId}`:k;}
function _lsGet(k){try{return localStorage.getItem(_lsKey(k));}catch(e){return null;}}
function _lsSet(k,v){try{localStorage.setItem(_lsKey(k),v);}catch(e){}}
function _lsDel(k){try{localStorage.removeItem(_lsKey(k));}catch(e){}}
function esc(s){if(s==null||s==='')return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
/* escJs: escapa string para uso DENTRO de JS string literal em atributos HTML
   (ex: onclick="fn('${escJs(x)}')"). Faz dupla escape: HTML entity para os
   caracteres especiais HTML (browser decodifica antes do JS parser ver) e
   barras invertidas para a JS string. */
function escJs(s){if(s==null)return'';return String(s).replace(/\\/g,'\\\\').replace(/'/g,'\\x27').replace(/"/g,'\\x22').replace(/&/g,'\\x26').replace(/</g,'\\x3c').replace(/>/g,'\\x3e').replace(/\r?\n/g,'\\n');}

/* ======================================================
   DATE HELPERS
====================================================== */
function fmtDate(s){
  if(!s)return'—';
  const p=s.split('-');
  if(p.length!==3)return s;
  return p[2]+'/'+p[1]+'/'+p[0];
}

function between(a,b){
  if(!a||!b)return'—';
  const ms=new Date(b)-new Date(a);
  if(ms<0)return`<span style="color:var(--ylw2)" title="Liquidação anterior à aquisição">⚠</span>`;
  const d=Math.floor(ms/864e5);
  const y=Math.floor(d/365),m=Math.floor((d%365)/30),dd=d%30;
  return(y?y+'a ':'')+(m?m+'m ':'')+dd+'d';
}

function liqDays(dateStr){
  if(!dateStr)return null;
  return Math.round((new Date(dateStr)-new Date(todayStr()))/864e5);
}

function liquidacaoDiff(dateStr){
  const diff=liqDays(dateStr);
  if(diff===null)return'—';
  const sign=diff>=0?'+':'-';
  const abs=Math.abs(diff);
  let str;
  if(abs>=365){const y=Math.floor(abs/365);const m=Math.floor((abs%365)/30);str=sign+y+'a'+(m?' '+m+'m':'');}
  else if(abs>=30){const m=Math.floor(abs/30);const d=abs%30;str=sign+m+'m'+(d?' '+d+'d':'');}
  else{str=sign+abs+'d';}
  const col=diff<0?'var(--red2)':diff<60?'var(--ylw2)':'var(--grn2)';
  return`<span style="color:${col};font-weight:600">${str}</span>`;
}

function todayStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

function normDate(s){
  if(!s)return'';
  if(s instanceof Date){
    if(isNaN(s))return'';
    return s.getFullYear()+'-'+String(s.getMonth()+1).padStart(2,'0')+'-'+String(s.getDate()).padStart(2,'0');
  }
  const str=String(s).trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(str))return str.slice(0,10);
  const m=str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if(m)return`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return'';
}

function fatalLevel(s){
  const n=normDate(s);
  if(!n)return null;
  const today=todayStr();
  if(n<today)return'exp';
  const diff=Math.round((new Date(n)-new Date(today))/864e5);
  if(diff<=3)return'urg';
  if(diff<=7)return'warn';
  if(diff<=15)return'next';
  return'future';
}

function fatalBadge(s){
  if(!s)return'—';
  return fmtDate(s);
}

function rowCls(r){
  const lv=fatalLevel(r.prazoFatal);
  if(lv==='exp'||lv==='urg')return'row-red';
  if(lv==='warn')return'row-ylw';
  return'';
}

function fmtBRL(v){
  if(v===undefined||v===null||v==='')return'—';
  return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(v);
}

/* ======================================================
   NAV
====================================================== */
// topTab: 'dashboard' | 'acompanhamento' | 'contatos'
// subTab: 'cessoes' | 'rpv' | 'encerrados' | 'requerimentos' — apenas relevante quando topTab==='acompanhamento'
const _SUB_TABS=['cessoes','rpv','encerrados','requerimentos'];
const _SUB_LABELS={cessoes:'Cessões Ativas',rpv:'RPV Complementar',encerrados:'Encerrados',requerimentos:'Diversos'};

// Migração de `cj-sidebar-lasttab`: valores antigos podiam ser cessoes/rpv/encerrados/requerimentos.
// Hoje esses representam Acompanhamento + sub-tab. Roda ANTES de ler topTab/subTab abaixo.
(function _migrateLastExecTab(){
  const v=localStorage.getItem('cj-sidebar-lasttab');
  if(v&&_SUB_TABS.includes(v)){
    localStorage.setItem('cj-sub-tab',v);
    localStorage.setItem('cj-sidebar-lasttab','acompanhamento');
  }
})();
let topTab='dashboard';
let subTab=localStorage.getItem('cj-sub-tab')||'cessoes';
if(!_SUB_TABS.includes(subTab))subTab='cessoes';
let lastExecTab=localStorage.getItem('cj-sidebar-lasttab')||'dashboard';
let _execWasActive=false; // true quando exec já foi visitado nesta sessão

/* CRT state — declarado ANTES de _initSidebar() para evitar TDZ.
   Usar var (hoisted) garante que _sbShowCarteiras() chamado pelo IIFE não
   crashe ao acessar/atribuir essas variáveis durante a inicialização. */
var _crtInvestidores=[];
var _crtAcSelected='';

// SIDEBAR
(function _initSidebar(){
  const saved=localStorage.getItem('cj-sidebar-state'); const collapsed=saved?saved!=='expanded':false;
  if(collapsed)_sbSetCollapsed(true);
  const active=localStorage.getItem('cj-sidebar-active')||'exec';
  if(active==='carteiras')_sbShowCarteiras();
  else if(active==='credito')_sbShowCredito();
  else if(active==='config')_sbShowConfig();
  else _execWasActive=true; // exec era a seção ativa — respeitar lastExecTab ao retornar
})();

function _sbSetCollapsed(v){
  const sbEl=document.getElementById('sidebar');
  const arr=document.getElementById('sb-arrow');
  if(v){
    sbEl.classList.add('collapsed');
    arr.innerHTML='<polyline points="6,4 10,8 6,12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  }else{
    sbEl.classList.remove('collapsed');
    arr.innerHTML='<polyline points="10,4 6,8 10,12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  }
}

function toggleMovGroup(hdr){
  const body=hdr.nextElementSibling;
  const arrow=hdr.querySelector('.mov-arrow');
  const isOpen=body.style.display!=='none';
  body.style.display=isOpen?'none':'block';
  arrow.textContent=isOpen?'▶':'▼';
}

function _applyTheme(light){
  document.body.classList.toggle('light',light);
  const icon=document.getElementById('sb-theme-icon');
  const lbl=document.getElementById('sb-theme-lbl');
  if(lbl)lbl.textContent=light?'Modo escuro':'Modo claro';
  if(icon)icon.innerHTML=light
    ?'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 6.5A4.5 4.5 0 0 1 5.5 11 4.5 4.5 0 0 1 1 6.5 4.5 4.5 0 0 1 5.5 2c-.5 1-.8 2.2-.8 3.5S4.5 8.7 5 9.7A4.5 4.5 0 0 0 10 6.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
    :'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="2.3" stroke="currentColor" stroke-width="1.2"/><path d="M6 0.5V2M6 10V11.5M0.5 6H2M10 6H11.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
}
function toggleTheme(){
  const light=!document.body.classList.contains('light');
  _applyTheme(light);
  localStorage.setItem('cj-theme',light?'light':'dark');
}
// Restaurar tema ao carregar
(function(){const t=localStorage.getItem('cj-theme');if(t==='light')_applyTheme(true);})();

function toggleSidebar(){
  const sb=document.getElementById('sidebar');
  const collapsed=!sb.classList.contains('collapsed');
  _sbSetCollapsed(collapsed);
  localStorage.setItem('cj-sidebar-state',collapsed?'collapsed':'expanded');
}

function _sbHideAll(){
  /* Oculta TUDO — cada função show() revela apenas o que precisa */
  const navEl=document.querySelector('.nav');
  const mainEl=document.querySelector('.main');
  if(navEl)navEl.style.display='none';
  if(mainEl)mainEl.style.display='none';
  document.getElementById('pane-credito').style.display='none';
  document.getElementById('pane-config').style.display='none';
  document.getElementById('pane-carteiras').classList.remove('on');
  const paneContratos=document.getElementById('pane-contratos');
  if(paneContratos)paneContratos.style.display='none';
  document.querySelector('.app-content')?.classList.remove('mode-nonexec');
  const hdrSearch=document.querySelector('.hdr-search');
  const syncBtn=document.getElementById('sync-btn');
  if(hdrSearch)hdrSearch.style.display='none';
  if(syncBtn)syncBtn.style.display='none';
  ['sb-item-exec','sb-item-credito','sb-item-config','sb-item-carteiras','sb-item-contratos'].forEach(id=>{
    document.getElementById(id)?.classList.remove('active');
  });
}

function _sbShowCarteiras(){
  _sbHideAll();
  _execWasActive=false;
  document.getElementById('pane-carteiras').classList.add('on');
  document.getElementById('sb-item-carteiras').classList.add('active');
  localStorage.setItem('cj-sidebar-active','carteiras');
  /* Popula sempre — _crtPopulateInvestidores() trata CACHE vazio com segurança.
     Se chamado durante _initSidebar() (sem auth), _onAuthenticated() re-chama depois. */
  _crtPopulateInvestidores();
  _crtRenderOperacoes(_crtAcSelected||null);
}

function _sbShowCredito(){
  _sbHideAll();
  _execWasActive=false;
  document.getElementById('pane-credito').style.display='flex';
  document.getElementById('sb-item-credito').classList.add('active');
  localStorage.setItem('cj-sidebar-active','credito');
}

function _sbShowConfig(){
  _sbHideAll();
  _execWasActive=false;
  document.getElementById('pane-config').style.display='flex';
  document.getElementById('sb-item-config').classList.add('active');
  localStorage.setItem('cj-sidebar-active','config');
  const emailEl=document.getElementById('cfg-user-email');
  if(emailEl&&sb){
    sb.auth.getUser().then(({data})=>{
      if(data?.user?.email)emailEl.textContent=data.user.email;
    });
  }
  const inp=document.getElementById('cfg-advbox-token');
  if(inp&&_secrets.advbox())inp.placeholder='Token já configurado — cole para substituir';
  _cfgAutosyncLoad();
}

/* ======================================================
   AUTO-SYNC — disparo diário automático
   Fonte da verdade: tabela `configuracoes` (Supabase), chave `autosync_config`.
   localStorage `cj-autosync` é cache local — repopulado a cada login/abertura.
====================================================== */
const _AUTOSYNC_KEY = 'cj-autosync';
const _AUTOSYNC_SB_KEY = 'autosync_config';
let _autoSyncTimer = null;

function _cfgAutosyncRead(){
  try { return JSON.parse(localStorage.getItem(_AUTOSYNC_KEY)||'{}'); } catch { return {}; }
}
function _cfgAutosyncWrite(cfg){
  localStorage.setItem(_AUTOSYNC_KEY, JSON.stringify(cfg));
  // Espelha pro Supabase (fire-and-forget — nao bloqueia UI; logs erro se houver)
  if(sb){
    sb.from('configuracoes').upsert(
      {chave:_AUTOSYNC_SB_KEY,valor:JSON.stringify(cfg)},
      {onConflict:'chave'}
    ).then(({error})=>{if(error)console.warn('[Credijuris] autosync save:',error);});
  }
}

async function _cfgAutosyncFetchRemote(){
  if(!sb)return null;
  try{
    const{data,error}=await sb.from('configuracoes').select('valor').eq('chave',_AUTOSYNC_SB_KEY).maybeSingle();
    if(!error&&data?.valor)return JSON.parse(data.valor);
  }catch(e){console.warn('[Credijuris] autosync load:',e);}
  return null;
}

// Mescla cache local e remoto, mantendo o lastRun mais recente. Persiste merge no
// localStorage. Retorna o objeto mesclado (ou null se Supabase indisponivel).
async function _cfgAutosyncMergeFromRemote(){
  const remote = await _cfgAutosyncFetchRemote();
  if(!remote) return null;
  const local = _cfgAutosyncRead();
  const localTime = local.lastRun ? new Date(local.lastRun).getTime() : 0;
  const remoteTime = remote.lastRun ? new Date(remote.lastRun).getTime() : 0;
  const merged = {...remote};
  if(localTime > remoteTime) merged.lastRun = local.lastRun;
  localStorage.setItem(_AUTOSYNC_KEY, JSON.stringify(merged));
  return merged;
}

function _cfgAutosyncRenderUI(cfg){
  cfg = cfg || {};
  const en = document.getElementById('cfg-autosync-en');
  const time = document.getElementById('cfg-autosync-time');
  const last = document.getElementById('cfg-autosync-last');
  if(en) en.checked = !!cfg.enabled;
  if(time) time.value = cfg.time || '06:00';
  if(last){
    if(cfg.lastRun){
      const d = new Date(cfg.lastRun);
      last.textContent = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    } else {
      last.textContent = 'Nunca';
    }
  }
}

async function _cfgAutosyncLoad(){
  // Render imediato com cache local (resposta rapida)
  _cfgAutosyncRenderUI(_cfgAutosyncRead());
  // Em paralelo, busca Supabase e re-renderiza com merge se vier algo
  const merged = await _cfgAutosyncMergeFromRemote();
  if(merged) _cfgAutosyncRenderUI(merged);
}

function _cfgAutosyncSave(){
  const cfg = _cfgAutosyncRead();
  cfg.enabled = !!document.getElementById('cfg-autosync-en')?.checked;
  cfg.time = document.getElementById('cfg-autosync-time')?.value || '06:00';
  _cfgAutosyncWrite(cfg);
  showToast(cfg.enabled ? `Auto-sync ativado para ${cfg.time}` : 'Auto-sync desativado');
}

function _autoSyncDayKey(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _autoSyncCheck(){
  const cfg = _cfgAutosyncRead();
  if(!cfg.enabled) return;
  // Só rodamos enquanto a aba de Execução Processual está visível (botão de sync existe e o token está configurado).
  // O syncAdvbox internamente também valida _secrets.advbox().
  const btn = document.getElementById('sync-btn');
  if(!btn || btn.disabled) return;
  if(!_secrets.advbox()) return;

  const now = new Date();
  const todayKey = _autoSyncDayKey(now);
  const lastKey = (cfg.lastRun||'').slice(0,10);
  if(lastKey === todayKey) return; // já rodou hoje

  const [hh, mm] = (cfg.time||'06:00').split(':').map(Number);
  const targetMin = (hh|0)*60 + (mm|0);
  const nowMin = now.getHours()*60 + now.getMinutes();
  if(nowMin < targetMin) return; // ainda não chegou o horário

  // Marca antes de disparar para evitar double-trigger em race
  cfg.lastRun = now.toISOString();
  _cfgAutosyncWrite(cfg);
  _cfgAutosyncLoad(); // atualiza "Última execução" se UI estiver aberta

  // Dispara sync — mesma função do botão manual
  if(typeof syncAdvbox === 'function'){
    Promise.resolve()
      .then(()=>syncAdvbox())
      .catch(e=>console.warn('[Credijuris] auto-sync falhou:', e));
  }
}

async function _autoSyncInit(){
  if(_autoSyncTimer) clearInterval(_autoSyncTimer);
  // Carrega config do Supabase ANTES do primeiro check — dispositivo fresh pode ter
  // localStorage vazio mas Supabase tem lastRun de outro dispositivo (cross-device).
  await _cfgAutosyncMergeFromRemote();
  // Checagem inicial + a cada 60s. Browsers throttlam timers em abas inativas,
  // mas o check é leve e idempotente (lastRun garante no-op duplo).
  _autoSyncCheck();
  _autoSyncTimer = setInterval(_autoSyncCheck, 60_000);
  // Quando a aba volta a ficar visível, força um check imediato (caso o timer
  // tenha sido throttlado durante a inatividade).
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden) _autoSyncCheck();
  });
}

function _sbShowExec(){
  _sbHideAll();
  /* Revela nav/main e itens de cabeçalho — exec é o único modo que usa esses elementos */
  const navEl=document.querySelector('.nav');
  const mainEl=document.querySelector('.main');
  if(navEl)navEl.style.display='flex';
  if(mainEl)mainEl.style.display='block';
  const hdrSearch=document.querySelector('.hdr-search');
  const syncBtn=document.getElementById('sync-btn');
  if(hdrSearch)hdrSearch.style.display='';
  if(syncBtn)syncBtn.style.display='';
  document.getElementById('sb-item-exec').classList.add('active');
  localStorage.setItem('cj-sidebar-active','exec');
}

async function cfgSaveAdvboxToken(){
  const inp=document.getElementById('cfg-advbox-token');
  const status=document.getElementById('cfg-advbox-status');
  const val=(inp?.value||'').trim();
  if(!val){status.textContent='Token vazio';status.className='cfg-status err';return;}
  const saveBtn=document.getElementById('cfg-advbox-save-btn');if(saveBtn)saveBtn.disabled=true;
  status.textContent='Salvando…';status.className='cfg-status';
  try{
    const{error}=await sb.from('configuracoes').upsert({chave:'advbox_token',valor:val},{onConflict:'chave'});
    if(error)throw error;
    _secrets.setAdvbox(val);
    inp.value='';
    inp.placeholder='Token já configurado — cole para substituir';
    status.textContent='Salvo ✓';status.className='cfg-status ok';
    setTimeout(()=>{status.textContent='';},3000);
  }catch(e){
    status.textContent='Erro ao salvar';status.className='cfg-status err';
    console.error(e);
  }finally{
    if(saveBtn)saveBtn.disabled=false;
  }
}

function crtNav(tab){
  document.querySelectorAll('.crt-tab').forEach(t=>t.classList.toggle('on',t.dataset.crt===tab));
  document.querySelectorAll('.crt-pane').forEach(p=>p.classList.toggle('on',p.id==='crt-pane-'+tab));
  if(tab==='investidores'){_crtPopulateInvestidores();_crtRenderOperacoes(_crtAcSelected||null);}
  if(tab==='consolidado')_crtRenderConsolidado();
}

function openParametrosModal(){
  openModal('parametros-ov');
  _prmInit();
}

function _crtPopulateInvestidores(){
  const mesInp=document.getElementById('crt-mes-referencia');
  if(mesInp&&!mesInp.value){
    const hoje=new Date();
    mesInp.value=`${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
  }
  const nomes=new Set();
  [...(CACHE.cessoes||[]),...(CACHE.rpv||[]),...(CACHE.encerrados||[])].forEach(r=>{
    const v=(r.cessionario||'').trim();
    if(v)nomes.add(v);
  });
  _crtInvestidores=[...nomes].sort((a,b)=>a.localeCompare(b,'pt-BR',{sensitivity:'base'}));
  const countEl=document.getElementById('crt-inv-count');
  if(countEl)countEl.textContent=_crtInvestidores.length;
}

function _crtAcRender(lista){
  const dd=document.getElementById('crt-ac-dd');
  if(!dd)return;
  if(!lista.length){dd.innerHTML='<div class="crt-ac-empty">Nenhum resultado</div>';dd.classList.add('on');return;}
  dd.innerHTML=lista.map(n=>`<div class="crt-ac-item${n===_crtAcSelected?' sel':''}" onmousedown="_crtAcPick('${escJs(n)}')">${esc(n)}</div>`).join('');
  dd.classList.add('on');
}

function _crtAcOpen(){_crtAcRender(_crtInvestidores);}
function _crtAcFilter(q){
  _crtAcSelected='';
  const f=q.trim().toLowerCase();
  const lista=f?_crtInvestidores.filter(n=>n.toLowerCase().includes(f)):_crtInvestidores;
  _crtAcRender(lista);
}
function _crtAcPick(nome){
  _crtAcSelected=nome;
  const inp=document.getElementById('crt-ac-input');
  if(inp)inp.value=nome;
  _crtAcClose();
  _crtRenderOperacoes(nome);
}

function _crtRenderOperacoes(investidor){
  const tbody=document.getElementById('crt-tbl-body');
  const scroll=document.getElementById('crt-tbl-scroll');
  const emptyMsg=document.getElementById('crt-tbl-empty-msg');
  if(!tbody)return;
  const _showTable=v=>{
    if(scroll)scroll.style.display=v?'':'none';
    if(emptyMsg)emptyMsg.style.display=v?'none':'';
  };
  if(!investidor){_showTable(false);return;}
  const norm=s=>(s||'').trim().toLowerCase();
  const inv=norm(investidor);

  // Coleta registros das 3 abas marcando origem (processos pai apenas)
  const rows=[];
  (CACHE.cessoes||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===inv)rows.push({...r,_aba:'cessoes'});});
  (CACHE.rpv||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===inv)rows.push({...r,_aba:'rpv'});});
  (CACHE.encerrados||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===inv)rows.push({...r,_aba:'encerrados'});});
  rows.sort((a,b)=>(a.dataAquisicao||'').localeCompare(b.dataAquisicao||''));

  if(!rows.length){
    _showTable(true);
    tbody.innerHTML='<tr><td colspan="27" class="crt-tbl-empty">Nenhuma operação encontrada para este investidor</td></tr>';
    _crtAtualizaCards([]);
    return;
  }
  _showTable(true);

  const _e=v=>(!v&&v!==0)?'—':String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const _d=v=>v?v.split('-').reverse().join('/'):'—'; // yyyy-mm-dd → dd/mm/yyyy

  const abaBadge={
    cessoes:'<span class="crt-aba-badge crt-aba-ativa">Ativa</span>',
    rpv:'<span class="crt-aba-badge crt-aba-rpv">RPV</span>',
    encerrados:'<span class="crt-aba-badge crt-aba-enc">Encerrado</span>'
  };

  tbody.innerHTML=rows.map(r=>{
    return`
    <tr>
      <td style="min-width:104px"><span class="crt-proc">${_e(r.numeroProcesso)}</span>${cpyBtn(r.numeroProcesso||'')}</td>
      <td style="min-width:112px" title="${_e(r.cedente)}">${_e(r.cedente)}</td>
      <td style="min-width:112px" title="${_e(r.advogado)}">${_e(r.advogado)}</td>
      <td style="min-width:96px">${_e(r.objeto)}</td>
      <td style="min-width:64px">${_e(r.tribunal)}</td>
      <td style="min-width:96px" class="crt-td-num crt-sub-grp-start">${crtCellBRL(r._aba,r.id,'capitalInvestido',r.capitalInvestido,'text')}</td>
      <td style="min-width:88px">${_d(r.dataAquisicao)}</td>
      <td style="min-width:96px" class="crt-td-num crt-sub-grp-start">${crtCellBRL(r._aba,r.id,'valorFace',r.valorFace,'text')}</td>
      <td style="min-width:88px">${crtCell(r._aba,r.id,'dataRefFace',r.dataRefFace,'date')}</td>
      <td style="min-width:104px">${crtSelectCell(r._aba,r.id,'indiceAtualizacao',r.indiceAtualizacao,['IPCA + 2%','SELIC'])}</td>
      <td style="min-width:88px" class="crt-sub-grp-start">${crtCell(r._aba,r.id,'dataEstRecebimento',r.dataEstRecebimento,'date')}</td>
      <td style="min-width:88px" class="crt-td-num">${crtCellBRL(r._aba,r.id,'jaRecebido',r.jaRecebido,'text')}</td>
      <td style="min-width:88px">${_d(r.dataLiquidacao)}</td>
      <td style="min-width:96px" class="crt-td-num crt-sub-grp-start">${crtCellBRL(r._aba,r.id,'valorEstComplementar',r.valorEstComplementar,'text')}</td>
      <td style="min-width:80px" class="crt-sub-grp-start">${(()=>{const s=_crtAutoStatus(r);return`<span style="font-weight:600;color:${s.color}">${s.label}</span>`;})()}</td>
      <td style="min-width:112px;max-width:112px;overflow:hidden">${crtTextCell(r._aba,r.id,'estagioProcessual',r.estagioProcessual,r.numeroProcesso)}</td>
      <td style="min-width:160px;max-width:160px;overflow:hidden">${crtTextCell(r._aba,r.id,'providencias',r.providencias,r.numeroProcesso)}</td>
      <td style="min-width:80px">${_d(SORT_COMPUTED.ultimaMovimentacao(r))}</td>
      <td style="min-width:96px" class="crt-td-num crt-sub-grp-start">${(()=>{const v=_calcValorProjetado(r);return v?fmtBRL(v):'—';})()}</td>
      <td style="min-width:80px">${(()=>{const jr=_parseNumCrt(r.jaRecebido);return jr>0?'<strong>Efetivada</strong>':'Estimada';})()}</td>
      <td style="min-width:64px" class="crt-td-num">${(()=>{const t=_calcTirAnual(r);return t==null?'—':(t*100).toFixed(2).replace('.',',')+'%';})()}</td>
      <td style="min-width:64px" class="crt-td-num">${(()=>{const t=_calcTirAnual(r);if(t==null||t<=-1)return'—';const m=Math.pow(1+t,1/12)-1;return isFinite(m)?(m*100).toFixed(2).replace('.',',')+'%':'—';})()}</td>
      <td style="min-width:72px" class="crt-td-num">${(()=>{const d=_calcDiasCarteira(r);return d==null?'—':d+' dias';})()}</td>
      <td style="min-width:96px" class="crt-td-num">${(()=>{const g=_calcGanhoProjetado(r);return g==null?'—':fmtBRL(g);})()}</td>
      <td style="min-width:72px" class="crt-td-num">${(()=>{const g=_calcGanhoProjetado(r);const c=_parseNumCrt(r.capitalInvestido);return(g==null||!c)?'—':((g/c)*100).toFixed(2).replace('.',',')+'%';})()}</td>
    </tr>`;
  }).join('');

  _crtAtualizaCards(rows);
}

function _consExportarXLSX(){
  if(typeof XLSX==='undefined'){alert('Biblioteca de exportação ainda carregando, tente novamente em alguns segundos.');return;}
  const norm=s=>(s||'').trim().toLowerCase();
  const monthOK=r=>_consMonthFilter==='todos'||_extractYM(r.dataAquisicao)===_consMonthFilter;
  const investMap=new Map();
  [...(CACHE.cessoes||[]),...(CACHE.rpv||[]),...(CACHE.encerrados||[])].forEach(r=>{
    if(r.vinculoPai)return;
    const v=(r.cessionario||'').trim();
    if(v)investMap.set(norm(v),v);
  });
  if(!investMap.size){alert('Nenhum investidor para exportar.');return;}
  const tableRows=[];
  let totCap=0,totReceb=0,totAReceber=0,totGanho=0,totOps=0;
  const tirs=[];
  for(const[normName,displayName]of investMap){
    const ops=[];
    (CACHE.cessoes||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===normName&&monthOK(r))ops.push({...r,_aba:'cessoes'});});
    (CACHE.rpv||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===normName&&monthOK(r))ops.push({...r,_aba:'rpv'});});
    (CACHE.encerrados||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===normName&&monthOK(r))ops.push({...r,_aba:'encerrados'});});
    if(!ops.length)continue;
    const capital=ops.reduce((s,r)=>s+_parseNumCrt(r.capitalInvestido),0);
    const recebido=ops.reduce((s,r)=>s+_parseNumCrt(r.jaRecebido),0);
    const aReceber=ops.reduce((s,r)=>{const jr=_parseNumCrt(r.jaRecebido);if(jr>0)return s;const vp=_calcValorProjetado(r);return s+(vp||0);},0);
    const ganho=ops.reduce((s,r)=>s+(_calcGanhoProjetado(r)||0),0);
    const tirList=ops.map(_calcTirAnual).filter(v=>v!=null&&isFinite(v));
    const tirAvg=tirList.length?(tirList.reduce((s,v)=>s+v,0)/tirList.length):null;
    const retorno=capital>0?ganho/capital:null;
    tableRows.push({displayName,capital,aReceber,recebido,retorno,tir:tirAvg,count:ops.length});
    totCap+=capital;totReceb+=recebido;totAReceber+=aReceber;totGanho+=ganho;totOps+=ops.length;
    tirs.push(...tirList);
  }
  if(!tableRows.length){alert('Nenhuma cessão no filtro atual.');return;}
  tableRows.sort((a,b)=>a.displayName.localeCompare(b.displayName,'pt-BR',{sensitivity:'base'}));
  const totRetorno=totCap>0?totGanho/totCap:null;
  const totTir=tirs.length?(tirs.reduce((s,v)=>s+v,0)/tirs.length):null;

  const mesLbl=_consMesLbl(_consMonthFilter);
  const headers=['Investidor','Capital inv. (R$)','A receber est. (R$)','Já recebido (R$)','Retorno','TIR a.a.','Qtd. operações'];
  const aoa=[
    ['Consolidado de carteiras'],
    ['Filtro de mês',mesLbl],
    [],
    headers,
    ...tableRows.map(r=>[r.displayName,r.capital,r.aReceber,r.recebido,r.retorno==null?'':r.retorno,r.tir==null?'':r.tir,r.count]),
    ['Total da carteira',totCap,totAReceber,totReceb,totRetorno==null?'':totRetorno,totTir==null?'':totTir,totOps]
  ];
  const headerRowIdx=3;
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=[{wch:36},{wch:20},{wch:20},{wch:20},{wch:14},{wch:14},{wch:18}];

  const C={brand:'6E7DBB',brandSoft:'1B2138',txtMuted:'8C9AD0',border:'D0D7DE',rowAlt:'F4F8FC'};
  const fontBase={name:'Calibri',sz:11};
  const borderThin={top:{style:'thin',color:{rgb:C.border}},bottom:{style:'thin',color:{rgb:C.border}},left:{style:'thin',color:{rgb:C.border}},right:{style:'thin',color:{rgb:C.border}}};
  const setStyle=(ref,s)=>{if(ws[ref])ws[ref].s=Object.assign({},ws[ref].s||{},s);};

  ws['!merges']=[{s:{r:0,c:0},e:{r:0,c:headers.length-1}}];
  setStyle('A1',{font:{...fontBase,bold:true,sz:14,color:{rgb:'FFFFFF'}},fill:{patternType:'solid',fgColor:{rgb:C.brand}},alignment:{horizontal:'left',vertical:'center'}});
  setStyle('A2',{font:{...fontBase,bold:true,color:{rgb:C.txtMuted},sz:9},alignment:{horizontal:'left',vertical:'center'}});
  setStyle('B2',{font:{...fontBase,bold:true,sz:12,color:{rgb:C.brandSoft}},alignment:{horizontal:'left',vertical:'center'}});

  ws['!rows']=[];
  ws['!rows'][0]={hpt:24};
  ws['!rows'][headerRowIdx]={hpt:30};

  for(let c=0;c<headers.length;c++){
    setStyle(XLSX.utils.encode_cell({r:headerRowIdx,c}),{
      font:{...fontBase,bold:true,sz:10,color:{rgb:'FFFFFF'}},
      fill:{patternType:'solid',fgColor:{rgb:C.brandSoft}},
      alignment:{horizontal:'center',vertical:'center',wrapText:true},
      border:borderThin
    });
  }

  const moneyCols=[1,2,3];
  const pctCols=[4,5];
  for(let i=0;i<tableRows.length;i++){
    const rIdx=headerRowIdx+1+i;
    const zebra=i%2===1;
    for(let c=0;c<headers.length;c++){
      const ref=XLSX.utils.encode_cell({r:rIdx,c});
      const align=c===0?'left':'right';
      const style={font:{...fontBase,sz:10},alignment:{horizontal:align,vertical:'center'},border:borderThin};
      if(zebra)style.fill={patternType:'solid',fgColor:{rgb:C.rowAlt}};
      if(ws[ref])ws[ref].s=style;
      if(ws[ref]&&moneyCols.includes(c)&&typeof ws[ref].v==='number')ws[ref].z='"R$" #,##0.00';
      if(ws[ref]&&pctCols.includes(c)&&typeof ws[ref].v==='number')ws[ref].z='0.00%';
    }
  }

  const totRIdx=headerRowIdx+1+tableRows.length;
  for(let c=0;c<headers.length;c++){
    const ref=XLSX.utils.encode_cell({r:totRIdx,c});
    const align=c===0?'left':'right';
    if(ws[ref])ws[ref].s={
      font:{...fontBase,bold:true,sz:11,color:{rgb:'FFFFFF'}},
      fill:{patternType:'solid',fgColor:{rgb:C.brand}},
      alignment:{horizontal:align,vertical:'center'},
      border:borderThin
    };
    if(ws[ref]&&moneyCols.includes(c)&&typeof ws[ref].v==='number')ws[ref].z='"R$" #,##0.00';
    if(ws[ref]&&pctCols.includes(c)&&typeof ws[ref].v==='number')ws[ref].z='0.00%';
  }

  ws['!freeze']={xSplit:0,ySplit:headerRowIdx+1};
  ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:headerRowIdx,c:0},e:{r:totRIdx-1,c:headers.length-1}})};

  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Consolidado');
  const d=new Date();
  const ts=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const mesSafe=(_consMonthFilter==='todos'?'tudo':_consMonthFilter);
  XLSX.writeFile(wb,`consolidado_${mesSafe}_${ts}.xlsx`);
}

function _calcGanhoProjetado(r){
  const capital=_parseNumCrt(r.capitalInvestido);
  if(!capital)return null;
  const st=_crtAutoStatus(r);
  if(st.label==='Verde'){
    const jr=_parseNumCrt(r.jaRecebido);
    const comp=_parseNumCrt(r.valorEstComplementar);
    if(!jr&&!comp)return null;
    return(jr+comp)-capital;
  }
  const vp=_calcValorProjetado(r);
  if(vp==null)return null;
  return vp-capital;
}

function _calcDiasCarteira(r){
  const d0=r.dataAquisicao;
  if(!d0)return null;
  const st=_crtAutoStatus(r);
  let t1;
  if(st.label==='Verde'){
    if(!r.dataLiquidacao)return null;
    t1=new Date(r.dataLiquidacao+'T12:00:00').getTime();
  }else{
    t1=Date.now();
  }
  const t0=new Date(d0+'T12:00:00').getTime();
  if(!isFinite(t0)||!isFinite(t1))return null;
  const dias=Math.round((t1-t0)/86400000);
  return dias>=0?dias:null;
}

function _calcTirAnual(r){
  const capital=_parseNumCrt(r.capitalInvestido);
  if(!capital||capital<=0)return null;
  const st=_crtAutoStatus(r);
  let valorFinal,d0,d1;
  if(st.label==='Verde'){
    valorFinal=_parseNumCrt(r.jaRecebido);
    d0=r.dataAquisicao;d1=r.dataLiquidacao;
  }else{
    valorFinal=_calcValorProjetado(r);
    d0=r.dataAquisicao;d1=r.dataEstRecebimento;
  }
  if(!valorFinal||valorFinal<=0||!d0||!d1)return null;
  const t0=new Date(d0+'T12:00:00').getTime();
  const t1=new Date(d1+'T12:00:00').getTime();
  if(!isFinite(t0)||!isFinite(t1))return null;
  const dias=(t1-t0)/86400000;
  if(dias<=0)return null;
  const tir=Math.pow(valorFinal/capital,365/dias)-1;
  return isFinite(tir)?tir:null;
}

function _calcValorProjetado(r){
  const st=_crtAutoStatus(r);
  // Verde = liquidado → projetado = já recebido
  if(st.label==='Verde'){
    const jr=_parseNumCrt(r.jaRecebido);
    return jr>0?jr:null;
  }
  // Demais: face × (1 + taxa × dias/365)
  const face=_parseNumCrt(r.valorFace);
  if(!face)return null;
  const d0=r.dataRefFace,d1=r.dataEstRecebimento;
  if(!d0||!d1)return null;
  const t0=new Date(d0+'T12:00:00').getTime();
  const t1=new Date(d1+'T12:00:00').getTime();
  if(!isFinite(t0)||!isFinite(t1))return null;
  const dias=(t1-t0)/86400000;
  if(dias<0)return null;
  const prm=_prmLoad();
  const get=k=>parseFloat(document.getElementById('prm-'+k)?.value)||parseFloat(prm[k])||0;
  const ipca=get('ipca'),selic=get('selic');
  const ind=(r.indiceAtualizacao||'').toUpperCase();
  let taxa=null;
  if(ind.includes('IPCA'))taxa=ipca+2;        // "IPCA + 2%" → índice padrão de projeção
  else if(ind.includes('SELIC'))taxa=selic;
  if(taxa==null||!isFinite(taxa))return null;
  return face*(1+(taxa/100)*dias/365);
}

function _crtExportarXLSX(){
  if(typeof XLSX==='undefined'){alert('Biblioteca de exportação ainda carregando, tente novamente em alguns segundos.');return;}
  const investidor=_crtAcSelected;
  if(!investidor){alert('Selecione um investidor antes de exportar.');return;}
  const norm=s=>(s||'').trim().toLowerCase();
  const inv=norm(investidor);
  const rows=[];
  (CACHE.cessoes||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===inv)rows.push({...r,_aba:'cessoes'});});
  (CACHE.rpv||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===inv)rows.push({...r,_aba:'rpv'});});
  (CACHE.encerrados||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===inv)rows.push({...r,_aba:'encerrados'});});
  rows.sort((a,b)=>(a.dataAquisicao||'').localeCompare(b.dataAquisicao||''));
  if(!rows.length){alert('Não há operações para exportar.');return;}
  const _d=v=>v?v.split('-').reverse().join('/'):'';
  const _abaLbl={cessoes:'Ativa',rpv:'RPV',encerrados:'Encerrado'};
  const headers=['Aba','Nº processo','Cedente','Advogado','Tipo de crédito','Tribunal',
    'Capital investido (R$)','Data da cessão','Valor de face (R$)','Data ref. do face','Índice de atualização',
    'Data est. recebimento','Já recebido (R$)','Data receb. efetivo','Valor est. complementar (R$)',
    'Status','Estágio processual','Providências / próx. passos','Últ. atualização','Valor projetado (R$)','Status TIR','TIR a.a.','TIR mensal'];
  const data=rows.map(r=>{
    const st=_crtAutoStatus(r);
    const jr=_parseNumCrt(r.jaRecebido);
    const vp=_calcValorProjetado(r);
    const tir=_calcTirAnual(r);
    return[
      _abaLbl[r._aba]||r._aba,
      r.numeroProcesso||'',
      r.cedente||'',
      r.advogado||'',
      r.objeto||'',
      r.tribunal||'',
      _parseNumCrt(r.capitalInvestido)||'',
      _d(r.dataAquisicao),
      _parseNumCrt(r.valorFace)||'',
      _d(r.dataRefFace),
      r.indiceAtualizacao||'',
      _d(r.dataEstRecebimento),
      jr||'',
      _d(r.dataLiquidacao),
      _parseNumCrt(r.valorEstComplementar)||'',
      st.label||'',
      r.estagioProcessual||'',
      r.providencias||'',
      _d(SORT_COMPUTED.ultimaMovimentacao(r)),
      vp||'',
      jr>0?'Efetivada':'Estimada',
      tir==null?'':tir,
      tir==null||tir<=-1?'':(Math.pow(1+tir,1/12)-1)
    ];
  });
  // cabeçalho com Investidor, Mês de Referência e Cards
  const mesRefVal=document.getElementById('crt-mes-referencia')?.value||'';
  const mesRefFmt=mesRefVal?(()=>{
    const [y,m]=mesRefVal.split('-');
    const MES=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
    return `${MES[Number(m)-1]} de ${y}`;
  })():'';
  const txt=(id,fb='—')=>document.getElementById(id)?.textContent||fb;
  const cards=[
    ['Capital total',txt('crt-card-capital')],
    ['TIR média',txt('crt-card-tir')],
    ['Retorno projetado',txt('crt-card-retorno')],
    ['Já recebido',txt('crt-card-recebido')],
    ['A receber estimado',txt('crt-card-areceber')],
    ['N.º operações',txt('crt-card-operacoes')]
  ];
  const aoa=[
    ['Investidor',investidor],            // linha 1
    ['Mês de Referência',mesRefFmt],     // linha 2
    [],                                   // linha 3
    ['Resumo'],                           // linha 4
    ...cards.map(([k,v])=>[k,v]),        // linhas 5–10
    [],                                   // linha 11
    headers,                              // linha 12 = header da tabela
    ...data
  ];
  const headerRowIdx=aoa.findIndex(r=>r[0]==='Aba');
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  // larguras alinhadas às colunas da tabela (23 cols: A..W)
  ws['!cols']=[{wch:12},{wch:22},{wch:26},{wch:22},{wch:18},{wch:10},{wch:20},{wch:13},{wch:20},{wch:14},{wch:18},{wch:14},{wch:18},{wch:14},{wch:22},{wch:12},{wch:24},{wch:32},{wch:14},{wch:20},{wch:12},{wch:12},{wch:12}];

  // ----- paleta inspirada no tema (Credijuris periwinkle) -----
  const C={
    brand:'6E7DBB',      // periwinkle principal
    brandSoft:'1B2138',  // azul-marinho header da tabela
    gold:'C9A84C',
    bgTitle:'0D1117',    // título sobre fundo claro? usaremos para texto
    txtMuted:'8C9AD0',
    border:'D0D7DE',
    rowAlt:'F4F8FC'
  };
  const fontBase={name:'Calibri',sz:11};
  const borderThin={top:{style:'thin',color:{rgb:C.border}},bottom:{style:'thin',color:{rgb:C.border}},left:{style:'thin',color:{rgb:C.border}},right:{style:'thin',color:{rgb:C.border}}};

  const setStyle=(ref,s)=>{if(ws[ref])ws[ref].s=Object.assign({},ws[ref].s||{},s);};
  const styleRow=(r,cMin,cMax,s)=>{for(let c=cMin;c<=cMax;c++)setStyle(XLSX.utils.encode_cell({r,c}),s);};

  // linha 1 (Investidor)
  setStyle('A1',{font:{...fontBase,bold:true,color:{rgb:C.txtMuted},sz:9},alignment:{horizontal:'left',vertical:'center'}});
  setStyle('B1',{font:{...fontBase,bold:true,sz:14,color:{rgb:C.brand}},alignment:{horizontal:'left',vertical:'center'}});
  // linha 2 (Mês de Referência)
  setStyle('A2',{font:{...fontBase,bold:true,color:{rgb:C.txtMuted},sz:9},alignment:{horizontal:'left',vertical:'center'}});
  setStyle('B2',{font:{...fontBase,bold:true,sz:12,color:{rgb:C.brandSoft}},alignment:{horizontal:'left',vertical:'center'}});

  // linha 4 ("Resumo")
  setStyle('A4',{font:{...fontBase,bold:true,sz:12,color:{rgb:'FFFFFF'}},fill:{patternType:'solid',fgColor:{rgb:C.brand}},alignment:{horizontal:'left',vertical:'center'}});
  // mescla A4:B4
  ws['!merges']=(ws['!merges']||[]);
  ws['!merges'].push({s:{r:3,c:0},e:{r:3,c:1}});

  // cards (linhas 5–10): label coluna A, valor coluna B
  for(let i=0;i<cards.length;i++){
    const r=4+i;
    setStyle(XLSX.utils.encode_cell({r,c:0}),{font:{...fontBase,bold:true,color:{rgb:C.brandSoft}},fill:{patternType:'solid',fgColor:{rgb:C.rowAlt}},alignment:{horizontal:'left',vertical:'center'},border:borderThin});
    setStyle(XLSX.utils.encode_cell({r,c:1}),{font:{...fontBase,bold:true,sz:12,color:{rgb:C.brand}},alignment:{horizontal:'right',vertical:'center'},border:borderThin});
  }

  // altura das linhas do topo
  ws['!rows']=[];
  ws['!rows'][0]={hpt:22};
  ws['!rows'][1]={hpt:20};
  ws['!rows'][3]={hpt:22};
  ws['!rows'][headerRowIdx]={hpt:32};

  // header da tabela
  const totalCols=23;
  styleRow(headerRowIdx,0,totalCols-1,{
    font:{...fontBase,bold:true,color:{rgb:'FFFFFF'},sz:10},
    fill:{patternType:'solid',fgColor:{rgb:C.brandSoft}},
    alignment:{horizontal:'center',vertical:'center',wrapText:true},
    border:borderThin
  });

  // formato + estilo das linhas de dados
  const moneyCols=[6,8,12,14,19];
  const pctCols=[21,22];
  for(let i=1;i<=rows.length;i++){
    const rIdx=headerRowIdx+i;
    const zebra=i%2===0;
    for(let c=0;c<totalCols;c++){
      const ref=XLSX.utils.encode_cell({r:rIdx,c});
      const isMoney=moneyCols.includes(c);
      const isPct=pctCols.includes(c);
      const align=isMoney||isPct||c===0||c===19?'right':'left';
      const style={
        font:{...fontBase,sz:10},
        alignment:{horizontal:align,vertical:'center',wrapText:false},
        border:borderThin
      };
      if(zebra)style.fill={patternType:'solid',fgColor:{rgb:C.rowAlt}};
      if(ws[ref])ws[ref].s=style;
      if(ws[ref]&&isMoney&&typeof ws[ref].v==='number')ws[ref].z='"R$" #,##0.00';
      if(ws[ref]&&isPct&&typeof ws[ref].v==='number')ws[ref].z='0.00%';
    }
  }
  // congela painel até abaixo do header da tabela
  ws['!freeze']={xSplit:0,ySplit:headerRowIdx+1};
  ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:headerRowIdx,c:0},e:{r:headerRowIdx+rows.length,c:totalCols-1}})};
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Operações');
  const safe=investidor.replace(/[^a-zA-Z0-9-_]+/g,'_');
  const d=new Date();
  const ts=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  XLSX.writeFile(wb,`operacoes_${safe}_${ts}.xlsx`);
}

function _crtAtualizaCards(rows){
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  set('crt-card-operacoes', rows.length||'—');

  // Capital total = soma de capitalInvestido de todas as linhas
  const totalCapital=rows.reduce((sum,r)=>sum+_parseNumCrt(r.capitalInvestido),0);
  set('crt-card-capital', totalCapital>0 ? fmtBRL(totalCapital) : '—');

  // Já recebido = soma de jaRecebido de todas as linhas
  const totalRecebido=rows.reduce((sum,r)=>sum+_parseNumCrt(r.jaRecebido),0);
  set('crt-card-recebido', totalRecebido>0 ? fmtBRL(totalRecebido) : '—');

  // TIR média = média simples das TIR a.a. válidas
  const tirs=rows.map(_calcTirAnual).filter(v=>v!=null&&isFinite(v));
  const tirAvg=tirs.length?(tirs.reduce((s,v)=>s+v,0)/tirs.length):null;
  set('crt-card-tir', tirAvg==null?'—':(tirAvg*100).toFixed(2).replace('.',',')+'%');

  // A receber estimado = soma de Valor projetado das linhas sem Já recebido
  const totalAReceber=rows.reduce((sum,r)=>{
    const jr=_parseNumCrt(r.jaRecebido);
    if(jr>0)return sum;
    const vp=_calcValorProjetado(r);
    return sum+(vp||0);
  },0);
  set('crt-card-areceber', totalAReceber>0 ? fmtBRL(totalAReceber) : '—');

  // Retorno projetado = soma(Ganho projetado) / soma(Capital investido)
  const totalGanho=rows.reduce((s,r)=>s+(_calcGanhoProjetado(r)||0),0);
  set('crt-card-retorno', totalCapital>0 ? ((totalGanho/totalCapital)*100).toFixed(2).replace('.',',')+'%' : '—');
}
function _crtAcClose(){const dd=document.getElementById('crt-ac-dd');if(dd)dd.classList.remove('on');}
function _crtAcKey(e){
  const dd=document.getElementById('crt-ac-dd');
  if(!dd||!dd.classList.contains('on'))return;
  const items=[...dd.querySelectorAll('.crt-ac-item')];
  const cur=items.findIndex(i=>i.classList.contains('sel'));
  if(e.key==='ArrowDown'){e.preventDefault();const nx=items[cur+1]||items[0];items.forEach(i=>i.classList.remove('sel'));nx?.classList.add('sel');_crtAcSelected=nx?.textContent||'';}
  else if(e.key==='ArrowUp'){e.preventDefault();const pv=items[cur-1]||items[items.length-1];items.forEach(i=>i.classList.remove('sel'));pv?.classList.add('sel');_crtAcSelected=pv?.textContent||'';}
  else if(e.key==='Enter'){e.preventDefault();if(_crtAcSelected)_crtAcPick(_crtAcSelected);}
  else if(e.key==='Escape')_crtAcClose();
}
document.addEventListener('click',e=>{if(!e.target.closest('.crt-ac-wrap'))_crtAcClose();});

function sbNav(item){
  if(item==='config'){
    _sbShowConfig();
    return;
  }
  if(item==='exec'){
    _sbShowExec();
    // Se exec não estava ativo nesta sessão (ex: vindo de carteiras), sempre abre no dashboard
    const target=_execWasActive?(lastExecTab||'dashboard'):'dashboard';
    _execWasActive=true;
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
    const tEl=document.querySelector(`.tab[data-tab="${target}"]`);
    if(tEl)tEl.classList.add('on');
    const pEl=document.getElementById('pane-'+target);
    if(pEl)pEl.classList.add('on');
    topTab=target;
    // Usar requestAnimationFrame para garantir que o DOM foi aplicado antes de renderizar
    requestAnimationFrame(()=>{
      if(topTab==='dashboard')updateDash();
      else if(topTab==='acompanhamento')selectSubpane(subTab||'cessoes');
      else render(topTab);
    });
  }else if(item==='credito'){
    _sbShowCredito();
  }else if(item==='carteiras'){
    _sbShowCarteiras();
  }else if(item==='contratos'){
    _sbShowContratos();
  }
}

/* ======================================================
   GERAR CONTRATOS — pane
====================================================== */
const GC={
  job_id:null,
  investidores:[],
  uploads:{apresentacao:[],cedente:[],escritorio:[]},
};

function _sbShowContratos(){
  _sbHideAll();
  _execWasActive=false;
  const pane=document.getElementById('pane-contratos');
  if(pane)pane.style.display='flex';
  document.getElementById('sb-item-contratos')?.classList.add('active');
  localStorage.setItem('cj-sidebar-active','contratos');
  gcInit();
}

async function gcInit(){
  GC.job_id=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2));
  GC.uploads={apresentacao:[],cedente:[],escritorio:[]};
  const res=document.getElementById('gc-result');if(res)res.innerHTML='';
  await gcLoadInvestidores();
  gcRenderInvestidores();
  gcRenderFiles();
}

async function gcLoadInvestidores(){
  if(!sb){GC.investidores=[];return;}
  try{
    const{data,error}=await sb.from('investidores').select('id,nome,cpf').order('nome');
    if(error)throw error;
    GC.investidores=data||[];
  }catch(e){
    console.error('[GC] loadInvestidores',e);
    GC.investidores=[];
  }
}

function gcRenderInvestidores(){
  const sel=document.getElementById('gc-investidor');
  if(!sel)return;
  if(GC.investidores.length===0){
    sel.innerHTML='<option value="">(nenhum investidor cadastrado — rode o seed no Supabase)</option>';
    return;
  }
  sel.innerHTML='<option value="">— selecione —</option>'+
    GC.investidores.map(i=>`<option value="${esc(i.id)}">${esc(i.nome)}${i.cpf?` (${esc(i.cpf)})`:''}</option>`).join('');
}

function gcRenderFiles(){
  for(const papel of ['apresentacao','cedente','escritorio']){
    const list=document.getElementById('gc-files-'+papel);
    if(!list)continue;
    const arr=GC.uploads[papel];
    if(arr.length===0){
      list.innerHTML='<div class="gc-files-empty">Nenhum arquivo selecionado</div>';
    }else{
      list.innerHTML=arr.map((f,idx)=>`
        <div class="gc-file-item">
          <span class="gc-file-name">${esc(f.name)}</span>
          <span class="gc-file-size">${(f.size/1024).toFixed(1)} KB</span>
          <button class="gc-file-rm" onclick="gcRemoveFile('${papel}',${idx})" title="Remover">✕</button>
        </div>
      `).join('');
    }
  }
  const btn=document.getElementById('gc-submit');
  if(!btn)return;
  const inv=document.getElementById('gc-investidor')?.value||'';
  const inter=(document.getElementById('gc-intermediador')?.value||'').trim();
  const hasApresentacao=GC.uploads.apresentacao.length>0;
  btn.disabled=!(inv&&inter&&hasApresentacao);
}

function gcOnFileSelect(papel,input){
  if(!input||!input.files)return;
  for(const f of Array.from(input.files))GC.uploads[papel].push(f);
  input.value='';
  gcRenderFiles();
}

function gcRemoveFile(papel,idx){
  GC.uploads[papel].splice(idx,1);
  gcRenderFiles();
}

function _gcProgress(msg){
  const p=document.getElementById('gc-progress');
  const t=document.getElementById('gc-progress-text');
  if(p)p.style.display='flex';
  if(t)t.textContent=msg;
}

function _gcHideProgress(){
  const p=document.getElementById('gc-progress');
  if(p)p.style.display='none';
}

function _gcShowOk(data){
  const r=document.getElementById('gc-result');
  if(!r)return;
  const pendBlock=(data.pendentes&&data.pendentes.length)?`
    <div class="gc-pendentes">
      ⚠ Variáveis não preenchidas em alguns contratos: <strong>${esc(data.pendentes.join(', '))}</strong>
      <div class="gc-pendentes-hint">Edite manualmente nos arquivos .docx no Drive.</div>
    </div>`:'';
  const tipos=Array.isArray(data.tipos_gerados)?data.tipos_gerados:[];
  r.innerHTML=`
    <div class="gc-result-ok">
      <div class="gc-result-title ok">✓ ${tipos.length} contrato(s) gerado(s)</div>
      <div class="gc-result-msg">${esc(tipos.join(', '))} — enviados pra pasta <em>${esc(DRIVE_PASTA_CONTRATOS_LABEL)}</em> no Drive.</div>
      <a href="${esc(data.drive_folder_url)}" target="_blank" rel="noopener" class="btn btn-gold btn-sm">
        Abrir pasta no Drive ↗
      </a>
      ${pendBlock}
    </div>`;
}
const DRIVE_PASTA_CONTRATOS_LABEL='2. Contratos assinados';

function _gcShowErr(msg){
  const r=document.getElementById('gc-result');
  if(!r)return;
  r.innerHTML=`
    <div class="gc-result-err">
      <div class="gc-result-title err">✕ Erro ao gerar contratos</div>
      <div class="gc-result-msg">${esc(msg)}</div>
    </div>`;
}

async function gcSubmit(){
  const btn=document.getElementById('gc-submit');
  if(!btn||btn.disabled)return;
  const r=document.getElementById('gc-result');if(r)r.innerHTML='';
  btn.disabled=true;

  const investidor_id=document.getElementById('gc-investidor').value;
  const intermediador=(document.getElementById('gc-intermediador').value||'').trim();
  const tipo=document.getElementById('gc-tipo').value||null;

  try{
    if(!sb)throw new Error('Supabase não inicializado');
    const{data:userData}=await sb.auth.getUser();
    const userId=userData?.user?.id;
    if(!userId)throw new Error('Sessão expirada — faça login de novo');

    // 1. Upload de arquivos
    const total=GC.uploads.apresentacao.length+GC.uploads.cedente.length+GC.uploads.escritorio.length;
    let done=0;
    for(const papel of ['apresentacao','cedente','escritorio']){
      for(const file of GC.uploads[papel]){
        done++;
        _gcProgress(`Enviando arquivos… (${done}/${total}) ${file.name}`);
        // Supabase Storage não aceita acento/símbolo — normaliza p/ ASCII
        const safeName=file.name
          .normalize('NFD').replace(/[̀-ͯ]/g,'')
          .replace(/[^\w.\-()]/g,'_');
        const path=`${userId}/${GC.job_id}/${papel}/${safeName}`;
        const{error}=await sb.storage.from('contratos-input').upload(path,file,{upsert:true});
        if(error)throw new Error(`Upload de ${file.name} falhou: ${error.message}`);
      }
    }

    // 2. Invoca a Edge Function
    _gcProgress('Extraindo dados e gerando contratos… (pode levar 30–90s)');
    const{data,error}=await sb.functions.invoke('gerar-contrato',{
      body:{job_id:GC.job_id,investidor_id,intermediador,tipo},
    });
    if(error){
      // Tenta extrair mensagem detalhada do response body
      let detail=error.message||String(error);
      try{
        if(error.context&&typeof error.context.json==='function'){
          const j=await error.context.json();
          if(j?.error)detail=j.error;
          if(j?.intermediadores_disponiveis){
            if(j.intermediadores_disponiveis.length>0){
              detail+='\n\nIntermediadores disponíveis no Drive:\n• '+j.intermediadores_disponiveis.join('\n• ');
            }else{
              detail+='\n\n(Lista de intermediadores veio vazia)';
            }
          }
          if(j?.debug)detail+='\n\nDebug:\n'+JSON.stringify(j.debug,null,2);
        }
      }catch(_){}
      throw new Error(detail);
    }
    if(data?.error)throw new Error(data.error);

    _gcHideProgress();
    _gcShowOk(data);

    // Reset state pra próxima geração
    GC.job_id=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2));
    GC.uploads={apresentacao:[],cedente:[],escritorio:[]};
    gcRenderFiles();
  }catch(e){
    console.error('[GC] submit',e);
    _gcHideProgress();
    _gcShowErr(e.message||String(e));
    btn.disabled=false;
  }
}

document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
    t.classList.add('on');
    document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
    topTab=t.dataset.tab;
    lastExecTab=topTab;
    _execWasActive=true;
    localStorage.setItem('cj-sidebar-lasttab',topTab);
    document.getElementById('pane-'+topTab).classList.add('on');
    _gsClose();
    if(topTab==='dashboard')updateDash();
    else if(topTab==='acompanhamento')selectSubpane(subTab||'cessoes');
    else render(topTab);
  });
});

/* ======================================================
   GLOBAL SEARCH
====================================================== */
const _GS_MODS=[
  {key:'cessoes',    label:'Cessões Ativas', cls:'gs-badge-cess'},
  {key:'rpv',        label:'RPV Complementar',cls:'gs-badge-rpv'},
  {key:'encerrados', label:'Encerrados',     cls:'gs-badge-enc'},
  {key:'requerimentos',label:'Diversos',     cls:'gs-badge-div'},
];
function _gsSearch(q){
  const dd=document.getElementById('gs-dd');
  const ql=(q||'').trim().toLowerCase();
  if(!ql){dd.classList.remove('on');return;}
  let html='',total=0;
  _GS_MODS.forEach(({key,label,cls})=>{
    const hits=load(key).filter(r=>
      (r.numeroProcesso||'').toLowerCase().includes(ql)||
      (r.cedente||'').toLowerCase().includes(ql)||
      (r.cessionario||'').toLowerCase().includes(ql)||
      (r.advogado||'').toLowerCase().includes(ql)||
      (r.devedor||'').toLowerCase().includes(ql)||
      (r.orgaoJulgador||'').toLowerCase().includes(ql)||
      (key==='requerimentos'&&((r.materia||'').toLowerCase().includes(ql)||(r.natureza||'').toLowerCase().includes(ql)))
    ).slice(0,5);
    if(!hits.length)return;
    total+=hits.length;
    html+=`<div class="gs-group-hdr">${label}</div>`;
    html+=hits.map(r=>{
      const sub=key==='requerimentos'
        ?[r.tribunal,r.materia].filter(Boolean).join(' · ')
        :(r.cedente||r.cessionario)
          ?`${r.cedente||''}${r.cedente&&r.cessionario?' v. ':''}${r.cessionario||''}`
          :'';
      return`<div class="gs-item" onclick="_gsGo('${key}','${esc(r.id)}')"><span class="gs-badge ${cls}">${label}</span><span class="gs-proc">${esc(r.numeroProcesso||'—')}</span>${sub?`<span class="gs-sub" style="margin-left:8px">${esc(sub)}</span>`:''}</div>`;
    }).join('');
  });
  if(!total)html=`<div class="gs-empty">Nenhum resultado para "${esc(q)}"</div>`;
  dd.innerHTML=html;
  dd.classList.add('on');
}
function _gsClose(){document.getElementById('gs-dd').classList.remove('on');}
function _gsGo(mod,id){
  _gsClose();
  document.getElementById('g-search').value='';
  goToProcess(mod,id);
}
document.addEventListener('click',e=>{
  const wrap=document.querySelector('.hdr-search');
  if(wrap&&!wrap.contains(e.target))_gsClose();
});

/* ======================================================
   DASHBOARD
====================================================== */
function updateDash(){
  const ce=load('cessoes'),rp=load('rpv'),re=load('requerimentos'),en=load('encerrados');
  const cePai=ce.filter(r=>!r.vinculoPai).length;
  const rpPai=rp.filter(r=>!r.vinculoPai).length;
  const enPai=en.filter(r=>!r.vinculoPai).length;
  document.getElementById('ds-total').textContent=cePai+rpPai+enPai;
  document.getElementById('ds-cess').textContent=cePai;
  document.getElementById('ds-rpv').textContent=rpPai;
  document.getElementById('ds-enc').textContent=enPai;
  /* "Com Prazo Fatal" — apenas registros pais (não filhos vinculados),
     consistente com o critério de contagem dos demais cards. */
  const withFatal=[...ce,...rp,...re].filter(r=>!r.vinculoPai&&r.prazoFatal&&normDate(r.prazoFatal)).length;
  document.getElementById('ds-fatal').textContent=withFatal;

  const today=new Date(); today.setHours(0,0,0,0);

  // TABELA 1 — Liquidação Próxima ou Vencida (cessões ativas, exp. liq. vencida ou ≤60 dias)
  // Cessionários que já receberam (têm registro em RPV ou Encerrados)
  const cessCom=new Set([
    ...rp.map(r=>(r.cessionario||'').trim().toLowerCase()),
    ...en.map(r=>(r.cessionario||'').trim().toLowerCase())
  ].filter(Boolean));
  // Cessionários com mais de um processo ativo em cessões
  const cessCont={};
  ce.forEach(r=>{const k=(r.cessionario||'').trim().toLowerCase();if(k)cessCont[k]=(cessCont[k]||0)+1;});

  const liqRecs=ce
    .filter(r=>!r.vinculoPai&&r.expectativaLiquidacao)
    .map(r=>{
      const diff=liqDays(r.expectativaLiquidacao); // mesma fórmula da coluna "Tempo Decorrido"
      const ck=(r.cessionario||'').trim().toLowerCase();
      const prioritario=ck&&(cessCont[ck]>1)&&!cessCom.has(ck);
      return{...r,_diff:diff,_prio:prioritario};
    })
    .filter(r=>r._diff<=60)
    .sort((a,b)=>{
      if(a._prio!==b._prio)return a._prio?-1:1;
      return a._diff-b._diff;
    });

  document.getElementById('ds-cnt-liq').textContent=liqRecs.length?`· ${liqRecs.length}`:'';
  const lb=document.getElementById('ds-liq-body');
  if(!liqRecs.length){
    lb.innerHTML='<div class="db-empty">Nenhum processo com liquidação próxima ou vencida</div>';
  } else {
    lb.innerHTML=liqRecs.map(r=>{
      const d=r._diff;
      const sub=d<0?'vencida':'próxima';
      const col=d<0?'var(--red2)':d<60?'var(--ylw2)':'var(--grn2)';
      const prioBadge=r._prio
        ?'<span class="prio-badge">Prioritário</span>'
        :'';
      return`<div class="alert-item">
        <div style="flex:1;min-width:0">
          <div class="al-text" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.numeroProcesso)}${navBtn('cessoes',r.id)}${prioBadge}</div>
          ${(r.cedente||r.cessionario)?`<div style="font-size:10px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.cedente||'')}${r.cedente&&r.cessionario?' v. ':''}${esc(r.cessionario||'')}</div>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap">
          <span style="font-size:10px;color:#6b7280">${sub}</span>
          <span style="font-size:11px;font-weight:600;color:${col}">${liquidacaoDiff(r.expectativaLiquidacao)}</span>
        </div>
      </div>`;
    }).join('');
  }

  // TABELA 2 — Processos Paralisados (última mov. judicial há >30 dias)
  const parRecs=ce
    .filter(r=>!r.vinculoPai)
    .map(r=>{
      const mov=SORT_COMPUTED.ultimaMovimentacao(r)||null;
      const d=mov||r.dataAquisicao||null;
      if(!d)return null;
      const dias=Math.floor((today-new Date(d))/864e5);
      return{...r,_movDate:d,_dias:dias,_semMov:!mov};
    })
    .filter(r=>r&&r._dias>=30)
    .sort((a,b)=>b._dias-a._dias);

  document.getElementById('ds-cnt-par').textContent=parRecs.length?`· ${parRecs.length}`:'';
  const pb=document.getElementById('ds-par-body');
  if(!parRecs.length){
    pb.innerHTML='<div class="db-empty">Nenhum processo paralisado há mais de 30 dias</div>';
  } else {
    pb.innerHTML=parRecs.map(r=>{
      const col=r._dias>60?'var(--red2)':'#fb923c';
      const meses=Math.floor(r._dias/30);
      const mesLabel=r._semMov
        ?'sem movimentação'
        :meses>=1?`há +${meses} ${meses===1?'mês':'meses'}`:'há menos de 1 mês';
      return`<div class="alert-item">
        <div style="flex:1;min-width:0">
          <div class="al-text" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.numeroProcesso)}${navBtn('cessoes',r.id)}</div>
          ${(r.cedente||r.cessionario)?`<div style="font-size:10px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.cedente||'')}${r.cedente&&r.cessionario?' v. ':''}${esc(r.cessionario||'')}</div>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap">
          <span style="font-size:10px;color:#6b7280">${mesLabel}</span>
          <span style="font-size:11px;font-weight:600;color:${col}">${r._dias}d</span>
        </div>
      </div>`;
    }).join('');
  }

  // ALERTAS — Prazos Fatais (igual ao original)
  const alertRecs=[
    ...ce.filter(r=>!r.vinculoPai).map(r=>({...r,_mod:'cessoes'})),
    ...rp.filter(r=>!r.vinculoPai).map(r=>({...r,_mod:'rpv'})),
    ...re.filter(r=>!r.vinculoPai).map(r=>({...r,_mod:'requerimentos'}))
  ].filter(r=>r.prazoFatal&&normDate(r.prazoFatal))
    .sort((a,b)=>normDate(a.prazoFatal).localeCompare(normDate(b.prazoFatal)));

  document.getElementById('ds-cnt-alerts').textContent=alertRecs.length?`· ${alertRecs.length}`:'';
  const ab=document.getElementById('ds-alerts-body');
  if(!alertRecs.length){
    ab.innerHTML='<div style="padding:20px;text-align:center;color:var(--txt3);font-size:12px">Nenhum alerta de prazo fatal</div>';
  } else {
    ab.innerHTML=alertRecs.map(r=>{
      const lv=fatalLevel(r.prazoFatal);
      const nd=normDate(r.prazoFatal);
      const diff=Math.round((new Date(nd)-new Date(todayStr()))/864e5);
      const col=lv==='exp'?'var(--red2)':lv==='urg'?'#f97316':lv==='warn'?'#fb923c':lv==='next'?'var(--ylw2)':'var(--txt3)';
      const msg=lv==='exp'?'vencido'
        :diff===1?`${diff} dia restante`
        :`${diff} dias restantes`;
      return`<div class="alert-item">
        <div style="flex:1;min-width:0">
          <div class="al-text">${esc(r.numeroProcesso)}${navBtn(r._mod,r.id)}</div>
          ${(r.cedente||r.cessionario)?`<div style="font-size:10px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.cedente||'')}${r.cedente&&r.cessionario?' v. ':''}${esc(r.cessionario||'')}</div>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;white-space:nowrap">
          <span style="font-size:10px;color:#6b7280">${msg}</span>
          <span style="font-size:11px;font-weight:600;color:${col}">${fmtDate(r.prazoFatal)}</span>
        </div>
      </div>`;
    }).join('');
  }

  // ÚLTIMAS MOVIMENTAÇÕES — últimos 20 dias, agrupadas por processo
  const cutoff=new Date(today); cutoff.setDate(cutoff.getDate()-20);
  const modLabel={cessoes:'Cessões Ativas',rpv:'RPV Complementar',requerimentos:'Diversos'};
  const modBdg={cessoes:'bdg-blue',rpv:'bdg-grn',requerimentos:'bdg-ylw'};
  // Coletar todas as movimentações recentes
  const movRows=[];
  [['cessoes',ce],['rpv',rp],['requerimentos',re]].forEach(([mod,recs])=>{
    recs.forEach(r=>{
      (r.historicoProcessual||[]).forEach(h=>{
        if(!h.data)return;
        const d=new Date(h.data+'T00:00:00');
        if(d<cutoff)return;
        movRows.push({mod,r,data:h.data,desc:h.descricao||''});
      });
    });
  });
  // Agrupar por processo (chave: id único do registro)
  const grupos=new Map();
  movRows.forEach(row=>{
    const key=row.r.id||row.r.numeroProcesso||'';
    if(!grupos.has(key))grupos.set(key,{mod:row.mod,r:row.r,movs:[]});
    grupos.get(key).movs.push({data:row.data,desc:row.desc});
  });
  // Ordenar movs dentro de cada grupo (mais recente primeiro)
  grupos.forEach(g=>g.movs.sort((a,b)=>b.data.localeCompare(a.data)));
  // Ordenar grupos pela data mais recente
  const gruposArr=[...grupos.values()].sort((a,b)=>b.movs[0].data.localeCompare(a.movs[0].data));
  const totalMovs=movRows.length;
  document.getElementById('ds-cnt-mov').textContent=totalMovs?`${totalMovs}`:'';
  const _amc=document.getElementById('act-count-mov');if(_amc)_amc.textContent=totalMovs||'0';
  const mb=document.getElementById('ds-mov-body');
  if(!gruposArr.length){
    mb.innerHTML='<div class="db-empty">Nenhuma movimentação nos últimos 20 dias</div>';
  } else {
    mb.innerHTML=gruposArr.map(({mod,r,movs})=>{
      const partes=(r.cedente||r.cessionario)
        ?`<div style="font-size:10px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.cedente||'')}${r.cedente&&r.cessionario?' v. ':''}${esc(r.cessionario||'')}</div>`:'';
      const movsHtml=movs.map(m=>`<div style="padding:6px 16px 6px 24px;border-top:1px solid rgba(30,36,51,.4);font-size:11px">
          <span style="color:#6b7280;margin-right:8px">${fmtDate(m.data)}</span><span style="color:var(--txt2)">${esc(m.desc)||'<span style="color:#4b5563">—</span>'}</span>
        </div>`).join('');
      const cnt=movs.length;
      return`<div class="mov-group">
        <div class="mov-group-hdr" onclick="toggleMovGroup(this)">
          <div style="flex:1;min-width:0;overflow:hidden">
            <div style="display:flex;align-items:center;gap:4px;overflow:hidden">
              <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500">${esc(r.numeroProcesso||'')}</span>${cpyBtn(r.numeroProcesso||'')}${navBtn(mod,r.id)}
            </div>
            ${partes}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span class="bdg ${modBdg[mod]}">${modLabel[mod]}</span>
            <span style="font-size:10px;color:#6b7280;white-space:nowrap">${cnt}</span>
            <span class="mov-arrow">▶</span>
          </div>
        </div>
        <div class="mov-group-body" style="display:none">${movsHtml}</div>
      </div>`;
    }).join('');
  }
  // Contadores do card Urgências
  const _uPraz=document.getElementById('urg-count-prazos');if(_uPraz)_uPraz.textContent=alertRecs.length||'0';
  const _uLiq=document.getElementById('urg-count-liq');if(_uLiq)_uLiq.textContent=liqRecs.length||'0';
  const _uPar=document.getElementById('urg-count-par');if(_uPar)_uPar.textContent=parRecs.length||'0';
  selectUrgency(dashUrgencyType||'prazos');
  selectActivity(dashActivityType||'publicacoes');

  renderCalendario();
}

/* ======================================================
   CALENDÁRIO DE PRAZOS — lista vertical com nav por mês
====================================================== */
let calAno = new Date().getFullYear();
let calMes = new Date().getMonth();

function calNav(dir){
  calMes += dir;
  if(calMes > 11){calMes=0; calAno++;}
  if(calMes < 0){calMes=11; calAno--;}
  renderCalendario();
}

function renderCalendario() {
  const cal = document.getElementById('cal-container');
  if(!cal) return;
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const nomesSem = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  const hoje = new Date(); hoje.setHours(0,0,0,0);
  const hojeStr = todayStr();
  const curMes = hoje.getMonth();
  const curAno = hoje.getFullYear();
  const isCurMonth = (calMes === curMes && calAno === curAno);

  // Coleta diligências abertas (Advbox /history) agrupadas pelo dia do prazo.
  // Diligências com deadline < hoje são ignoradas no calendário (não acumula
  // em "hoje"); elas continuam visíveis dentro do histórico de cada processo.
  const prazosByDay = {};
  let totalDils = 0;
  let recsWithDilsField = 0;
  let totalRecs = 0;
  [['cessoes',load('cessoes')],['rpv',load('rpv')],['requerimentos',load('requerimentos')]].forEach(([mod,recs])=>{
    recs.forEach(r=>{
      // Inclui processos filhos (vinculoPai!=null) — diligencias sao por processo,
      // entao filhos tem prazos independentes do pai.
      totalRecs++;
      if(Object.prototype.hasOwnProperty.call(r,'_advboxDiligencias')) recsWithDilsField++;
      const dils = r._advboxDiligencias || [];
      dils.forEach(d => {
        if(!d.deadline) return;
        const ddl = normDate(d.deadline); if(!ddl) return;
        totalDils++;
        if(ddl < hojeStr) return;
        (prazosByDay[ddl] = prazosByDay[ddl] || []).push({
          _mod:mod, _id:r.id,
          numeroProcesso:r.numeroProcesso||'',
          task:d.task||'',
          notes:d.notes||'',
          deadline:ddl,
          responsible:d.responsible||''
        });
      });
    });
  });

  const diasNoMes = new Date(calAno, calMes + 1, 0).getDate();
  const firstDay = isCurMonth ? hoje.getDate() : 1;

  let rows = '';
  for(let d = firstDay; d <= diasNoMes; d++) {
    const dt = new Date(calAno, calMes, d);
    const dow = dt.getDay();
    const dateStr = `${calAno}-${String(calMes+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isHoje = (d === hoje.getDate() && isCurMonth);
    const recs = prazosByDay[dateStr] || [];
    const temPrazo = recs.length > 0;
    const cls = ['cal-row'];
    if(isHoje) cls.push('cal-row-today');
    if(temPrazo) cls.push('cal-row-has-deadline');
    if(dow === 0 || dow === 6) cls.push('cal-row-weekend');
    const tag = isHoje ? '<span class="cal-row-tag">hoje</span>' : '';
    const tasksHtml = temPrazo
      ? `<div class="cal-row-tasks">${recs.map(t=>{
          const taskTxt = t.task ? esc(t.task) : '<span style="color:#6b7280">(sem descrição)</span>';
          const procTxt = t.numeroProcesso ? esc(t.numeroProcesso) : '';
          const noteRaw = (t.notes||'').trim();
          const ttl = [t.task,t.numeroProcesso,noteRaw].filter(Boolean).join(' — ');
          return `<div class="cal-task" title="${esc(ttl)}">
            <div class="cal-task-line1">
              <span class="cal-task-proc">${taskTxt}</span>
              ${procTxt ? `<span class="cal-task-dot">·</span><span class="cal-task-num">${procTxt}</span>` : ''}
            </div>
            ${noteRaw ? `<span class="cal-task-note">${esc(noteRaw)}</span>` : ''}
          </div>`;
        }).join('')}</div>`
      : '';
    rows += `<div class="${cls.join(' ')}">
      <div class="cal-row-left">
        <span class="cal-row-day">${d}</span>
        <span class="cal-row-wd">${nomesSem[dow]}</span>
        ${tag}
      </div>
      ${tasksHtml}
    </div>`;
  }

  let emptyHint = '';
  if(Object.keys(prazosByDay).length === 0){
    if(totalRecs > 0 && recsWithDilsField === 0){
      emptyHint = `<div class="cal-empty-hint">Diligências do Advbox ainda não foram sincronizadas. Clique em <strong>↺ Sincronizar</strong> no topo para puxá-las.</div>`;
    } else if(recsWithDilsField > 0 && totalDils === 0){
      emptyHint = `<div class="cal-empty-hint">Nenhuma diligência aberta com prazo registrado no Advbox.</div>`;
    }
  }

  cal.innerHTML = `
    <div class="cal-head">
      <div class="cal-title">${meses[calMes]} <span>${calAno}</span></div>
      <div class="cal-nav">
        <button type="button" onclick="calNav(-1)" aria-label="Mês anterior" ${isCurMonth?'disabled':''}>‹</button>
        <button type="button" onclick="calNav(1)" aria-label="Próximo mês">›</button>
      </div>
    </div>
    ${emptyHint}
    <div class="cal-vlist" id="cal-vlist">${rows}</div>`;
}

/* ======================================================
   COLUMN SORT
====================================================== */
const SORT_STATE={
  cessoes:        {field:'dataAquisicao',  dir:'asc'},
  rpv:            {field:'dataLiquidacao', dir:'asc'},
  encerrados:     {field:'dataLiquidacao', dir:'asc'},
  requerimentos:  {field:'protocolo',      dir:'asc'}
};

const SORT_COMPUTED={
  _tempo_dec: r=>new Date(r.expectativaLiquidacao||'9999-12-31').getTime(),
  _dur_rpv:   r=>(r.dataAquisicao&&r.dataLiquidacao)?new Date(r.dataLiquidacao)-new Date(r.dataAquisicao):0,
  _dur_enc:   r=>(r.dataAquisicao&&r.dataLiquidacao)?new Date(r.dataLiquidacao)-new Date(r.dataAquisicao):0,
  protocolo:  r=>r.protocolo||'9999-12-31',
  ultimaMovimentacao: r=>{const h=(r.historicoProcessual||[]).slice().sort((a,b)=>(b.data||'').localeCompare(a.data||''));if(!h.length)return'';for(const e of h){if(!isPartyAction(e.descricao))return e.data;}return h[0].data||'';},
};

function toggleSort(mod,field,btn){
  const s=SORT_STATE[mod];
  if(s.field===field){
    if(s.dir==='asc')s.dir='desc';
    else{s.field=null;s.dir=null;}
  } else {
    s.field=field;s.dir='asc';
  }
  document.querySelectorAll(`#pane-${mod} .col-sbtn`).forEach(b=>{
    const f=b.getAttribute('data-field');
    if(f===s.field){b.textContent=s.dir==='asc'?'↑':'↓';b.classList.add('active');}
    else{b.textContent='↕';b.classList.remove('active');}
  });
  _fSave();
  PG[mod]=1;render(mod);
}

function sortRecs(recs,mod){
  const s=SORT_STATE[mod];
  if(!s||!s.field)return recs;
  const dir=s.dir==='asc'?1:-1;
  const getter=SORT_COMPUTED[s.field]||(r=>String(r[s.field]||''));
  return[...recs].sort((a,b)=>{
    const va=getter(a),vb=getter(b);
    if(typeof va==='number'&&typeof vb==='number')return(va-vb)*dir;
    /* null-safe comparison: força strings, evita TypeError em null/undefined */
    return String(va==null?'':va).localeCompare(String(vb==null?'':vb),'pt-BR',{sensitivity:'base'})*dir;
  });
}

/* ======================================================
   COLUMN FILTERS — Excel-style dropdown
====================================================== */
const COL_FILTERS={cessoes:{},rpv:{},encerrados:{},requerimentos:{}};
let _cfMod=null,_cfField=null,_cfBtn=null,_cfAllVals=[],_cfTemp=new Set();

function openColFilter(event,mod,field,btn){
  event.stopPropagation();
  const panel=document.getElementById('col-filter-panel');
  if(_cfBtn===btn&&panel.classList.contains('open')){closeColFilterPanel();return;}
  _cfMod=mod;_cfField=field;_cfBtn=btn;
  const recs=load(mod);
  _cfAllVals=[...new Set(recs.map(r=>String(r[field]||'')).filter(Boolean))].sort((a,b)=>{
    // sort dates descending, text ascending
    if(/^\d{4}-\d{2}-\d{2}$/.test(a)&&/^\d{4}-\d{2}-\d{2}$/.test(b))return b.localeCompare(a);
    return a.localeCompare(b,'pt-BR',{sensitivity:'base'});
  });
  const active=COL_FILTERS[mod][field];
  _cfTemp=active?new Set(active):new Set(_cfAllVals);
  document.getElementById('cfp-search').value='';
  _cfRenderList(_cfAllVals);
  _cfUpdateAll();
  const rect=btn.getBoundingClientRect();
  panel.classList.add('open');
  const left=Math.min(rect.left,window.innerWidth-258);
  panel.style.left=Math.max(4,left)+'px';
  panel.style.top=(rect.bottom+4)+'px';
}

function _cfDisplayVal(v){
  return/^\d{4}-\d{2}-\d{2}$/.test(v)?fmtDate(v):v;
}

function _cfRenderList(vals){
  const q=document.getElementById('cfp-search').value.toLowerCase();
  const shown=q?vals.filter(v=>_cfDisplayVal(v).toLowerCase().includes(q)):vals;
  document.getElementById('cfp-list').innerHTML=shown.length
    ?shown.map(v=>`<label class="cf-item"><input type="checkbox" value="${esc(v)}" ${_cfTemp.has(v)?'checked':''} onchange="cfpToggleItem(this)"><span>${esc(_cfDisplayVal(v))}</span></label>`).join('')
    :'<div style="padding:8px 6px;font-size:12px;color:var(--txt3)">Nenhum valor</div>';
}

function _cfUpdateAll(){
  const allChk=document.getElementById('cfp-all');
  const checked=_cfAllVals.filter(v=>_cfTemp.has(v)).length;
  allChk.checked=checked===_cfAllVals.length;
  allChk.indeterminate=checked>0&&checked<_cfAllVals.length;
}

function cfpSearch(){_cfRenderList(_cfAllVals);}

function cfpToggleItem(cb){
  cb.checked?_cfTemp.add(cb.value):_cfTemp.delete(cb.value);
  _cfUpdateAll();
}

function cfpToggleAll(cb){
  _cfAllVals.forEach(v=>cb.checked?_cfTemp.add(v):_cfTemp.delete(v));
  _cfRenderList(_cfAllVals);
}

function applyColFilter(){
  const allSel=_cfAllVals.every(v=>_cfTemp.has(v));
  COL_FILTERS[_cfMod][_cfField]=allSel?null:new Set(_cfTemp);
  _cfBtn&&(_cfBtn.classList.toggle('active',!allSel));
  closeColFilterPanel();
  _fSave();
  PG[_cfMod]=1;render(_cfMod);
}

function closeColFilterPanel(){
  document.getElementById('col-filter-panel').classList.remove('open');
  _cfBtn=null;
}

document.addEventListener('click',e=>{
  const p=document.getElementById('col-filter-panel');
  if(p&&p.classList.contains('open')&&!p.contains(e.target)&&e.target!==_cfBtn)closeColFilterPanel();
  const dd=document.getElementById('actions-dd');
  if(dd&&dd.style.display!=='none'&&!dd.contains(e.target))_closeActMenu();
});

/* ======================================================
   ACTIONS DROPDOWN
====================================================== */
function _closeActMenu(){document.getElementById('actions-dd').style.display='none';}
function openActMenu(e,mod,id,isChild){
  e.stopPropagation();
  const dd=document.getElementById('actions-dd');
  const vincItem=isChild
    ?`<div class="dd-item" onclick="_closeActMenu();desvincular('${mod}','${id}')">Desvincular</div>`
    :`<div class="dd-item" onclick="_closeActMenu();openVinculo('${mod}','${id}')">Vincular processo</div>`;
  const moveOpts=(MV_OPTS[mod]||[]).map(o=>`<div class="dd-item" onclick="_closeActMenu();moveItem('${mod}','${id}','${o.v}')">${o.l}</div>`).join('');
  const moveHtml=moveOpts?`<div class="dd-item has-sub">Mover para…<span style="margin-left:auto;font-size:10px;opacity:.5">▶</span><div class="dd-sub">${moveOpts}</div></div>`:'';
  dd.innerHTML=`${vincItem}
    ${moveHtml}
    <div class="dd-item" onclick="_closeActMenu();openForm('${mod}','${id}')">Editar</div>
    <div class="dd-item red" onclick="_closeActMenu();del('${mod}','${id}')">Excluir</div>`;
  const rect=e.currentTarget.getBoundingClientRect();
  const menuW=168;
  let left=rect.right-menuW;
  let top=rect.bottom+4;
  if(left<8)left=8;
  if(top+150>window.innerHeight)top=rect.top-154;
  dd.style.left=left+'px';
  dd.style.top=top+'px';
  dd.style.display='block';
}

/* ======================================================
   FILTER + PAGINATE
====================================================== */
function gv(id){const e=document.getElementById(id);return e?e.value.trim().toLowerCase():'';}

/* Encontra filhos que batem com a query, expande seus pais e retorna o Set de IDs de pais forçados */
function _expandChildMatches(mod,allData,q){
  if(!q)return new Set();
  const ms=v=>(v||'').toLowerCase().includes(q);
  const forced=new Set();
  allData.filter(r=>r.vinculoPai).forEach(child=>{
    if(ms(child.numeroProcesso)||ms(child.advogado)||ms(child.cedente)||ms(child.cessionario)||ms(child.devedor)){
      const pai=allData.find(r=>r.id===child.vinculoPai);
      if(pai){expandedByMod[mod].add(pai.id);forced.add(pai.id);}
    }
  });
  return forced;
}

function filterRecs(recs,mod,forcedIds=new Set()){
  const ms=(val,f)=>!f||(val||'').toLowerCase().includes(f);
  const procId={cessoes:'fc-proc',rpv:'fr-proc',requerimentos:'fre-proc',encerrados:'fen-proc'}[mod];
  const vProc=procId?gv(procId):'';
  return recs.filter(r=>{
    if(forcedIds.has(r.id))return true;
    if(vProc&&!(ms(r.numeroProcesso,vProc)||ms(r.advogado,vProc)||ms(r.cedente,vProc)||ms(r.cessionario,vProc)||ms(r.devedor,vProc)))return false;
    const active=COL_FILTERS[mod];
    if(active){
      for(const[field,allowed]of Object.entries(active)){
        if(!allowed)continue;
        if(!allowed.has(String(r[field]||'')))return false;
      }
    }
    return true;
  });
}

function clearF(mod){
  document.querySelectorAll(`#pane-${mod} .fb input`).forEach(i=>i.value='');
  if(COL_FILTERS[mod]){
    for(const k of Object.keys(COL_FILTERS[mod]))delete COL_FILTERS[mod][k];
    document.querySelectorAll(`#pane-${mod} .col-fbtn`).forEach(b=>b.classList.remove('active'));
  }
  const SORT_DEFAULTS={cessoes:{field:'dataAquisicao',dir:'asc'},rpv:{field:'dataLiquidacao',dir:'asc'},encerrados:{field:'dataLiquidacao',dir:'asc'},requerimentos:{field:'protocolo',dir:'asc'}};
  if(SORT_STATE[mod]){
    const def=SORT_DEFAULTS[mod];
    if(def){SORT_STATE[mod].field=def.field;SORT_STATE[mod].dir=def.dir;}
    else{SORT_STATE[mod].field=null;SORT_STATE[mod].dir=null;}
  }
  _fSave();
  PG[mod]=1;render(mod);
}

function paginate(all,mod){
  const ps=PS[mod];
  if(ps===0)return all.slice(); // sempre retorna cópia (evita mutação compartilhada)
  /* Clamp da página: se total mudou (realtime), página atual pode exceder.
     Ajusta PG[mod] para a última válida. */
  const tp=Math.max(1,Math.ceil(all.length/ps));
  if(PG[mod]>tp)PG[mod]=tp;
  return all.slice((PG[mod]-1)*ps,PG[mod]*ps);
}

function renderPgn(containerId,total,mod){
  const el=document.getElementById(containerId);
  const ps=PS[mod];
  const tp=ps===0?1:Math.max(1,Math.ceil(total/ps));
  const cur=PG[mod];
  const sizes=[10,25,50,100,0];
  const lbl={10:'10',25:'25',50:'50',100:'100',0:'Todos'};
  const psHtml=sizes.map(s=>`<button class="pgb-ps${ps===s?' on':''}" onclick="setPS('${mod}',${s})">${lbl[s]}</button>`).join('');
  el.innerHTML=
    `<div class="pgn-row pgn-top">`+
      `<span class="pgn-info">${total} registro(s)</span>`+
      `<div class="pgn-ps"><span class="pgn-ps-lbl">Itens por página:</span>${psHtml}</div>`+
    `</div>`+
    `<div class="pgn-row pgn-nav">`+
      `<button class="pgb" onclick="goP('${mod}',${cur-1})" ${cur===1?'disabled':''}>← Anterior</button>`+
      `<span class="pgn-cur">Página ${cur} de ${tp}</span>`+
      `<button class="pgb" onclick="goP('${mod}',${cur+1})" ${cur===tp?'disabled':''}>Próxima →</button>`+
    `</div>`;
}

function setPS(mod,n){PS[mod]=n;PG[mod]=1;render(mod);}

function goP(mod,p){
  let len;
  if(mod==='contatos'){len=_contatosRows.length;}
  else{
    const all=load(mod);
    /* Inclui forcedIds (matches em filhos) para casar com o cálculo de render */
    const procId={cessoes:'fc-proc',rpv:'fr-proc',requerimentos:'fre-proc',encerrados:'fen-proc'}[mod];
    const q=procId?gv(procId):'';
    const forced=q?_expandChildMatches(mod,all,q):new Set();
    len=filterRecs(all.filter(r=>!r.vinculoPai),mod,forced).length;
  }
  const ps=PS[mod];
  const tp=ps===0?1:Math.ceil(len/ps)||1;
  PG[mod]=Math.max(1,Math.min(p,tp));
  render(mod);
}

/* ======================================================
   RENDER DISPATCH
====================================================== */
function syncSortUI(mod){
  const s=SORT_STATE[mod];
  if(!s)return;
  document.querySelectorAll(`#pane-${mod} .col-sbtn`).forEach(b=>{
    const f=b.getAttribute('data-field');
    if(f===s.field){b.textContent=s.dir==='asc'?'↑':'↓';b.classList.add('active');}
    else{b.textContent='↕';b.classList.remove('active');}
  });
}

function syncFilterBtnsUI(mod){
  const active=COL_FILTERS[mod]||{};
  document.querySelectorAll(`#pane-${mod} .col-fbtn`).forEach(b=>{
    const f=b.getAttribute('data-field');
    b.classList.toggle('active',!!(f&&active[f]));
  });
}

/* ======================================================
   PERSISTÊNCIA DE FILTROS POR USUÁRIO/BROWSER
   Filtros padrão (JS) → todos os usuários
   Filtros aplicados → apenas este browser (localStorage)
====================================================== */
const _F_LS_KEY='cj-user-filters';

function _fSave(){
  try{
    const cf={};
    for(const[mod,fields]of Object.entries(COL_FILTERS)){
      cf[mod]={};
      for(const[field,set]of Object.entries(fields)){
        if(set instanceof Set)cf[mod][field]=[...set];
      }
    }
    const ss={};
    for(const[mod,state]of Object.entries(SORT_STATE)){
      ss[mod]={field:state.field||null,dir:state.dir||null};
    }
    _lsSet(_F_LS_KEY,JSON.stringify({
      colFilters:cf,sortState:ss,
      consSortCol:_consSortCol,consSortDir:_consSortDir
    }));
  }catch(e){console.error('[Credijuris] filter save error',e);}
}

function _fLoad(){
  try{
    const raw=_lsGet(_F_LS_KEY);
    if(!raw)return;
    const data=JSON.parse(raw);
    if(data.colFilters){
      for(const[mod,fields]of Object.entries(data.colFilters)){
        if(!COL_FILTERS[mod])continue;
        for(const[field,arr]of Object.entries(fields)){
          if(Array.isArray(arr)&&arr.length){
            /* Filtra valores não-string (null/undefined) que poderiam corromper o filtro */
            const clean=arr.filter(v=>typeof v==='string');
            if(clean.length)COL_FILTERS[mod][field]=new Set(clean);
          }
        }
      }
    }
    if(data.sortState){
      for(const[mod,state]of Object.entries(data.sortState)){
        if(SORT_STATE[mod]&&state&&state.field){
          SORT_STATE[mod].field=state.field;
          SORT_STATE[mod].dir=state.dir||'asc';
        }
      }
    }
    if(data.consSortCol)_consSortCol=data.consSortCol;
    if(typeof data.consSortDir==='number')_consSortDir=data.consSortDir;
  }catch(e){console.error('[Credijuris] filter load error',e);}
}

function render(mod){
  if(mod==='dashboard'){updateDash();return;}
  ({cessoes:renderCessoes,rpv:renderRPV,
    requerimentos:renderReq,encerrados:renderEnc,
    contatos:renderContatos})[mod]?.();
  syncSortUI(mod);
  syncFilterBtnsUI(mod);
}

/* ======================================================
   RENDER CESSÕES
====================================================== */
function cessoesRow(r,allData,isChild){
  const childIds=r.vinculosFilhos||[];
  const childRecs=isChild?[]:childIds.map(cid=>allData.find(c=>c.id===cid)).filter(Boolean);
  const isExpanded=expandedByMod.cessoes.has(r.id);
  const procCell=esc(r.numeroProcesso)+cpyBtn(r.numeroProcesso||'');
  const expandBtn=!isChild&&childRecs.length>0?`<button class="btn-expand" onclick="toggleExpand('cessoes','${r.id}')" title="${childRecs.length} vínculo(s)"><span style="display:inline-block;transition:transform .2s;transform:${isExpanded?'rotate(90deg)':'rotate(0deg)'}">›</span></button>`:'';
  const actsBtns=`<button class="btn-dots" onclick="openActMenu(event,'cessoes','${r.id}',${isChild})" title="Ações">⋯</button>${expandBtn}`;
  const trCls=(isChild?rowCls(r)+' child-row':rowCls(r))+(highlightIds.has(r.id)?' row-highlight':'');
  let html=`<tr class="${trCls}">
    <td><div class="acts">${actsBtns}</div></td>
    <td>${procCell}</td>
    <td class="td-icon"><button class="btn btn-blue btn-xs" onclick="openHist('cessoes','${r.id}')"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><line x1="3.5" y1="4" x2="7.5" y2="4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3.5" y1="6" x2="6.5" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></td>
    <td>${calcUltimaMovimentacao(r)}</td>
    <td class="td-icon">${contatoBadge('cessoes',r)}</td>
    <td>${instrBadge(r.instrumento)}</td>
    <td class="td-icon">${cartorioBadge(r)}</td>
    <td>${fatalCell('cessoes',r.id,r.prazoFatal)}</td>
    <td>${fmtDate(r.dataAquisicao)}</td>
    <td>${fmtDate(r.expectativaLiquidacao)}</td>
    <td>${liquidacaoDiff(r.expectativaLiquidacao)}</td>
    <td class="wrap" style="min-width:120px" title="${esc(r.objeto||'')}">${objetoHtml(r.objeto)}</td>
    <td title="${esc(r.advogado||'')}">${esc(r.advogado)||'—'}</td>
    <td title="${esc(r.cedente||'')}">${esc(r.cedente)||'—'}</td>
    <td title="${esc(r.cessionario||'')}">${esc(r.cessionario)||'—'}</td>
    <td title="${esc(r.devedor||'')}">${esc(r.devedor)||'—'}</td>
    <td>${esc(r.tribunal)||'—'}</td>
    <td title="${esc(r.orgaoJulgador||'')}">${esc(r.orgaoJulgador)||'—'}</td>
  </tr>`;
  if(!isChild&&childRecs.length>0&&isExpanded){
    html+=childRecs.map(c=>cessoesRow(c,allData,true)).join('');
  }
  return html;
}

function renderCessoes(){
  const allData=load('cessoes');
  const forced=_expandChildMatches('cessoes',allData,gv('fc-proc'));
  const sorted=sortRecs(filterRecs(allData.filter(r=>!r.vinculoPai),'cessoes',forced),'cessoes');
  const rows=paginate(sorted,'cessoes');
  const tb=document.getElementById('tb-cessoes');
  if(!sorted.length){
    tb.innerHTML=`<tr><td colspan="18"><div class="empty"><div class="empty-ico">📋</div><div class="empty-txt">Nenhuma cessão ativa</div></div></td></tr>`;
  } else {
    tb.innerHTML=rows.map(r=>cessoesRow(r,allData,false)).join('');
  }
  renderPgn('pg-cessoes',sorted.length,'cessoes');
}

/* ======================================================
   RENDER RPV
====================================================== */
function rpvRow(r,allData,isChild){
  const childIds=r.vinculosFilhos||[];
  const childRecs=isChild?[]:childIds.map(cid=>allData.find(c=>c.id===cid)).filter(Boolean);
  const isExpanded=expandedByMod.rpv.has(r.id);
  const procCell=esc(r.numeroProcesso)+cpyBtn(r.numeroProcesso||'');
  const expandBtn=!isChild&&childRecs.length>0?`<button class="btn-expand" onclick="toggleExpand('rpv','${r.id}')" title="${childRecs.length} vínculo(s)"><span style="display:inline-block;transition:transform .2s;transform:${isExpanded?'rotate(90deg)':'rotate(0deg)'}">›</span></button>`:'';
  const actsBtns=`<button class="btn-dots" onclick="openActMenu(event,'rpv','${r.id}',${isChild})" title="Ações">⋯</button>${expandBtn}`;
  const trCls=(isChild?rowCls(r)+' child-row':rowCls(r))+(highlightIds.has(r.id)?' row-highlight':'');
  let html=`<tr class="${trCls}">
    <td><div class="acts">${actsBtns}</div></td>
    <td>${procCell}</td>
    <td class="td-icon"><button class="btn btn-blue btn-xs" onclick="openHist('rpv','${r.id}')"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><line x1="3.5" y1="4" x2="7.5" y2="4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3.5" y1="6" x2="6.5" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></td>
    <td>${calcUltimaMovimentacao(r)}</td>
    <td class="td-icon">${contatoBadge('rpv',r)}</td>
    <td>${fatalCell('rpv',r.id,r.prazoFatal)}</td>
    <td>${fmtDate(r.dataAquisicao)}</td>
    <td>${fmtDate(r.dataLiquidacao)}</td>
    <td>${between(r.dataAquisicao,r.dataLiquidacao)}</td>
    <td class="wrap" style="min-width:120px" title="${esc(r.objeto||'')}">${objetoHtml(r.objeto)}</td>
    <td title="${esc(r.advogado||'')}">${esc(r.advogado)||'—'}</td>
    <td title="${esc(r.cedente||'')}">${esc(r.cedente)||'—'}</td>
    <td title="${esc(r.cessionario||'')}">${esc(r.cessionario)||'—'}</td>
    <td title="${esc(r.devedor||'')}">${esc(r.devedor)||'—'}</td>
    <td>${esc(r.tribunal)||'—'}</td>
    <td title="${esc(r.orgaoJulgador||'')}">${esc(r.orgaoJulgador)||'—'}</td>
  </tr>`;
  if(!isChild&&childRecs.length>0&&isExpanded){
    html+=childRecs.map(c=>rpvRow(c,allData,true)).join('');
  }
  return html;
}

function renderRPV(){
  const allData=load('rpv');
  const forced=_expandChildMatches('rpv',allData,gv('fr-proc'));
  const sorted=sortRecs(filterRecs(allData.filter(r=>!r.vinculoPai),'rpv',forced),'rpv');
  const rows=paginate(sorted,'rpv');
  const tb=document.getElementById('tb-rpv');
  if(!sorted.length){
    tb.innerHTML=`<tr><td colspan="16"><div class="empty"><div class="empty-ico">📄</div><div class="empty-txt">Nenhum RPV complementar</div></div></td></tr>`;
  } else {
    tb.innerHTML=rows.map(r=>rpvRow(r,allData,false)).join('');
  }
  renderPgn('pg-rpv',sorted.length,'rpv');
}


/* ======================================================
   DILIGÊNCIAS DE CARTÓRIO (embutidas em cessões)
====================================================== */
function cartorioBadge(r){
  const dils=r.diligencias||[];
  if(!dils.length)return`<button class="btn btn-blue btn-xs" style="opacity:.4" onclick="openCartorio('${r.id}')" title="Sem diligências"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><line x1="1.5" y1="9.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="3.5" x2="9.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="1.5" x2="1.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="1.5" x2="9.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3" y1="3.5" x2="3" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="3.5" x2="5.5" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="3.5" x2="8" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`;
  const allResolved=dils.every(d=>d.resolvido);
  const col=allResolved?'var(--grn2)':'#f59e0b';
  return`<button class="btn btn-blue btn-xs" style="border-color:${col};color:${col}" onclick="openCartorio('${r.id}')" title="${dils.length} diligência(s)"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><line x1="1.5" y1="9.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="1.5" y1="3.5" x2="9.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="1.5" x2="1.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="1.5" x2="9.5" y2="3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3" y1="3.5" x2="3" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="5.5" y1="3.5" x2="5.5" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="8" y1="3.5" x2="8" y2="9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg> ${dils.length}</button>`;
}

let curCartorioCessaoId=null,curDilId=null;

function openCartorio(cessaoId){
  curCartorioCessaoId=cessaoId;
  curDilId=null;
  const cess=load('cessoes').find(r=>r.id===cessaoId)
    ||load('rpv').find(r=>r.id===cessaoId)
    ||load('requerimentos').find(r=>r.id===cessaoId);
  if(!cess)return;
  document.getElementById('cart-proc').textContent=cess.numeroProcesso||'';
  renderCartorioBody(cessaoId,null);
  openModal('cart-ov');
}

function renderCartorioBody(cessaoId,editId){
  const cessoes=load('cessoes');
  const cess=cessoes.find(r=>r.id===cessaoId)
    ||load('rpv').find(r=>r.id===cessaoId)
    ||load('requerimentos').find(r=>r.id===cessaoId);
  if(!cess){document.getElementById('cart-body').innerHTML='<div style="color:var(--txt3);padding:20px;text-align:center">Cessão não encontrada.</div>';return;}
  const dils=cess.diligencias||[];
  const statOpts=['Em andamento','Aguardando orçamento','Aguardando pagamento','Protocolado','Concluído','Cancelado'];
  const editDil=editId?dils.find(d=>d.id===editId)||{}:{};

  let html='';
  if(dils.length){
    html+=dils.map(d=>`
      <div style="background:var(--bg2);border:1px solid var(--brd);border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;gap:10px;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
            ${d.objeto?`<span class="bdg bdg-gray">${esc(d.objeto)}</span>`:''}
            ${instrBadge(d.instrumento)}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 14px;font-size:12px">
            ${d.protocoloRTDPJ?`<div><span style="color:var(--txt3)">Protocolo RTDPJ: </span><span style="color:var(--txt)">${esc(d.protocoloRTDPJ)}</span></div>`:''}
            ${d.orcamento?`<div><span style="color:var(--txt3)">Orçamento: </span><span style="color:var(--txt)">${fmtBRL(d.orcamento)}</span></div>`:''}
            ${d.status?`<div><span style="color:var(--txt3)">Status: </span><span style="color:var(--txt)">${esc(d.status)}</span></div>`:''}
            <div><span style="color:var(--txt3)">Pago: </span>${d.pago?'<span style="color:var(--grn2)">Sim</span>':'<span style="color:var(--ylw2)">Não</span>'}</div>
            <div><span style="color:var(--txt3)">Resolvido: </span>${d.resolvido?'<span style="color:var(--grn2)">Sim</span>':'<span style="color:var(--red2)">Não</span>'}</div>
          </div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button class="btn btn-blue btn-xs" onclick="editDiligencia('${cessaoId}','${d.id}')" title="Editar">✏️</button>
          <button class="btn btn-red btn-xs" onclick="delDiligencia('${cessaoId}','${d.id}')" title="Excluir">🗑</button>
        </div>
      </div>`).join('');
  } else {
    html+=`<div style="text-align:center;color:var(--txt3);font-size:13px;padding:18px 0 14px">Nenhuma diligência cadastrada.</div>`;
  }

  const isEdit=!!editId;
  html+=`
    <div id="dil-add-form" style="background:var(--bg0);border:1px dashed var(--brd);border-radius:8px;padding:14px;margin-top:4px">
      <div style="font-size:11px;font-weight:700;color:${isEdit?'var(--gold)':'var(--txt3)'};text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">
        ${isEdit?'✏️ Editar Diligência':'+ Adicionar Diligência'}
      </div>
      <div class="fgrid">
        ${fg('Objeto',fi('dil-objeto',editDil.objeto||'','text','Objeto'))}
        ${fg('Instrumento',fi('dil-instrumento',editDil.instrumento||'','text','Tipo de instrumento'))}
        ${fg('Protocolo RTDPJ',fi('dil-protocoloRTDPJ',editDil.protocoloRTDPJ||'','text','Número do protocolo'))}
        ${fg('Orçamento (R$)',fi('dil-orcamento',editDil.orcamento||'','number','0,00'))}
        ${fg('Status',fsel('dil-status',editDil.status||'',statOpts))}
        ${fg('Pago',fck('dil-pago',!!editDil.pago,'Sim'))}
        ${fg('Resolvido',fck('dil-resolvido',!!editDil.resolvido,'Sim'))}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
        ${isEdit?`<button class="btn btn-blue btn-sm" onclick="cancelEditDiligencia('${escJs(cessaoId)}')">Cancelar</button>`:''}
        <button class="btn btn-gold btn-sm" onclick="saveDiligencia('${escJs(cessaoId)}')">${isEdit?'Atualizar':'Salvar Diligência'}</button>
      </div>
    </div>`;

  document.getElementById('cart-body').innerHTML=html;
  if(isEdit){
    const form=document.getElementById('dil-add-form');
    if(form)setTimeout(()=>form.scrollIntoView({behavior:'smooth',block:'nearest'}),50);
  }
}

/* Localiza módulo+índice de uma cessão por id em qualquer aba relevante.
   Retorna {mod, data, idx, rec} ou null. */
function _findRecCrossMod(id){
  for(const mod of ['cessoes','rpv','requerimentos','encerrados']){
    const data=load(mod);
    const idx=data.findIndex(r=>r.id===id);
    if(idx!==-1)return{mod,data,idx,rec:data[idx]};
  }
  return null;
}

function saveDiligencia(cessaoId){
  const found=_findRecCrossMod(cessaoId);
  if(!found){showToast('Registro não encontrado.');return;}
  const{mod,data,idx,rec:cess}=found;
  const _objetoVal=(document.getElementById('f-dil-objeto')?.value||'').trim();
  if(!_objetoVal){alert('Preencha o campo Objeto.');return;}
  const dil={
    id:curDilId||uid(),
    objeto:_objetoVal,
    instrumento:document.getElementById('f-dil-instrumento')?.value.trim()||'',
    protocoloRTDPJ:document.getElementById('f-dil-protocoloRTDPJ')?.value.trim()||'',
    orcamento:parseFloat(document.getElementById('f-dil-orcamento')?.value||0)||0,
    status:document.getElementById('f-dil-status')?.value||'',
    pago:document.getElementById('f-dil-pago')?.checked||false,
    resolvido:document.getElementById('f-dil-resolvido')?.checked||false,
    updatedAt:new Date().toISOString(),
  };
  /* Imutável: clona registro, atualiza diligencias array e substitui slot.
     Evita mutar referências do CACHE diretamente. */
  const dils=Array.isArray(cess.diligencias)?cess.diligencias.slice():[];
  if(curDilId){
    const dilIdx=dils.findIndex(d=>d.id===curDilId);
    if(dilIdx!==-1)dils[dilIdx]=dil; else dils.push(dil);
  } else {
    dil.createdAt=dil.updatedAt;
    dils.push(dil);
  }
  data[idx]={...cess,diligencias:dils};
  curDilId=null;
  save(mod,data);
  renderCartorioBody(cessaoId,null);
  render(mod);
}

function delDiligencia(cessaoId,dilId){
  if(!confirm('Confirma a exclusão desta diligência?'))return;
  const found=_findRecCrossMod(cessaoId);
  if(!found)return;
  const{mod,data,idx,rec:cess}=found;
  if(!cess.diligencias)return;
  data[idx]={...cess,diligencias:cess.diligencias.filter(d=>d.id!==dilId)};
  save(mod,data);
  renderCartorioBody(cessaoId,null);
  render(mod);
}

function editDiligencia(cessaoId,dilId){
  curDilId=dilId;
  renderCartorioBody(cessaoId,dilId);
}

function cancelEditDiligencia(cessaoId){
  curDilId=null;
  renderCartorioBody(cessaoId,null);
}

/* ======================================================
   RENDER REQUERIMENTOS
====================================================== */
function reqRow(r,allData,isChild){
  const childIds=r.vinculosFilhos||[];
  const childRecs=isChild?[]:childIds.map(cid=>allData.find(c=>c.id===cid)).filter(Boolean);
  const isExpanded=expandedByMod.requerimentos.has(r.id);
  const procCell=esc(r.numeroProcesso)+cpyBtn(r.numeroProcesso||'');
  const expandBtn=!isChild&&childRecs.length>0?`<button class="btn-expand" onclick="toggleExpand('requerimentos','${r.id}')" title="${childRecs.length} vínculo(s)"><span style="display:inline-block;transition:transform .2s;transform:${isExpanded?'rotate(90deg)':'rotate(0deg)'}">›</span></button>`:'';
  const actsBtns=`<button class="btn-dots" onclick="openActMenu(event,'requerimentos','${r.id}',${isChild})" title="Ações">⋯</button>${expandBtn}`;
  const trCls=(isChild?rowCls(r)+' child-row':rowCls(r))+(highlightIds.has(r.id)?' row-highlight':'');
  let html=`<tr class="${trCls}">
    <td><div class="acts">${actsBtns}</div></td>
    <td>${procCell}</td>
    <td class="td-icon"><button class="btn btn-blue btn-xs" onclick="openHist('requerimentos','${r.id}')"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><line x1="3.5" y1="4" x2="7.5" y2="4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3.5" y1="6" x2="6.5" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button></td>
    <td class="wrap">${calcUltimaMovimentacao(r)}</td>
    <td class="td-icon">${contatoBadge('requerimentos',r)}</td>
    <td>${fatalCell('requerimentos',r.id,r.prazoFatal)}</td>
    <td>${fmtDate(r.protocolo)}</td>
    <td class="td-icon"><button class="btn btn-blue btn-xs" onclick="openSenha('${r.id}')" title="Ver senha" style="opacity:${r.senhaAcesso?1:.35}"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="2" y="5" width="7" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 5V3.5a2 2 0 014 0V5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="5.5" cy="7.5" r=".8" fill="currentColor"/></svg></button></td>
    <td title="${esc(r.natureza||'')}">${esc(r.natureza)||'—'}</td>
    <td title="${esc(r.materia||'')}">${esc(r.materia)||'—'}</td>
    <td>${esc(r.tribunal)||'—'}</td>
    <td title="${esc(r.orgaoJulgador||'')}">${esc(r.orgaoJulgador)||'—'}</td>
  </tr>`;
  if(!isChild&&childRecs.length>0&&isExpanded){
    html+=childRecs.map(c=>reqRow(c,allData,true)).join('');
  }
  return html;
}

function renderReq(){
  const allData=load('requerimentos');
  const forced=_expandChildMatches('requerimentos',allData,gv('fre-proc'));
  const sorted=sortRecs(filterRecs(allData.filter(r=>!r.vinculoPai),'requerimentos',forced),'requerimentos');
  const rows=paginate(sorted,'requerimentos');
  const tb=document.getElementById('tb-requerimentos');
  if(!sorted.length){
    tb.innerHTML=`<tr><td colspan="12"><div class="empty"><div class="empty-ico">📝</div><div class="empty-txt">Nenhum registro em Diversos</div></div></td></tr>`;
  } else {
    tb.innerHTML=rows.map(r=>reqRow(r,allData,false)).join('');
  }
  renderPgn('pg-requerimentos',sorted.length,'requerimentos');
}

/* ======================================================
   RENDER ENCERRADOS
====================================================== */
function encRow(r,allData,isChild){
  const childIds=r.vinculosFilhos||[];
  const childRecs=isChild?[]:childIds.map(cid=>allData.find(c=>c.id===cid)).filter(Boolean);
  const isExpanded=expandedByMod.encerrados.has(r.id);
  const procCell=esc(r.numeroProcesso)+cpyBtn(r.numeroProcesso||'');
  const expandBtn=!isChild&&childRecs.length>0?`<button class="btn-expand" onclick="toggleExpand('encerrados','${r.id}')" title="${childRecs.length} vínculo(s)"><span style="display:inline-block;transition:transform .2s;transform:${isExpanded?'rotate(90deg)':'rotate(0deg)'}">›</span></button>`:'';
  const actsBtns=`<button class="btn-dots" onclick="openActMenu(event,'encerrados','${r.id}',${isChild})" title="Ações">⋯</button>${expandBtn}`;
  // Encerrados não aplica rowCls (prazoFatal não é exibido/editável nessa aba)
  const trCls=(isChild?'child-row':'')+(highlightIds.has(r.id)?' row-highlight':'');
  let html=`<tr class="${trCls}">
    <td><div class="acts">${actsBtns}</div></td>
    <td>${procCell}</td>
    <td>${fmtDate(r.dataAquisicao)}</td>
    <td>${fmtDate(r.dataLiquidacao)}</td>
    <td>${between(r.dataAquisicao,r.dataLiquidacao)}</td>
    <td class="wrap" style="min-width:120px" title="${esc(r.objeto||'')}">${objetoHtml(r.objeto)}</td>
    <td title="${esc(r.advogado||'')}">${esc(r.advogado)||'—'}</td>
    <td title="${esc(r.cedente||'')}">${esc(r.cedente)||'—'}</td>
    <td title="${esc(r.cessionario||'')}">${esc(r.cessionario)||'—'}</td>
    <td title="${esc(r.devedor||'')}">${esc(r.devedor)||'—'}</td>
    <td class="td-icon">${r.motivo?`<button class="btn btn-blue btn-xs" onclick="openMotivo('${r.id}')" title="Ver motivo"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2.5 1.5h4l2 2v6a.5.5 0 01-.5.5h-5.5a.5.5 0 01-.5-.5v-7.5a.5.5 0 01.5-.5z" stroke="currentColor" stroke-width="1.3"/><line x1="3.5" y1="5.5" x2="7.5" y2="5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><line x1="3.5" y1="7.5" x2="6.5" y2="7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`:'—'}</td>
  </tr>`;
  if(!isChild&&childRecs.length>0&&isExpanded){
    html+=childRecs.map(c=>encRow(c,allData,true)).join('');
  }
  return html;
}

function renderEnc(){
  const allData=load('encerrados');
  const forced=_expandChildMatches('encerrados',allData,gv('fen-proc'));
  const sorted=sortRecs(filterRecs(allData.filter(r=>!r.vinculoPai),'encerrados',forced),'encerrados');
  const rows=paginate(sorted,'encerrados');
  const tb=document.getElementById('tb-encerrados');
  if(!sorted.length){
    tb.innerHTML=`<tr><td colspan="11"><div class="empty"><div class="empty-ico">✅</div><div class="empty-txt">Nenhum processo encerrado</div></div></td></tr>`;
  } else {
    tb.innerHTML=rows.map(r=>encRow(r,allData,false)).join('');
  }
  renderPgn('pg-encerrados',sorted.length,'encerrados');
}

/* ======================================================
   MODAL HELPERS
====================================================== */
function openModal(id){document.getElementById(id).classList.add('on');}
function closeModal(id){document.getElementById(id).classList.remove('on');}
function ovClick(e,id){if(e.target===document.getElementById(id))closeModal(id);}

let dashUrgencyType='prazos';
function selectUrgency(tipo){
  const map={
    prazos:      {srcId:'ds-alerts-body', title:'Prazos Fatais',                 cntId:'urg-count-prazos'},
    liquidacao:  {srcId:'ds-liq-body',    title:'Liquidação Próxima ou Vencida', cntId:'urg-count-liq'},
    paralisados: {srcId:'ds-par-body',    title:'Paralisados',                   cntId:'urg-count-par'},
  };
  const cfg=map[tipo]; if(!cfg)return;
  dashUrgencyType=tipo;
  const src=document.getElementById(cfg.srcId);
  const body=document.getElementById('dash-urgency-body');
  if(!src||!body)return;
  const cnt=(document.getElementById(cfg.cntId)?.textContent||'').trim();
  const titleEl=document.getElementById('urg-current-title');
  const cntEl=document.getElementById('urg-current-count');
  if(titleEl)titleEl.textContent=cfg.title;
  if(cntEl)cntEl.textContent=(cnt&&cnt!=='0')?cnt:'';
  body.innerHTML='';
  const clone=src.cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.add('dash-side-list');
  clone.style.cssText='';
  body.appendChild(clone);
  document.querySelectorAll('.urg-dd-item').forEach(el=>el.classList.toggle('on',el.dataset.urgency===tipo));
  // Rodapé fixo: legenda do tipo 'liquidacao' (cessionário c/ 2+ processos)
  const footer=document.getElementById('urg-footer');
  if(footer){
    if(tipo==='liquidacao'){
      footer.innerHTML='<span class="prio-badge" style="font-size:9px;padding:1px 6px">Prioritário</span><span>cessionário c/ 2+ processos sem recebimento</span>';
      footer.hidden=false;
    } else {
      footer.hidden=true;
    }
  }
  closeUrgDD();
}

/* Dropdown de Urgências */
function toggleUrgDD(e){
  e&&e.stopPropagation();
  const menu=document.getElementById('urg-dd-menu');
  if(!menu)return;
  if(menu.hidden) openUrgDD(); else closeUrgDD();
}
function openUrgDD(){
  const btn=document.getElementById('urg-dd-btn');
  const menu=document.getElementById('urg-dd-menu');
  if(menu) menu.hidden=false;
  if(btn) btn.setAttribute('aria-expanded','true');
}
function closeUrgDD(){
  const btn=document.getElementById('urg-dd-btn');
  const menu=document.getElementById('urg-dd-menu');
  if(menu) menu.hidden=true;
  if(btn) btn.setAttribute('aria-expanded','false');
}
document.addEventListener('click',e=>{
  const menu=document.getElementById('urg-dd-menu');
  if(!menu||menu.hidden) return;
  const btn=document.getElementById('urg-dd-btn');
  if(menu.contains(e.target)||(btn&&btn.contains(e.target))) return;
  closeUrgDD();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape') closeUrgDD();
});

// Compatibilidade: chamadas antigas a openDashPanel ainda funcionam como seleção.
function openDashPanel(tipo){ selectUrgency(tipo); }

/* ======================================================
   COLUNA DE ATIVIDADE — dropdown e Publicações DJEN
====================================================== */
let dashActivityType='publicacoes';
let _pubsCache={data:null,ts:0};
const _PUB_CACHE_MS=15*60*1000;
const _DJEN_OABS=[
  {numeroOab:'230939',ufOab:'MG'},
  {numeroOab:'76236', ufOab:'GO'},
  {numeroOab:'168902',ufOab:'MG'},
  {numeroOab:'215051',ufOab:'MG'}
];

function selectActivity(tipo){
  if(tipo!=='movimentacoes'&&tipo!=='publicacoes')return;
  dashActivityType=tipo;
  const mb=document.getElementById('ds-mov-body');
  const pb=document.getElementById('ds-pub-body');
  const titleEl=document.getElementById('act-current-title');
  const cntEl=document.getElementById('act-current-count');
  document.querySelectorAll('.urg-dd-item[data-activity]').forEach(el=>{
    el.classList.toggle('on',el.dataset.activity===tipo);
  });
  if(tipo==='movimentacoes'){
    if(mb)mb.hidden=false;
    if(pb)pb.hidden=true;
    if(titleEl)titleEl.textContent='Últimas Movimentações';
    const cnt=(document.getElementById('act-count-mov')?.textContent||'').trim();
    if(cntEl)cntEl.textContent=(cnt&&cnt!=='0')?cnt:'';
  } else {
    if(mb)mb.hidden=true;
    if(pb)pb.hidden=false;
    if(titleEl)titleEl.textContent='Publicações';
    const cnt=(document.getElementById('act-count-pub')?.textContent||'').trim();
    if(cntEl)cntEl.textContent=(cnt&&cnt!=='0')?cnt:'';
    _renderPubs();
  }
  closeActDD();
}

function toggleActDD(e){
  e&&e.stopPropagation();
  const menu=document.getElementById('act-dd-menu');
  if(!menu)return;
  if(menu.hidden) openActDD(); else closeActDD();
}
function openActDD(){
  const btn=document.getElementById('act-dd-btn');
  const menu=document.getElementById('act-dd-menu');
  if(menu) menu.hidden=false;
  if(btn) btn.setAttribute('aria-expanded','true');
}
function closeActDD(){
  const btn=document.getElementById('act-dd-btn');
  const menu=document.getElementById('act-dd-menu');
  if(menu) menu.hidden=true;
  if(btn) btn.setAttribute('aria-expanded','false');
}
document.addEventListener('click',e=>{
  const menu=document.getElementById('act-dd-menu');
  if(!menu||menu.hidden) return;
  const btn=document.getElementById('act-dd-btn');
  if(menu.contains(e.target)||(btn&&btn.contains(e.target))) return;
  closeActDD();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape') closeActDD();
});

/* ======================================================
   ACOMPANHAMENTO PROCESSUAL — dropdown de sub-aba
====================================================== */
// Wrapper para o botao "+ Adicionar" no header de Acompanhamento — abre o form do subTab atual
function openCurrentSubForm(){ openForm(subTab); }

function selectSubpane(mod,opts){
  if(!_SUB_TABS.includes(mod))return;
  subTab=mod;
  localStorage.setItem('cj-sub-tab',mod);
  // Alterna visibilidade dos sub-panes
  _SUB_TABS.forEach(m=>{
    const el=document.getElementById('pane-'+m);
    if(el)el.classList.toggle('on',m===mod);
  });
  // Atualiza estado do dropdown
  document.querySelectorAll('.urg-dd-item[data-subtab]').forEach(el=>{
    el.classList.toggle('on',el.dataset.subtab===mod);
  });
  const titleEl=document.getElementById('sub-current-title');
  if(titleEl)titleEl.textContent=_SUB_LABELS[mod];
  closeSubDD();
  // Renderiza apenas se topTab==='acompanhamento' (não tem efeito visual se outro top tab ativo,
  // mas o render é necessário pra ter dados prontos quando o usuário voltar).
  if(!opts||!opts.skipRender){
    render(mod);
  }
}

function toggleSubDD(e){
  e&&e.stopPropagation();
  const menu=document.getElementById('sub-dd-menu');
  if(!menu)return;
  if(menu.hidden) openSubDD(); else closeSubDD();
}
function openSubDD(){
  const btn=document.getElementById('sub-dd-btn');
  const menu=document.getElementById('sub-dd-menu');
  if(menu) menu.hidden=false;
  if(btn) btn.setAttribute('aria-expanded','true');
}
function closeSubDD(){
  const btn=document.getElementById('sub-dd-btn');
  const menu=document.getElementById('sub-dd-menu');
  if(menu) menu.hidden=true;
  if(btn) btn.setAttribute('aria-expanded','false');
}
document.addEventListener('click',e=>{
  const menu=document.getElementById('sub-dd-menu');
  if(!menu||menu.hidden) return;
  const btn=document.getElementById('sub-dd-btn');
  if(menu.contains(e.target)||(btn&&btn.contains(e.target))) return;
  closeSubDD();
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape') closeSubDD();
});

function _normProcNum(s){return String(s||'').replace(/\D/g,'');}

// Decodifica entidades HTML (&eacute; -> é, &sect; -> §, etc.) usando o parser
// nativo do navegador via <textarea> — RCDATA decodifica entidades mas não
// interpreta tags, então é seguro contra XSS.
function _decodeHtmlEntities(s){
  if(!s)return'';
  const ta=document.createElement('textarea');
  ta.innerHTML=String(s);
  return ta.value;
}

// Title-case PT-BR mantendo partículas minúsculas (da, de, do, etc.).
function _toTitleCase(s){
  if(!s)return'';
  const particulas=new Set(['da','de','do','das','dos','e','à','ao','aos','di','du','del']);
  return _decodeHtmlEntities(String(s)).toLowerCase().split(/(\s+)/).map((w,i)=>{
    if(!w.trim())return w;
    if(i>0&&particulas.has(w))return w;
    return w.charAt(0).toUpperCase()+w.slice(1);
  }).join('');
}

function _djenDateRange(){
  const fim=todayStr();
  const past=new Date(); past.setHours(0,0,0,0); past.setDate(past.getDate()-30);
  const inicio=past.getFullYear()+'-'+String(past.getMonth()+1).padStart(2,'0')+'-'+String(past.getDate()).padStart(2,'0');
  return {inicio,fim};
}

async function _fetchDJEN(numeroOab,ufOab,inicio,fim){
  const params=new URLSearchParams({
    numeroOab,ufOab,
    dataDisponibilizacaoInicio:inicio,
    dataDisponibilizacaoFim:fim,
    itensPorPagina:'100',
    pagina:'1'
  });
  const url='https://comunicaapi.pje.jus.br/api/v1/comunicacao?'+params.toString();
  const doFetch=()=>fetch(url,{method:'GET',headers:{'Accept':'application/json'}});
  let resp;
  try{ resp=await doFetch(); } catch(_){ throw new Error('network'); }
  if(resp.status===429){
    await new Promise(r=>setTimeout(r,60000));
    try{ resp=await doFetch(); } catch(_){ throw new Error('network'); }
  }
  if(!resp.ok) throw new Error('http:'+resp.status);
  const j=await resp.json().catch(()=>({}));
  return Array.isArray(j.items)?j.items:[];
}

async function _fetchAllPubs(){
  const {inicio,fim}=_djenDateRange();
  const all=[];
  for(const {numeroOab,ufOab} of _DJEN_OABS){
    const items=await _fetchDJEN(numeroOab,ufOab,inicio,fim);
    all.push(...items);
  }
  const seen=new Set();
  const uniq=[];
  for(const it of all){
    const id=it&&it.id;
    if(id==null){ uniq.push(it); continue; }
    if(seen.has(id)) continue;
    seen.add(id);
    uniq.push(it);
  }
  return uniq;
}

function _processosCadastrados(){
  const ce=load('cessoes'),rp=load('rpv'),re=load('requerimentos');
  const m=new Map();
  [['cessoes',ce,'Cessões Ativas','bdg-blue'],
   ['rpv',rp,'RPV Complementar','bdg-grn'],
   ['requerimentos',re,'Diversos','bdg-ylw']].forEach(([mod,recs,label,bdg])=>{
    recs.forEach(r=>{
      const n=_normProcNum(r.numeroProcesso);
      if(!n)return;
      if(!m.has(n))m.set(n,{mod,r,label,bdg});
    });
  });
  return m;
}

async function _renderPubs(){
  const pb=document.getElementById('ds-pub-body');
  const cntDD=document.getElementById('act-count-pub');
  const cntCurEl=document.getElementById('act-current-count');
  if(!pb)return;

  const now=Date.now();
  let items;
  if(_pubsCache.data&&(now-_pubsCache.ts<_PUB_CACHE_MS)){
    items=_pubsCache.data;
  } else {
    pb.innerHTML='<div class="pub-loading"><span class="pub-spinner"></span>Buscando publicações no DJEN…</div>';
    if(cntDD)cntDD.textContent='';
    if(cntCurEl&&dashActivityType==='publicacoes')cntCurEl.textContent='';
    try{
      items=await _fetchAllPubs();
      _pubsCache={data:items,ts:Date.now()};
    } catch(e){
      pb.innerHTML='<div class="pub-error">Erro ao consultar o DJEN. Tente novamente em instantes.</div>';
      if(cntDD)cntDD.textContent='';
      if(cntCurEl&&dashActivityType==='publicacoes')cntCurEl.textContent='';
      return;
    }
  }

  const procs=_processosCadastrados();
  const matched=items.filter(it=>{
    const n=_normProcNum(it&&(it.numero_processo||it.numeroprocessocommascara)||'');
    return n&&procs.has(n);
  });
  matched.sort((a,b)=>String(b.data_disponibilizacao||'').localeCompare(String(a.data_disponibilizacao||'')));

  if(cntDD)cntDD.textContent=String(matched.length||0);
  if(cntCurEl&&dashActivityType==='publicacoes')cntCurEl.textContent=matched.length?String(matched.length):'';

  if(!matched.length){
    pb.innerHTML='<div class="db-empty">Nenhuma publicação encontrada nos últimos 30 dias para os processos cadastrados.</div>';
    return;
  }
  pb.innerHTML=matched.map(it=>{
    const n=_normProcNum(it.numero_processo||it.numeroprocessocommascara||'');
    const ctx=procs.get(n);
    const numMasc=it.numeroprocessocommascara||it.numero_processo||'';
    const link=it.link||'';
    const trib=it.siglaTribunal||'';
    const dataDisp=fmtDate(String(it.data_disponibilizacao||'').slice(0,10));
    const texto=_decodeHtmlEntities(it.texto||'').trim();
    const isLong=texto.length>150;
    const textoShort=isLong?texto.slice(0,150)+'…':texto;
    const destArr=Array.isArray(it.destinatarios)?it.destinatarios:[];
    const destHtml=destArr.length
      ?destArr.map(d=>esc(_toTitleCase(d.nome||''))).filter(Boolean).join(' · ')
      :'';
    const tribBadge=trib?`<span class="bdg bdg-gray">${esc(trib)}</span>`:'';
    const modBadge=ctx?`<span class="bdg ${ctx.bdg}">${esc(ctx.label)}</span>`:'';
    const tituloHtml=link
      ?`<a href="${esc(link)}" target="_blank" rel="noopener" class="pub-title-link">${esc(numMasc)}</a>`
      :`<span class="pub-title">${esc(numMasc)}</span>`;
    const navB=ctx?navBtn(ctx.mod,ctx.r.id):'';
    const inteiroBtn=isLong?`<button type="button" class="pub-inteiro-btn" onclick="togglePubText(this)">Ver inteiro teor</button>`:'';
    const cedCess=ctx?(()=>{
      const c=ctx.r.cedente||'',s=ctx.r.cessionario||'';
      if(!c&&!s)return'';
      return`<div class="pub-item-partes">${esc(c)}${c&&s?' v. ':''}${esc(s)}</div>`;
    })():'';
    return`<div class="pub-item">
      <div class="pub-item-hdr">
        <div class="pub-item-titulo-wrap">
          <div class="pub-item-titulo">${tituloHtml}${cpyBtn(numMasc)}${navB}</div>
          ${cedCess}
        </div>
        <div class="pub-item-badges">${tribBadge}${modBadge}</div>
      </div>
      <div class="pub-item-meta">
        <span class="pub-data"><span class="pub-data-lbl">Disponibilização:</span> ${dataDisp}</span>
      </div>
      ${texto?`<div class="pub-text" data-full="${esc(texto)}" data-short="${esc(textoShort)}">${esc(textoShort)}</div>`:''}
      ${inteiroBtn}
      ${destHtml?`<div class="pub-dest"><span class="pub-dest-lbl">Destinatários:</span> ${destHtml}</div>`:''}
    </div>`;
  }).join('');
}

function togglePubText(btn){
  const item=btn.closest('.pub-item');
  if(!item)return;
  const txt=item.querySelector('.pub-text');
  if(!txt)return;
  const isExpanded=txt.classList.contains('expanded');
  if(isExpanded){
    txt.textContent=txt.dataset.short||'';
    txt.classList.remove('expanded');
    btn.textContent='Ver inteiro teor';
  } else {
    txt.textContent=txt.dataset.full||'';
    txt.classList.add('expanded');
    btn.textContent='Recolher';
  }
}

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){['form-ov','hist-ov','senha-ov','vinculo-ov','motivo-ov','cart-ov','del-ov','contato-ov','aux-ov','parametros-ov'].forEach(closeModal);_crtTxtClose();}
  if(e.ctrlKey&&e.key==='f'){
    const mp={cessoes:'fc-proc',rpv:'fr-proc',requerimentos:'fre-proc',encerrados:'fen-proc',contatos:'fct-q'};
    const target=topTab==='acompanhamento'?subTab:topTab;
    const elId=mp[target];
    if(elId){e.preventDefault();const el=document.getElementById(elId);if(el){el.focus();el.select();}}
  }
});

/* ======================================================
   FORM MODAL
====================================================== */
let curMod=null,curId=null;

function openForm(mod,id=null){
  curMod=mod;curId=id;
  const isEdit=id!==null;
  document.getElementById('form-title').textContent=isEdit?'Editar Registro':'Adicionar Registro';
  let rec={};
  if(isEdit){rec=load(mod).find(r=>r.id===id)||{};}
  document.getElementById('form-body').innerHTML=buildForm(mod,rec);
  openModal('form-ov');
}

function fi(id,val,type='text',ph='',extra=''){
  return`<input type="${esc(type)}" id="f-${esc(id)}" class="finp" value="${esc(val||'')}" placeholder="${esc(ph)}"${extra?' '+extra:''}>`;
}
function fsel(id,val,opts){
  const o=opts.map(x=>`<option value="${esc(x)}" ${val===x?'selected':''}>${esc(x)}</option>`).join('');
  return`<select id="f-${esc(id)}" class="fsel"><option value="">Selecione…</option>${o}</select>`;
}
function fta(id,val,ph=''){
  return`<textarea id="f-${id}" class="fta" placeholder="${ph}">${esc(val||'')}</textarea>`;
}
function fg(lbl,html,full=false){
  return`<div class="fg${full?' full':''}"><label class="flbl">${lbl}</label>${html}</div>`;
}
function fck(id,checked,lbl){
  return`<div class="fcheck"><input type="checkbox" id="f-${id}" ${checked?'checked':''}><span>${lbl}</span></div>`;
}

function buildForm(mod,r){
  if(mod==='cessoes') return`<div class="fgrid">
    ${fg('Número do Processo',fi('numeroProcesso',r.numeroProcesso,'text','Ex: 0001234-56.2020.8.09.0001'))}
    ${fg('Data da Aquisição',fi('dataAquisicao',r.dataAquisicao,'date'))}
    ${fg('Expectativa de Liquidação',fi('expectativaLiquidacao',r.expectativaLiquidacao,'date'))}
    ${fg('Objeto',fi('objeto',r.objeto,'text','Objeto do processo'))}
    ${fg('Advogado',fi('advogado',r.advogado,'text','Nome do advogado'))}
    ${fg('Cedente',fi('cedente',r.cedente,'text','Nome do cedente'))}
    ${fg('Cessionário',fi('cessionario',r.cessionario,'text','Nome do cessionário'))}
    ${fg('Devedor',fi('devedor',r.devedor,'text','Nome do devedor'))}
    ${fg('Tribunal',fi('tribunal',r.tribunal,'text','Ex: TJGO'))}
    ${fg('Órgão Julgador',fi('orgaoJulgador',r.orgaoJulgador,'text','Vara / Câmara'))}
    ${fg('Instrumento',fi('instrumento',r.instrumento,'text','Tipo de instrumento'))}
  </div>`;

  if(mod==='rpv') return`<div class="fgrid">
    ${fg('Número do Processo',fi('numeroProcesso',r.numeroProcesso,'text','Ex: 0001234-56.2020.8.09.0001'))}
    ${fg('Data da Aquisição',fi('dataAquisicao',r.dataAquisicao,'date'))}
    ${fg('Data da Liquidação',fi('dataLiquidacao',r.dataLiquidacao,'date'))}
    ${fg('Objeto',fi('objeto',r.objeto,'text','Objeto do processo'))}
    ${fg('Advogado',fi('advogado',r.advogado,'text','Nome do advogado'))}
    ${fg('Cedente',fi('cedente',r.cedente,'text','Nome do cedente'))}
    ${fg('Cessionário',fi('cessionario',r.cessionario,'text','Nome do cessionário'))}
    ${fg('Devedor',fi('devedor',r.devedor,'text','Nome do devedor'))}
    ${fg('Tribunal',fi('tribunal',r.tribunal,'text','Ex: TJGO'))}
    ${fg('Órgão Julgador',fi('orgaoJulgador',r.orgaoJulgador,'text','Vara / Câmara'))}
  </div>`;

  if(mod==='requerimentos') return`<div class="fgrid">
    ${fg('Número do Processo',fi('numeroProcesso',r.numeroProcesso,'text','Ex: 0001234-56.2020.8.09.0001'))}
    ${fg('Protocolo',fi('protocolo',r.protocolo,'date'))}
    ${fg('Senha de Acesso',fi('senhaAcesso',r.senhaAcesso,'text','Senha do sistema'))}
    ${fg('Natureza',fi('natureza',r.natureza,'text','Natureza'))}
    ${fg('Matéria',fi('materia',r.materia,'text','Matéria'))}
    ${fg('Tribunal',fi('tribunal',r.tribunal,'text','Ex: TJGO'))}
    ${fg('Órgão Julgador',fi('orgaoJulgador',r.orgaoJulgador,'text','Vara / Câmara'))}
  </div>`;

  if(mod==='encerrados') return`<div class="fgrid">
    <input type="hidden" id="f-enc-orgaojulgador" value="${esc(r.orgaoJulgador||'')}">
    ${fg('Número do Processo',fi('numeroProcesso',r.numeroProcesso,'text','Ex: 0001234-56.2020.8.09.0001'))}
    ${fg('Tribunal',fi('tribunal',r.tribunal,'text','Ex: TJGO'))}
    ${fg('Data da Aquisição',fi('dataAquisicao',r.dataAquisicao,'date'))}
    ${fg('Data da Liquidação',fi('dataLiquidacao',r.dataLiquidacao,'date'))}
    ${fg('Objeto',fi('objeto',r.objeto,'text','Objeto do processo'))}
    ${fg('Advogado',fi('advogado',r.advogado,'text','Nome do advogado'))}
    ${fg('Cedente',fi('cedente',r.cedente,'text','Nome do cedente'))}
    ${fg('Cessionário',fi('cessionario',r.cessionario,'text','Nome do cessionário'))}
    ${fg('Devedor',fi('devedor',r.devedor,'text','Nome do devedor'))}
    ${fg('Motivo do Encerramento',fta('motivo',r.motivo,'Descreva o motivo…'),true)}
  </div>`;

  if(mod==='contatos') return`
    <div class="fgrid">
      ${fg('Órgão Julgador',fi('cont-orgao',r.orgaoJulgador||r.orgao_julgador,'text','','readonly style="opacity:0.55;cursor:not-allowed;pointer-events:none"'))}
      ${fg('Tribunal',fi('cont-tribunal',r.tribunal,'text','','readonly style="opacity:0.55;cursor:not-allowed;pointer-events:none"'))}
    </div>
    <div class="divider"></div>
    <div style="margin-bottom:14px">
      <div class="flbl" style="margin-bottom:8px">WhatsApp</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fg"><label class="flbl" style="font-size:10px;font-weight:400;color:var(--txt3);text-transform:none;letter-spacing:0;font-family:var(--font-head)">Serventia</label>${fi('cont-ws',r.whatsapp_serventia,'tel','(00) 00000-0000','oninput="maskPhone(this)"')}</div>
        <div class="fg"><label class="flbl" style="font-size:10px;font-weight:400;color:var(--txt3);text-transform:none;letter-spacing:0;font-family:var(--font-head)">Gabinete</label>${fi('cont-wg',r.whatsapp_gabinete,'tel','(00) 00000-0000','oninput="maskPhone(this)"')}</div>
      </div>
    </div>
    <div style="margin-bottom:14px">
      <div class="flbl" style="margin-bottom:8px">Telefone</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fg"><label class="flbl" style="font-size:10px;font-weight:400;color:var(--txt3);text-transform:none;letter-spacing:0;font-family:var(--font-head)">Serventia</label>${fi('cont-ts',r.telefone_serventia,'tel','(00) 0000-0000','oninput="maskPhone(this)"')}</div>
        <div class="fg"><label class="flbl" style="font-size:10px;font-weight:400;color:var(--txt3);text-transform:none;letter-spacing:0;font-family:var(--font-head)">Gabinete</label>${fi('cont-tg',r.telefone_gabinete,'tel','(00) 0000-0000','oninput="maskPhone(this)"')}</div>
      </div>
    </div>
    <div style="margin-bottom:14px">
      <div class="flbl" style="margin-bottom:8px">E-mail</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="fg"><label class="flbl" style="font-size:10px;font-weight:400;color:var(--txt3);text-transform:none;letter-spacing:0;font-family:var(--font-head)">Serventia</label>${fi('cont-es',r.email_serventia,'email')}</div>
        <div class="fg"><label class="flbl" style="font-size:10px;font-weight:400;color:var(--txt3);text-transform:none;letter-spacing:0;font-family:var(--font-head)">Gabinete</label>${fi('cont-eg',r.email_gabinete,'email')}</div>
      </div>
    </div>
    <div class="divider"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${fg('Horário de Atendimento',fi('cont-horario',r.horario,'text','Ex: 08h às 17h'))}
      ${fg('Contato Preferencial',fsel('cont-pref',r.contato_preferencial||r.contatoPreferencial||'',['WhatsApp','Telefone','E-mail']))}
    </div>`;
  return'';
}

function gf(id,type='text'){
  const el=document.getElementById('f-'+id);
  if(!el)return type==='checkbox'?false:type==='number'?0:'';
  if(type==='checkbox')return el.checked;
  if(type==='number')return parseFloat(el.value)||0;
  return el.value.trim();
}

function saveRecord(){
  if(!curMod)return;
  const data=load(curMod);
  let rec={};

  if(curMod==='cessoes') rec={
    numeroProcesso:gf('numeroProcesso'),dataAquisicao:gf('dataAquisicao'),
    expectativaLiquidacao:gf('expectativaLiquidacao'),
    objeto:gf('objeto'),advogado:gf('advogado'),cedente:gf('cedente'),
    cessionario:gf('cessionario'),devedor:gf('devedor'),tribunal:gf('tribunal'),
    orgaoJulgador:gf('orgaoJulgador'),instrumento:gf('instrumento')
  };
  else if(curMod==='rpv') rec={
    numeroProcesso:gf('numeroProcesso'),dataAquisicao:gf('dataAquisicao'),
    dataLiquidacao:gf('dataLiquidacao'),
    objeto:gf('objeto'),advogado:gf('advogado'),cedente:gf('cedente'),
    cessionario:gf('cessionario'),devedor:gf('devedor'),tribunal:gf('tribunal'),
    orgaoJulgador:gf('orgaoJulgador')
  };
  else if(curMod==='requerimentos') rec={
    numeroProcesso:gf('numeroProcesso'),protocolo:gf('protocolo'),
    senhaAcesso:gf('senhaAcesso'),natureza:gf('natureza'),materia:gf('materia'),
    tribunal:gf('tribunal'),orgaoJulgador:gf('orgaoJulgador')
  };
  else if(curMod==='encerrados') rec={
    numeroProcesso:gf('numeroProcesso'),dataAquisicao:gf('dataAquisicao'),
    dataLiquidacao:gf('dataLiquidacao'),objeto:gf('objeto'),advogado:gf('advogado'),
    cedente:gf('cedente'),cessionario:gf('cessionario'),devedor:gf('devedor'),
    motivo:gf('motivo'),
    tribunal:gf('tribunal')||'',
    orgaoJulgador:gf('enc-orgaojulgador')||''
  };
  else if(curMod==='contatos'){
    rec={
      orgaoJulgador:gf('cont-orgao'),
      tribunal:gf('cont-tribunal'),
      whatsapp_serventia:gf('cont-ws'),
      whatsapp_gabinete:gf('cont-wg'),
      telefone_serventia:gf('cont-ts'),
      telefone_gabinete:gf('cont-tg'),
      email_serventia:gf('cont-es'),
      email_gabinete:gf('cont-eg'),
      horario:gf('cont-horario'),
      contato_preferencial:gf('cont-pref'),
      // compat aliases
      contatoPreferencial:gf('cont-pref'),
    };
    if(!rec.orgaoJulgador){alert('Órgão julgador é obrigatório.');return;}
    if(curId){
      const idx=data.findIndex(r=>r.id===curId);
      rec.id=curId;
      if(idx!==-1){data[idx]=rec;}else{data.push(rec);}
    } else {
      rec.id=uid();
      data.push(rec);
    }
    save(curMod,data);
    closeModal('form-ov');
    render('contatos');
    return;
  }

  if(curMod!=='contatos'&&!rec.numeroProcesso){alert('O número do processo é obrigatório.');return;}

  if(curId){
    const idx=data.findIndex(r=>r.id===curId);
    if(idx!==-1){
      const old=data[idx];
      // Preserva todos os campos existentes (Carteiras, histórico, diligências, etc.)
      // e sobrescreve apenas com o que veio do formulário
      data[idx]={...old,...rec,id:curId};
    }
  } else {
    rec.id=uid();
    rec.historicoProcessual=[];
    data.push(rec);
  }

  save(curMod,data);
  closeModal('form-ov');
  render(curMod);
  updateDash();
}

/* ======================================================
   DELETE
====================================================== */
function del(mod,id){
  const data=load(mod);
  const rec=data.find(r=>r.id===id);
  const num=rec?(rec.numeroProcesso||'processo'):'processo';
  const numFilhos=rec&&rec.vinculosFilhos?rec.vinculosFilhos.length:0;
  let msg=`Esta ação não pode ser desfeita. O processo ${num} será removido permanentemente.`;
  if(numFilhos)msg+=` ⚠️ Este processo possui ${numFilhos} processo(s) vinculado(s) que ficarão sem pai.`;
  document.getElementById('del-msg').textContent=msg;
  document.getElementById('del-confirm-btn').onclick=()=>{
    closeModal('del-ov');
    const d=load(mod);
    const r=d.find(x=>x.id===id);
    if(r){
      /* Imutável: substitui registros afetados por cópias modificadas */
      (r.vinculosFilhos||[]).forEach(cid=>{
        const cIdx=d.findIndex(x=>x.id===cid);
        if(cIdx!==-1){const{vinculoPai,...rest}=d[cIdx];d[cIdx]=rest;}
      });
      if(r.vinculoPai){
        const paiIdx=d.findIndex(x=>x.id===r.vinculoPai);
        if(paiIdx!==-1){
          const pai=d[paiIdx];
          d[paiIdx]={...pai,vinculosFilhos:(pai.vinculosFilhos||[]).filter(x=>x!==id)};
        }
      }
    }
    save(mod,d.filter(x=>x.id!==id));
    render(mod);updateDash();
  };
  openModal('del-ov');
}

/* ======================================================
   MOVER PARA
====================================================== */
const highlightIds=new Set();

const _CPY_SVG=`<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="display:inline;vertical-align:middle"><rect x="0.75" y="3" width="7" height="8" rx="1.25" stroke="#4b5563" stroke-width="1.5"/><rect x="4.25" y="0.75" width="7" height="8" rx="1.25" stroke="#4b5563" stroke-width="1.5"/></svg>`;
function cpyBtn(num){return`<button class="cpy-btn" data-num="${esc(num)}" onclick="cpyNum(event)">${_CPY_SVG}</button>`;}
const _NAV_SVG=`<svg width="11" height="11" viewBox="0 0 11 11" fill="none" style="display:inline;vertical-align:middle"><path d="M2.5 8.5L8.5 2.5M5 2.5H8.5V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function navBtn(mod,id){return`<button class="al-nav-btn" onclick="goToProcess('${mod}','${id}')" title="Ir para o processo">${_NAV_SVG}</button>`;}
const _PF_SVG=`<svg width="11" height="11" viewBox="0 0 11 11" fill="none" style="display:inline;vertical-align:middle"><path d="M7.5 1.5L9.5 3.5L3.5 9.5H1.5V7.5L7.5 1.5Z" stroke="#4b5563" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 2.5L8.5 4.5" stroke="#4b5563" stroke-width="1.3" stroke-linecap="round"/></svg>`;
function fatalCell(mod,id,val){
  const dateStr=val?fmtDate(val):'—';
  const btn=`<button class="pf-btn" onclick="editPrazoFatal('${mod}','${esc(id)}')" title="Editar prazo fatal">${_PF_SVG}</button>`;
  return `<span data-pf="${mod}:${esc(id)}">${dateStr}${btn}</span>`;
}
let _pfEsc=false;
function editPrazoFatal(mod,id){
  const key=`${mod}:${id}`;
  const span=document.querySelector(`[data-pf="${key}"]`);
  if(!span)return;
  const td=span.closest('td');
  if(!td)return;
  const rec=load(mod).find(r=>r.id===id);
  const cur=(rec&&rec.prazoFatal)?normDate(rec.prazoFatal):'';
  _pfEsc=false;
  td.innerHTML=`<input type="date" value="${cur}" style="background:#1a1f2e;border:1px solid #6e7dbb;border-radius:5px;color:#e2e8f0;padding:2px 5px;font-size:12px;font-family:inherit;outline:none;width:130px;color-scheme:dark" onblur="if(!_pfEsc)_pfSave('${mod}','${esc(id)}',this.value)" onkeydown="if(event.key==='Enter'){_pfEsc=false;this.blur()}else if(event.key==='Escape'){_pfEsc=true;event.preventDefault();render('${mod}')}">`;
  const inp=td.querySelector('input');
  if(inp){inp.focus();inp.click();}
}
function _pfSave(mod,id,valor){
  const data=load(mod);
  const idx=data.findIndex(r=>r.id===id);
  if(idx<0){render(mod);return;}
  const anterior=normDate(data[idx].prazoFatal||'');
  // Confirmação ao apagar uma data existente
  if(!valor&&anterior){
    if(!confirm('Remover o prazo fatal deste processo?')){render(mod);return;}
  }
  data[idx]={...data[idx],prazoFatal:valor||''};  // novo objeto: evita mutar CACHE antes do _sbSync capturar prev
  save(mod,data);
  render(mod);
  updateDash();
}
/* ======================================================
   CARTEIRAS — EDIÇÃO INLINE DE CAMPOS
====================================================== */
function crtCell(aba,id,field,val,type){
  const display=type==='date'?(val?val.split('-').reverse().join('/'):'—'):(val||'—');
  const key=`${aba}:${id}:${field}`;
  const btn=`<button class="crt-eb" onclick="crtEdit('${escJs(aba)}','${escJs(id)}','${escJs(field)}','${escJs(type)}')" title="Editar">${_PF_SVG}</button>`;
  return`<span data-crte="${esc(key)}">${esc(display)}${btn}</span>`;
}
function crtCellBRL(aba,id,field,val,type){
  const n=_parseNumCrt(val);
  const display=n?fmtBRL(n):(val||'—');
  const key=`${aba}:${id}:${field}`;
  const btn=`<button class="crt-eb" onclick="crtEdit('${escJs(aba)}','${escJs(id)}','${escJs(field)}','${escJs(type)}')" title="Editar">${_PF_SVG}</button>`;
  return`<span data-crte="${esc(key)}">${esc(display)}${btn}</span>`;
}
let _crtEsc=false;
function crtEdit(aba,id,field,type){
  const key=`${aba}:${id}:${field}`;
  /* Escape do CSS attr selector — IDs com aspas/colchetes quebrariam a query */
  const span=document.querySelector(`[data-crte="${CSS.escape?CSS.escape(key):key}"]`);
  if(!span)return;
  const td=span.closest('td');
  if(!td)return;
  const rec=load(aba).find(r=>r.id===id);
  const cur=rec?(type==='date'?(normDate(rec[field]||'')||''):(rec[field]||'')):'';
  _crtEsc=false;
  const w=type==='date'?'130px':'110px';
  const extra=type==='date'?'color-scheme:dark':'';
  td.innerHTML=`<input type="${esc(type)}" value="${esc(cur)}" style="background:#1a1f2e;border:1px solid #6e7dbb;border-radius:5px;color:#e2e8f0;padding:2px 5px;font-size:10px;font-family:inherit;outline:none;width:${w};${extra}" onblur="if(!_crtEsc)_crtSave('${escJs(aba)}','${escJs(id)}','${escJs(field)}',this.value)" onkeydown="if(event.key==='Enter'){_crtEsc=false;this.blur()}else if(event.key==='Escape'){_crtEsc=true;event.preventDefault();_crtRefresh()}">`;
  const inp=td.querySelector('input');
  if(inp){inp.focus();if(type!=='date')inp.select();}
}
function _crtSave(aba,id,field,val){
  const data=load(aba);
  const idx=data.findIndex(r=>r.id===id);
  if(idx<0){_crtRefresh();return;}
  /* Snapshot anterior para feedback de erro (rollback é tratado no _sbSync via showToast). */
  data[idx]={...data[idx],[field]:val||''};  // novo objeto: evita mutar CACHE antes do _sbSync capturar prev
  save(aba,data);
  _crtRefresh();
}
function _crtRefresh(){
  if(_crtAcSelected)_crtRenderOperacoes(_crtAcSelected);
}

/* ======================================================
   CONSOLIDADO
====================================================== */
/* Parser robusto de número BRL/JS:
   - Aceita "R$ 1.234,56", "1.234,56", "1234,56", "1234.56", número JS puro.
   - Detecta automaticamente se é formato BR (vírgula como decimal) ou US (ponto).
   - Trata negativos com sinal e parênteses contábeis: (1.234,56) → -1234.56. */
function _parseNumCrt(v){
  if(v==null||v==='')return 0;
  if(typeof v==='number')return isFinite(v)?v:0;
  let s=String(v).trim().replace(/[R$\s]/g,'');
  if(!s)return 0;
  /* Parênteses contábeis indicam negativo */
  let neg=false;
  if(/^\(.*\)$/.test(s)){neg=true;s=s.slice(1,-1);}
  if(s.startsWith('-')){neg=!neg;s=s.slice(1);}
  /* Detecta o último separador como decimal */
  const lastComma=s.lastIndexOf(',');
  const lastDot=s.lastIndexOf('.');
  if(lastComma>lastDot){
    /* Formato BR: 1.234,56 — pontos são milhares, vírgula é decimal */
    s=s.replace(/\./g,'').replace(',','.');
  } else if(lastDot>lastComma){
    /* Formato US ou número JS puro: 1,234.56 ou 1234.56 — vírgulas são milhares */
    s=s.replace(/,/g,'');
  } else {
    /* Sem separador decimal — apenas dígitos com possíveis milhares */
    s=s.replace(/[.,]/g,'');
  }
  const n=parseFloat(s);
  return isNaN(n)?0:(neg?-n:n);
}
function _parseISODate(s){return s?new Date(s+'T12:00:00'):null;}

function _crtAutoStatus(r){
  // Verde: encerrado (aba encerrados implica liquidado) OU tem data de liquidação efetiva
  if(r._aba==='encerrados'||r.dataLiquidacao){return{label:'Verde',color:'#4ade80'};}
  // Usa expectativaLiquidacao das abas de execução processual
  const estDate=_parseISODate(r.expectativaLiquidacao);
  if(!estDate){return{label:'—',color:'#4b5563'};}
  const today=new Date();today.setHours(0,0,0,0);
  const diffDays=(estDate-today)/(1000*60*60*24);
  if(diffDays<0) return{label:'Vermelho',color:'#f87171'};   // ultrapassou
  if(diffDays<=30)return{label:'Âmbar',  color:'#fbbf24'};   // menos de 1 mês
  return          {label:'Azul',   color:'#60a5fa'};          // mais de 1 mês
}

/* XIRR — Newton-Raphson */
function _xirr(cashFlows){
  // cashFlows: [{amount, date}]
  if(!cashFlows||cashFlows.length<2)return null;
  const hasPos=cashFlows.some(f=>f.amount>0);
  const hasNeg=cashFlows.some(f=>f.amount<0);
  if(!hasPos||!hasNeg)return null;
  const base=cashFlows.reduce((m,f)=>f.date<m?f.date:m,cashFlows[0].date);
  const yrs=cashFlows.map(f=>(f.date-base)/(365.25*86400*1000));
  const npv=r=>cashFlows.reduce((s,f,i)=>s+f.amount/Math.pow(1+r,yrs[i]),0);
  const dnpv=r=>cashFlows.reduce((s,f,i)=>s-yrs[i]*f.amount/Math.pow(1+r,yrs[i]+1),0);
  let rate=0.15;
  for(let i=0;i<200;i++){
    const n=npv(rate),d=dnpv(rate);
    if(Math.abs(d)<1e-12)break;
    const nr=rate-n/d;
    if(Math.abs(nr-rate)<1e-8){rate=nr;break;}
    rate=Math.max(-0.999,nr);
  }
  if(Math.abs(npv(rate))>0.01*cashFlows.reduce((s,f)=>s+Math.abs(f.amount),0))return null;
  return rate;
}

function _crtConsolidadoFlows(ops){
  const flows=[];
  const today=new Date();
  ops.forEach(r=>{
    const cap=_parseNumCrt(r.capitalInvestido);
    const dateIn=_parseISODate(r.dataAquisicao);
    if(!dateIn||cap<=0)return;
    flows.push({amount:-cap,date:dateIn});
    const recv=_parseNumCrt(r.jaRecebido);
    const estTotal=_parseNumCrt(r.valorAtualizadoManual)||_parseNumCrt(r.valorFace);
    const remaining=Math.max(0,estTotal-recv);
    const dateLiq=_parseISODate(r.dataLiquidacao);
    const dateEst=_parseISODate(r.dataEstRecebimento);
    if(recv>0){
      flows.push({amount:recv,date:dateLiq||dateEst||today});
    }
    if(remaining>0){
      const futDate=dateLiq||dateEst;
      if(futDate)flows.push({amount:remaining,date:futDate}); // inclui passado (encerrados com saldo residual)
    }
  });
  return flows;
}

/* estado de ordenação do Consolidado */
let _consSortCol='displayName';
let _consSortDir=1; // 1=asc, -1=desc
let _consMonthFilter='todos'; // 'todos' | 'yyyy-mm'

const _MES_PT=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
function _consMesLbl(v){
  if(!v||v==='todos')return'Tudo';
  const [y,m]=v.split('-');return`${_MES_PT[Number(m)-1]} de ${y}`;
}

let _consMesItems=['todos'];

function _consMesToggle(e){
  if(e)e.stopPropagation();
  const dd=document.getElementById('crt-cons-mes-dd');
  if(!dd)return;
  dd.classList.contains('on')?_consMesClose():_consMesOpen();
}
function _consMesOpen(){
  const dd=document.getElementById('crt-cons-mes-dd');
  if(!dd)return;
  dd.innerHTML=_consMesItems.map(v=>{
    const sel=v===_consMonthFilter?' sel':'';
    return`<div class="crt-ac-item${sel}" onmousedown="_consMesPick('${v}')">${_consMesLbl(v)}</div>`;
  }).join('');
  dd.classList.add('on');
}
function _consMesClose(){
  const dd=document.getElementById('crt-cons-mes-dd');
  if(dd)dd.classList.remove('on');
}
function _consMesPick(v){
  _consMonthFilter=v||'todos';
  const inp=document.getElementById('crt-cons-mes-input');
  if(inp)inp.value=_consMesLbl(_consMonthFilter);
  _consMesClose();
  _crtRenderConsolidado();
}
function _consMesKey(e){
  if(e.key==='Enter'||e.key===' '){e.preventDefault();_consMesToggle(e);return;}
  if(e.key==='Escape'){e.preventDefault();_consMesClose();return;}
  const dd=document.getElementById('crt-cons-mes-dd');
  if(!dd||!dd.classList.contains('on'))return;
  const cur=_consMesItems.indexOf(_consMonthFilter);
  if(e.key==='ArrowDown'){e.preventDefault();_consMesPick(_consMesItems[Math.min(cur+1,_consMesItems.length-1)]);_consMesOpen();}
  else if(e.key==='ArrowUp'){e.preventDefault();_consMesPick(_consMesItems[Math.max(cur-1,0)]);_consMesOpen();}
}
document.addEventListener('click',e=>{if(!e.target.closest('#crt-cons-mes-input')&&!e.target.closest('#crt-cons-mes-dd'))_consMesClose();});

function _extractYM(v){
  if(!v)return null;
  if(v instanceof Date)return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}`;
  const s=String(v);
  // tenta yyyy-mm em qualquer lugar (yyyy-mm-dd, yyyy-mm-ddTHH:MM, etc)
  const m1=s.match(/(\d{4})-(\d{2})/);
  if(m1)return `${m1[1]}-${m1[2]}`;
  // tenta dd/mm/yyyy
  const m2=s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if(m2)return `${m2[3]}-${m2[2]}`;
  return null;
}

function _consPopulateMonths(){
  const inp=document.getElementById('crt-cons-mes-input');
  if(!inp)return;
  const all=[...(CACHE.cessoes||[]),...(CACHE.rpv||[]),...(CACHE.encerrados||[])];
  let minYM=null;
  all.forEach(r=>{
    if(r.vinculoPai)return;
    const ym=_extractYM(r.dataAquisicao);
    if(!ym)return;
    if(!minYM||ym<minYM)minYM=ym;
  });
  const now=new Date();
  const cy=now.getFullYear(),cm=now.getMonth()+1;
  const months=[];
  if(minYM){
    let [y,m]=minYM.split('-').map(Number);
    while(y<cy||(y===cy&&m<=cm)){
      months.push(`${y}-${String(m).padStart(2,'0')}`);
      m++;if(m>12){m=1;y++;}
    }
  }
  months.reverse();
  _consMesItems=['todos',...months];
  if(_consMonthFilter!=='todos'&&!months.includes(_consMonthFilter))_consMonthFilter='todos';
  inp.value=_consMesLbl(_consMonthFilter);
}

const _CONS_COLS=[
  {key:'displayName', label:'Investidor',         num:false},
  {key:'capital',     label:'Capital inv. (R$)',   num:true},
  {key:'aReceberEst', label:'A receber est. (R$)', num:true},
  {key:'recebido',    label:'Já recebido (R$)',    num:true},
  {key:'retorno',     label:'Retorno (%)',         num:true},
  {key:'tir',         label:'TIR a.a.',            num:true},
  {key:'count',       label:'Qtd. operações',      num:true},
];

function _consSort(key){
  if(_consSortCol===key)_consSortDir*=-1;
  else{_consSortCol=key;_consSortDir=key==='displayName'?1:-1;}
  _fSave();
  _crtRenderConsolidado();
}

/* sincroniza scroll horizontal entre tabela principal e tabela de total */
(function(){
  let _syncing=false;
  function _syncScroll(src,dst){
    if(_syncing)return;
    _syncing=true;
    dst.scrollLeft=src.scrollLeft;
    _syncing=false;
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const main=document.getElementById('crt-cons-scroll');
    const tot=document.getElementById('crt-cons-total-wrap');
    if(main&&tot){
      main.addEventListener('scroll',()=>_syncScroll(main,tot));
      tot.addEventListener('scroll',()=>_syncScroll(tot,main));
    }
  });
})();

function _crtRenderConsolidado(){
  const tbody=document.getElementById('crt-cons-tbody');
  const thead=document.getElementById('crt-cons-thead');
  if(!tbody)return;
  _consPopulateMonths();
  const norm=s=>(s||'').trim().toLowerCase();
  const monthOK=r=>_consMonthFilter==='todos'||_extractYM(r.dataAquisicao)===_consMonthFilter;

  /* cabeçalho dinâmico com setas de ordenação */
  if(thead){
    thead.innerHTML=_CONS_COLS.map(c=>{
      const active=_consSortCol===c.key;
      const arrow=active?(_consSortDir===1?'↑':'↓'):'↕';
      return`<th class="cons-th${active?' cons-th-active':''}" onclick="_consSort('${c.key}')">${c.label}<span class="cons-sort-arrow">${arrow}</span></th>`;
    }).join('');
  }

  /* mapa: nome normalizado → nome exibível (apenas registros pai) */
  const investMap=new Map();
  [...(CACHE.cessoes||[]),...(CACHE.rpv||[]),...(CACHE.encerrados||[])].forEach(r=>{
    if(r.vinculoPai)return;
    const v=(r.cessionario||'').trim();
    if(v)investMap.set(norm(v),v);
  });

  if(!investMap.size){
    tbody.innerHTML='<tr><td colspan="7" class="crt-tbl-empty">Nenhum investidor encontrado</td></tr>';
    return;
  }

  const fmtPct=v=>v==null?'—':(v*100).toFixed(2).replace('.',',')+'%';
  const fmtNum=v=>v>0?fmtBRL(v):'—';

  const tableRows=[];
  let totCap=0,totRecebido=0,totOps=0;

  for(const[normName,displayName]of investMap){
    const ops=[];
    (CACHE.cessoes||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===normName&&monthOK(r))ops.push({...r,_aba:'cessoes'});});
    (CACHE.rpv||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===normName&&monthOK(r))ops.push({...r,_aba:'rpv'});});
    (CACHE.encerrados||[]).forEach(r=>{if(!r.vinculoPai&&norm(r.cessionario)===normName&&monthOK(r))ops.push({...r,_aba:'encerrados'});});

    if(!ops.length)continue;
    const capital=ops.reduce((s,r)=>s+_parseNumCrt(r.capitalInvestido),0);
    const recebido=ops.reduce((s,r)=>s+_parseNumCrt(r.jaRecebido),0);
    totCap+=capital;totRecebido+=recebido;totOps+=ops.length;
    tableRows.push({displayName,capital,recebido,retorno:null,tir:null,count:ops.length});
  }

  /* ordenação */
  tableRows.sort((a,b)=>{
    const va=a[_consSortCol],vb=b[_consSortCol];
    if(va==null&&vb==null)return 0;
    if(va==null)return 1;
    if(vb==null)return -1;
    if(typeof va==='string')return va.localeCompare(vb,'pt-BR',{sensitivity:'base'})*_consSortDir;
    return(va-vb)*_consSortDir;
  });

  if(!tableRows.length){
    tbody.innerHTML='<tr><td colspan="7" class="crt-tbl-empty">Nenhuma cessão no mês selecionado</td></tr>';
    const totEmpty=document.getElementById('crt-cons-total');
    if(totEmpty)totEmpty.innerHTML='';
    return;
  }

  /* tabela principal — apenas os investidores */
  tbody.innerHTML=tableRows.map(r=>`
    <tr>
      <td style="font-weight:500;color:#e2e8f0">${esc(r.displayName)}</td>
      <td class="crt-td-num">${fmtNum(r.capital)}</td>
      <td class="crt-td-num">—</td>
      <td class="crt-td-num">${fmtNum(r.recebido)}</td>
      <td class="crt-td-num">—</td>
      <td class="crt-td-num">—</td>
      <td class="crt-td-num">${r.count}</td>
    </tr>`).join('');

  /* tabela de total — separada, colunas alinhadas via colgroup idêntico */
  const totEl=document.getElementById('crt-cons-total');
  if(totEl)totEl.innerHTML=`
    <tr>
      <td style="padding:10px 8px">
        <span style="font-size:8px;font-weight:800;letter-spacing:.9px;text-transform:uppercase;color:#6e9fce">Consolidado</span>
        <div style="font-size:12px;font-weight:700;color:#e2e8f0;margin-top:1px">Total da carteira</div>
      </td>
      <td class="crt-td-num" style="font-weight:700;font-size:11px;color:#dce3ee;padding:10px 8px">${fmtNum(totCap)}</td>
      <td class="crt-td-num" style="font-weight:700;font-size:11px;color:#4b5563;padding:10px 8px">—</td>
      <td class="crt-td-num" style="font-weight:700;font-size:11px;color:#dce3ee;padding:10px 8px">${fmtNum(totRecebido)}</td>
      <td class="crt-td-num" style="font-weight:700;font-size:11px;color:#4b5563;padding:10px 8px">—</td>
      <td class="crt-td-num" style="font-weight:700;font-size:11px;color:#4b5563;padding:10px 8px">—</td>
      <td class="crt-td-num" style="font-weight:700;font-size:11px;color:#dce3ee;padding:10px 8px">${totOps}</td>
    </tr>`;
}

/* ======================================================
   PARÂMETROS
====================================================== */
const _PRM_KEY='cj-parametros';
function _prmLoad(){
  try{return JSON.parse(_lsGet(_PRM_KEY)||'{}');}catch(e){return{};}
}
async function _prmSave(){
  if(!sb)return;
  const obj={
    selic:document.getElementById('prm-selic').value,
    ipca:document.getElementById('prm-ipca').value,
    tr:document.getElementById('prm-tr').value,
    cdi:document.getElementById('prm-cdi').value
  };
  _lsSet(_PRM_KEY,JSON.stringify(obj));
  try{
    await sb.from('configuracoes').upsert({chave:'parametros_atualizacao',valor:JSON.stringify(obj)},{onConflict:'chave'});
  }catch(e){console.warn('[Credijuris] _prmSave supabase:',e);}
}
function _prmUpdate(){
  const ipca=parseFloat(document.getElementById('prm-ipca').value)||0;
  const ind=(ipca+2).toFixed(2);
  const el=document.getElementById('prm-indice-padrao');
  if(el)el.textContent=ind+'% a.a.';
}
async function _prmInit(){
  /* data de referência = hoje */
  const today=new Date();
  const dd=String(today.getDate()).padStart(2,'0');
  const mm=String(today.getMonth()+1).padStart(2,'0');
  const yyyy=today.getFullYear();
  const el=document.getElementById('prm-data-ref');
  if(el)el.textContent=`${dd}/${mm}/${yyyy}`;
  /* carregar do Supabase (fonte de verdade); fallback para localStorage */
  let saved=_prmLoad();
  try{
    const{data,error}=await sb.from('configuracoes').select('valor').eq('chave','parametros_atualizacao').maybeSingle();
    if(!error&&data?.valor){
      const remote=JSON.parse(data.valor);
      saved=remote;
      _lsSet(_PRM_KEY,JSON.stringify(remote));
    }
  }catch(e){console.warn('[Credijuris] _prmInit supabase:',e);}
  ['selic','ipca','tr','cdi'].forEach(k=>{
    const inp=document.getElementById('prm-'+k);
    if(inp&&saved[k]!=null)inp.value=saved[k];
  });
  _prmUpdate();
}

/* Célula de texto longo com fade e lápis */
function crtTextCell(aba,id,field,val,proc){
  const preview=val?String(val).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'—';
  const procArg=proc?`,'${escJs(proc)}'`:'';
  const btn=`<button class="crt-eb" onclick="crtTextEdit('${escJs(aba)}','${escJs(id)}','${escJs(field)}'${procArg})" title="Editar">${_PF_SVG}</button>`;
  return`<div class="crt-txt-cell"><span class="crt-txt-preview">${preview}</span>${btn}</div>`;
}
let _crtTxtCtx={aba:'',id:'',field:''};
const _CRT_TXT_LABELS={estagioProcessual:'Estágio Processual',providencias:'Providências / Próx. Passos'};
function crtTextEdit(aba,id,field,proc){
  const rec=load(aba).find(r=>r.id===id);
  _crtTxtCtx={aba,id,field};
  document.getElementById('crt-txt-lbl').textContent=_CRT_TXT_LABELS[field]||field;
  const procEl=document.getElementById('crt-txt-proc');
  if(procEl)procEl.textContent=proc||'';
  document.getElementById('crt-txt-area').value=rec?rec[field]||'':'';
  document.getElementById('crt-txt-ov').classList.add('on');
  setTimeout(()=>document.getElementById('crt-txt-area').focus(),80);
}
function _crtTxtConfirm(){
  const val=document.getElementById('crt-txt-area').value.trim();
  const{aba,id,field}=_crtTxtCtx;
  _crtSave(aba,id,field,val);
  _crtTxtClose();
}
function _crtTxtClose(){
  document.getElementById('crt-txt-ov').classList.remove('on');
}
const _CRT_SEL_COLORS={};
function crtSelectCell(aba,id,field,val,opts,colors){
  const key=`${aba}:${id}:${field}`;
  if(colors)_CRT_SEL_COLORS[key]=colors;
  const col=colors&&val?colors[val]:'';
  const display=val||'—';
  const options=opts.map(o=>{
    const c=colors?colors[o]:'';
    const label=o===''?'—':esc(o);
    const muted=o===''?'color:#4b5563;font-style:italic':'';
    return`<div class="crt-sel-opt${val===o?' selected':''}" style="${c?`color:${c}`:muted}" onclick="_crtSelPick('${escJs(key)}',this,'${escJs(o)}','${escJs(aba)}','${escJs(id)}','${escJs(field)}')">${esc(label)}</div>`;
  }).join('');
  return`<div class="crt-sel-wrap"><span class="crt-sel-val" data-crtsel="${key}" style="${col?`color:${col}`:''}" onclick="_crtSelToggle(event,'${key}')">${display}</span><div class="crt-sel-dd" id="crtdd-${key}">${options}</div></div>`;
}
let _crtSelOpen=null;
function _crtSelToggle(e,key){
  e.stopPropagation();
  const dd=document.getElementById('crtdd-'+key);
  const val=document.querySelector(`[data-crtsel="${key}"]`);
  if(!dd)return;
  if(_crtSelOpen&&_crtSelOpen!==key){
    const prev=document.getElementById('crtdd-'+_crtSelOpen);
    const prevVal=document.querySelector(`[data-crtsel="${_crtSelOpen}"]`);
    if(prev){prev.classList.remove('on');}
    if(prevVal){prevVal.classList.remove('open');}
  }
  const isOpen=dd.classList.toggle('on');
  val&&val.classList.toggle('open',isOpen);
  _crtSelOpen=isOpen?key:null;
}
function _crtSelPick(key,el,val,aba,id,field){
  el.closest('.crt-sel-dd').querySelectorAll('.crt-sel-opt').forEach(o=>o.classList.remove('selected'));
  el.classList.add('selected');
  const span=document.querySelector(`[data-crtsel="${key}"]`);
  if(span){
    span.textContent=val||'—';
    span.classList.remove('open');
    const colors=_CRT_SEL_COLORS[key];
    span.style.color=colors&&val?colors[val]:'';
  }
  el.closest('.crt-sel-dd').classList.remove('on');
  _crtSelOpen=null;
  _crtSave(aba,id,field,val);
}
document.addEventListener('click',()=>{
  if(_crtSelOpen){
    const dd=document.getElementById('crtdd-'+_crtSelOpen);
    const val=document.querySelector(`[data-crtsel="${_crtSelOpen}"]`);
    if(dd)dd.classList.remove('on');
    if(val)val.classList.remove('open');
    _crtSelOpen=null;
  }
});

function cpyNum(e){
  e.stopPropagation();
  const num=e.currentTarget.getAttribute('data-num');
  navigator.clipboard.writeText(num).catch(()=>{});
  const btn=e.currentTarget;
  btn.innerHTML='<span style="color:#22c55e;font-size:11px;line-height:1;vertical-align:middle">✓</span>';
  btn.style.opacity='0.5';
  setTimeout(()=>{btn.innerHTML=_CPY_SVG;btn.style.opacity='';},1500);
}

function goToProcess(mod,id){
  const data=load(mod);
  const rec=data.find(r=>r.id===id);
  const num=rec?(rec.numeroProcesso||''):'';
  if(!document.querySelector('.nav')?.style.display||document.querySelector('.nav').style.display==='none')_sbShowExec();
  // Os 4 mods de processo vivem dentro de pane-acompanhamento — ativamos o top tab e delegamos
  // a sub-aba para selectSubpane.
  const _topMod=_SUB_TABS.includes(mod)?'acompanhamento':mod;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  const _tabEl=document.querySelector(`.tab[data-tab="${_topMod}"]`);
  if(_tabEl)_tabEl.classList.add('on');
  document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
  topTab=_topMod;
  document.getElementById('pane-'+_topMod).classList.add('on');
  if(_topMod==='acompanhamento')selectSubpane(mod,{skipRender:true});
  const procId={cessoes:'fc-proc',rpv:'fr-proc',requerimentos:'fre-proc',encerrados:'fen-proc'}[mod];
  if(procId)document.getElementById(procId).value=num;
  highlightIds.add(id);
  render(mod);
  setTimeout(()=>{const row=document.querySelector(`#tb-${mod} tr.row-highlight`);if(row)row.scrollIntoView({block:'center',behavior:'smooth'});},60);
  setTimeout(()=>{highlightIds.delete(id);render(mod);},3200);
}

function showToast(msg,duration=3500){
  const t=document.getElementById('toast');
  if(!t)return;
  t.textContent=msg;t.classList.add('on');
  setTimeout(()=>t.classList.remove('on'),duration);
}

const MV_OPTS={
  cessoes:[{v:'rpv',l:'RPV Complementar'},{v:'encerrados',l:'Encerrados'}],
  rpv:[{v:'cessoes',l:'Cessões Ativas'},{v:'encerrados',l:'Encerrados'}],
  encerrados:[{v:'cessoes',l:'Cessões Ativas'},{v:'rpv',l:'RPV Complementar'}],
  requerimentos:[{v:'cessoes',l:'Cessões Ativas'},{v:'rpv',l:'RPV Complementar'},{v:'encerrados',l:'Encerrados'}]
};

function moveItem(mod,id,toMod){
  document.getElementById('actions-dd').style.display='none';
  const srcData=load(mod);
  const rec=srcData.find(r=>r.id===id);
  if(!rec)return;
  const numFilhos=(rec.vinculosFilhos||[]).length;
  if(numFilhos&&!confirm(`Este processo possui ${numFilhos} processo(s) vinculado(s). Eles ficarão sem pai (não são movidos junto). Continuar?`)){
    return;
  }
  /* Cópia imutável sem vínculos (registro movido vira pai standalone na nova aba) */
  const copy={...rec};
  delete copy.vinculoPai;delete copy.vinculosFilhos;
  /* 1) Adiciona na aba destino */
  save(toMod,[...load(toMod),copy]);
  /* 2) Remove vínculos referenciando o registro movido (de forma imutável) */
  let updatedSrc=srcData.map(r=>{
    if(rec.vinculosFilhos&&rec.vinculosFilhos.includes(r.id)){
      const{vinculoPai,...rest}=r;return rest;
    }
    if(rec.vinculoPai===r.id&&r.vinculosFilhos){
      return{...r,vinculosFilhos:r.vinculosFilhos.filter(x=>x!==id)};
    }
    return r;
  });
  /* 3) Remove o próprio registro da origem */
  save(mod,updatedSrc.filter(r=>r.id!==id));
  highlightIds.add(copy.id);
  // toMod sempre é um sub-tab (cessoes/rpv/encerrados/requerimentos) — abre pane-acompanhamento.
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.querySelector('.tab[data-tab="acompanhamento"]')?.classList.add('on');
  document.querySelectorAll('.pane').forEach(x=>x.classList.remove('on'));
  topTab='acompanhamento';
  document.getElementById('pane-acompanhamento').classList.add('on');
  selectSubpane(toMod,{skipRender:true});
  render(toMod);
  setTimeout(()=>{highlightIds.delete(copy.id);render(toMod);},3000);
  showToast(`Processo movido para ${{cessoes:'Cessões Ativas',rpv:'RPV Complementar',encerrados:'Encerrados',requerimentos:'Diversos'}[toMod]} com sucesso`);
  updateDash();
}

/* ======================================================
   SENHA DE ACESSO
====================================================== */
function openMotivo(id){
  const rec=load('encerrados').find(r=>r.id===id);
  if(!rec)return;
  document.getElementById('motivo-body').innerHTML=`
    <div style="font-size:11px;color:var(--txt3);margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px">Processo: <strong style="color:var(--gold2)">${esc(rec.numeroProcesso)}</strong></div>
    <div style="font-size:13.5px;color:var(--txt);line-height:1.7;white-space:pre-wrap">${esc(rec.motivo)}</div>`;
  openModal('motivo-ov');
}

function openSenha(id){
  const rec=load('requerimentos').find(r=>r.id===id);
  if(!rec)return;
  document.getElementById('senha-proc').textContent=rec.numeroProcesso||'';
  const s=rec.senhaAcesso||'';
  document.getElementById('senha-body').innerHTML=`
    <div style="text-align:center;padding:10px 0 20px">
      ${s
        ?`<div class="senha-display">${esc(s)}</div>`
        :'<div style="color:var(--txt3);font-size:14px;padding:20px 0">Nenhuma senha cadastrada.</div>'
      }
    </div>`;
  openModal('senha-ov');
}


/* ======================================================
   PROCESSOS VINCULADOS
====================================================== */
const expandedByMod={cessoes:new Set(),rpv:new Set(),encerrados:new Set(),requerimentos:new Set()};
let vPaiId=null;
let vMod=null;

function toggleExpand(mod,id){
  const s=expandedByMod[mod];
  s.has(id)?s.delete(id):s.add(id);
  render(mod);
}

function desvincular(mod,filhoId){
  if(!confirm('Desvincular este processo do processo pai?'))return;
  const data=load(mod);
  const filhoIdx=data.findIndex(r=>r.id===filhoId);
  if(filhoIdx===-1)return;
  const filho=data[filhoIdx];
  if(filho.vinculoPai){
    const paiIdx=data.findIndex(r=>r.id===filho.vinculoPai);
    if(paiIdx!==-1){
      const pai=data[paiIdx];
      data[paiIdx]={...pai,vinculosFilhos:(pai.vinculosFilhos||[]).filter(x=>x!==filhoId)};
    }
  }
  const{vinculoPai,...semVinculo}=filho;
  data[filhoIdx]=semVinculo;
  save(mod,data);
  render(mod);
  updateDash();
}

function openVinculo(mod,paiId){
  vMod=mod;vPaiId=paiId;
  const data=load(mod);
  const pai=data.find(r=>r.id===paiId);
  if(!pai)return;
  document.getElementById('vinculo-body').innerHTML=`
    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:var(--txt2);margin-bottom:12px">Processo pai: <strong style="color:var(--gold2)">${esc(pai.numeroProcesso)}</strong></div>
      <input id="vinculo-search" class="finp" placeholder="🔍 Filtrar por número, cedente ou cessionário…" oninput="filterVinculo()" style="margin-bottom:12px">
    </div>
    <div id="vinculo-list">${renderVinculoList(data.filter(r=>r.id!==paiId&&!r.vinculoPai))}</div>`;
  openModal('vinculo-ov');
}

function filterVinculo(){
  const q=normKw(document.getElementById('vinculo-search').value);
  /* Excluir o próprio pai, processos que já são filhos de alguém,
     E processos que já são pais de outros (evita hierarquia multinível). */
  const data=load(vMod).filter(r=>r.id!==vPaiId&&!r.vinculoPai&&!(r.vinculosFilhos&&r.vinculosFilhos.length)&&(
    !q||
    normKw(r.numeroProcesso||'').includes(q)||
    normKw(r.cedente||'').includes(q)||
    normKw(r.cessionario||'').includes(q)
  ));
  document.getElementById('vinculo-list').innerHTML=renderVinculoList(data);
}

function renderVinculoList(items){
  if(!items.length)return'<p style="color:var(--txt3);font-size:13px;padding:8px 0">Nenhum processo disponível para vinculação.</p>';
  return items.map(r=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px;border:1px solid var(--brd);border-radius:7px;margin-bottom:7px">
      <div>
        <div style="font-size:12.5px;font-weight:600;color:var(--txt)">${esc(r.numeroProcesso)}</div>
        <div style="font-size:11px;color:var(--txt3);margin-top:2px">${esc(r.advogado||'')} ${r.cedente?'· '+esc(r.cedente):''}</div>
      </div>
      <button class="btn btn-gold btn-xs" onclick="vincularProcesso('${escJs(r.id)}')">Vincular</button>
    </div>`).join('');
}

function vincularProcesso(filhoId){
  const data=load(vMod);
  const paiIdx=data.findIndex(r=>r.id===vPaiId);
  const filhoIdx=data.findIndex(r=>r.id===filhoId);
  if(paiIdx===-1||filhoIdx===-1)return;
  const pai=data[paiIdx],filho=data[filhoIdx];
  /* Validação anti-ciclo: o filho não pode ser ancestral do pai. */
  if(filho.vinculosFilhos&&filho.vinculosFilhos.length){
    showToast('Não é possível vincular: este processo já é pai de outros.');return;
  }
  if(filho.id===pai.vinculoPai){
    showToast('Vínculo cíclico detectado. Operação cancelada.');return;
  }
  /* Se filho já estava vinculado a outro pai, desvincula primeiro. */
  if(filho.vinculoPai&&filho.vinculoPai!==vPaiId){
    const oldPaiIdx=data.findIndex(r=>r.id===filho.vinculoPai);
    if(oldPaiIdx!==-1){
      const oldPai=data[oldPaiIdx];
      data[oldPaiIdx]={...oldPai,vinculosFilhos:(oldPai.vinculosFilhos||[]).filter(x=>x!==filhoId)};
    }
  }
  const novosFilhos=Array.isArray(pai.vinculosFilhos)?pai.vinculosFilhos.slice():[];
  if(!novosFilhos.includes(filhoId))novosFilhos.push(filhoId);
  data[paiIdx]={...pai,vinculosFilhos:novosFilhos};
  data[filhoIdx]={...filho,vinculoPai:vPaiId};
  save(vMod,data);
  closeModal('vinculo-ov');
  render(vMod);
  updateDash();
}

/* ======================================================
   INSTRUMENTO BADGE
====================================================== */
function instrBadge(v){
  if(!v)return'—';
  const n=v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
  if(n.includes('particular'))return`<span class="bdg bdg-grn">${esc(v)}</span>`;
  if(n.includes('registro'))return`<span class="bdg bdg-ylw">${esc(v)}</span>`;
  if(n.includes('escritura'))return`<span class="bdg bdg-red">${esc(v)}</span>`;
  return esc(v);
}

/* ======================================================
   OBJETO — lista ✓
====================================================== */
function objetoHtml(v){
  if(!v)return'—';
  const items=v.split(/\s+e\s+|[,;\n]+/).map(s=>s.trim()).filter(Boolean);
  if(!items.length)return'—';
  return'<div class="obj-list">'+items.map(item=>{
    const n=normKw(item);
    let label=item,cls='obj-bdg';
    if(n.includes('credito')&&n.includes('principal')){label='Crédito principal';cls='obj-bdg obj-bdg-blue';}
    else if(n.includes('honorario')&&n.includes('contratua')){label='Hon. contratuais';cls='obj-bdg obj-bdg-purple';}
    else if(n.includes('honorario')&&n.includes('sucumb')){label='Hon. sucumbenciais';cls='obj-bdg obj-bdg-marsala';}
    else if(n.includes('contratua')&&!n.includes('honorario')){label='Hon. contratuais';cls='obj-bdg obj-bdg-purple';}
    else if(n.includes('sucumb')){label='Hon. sucumbenciais';cls='obj-bdg obj-bdg-marsala';}
    else if((n.includes('agravo')||n.includes('ag.'))&&n.includes('instrumento')){label='Ag. de Instrumento';cls='obj-bdg obj-bdg-teal';}
    return`<div><span class="${cls}">${esc(label)}</span></div>`;
  }).join('')+'</div>';
}

/* ======================================================
   ÚLTIMA MOVIMENTAÇÃO (auto-calculada do histórico)
====================================================== */
const PARTY_PREFIXES=[
  'peticao','requerimento','recurso interposto','agravo interposto',
  'contrarrazoes','manifestacao das partes','juntada de documento','protocolo de peticao'
];

function normKw(s){
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim();
}

function isPartyAction(descricao){
  const d=normKw(descricao);
  return PARTY_PREFIXES.some(kw=>d.startsWith(kw));
}

function calcUltimaMovimentacao(rec){
  const hist=(rec.historicoProcessual||[]).slice().sort((a,b)=>(b.data||'').localeCompare(a.data||''));
  if(!hist.length)return'—';
  if(hist.length===1)return fmtDate(hist[0].data);
  for(const h of hist){
    if(!isPartyAction(h.descricao))return fmtDate(h.data);
  }
  return fmtDate(hist[0].data);
}

/* ======================================================
   HISTORY / TIMELINE
====================================================== */
let hMod=null,hId=null;

function openHist(mod,id){
  hMod=mod;hId=id;
  const data=load(mod);
  const rec=data.find(r=>r.id===id);
  if(!rec)return;
  document.getElementById('hist-proc').textContent=rec.numeroProcesso||'';
  renderHistBody(rec);
  switchHistTab('historico');
  openModal('hist-ov');
}

function switchHistTab(tab){
  ['historico','diligencias'].forEach(t=>{
    document.getElementById('hist-tab-content-'+t).style.display=t===tab?'block':'none';
    const btn=document.getElementById('hist-tab-'+(t==='historico'?'hist':'dil'));
    btn.style.color=t===tab?'#6e7dbb':'#6b7280';
    btn.style.borderBottom=t===tab?'2px solid #6e7dbb':'2px solid transparent';
  });
  if(tab==='diligencias')loadDiligencias();
}

async function loadDiligencias(){
  if(!document.getElementById('hist-ov').classList.contains('on')) return;
  const el=document.getElementById('hist-tab-content-diligencias');
  el.innerHTML='<div style="padding:20px;text-align:center;color:#6b7280;font-size:13px"><div class="spin"></div> Carregando diligências...</div>';
  try{
    const data=load(hMod);
    const rec=data.find(r=>r.id===hId);
    if(!rec){if(!document.getElementById('hist-ov').classList.contains('on')) return;el.innerHTML='<div style="padding:20px;text-align:center;color:#6b7280">Processo não encontrado.</div>';return;}
    const num=rec.numeroProcesso;

    // Usar o mesmo proxy Supabase que o syncAdvbox usa (evita CORS)
    const{data:{session}}=await sb.auth.getSession();
    const hdrs={...(session?.access_token?{'Authorization':'Bearer '+session.access_token}:{}),'apikey':_SB_KEY};
    const _PROXY=`${_SB_URL}/functions/v1/advbox-proxy`;

    async function _proxyGet(url){
      const r=await fetch(url,{headers:hdrs});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const body=await r.text();
      if(body.trimStart().startsWith('<'))throw new Error('Token Advbox expirado ou inválido');
      return JSON.parse(body);
    }

    // 1. Buscar lawsuit pelo número do processo
    const lawsuitsData=await _proxyGet(`${_PROXY}?action=lawsuits&process_number=${encodeURIComponent(num)}`);
    const lawsuits=Array.isArray(lawsuitsData)?lawsuitsData:(lawsuitsData.results||lawsuitsData.data||[]);
    const lawsuit=lawsuits[0];
    if(!lawsuit){
      el.innerHTML='<div style="padding:20px;text-align:center;color:#6b7280;font-size:13px">Processo não encontrado no Advbox.</div>';
      return;
    }

    // 2. Buscar histórico completo via /history/{lawsuit_id} (pending + completed)
    try{
      const histData=await _proxyGet(`${_PROXY}?action=history&lawsuit_id=${lawsuit.id}`);
      const all=Array.isArray(histData)?histData:(histData.data||histData.results||[]);

      if(!all.length){
        if(!document.getElementById('hist-ov').classList.contains('on')) return;
        el.innerHTML='<div style="padding:20px;text-align:center;color:#6b7280;font-size:13px">Nenhuma diligência registrada para este processo.</div>';
        return;
      }

      // /history usa campos diferentes: start (data), comments (notas), author/responsible (usuários)
      const sorted=all.slice().sort((a,b)=>new Date(b.start||b.created_at||0)-new Date(a.start||a.created_at||0));

      if(!document.getElementById('hist-ov').classList.contains('on')) return;
      el.innerHTML='<div class="tl">'+sorted.map((p,i)=>{
        const date=p.start||p.created_at||'';
        const task=p.task||'';
        const notes=p.comments||p.notes||'';
        const deadline=p.date_deadline||'';
        const concluded=(p.status==='completed')||(p.completed!=null&&p.completed!==false);
        const responsible=p.responsible||p.author||'';
        const nid=`dil-n-${i}`;
        const deadlineHtml=deadline
          ?`<span style="font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);color:#fbbf24">Prazo: ${fmtDate(normDate(deadline))}</span>`
          :'';
        const checkHtml=concluded
          ?`<span style="font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.35);color:#4ade80">✓ Concluída</span>`
          :'';
        return`<div class="tl-item">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap">
            <div class="tl-date">${fmtDate(normDate(date))}</div>
            ${deadlineHtml}
            ${checkHtml}
          </div>
          <div class="tl-desc" style="font-weight:600;color:#e2e8f0">${esc(task)}</div>
          ${notes?`<div class="tl-desc" style="margin-top:4px">
              <div id="${nid}" style="overflow:hidden;line-height:1.55em;max-height:calc(1.55em * 3)">${esc(notes)}</div>
              <span id="${nid}-btn" style="display:none;font-size:11px;color:var(--blue2);cursor:pointer;margin-top:3px"
                onclick="(function(el,btn){var exp=el.dataset.exp==='1';el.style.maxHeight=exp?'calc(1.55em * 3)':'none';el.dataset.exp=exp?'':'1';btn.textContent=exp?'ler mais ▾':'ler menos ▴'})(document.getElementById('${nid}'),this)">ler mais ▾</span>
          </div>`:''}
          ${responsible?`<div class="tl-desc" style="margin-top:2px;font-size:10px;color:#6b7280">${esc(responsible)}</div>`:''}
        </div>`;
      }).join('')+'</div>';
      // Após render: mostrar botão apenas onde o texto transborda 3 linhas
      setTimeout(()=>{
        sorted.forEach((_,i)=>{
          const noteEl=document.getElementById(`dil-n-${i}`);
          if(noteEl&&noteEl.scrollHeight>noteEl.clientHeight+1){
            const btn=document.getElementById(`dil-n-${i}-btn`);
            if(btn)btn.style.display='block';
          }
        });
      },50);
    }catch(e){
      if(!document.getElementById('hist-ov').classList.contains('on')) return;
      el.innerHTML=`<div style="padding:20px;text-align:center;color:#f87171;font-size:13px">Erro ao carregar diligências: ${esc(e.message)}</div>`;
      return;
    }
  }catch(e){
    if(!document.getElementById('hist-ov').classList.contains('on')) return;
    el.innerHTML=`<div style="padding:20px;text-align:center;color:#f87171;font-size:13px">Erro ao carregar diligências: ${esc(e.message)}</div>`;
  }
}

const _MOV_BADGES=[
  {pattern:/^\s*(decisão|decisao)\b/i,                                                        label:'Decisão',    bg:'#b45309'},
  {pattern:/^\s*(despacho)\b/i,                                                               label:'Despacho',   bg:'#b45309'},
  {pattern:/^\s*(sentença|sentenca)\b/i,                                                      label:'Sentença',   bg:'#c2410c'},
  {pattern:/^\s*(acórdão|acordao)\b/i,                                                        label:'Acórdão',    bg:'#c2410c'},
  {pattern:/^\s*(rpv\s*exp|requisição.*pequeno.*valor.*exp|requisicao.*pequeno.*valor.*exp)/i,label:'RPV Expedida',bg:'#047857'},
];

function _movBadge(desc){
  const hit=_MOV_BADGES.find(b=>b.pattern.test(desc));
  if(!hit)return'';
  return`<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:${hit.bg};color:#fff;white-space:nowrap">${hit.label}</span>`;
}

function renderHistBody(rec){
  const hist=rec.historicoProcessual||[];
  const sorted=hist.slice().sort((a,b)=>(b.data||'').localeCompare(a.data||''));
  const tlHtml=hist.length===0
    ?'<p style="color:var(--txt3);font-size:13px;padding:8px 0">Nenhuma entrada no histórico.</p>'
    :`<div class="tl">${sorted.map((h,si)=>{
      const badge=_movBadge(h.descricao||'');
      return`
      <div class="tl-item" id="tl-item-${si}">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;flex-wrap:wrap">
          <div class="tl-date">${fmtDate(h.data)}</div>
          ${badge}
        </div>
        <div class="tl-desc">${esc(h.descricao||'')}</div>
      </div>`;}).join('')}</div>`;

  document.getElementById('hist-tab-content-historico').innerHTML=tlHtml;
  document.getElementById('hist-add').innerHTML='';
}

function addHistEntry(){
  const dEl=document.getElementById('h-date');
  const tEl=document.getElementById('h-desc');
  if(!dEl||!tEl)return;
  const d=dEl.value;
  const t=tEl.value.trim();
  if(!d||!t){alert('Preencha a data e a descrição.');return;}
  const data=load(hMod);
  const idx=data.findIndex(r=>r.id===hId);
  if(idx===-1)return;
  /* Imutável: cria nova lista ordenada e substitui slot.
     Adiciona uid no entry para auditabilidade e edição segura. */
  const novoHist=[...((data[idx].historicoProcessual)||[]),{id:uid(),data:d,descricao:t,createdAt:new Date().toISOString()}];
  novoHist.sort((a,b)=>new Date(a.data)-new Date(b.data));
  data[idx]={...data[idx],historicoProcessual:novoHist};
  save(hMod,data);
  renderHistBody(data[idx]);
  render(hMod);updateDash();
}

function delHistEntry(si){
  if(!confirm('Remover esta entrada?'))return;
  const data=load(hMod);
  const idx=data.findIndex(r=>r.id===hId);
  if(idx===-1)return;
  const rec=data[idx];
  const sorted=(rec.historicoProcessual||[]).slice().sort((a,b)=>b.data.localeCompare(a.data));
  const target=sorted[si];
  if(!target)return;
  /* Match por id (preferido) para evitar problemas com índice desatualizado em realtime. */
  const novoHist=(rec.historicoProcessual||[]).filter(h=>target.id?h.id!==target.id:!(h.data===target.data&&h.descricao===target.descricao));
  data[idx]={...rec,historicoProcessual:novoHist};
  save(hMod,data);
  renderHistBody(data[idx]);
  render(hMod);updateDash();
}

function editHistEntry(si){
  const item=document.getElementById('tl-item-'+si);
  if(!item)return;
  const data=load(hMod);
  const rec=data.find(r=>r.id===hId);
  if(!rec)return;
  const sorted=(rec.historicoProcessual||[]).slice().sort((a,b)=>b.data.localeCompare(a.data));
  const h=sorted[si];
  if(!h)return;
  const realIdx=rec.historicoProcessual.indexOf(h);
  const inp='background:rgba(255,255,255,.05);border:1px solid var(--brd);border-radius:6px;padding:5px 9px;color:var(--txt);font-size:12px;outline:none;width:100%;display:block;font-family:inherit';
  item.innerHTML=`
    <input type="date" id="tl-ed-date-${si}" value="${h.data}" style="${inp};margin-bottom:6px">
    <input type="text" id="tl-ed-desc-${si}" value="${esc(h.descricao)}" style="${inp};margin-bottom:8px" onkeydown="if(event.key==='Enter')saveHistEdit(${si},${realIdx});if(event.key==='Escape')cancelHistEdit()">
    <div style="display:flex;gap:5px">
      <button class="btn btn-gold btn-xs" onclick="saveHistEdit(${si},${realIdx})">✓ Salvar</button>
      <button class="btn btn-blue btn-xs" onclick="cancelHistEdit()">Cancelar</button>
    </div>`;
  const descInput=document.getElementById('tl-ed-desc-'+si);
  if(descInput){descInput.focus();descInput.select();}
}

function saveHistEdit(si,realIdx){
  const d=document.getElementById('tl-ed-date-'+si)?.value;
  const t=document.getElementById('tl-ed-desc-'+si)?.value.trim();
  if(!d||!t){alert('Preencha a data e a descrição.');return;}
  const data=load(hMod);
  const idx=data.findIndex(r=>r.id===hId);
  if(idx===-1)return;
  const rec=data[idx];
  if(realIdx===undefined||!(rec.historicoProcessual||[])[realIdx])return;
  /* Imutável + preserva campos extras (id, createdAt) na entry editada. */
  const original=rec.historicoProcessual[realIdx];
  const novoHist=rec.historicoProcessual.slice();
  novoHist[realIdx]={...original,data:d,descricao:t,updatedAt:new Date().toISOString()};
  novoHist.sort((a,b)=>new Date(a.data)-new Date(b.data));
  data[idx]={...rec,historicoProcessual:novoHist};
  save(hMod,data);
  renderHistBody(data[idx]);
  render(hMod);updateDash();
}

function cancelHistEdit(){
  const data=load(hMod);
  const rec=data.find(r=>r.id===hId);
  if(rec)renderHistBody(rec);
}

/* ======================================================
   CONTATOS
====================================================== */
let _contatosRows=[];

function renderContatos(){
  const orgMap={};
  [...CACHE.cessoes,...CACHE.rpv,...CACHE.requerimentos].forEach(r=>{
    const org=(r.orgaoJulgador||'').trim();
    if(!org)return;
    if(!orgMap[org])orgMap[org]={orgaoJulgador:org,tribunal:(r.tribunal||'').trim()};
  });
  const allRows=Object.values(orgMap).sort((a,b)=>a.orgaoJulgador.localeCompare(b.orgaoJulgador,'pt-BR',{sensitivity:'base'}));
  const _ctQ=(document.getElementById('fct-q')||{}).value||'';
  const ctQ=_ctQ.trim().toLowerCase();
  const rows=ctQ?allRows.filter(o=>{
    const c=CACHE.contatos.find(x=>(x.orgaoJulgador||'').trim()===o.orgaoJulgador);
    return o.orgaoJulgador.toLowerCase().includes(ctQ)||
      (o.tribunal||'').toLowerCase().includes(ctQ)||
      [c?.whatsapp_serventia,c?.whatsapp_gabinete,c?.telefone_serventia,c?.telefone_gabinete,c?.email_serventia,c?.email_gabinete].some(v=>v&&v.toLowerCase().includes(ctQ));
  }):allRows;
  _contatosRows=rows;

  const ps=PS.contatos;
  const page=PG.contatos;
  const paged=ps===0?rows:rows.slice((page-1)*ps,page*ps);

  const tb=document.getElementById('tb-contatos');
  if(!rows.length){
    tb.innerHTML=`<tr><td colspan="6"><div class="empty"><div class="empty-ico">📞</div><div class="empty-txt">Nenhum órgão julgador encontrado nas cessões, RPV ou diversos</div></div></td></tr>`;
    renderPgn('pg-contatos',0,'contatos');
    return;
  }

  function stackedCell(v1,v2,isLink=false,isWa=false){
    if(!v1&&!v2)return'—';
    function line(label,val){
      if(!val)return'';
      let content=esc(val);
      if(isWa){const d=val.replace(/\D/g,'');if(d)content=`<a href="https://wa.me/55${d}" target="_blank" rel="noopener" style="color:var(--grn2)">${esc(val)}</a>`;}
      else if(isLink)content=`<a href="mailto:${esc(val)}" style="color:var(--blue2)">${esc(val)}</a>`;
      return`<div><span style="color:var(--txt3)">${label}:</span> ${content}</div>`;
    }
    const l1=line('Serventia',v1),l2=line('Gabinete',v2);
    if(l1&&l2)return`<div style="font-size:11px;color:var(--txt2)">${l1}<div style="margin-top:2px">${l2}</div></div>`;
    return`<div style="font-size:11px;color:var(--txt2)">${l1||l2}</div>`;
  }

  tb.innerHTML=paged.map(org=>{
    const c=CACHE.contatos.find(x=>(x.orgaoJulgador||'').trim()===org.orgaoJulgador);
    const waCell =stackedCell(c?.whatsapp_serventia||'',c?.whatsapp_gabinete||'',false,true);
    const telCell=stackedCell(c?.telefone_serventia||'',c?.telefone_gabinete||'');
    const emCell =stackedCell(c?.email_serventia||'',c?.email_gabinete||'',true);
    return`<tr>
      <td title="${esc(org.orgaoJulgador)}">${esc(org.orgaoJulgador)}</td>
      <td>${esc(org.tribunal)||'—'}</td>
      <td>${waCell}</td>
      <td>${telCell}</td>
      <td>${emCell}</td>
      <td><button class="btn btn-blue btn-xs" onclick="editContato('${escJs(org.orgaoJulgador)}')">Editar</button></td>
    </tr>`;
  }).join('');
  renderPgn('pg-contatos',rows.length,'contatos');
}

function contatoBadge(mod,r){
  const org=(r.orgaoJulgador||'').trim();
  if(!org){
    return`<button class="btn btn-blue btn-xs" style="opacity:.35;cursor:not-allowed" title="Sem órgão julgador" disabled><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 2.5c0-.3.2-.5.5-.5h1.8l.8 2-1.1.8c.5 1 1.2 1.8 2.2 2.2l.8-1.1 2 .8v1.8c0 .3-.2.5-.5.5C4.5 9.5 1.5 6.5 2 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>`;
  }
  const c=CACHE.contatos.find(x=>(x.orgaoJulgador||'').trim()===org);
  const hasInfo=c&&(c.whatsapp_serventia||c.whatsapp_gabinete||c.telefone_serventia||c.telefone_gabinete||c.email_serventia||c.email_gabinete);
  if(!hasInfo){
    return`<button class="btn btn-blue btn-xs" style="opacity:.35;cursor:not-allowed" title="Sem contato cadastrado" disabled><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 2.5c0-.3.2-.5.5-.5h1.8l.8 2-1.1.8c.5 1 1.2 1.8 2.2 2.2l.8-1.1 2 .8v1.8c0 .3-.2.5-.5.5C4.5 9.5 1.5 6.5 2 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>`;
  }
  return`<button class="btn btn-grn btn-xs" onclick="openContatoModal('${mod}','${r.id}')" title="Ver contato"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 2.5c0-.3.2-.5.5-.5h1.8l.8 2-1.1.8c.5 1 1.2 1.8 2.2 2.2l.8-1.1 2 .8v1.8c0 .3-.2.5-.5.5C4.5 9.5 1.5 6.5 2 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>`;
}

function openContatoModal(mod,id){
  const rec=CACHE[mod].find(r=>r.id===id);
  if(!rec)return;
  const org=(rec.orgaoJulgador||'').trim();
  const c=CACHE.contatos.find(x=>(x.orgaoJulgador||'').trim()===org);
  document.getElementById('contato-title').textContent=org;
  if(!c){
    document.getElementById('contato-body').innerHTML='<p style="color:var(--txt3);font-size:13px">Nenhum contato cadastrado para este órgão julgador.</p>';
    openModal('contato-ov');
    return;
  }

  function _lbl(t){return`<span style="font-size:10px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.06em;font-family:var(--font-body)">${t}</span>`;}
  function _row2(label1,val1,label2,val2,isWa=false){
    function cell(label,val){
      if(!val)return'';
      const digits=val.replace(/\D/g,'');
      const waBtn=isWa&&digits?` <a href="https://wa.me/55${digits}" target="_blank" rel="noopener" class="btn btn-grn btn-xs" style="text-decoration:none;margin-left:6px;font-size:10px">📲 Abrir</a>`:'';
      return`<div style="font-size:13px;color:var(--txt);font-family:var(--font-body);display:flex;align-items:center;flex-wrap:wrap;gap:4px"><span style="color:var(--txt3);font-size:11px">${label}:</span>${esc(val)}${waBtn}</div>`;
    }
    const c1=cell(label1,val1);
    const c2=cell(label2,val2);
    if(!c1&&!c2)return'';
    let out=c1||'';
    if(c2)out+=`<div style="margin-top:3px">${c2}</div>`;
    return out;
  }
  function _emailRow(l1,v1,l2,v2){
    function ecell(label,val){
      if(!val)return'';
      return`<div style="font-size:13px;color:var(--txt);font-family:var(--font-body);display:flex;align-items:center;gap:4px"><span style="color:var(--txt3);font-size:11px">${label}:</span><a href="mailto:${esc(val)}" style="color:var(--blue2)">${esc(val)}</a></div>`;
    }
    const c1=ecell(l1,v1),c2=ecell(l2,v2);
    if(!c1&&!c2)return'';
    return(c1||'')+(c2?`<div style="margin-top:3px">${c2}</div>`:'');
  }

  const waSec=_row2('Serventia',c.whatsapp_serventia||'','Gabinete',c.whatsapp_gabinete||'',true);
  const telSec=_row2('Serventia',c.telefone_serventia||'','Gabinete',c.telefone_gabinete||'',false);
  const emSec=_emailRow('Serventia',c.email_serventia||'','Gabinete',c.email_gabinete||'');
  const pref=(c.contato_preferencial||c.contatoPreferencial||'').replace(/ Serventia| Gabinete/g,'');

  let html=`<div style="display:flex;flex-direction:column;gap:12px">`;
  html+=`<div>${_lbl('Tribunal')}<div style="font-size:13px;color:var(--txt);margin-top:4px">${esc(c.tribunal||rec.tribunal||'')||'—'}</div></div>`;
  if(waSec)html+=`<div>${_lbl('WhatsApp')}<div style="margin-top:6px">${waSec}</div></div>`;
  if(telSec)html+=`<div>${_lbl('Telefone')}<div style="margin-top:6px">${telSec}</div></div>`;
  if(emSec)html+=`<div>${_lbl('E-mail')}<div style="margin-top:6px">${emSec}</div></div>`;
  if(c.horario)html+=`<div>${_lbl('Horário')}<div style="font-size:13px;color:var(--txt);margin-top:4px">${esc(c.horario)}</div></div>`;
  if(pref)html+=`<div>${_lbl('Contato Preferencial')}<div style="margin-top:4px"><span class="bdg bdg-blue">${esc(pref)}</span></div></div>`;
  html+=`</div>`;
  document.getElementById('contato-body').innerHTML=html;
  openModal('contato-ov');
}

function editContato(orgName){
  const org=_contatosRows.find(o=>o.orgaoJulgador===orgName);
  if(!org)return;
  const existing=CACHE.contatos.find(c=>(c.orgaoJulgador||'').trim()===org.orgaoJulgador.trim());
  curMod='contatos';
  curId=existing?existing.id:null;
  document.getElementById('form-title').innerHTML=`Contato<div style="font-size:11px;font-weight:400;color:var(--txt3);margin-top:2px;letter-spacing:0;text-transform:none">${esc(org.orgaoJulgador)}</div>`;
  document.getElementById('form-body').innerHTML=buildForm('contatos',existing||{
    orgaoJulgador:org.orgaoJulgador,tribunal:org.tribunal,
    whatsapp_serventia:'',whatsapp_gabinete:'',
    telefone_serventia:'',telefone_gabinete:'',
    email_serventia:'',email_gabinete:'',
    horario:'',contato_preferencial:'',contatoPreferencial:''
  });
  openModal('form-ov');
  ['cont-ws','cont-wg','cont-ts','cont-tg'].forEach(id=>{
    const el=document.getElementById('f-'+id);
    if(el&&el.value)maskPhone(el);
  });
}

/* ======================================================
   ÓRGÃOS AUXILIARES
====================================================== */
function renderAuxiliares(){
  const tbody=document.getElementById('tbody-aux');
  if(!tbody)return;
  if(!CACHE_AUX.length){
    tbody.innerHTML='<tr><td colspan="7" class="empty">Nenhum órgão auxiliar cadastrado.</td></tr>';
    return;
  }
  tbody.innerHTML=CACHE_AUX.map(c=>`
    <tr>
      <td style="font-size:12px">${esc(c.orgao||'')}</td>
      <td style="font-size:11px;color:#94a3b8">${esc(c.tribunal||'')||'—'}</td>
      <td style="font-size:11px;color:#94a3b8">${esc(c.whatsapp||'')||'—'}</td>
      <td style="font-size:11px;color:#94a3b8">${esc(c.telefone||'')||'—'}</td>
      <td style="font-size:11px;color:#94a3b8">${esc(c.email||'')||'—'}</td>
      <td><button class="btn btn-blue btn-xs" onclick="editAux('${esc(c.id)}')">Editar</button></td>
      <td><button class="btn btn-red btn-xs" onclick="deleteAux('${esc(c.id)}')">Excluir</button></td>
    </tr>`).join('');
}

async function loadAuxiliares(){
  const {data,error}=await sb.from('contatos_auxiliares').select('*');
  CACHE_AUX=(!error&&data)?data:[];
  renderAuxiliares();
}

function openAuxModal(c){
  c=c||{};
  curAuxId=c.id||null;
  const title=document.getElementById('aux-title');
  if(curAuxId){
    title.innerHTML=`Órgão Auxiliar<div style="font-size:11px;font-weight:400;color:var(--txt3);margin-top:2px;letter-spacing:0;text-transform:none">${esc(c.orgao||'')}</div>`;
  } else {
    title.textContent='Novo Órgão Auxiliar';
  }
  document.getElementById('aux-body').innerHTML=`
    <div class="fgrid">
      ${fg('Órgão',fi('aux-orgao',c.orgao||''))}
      ${fg('Tribunal',fi('aux-tribunal',c.tribunal||''))}
      ${fg('WhatsApp',fi('aux-wa',c.whatsapp||'','tel','(00) 00000-0000'))}
      ${fg('Telefone',fi('aux-tel',c.telefone||'','tel','(00) 0000-0000'))}
      ${fg('E-mail',fi('aux-email',c.email||'','email'))}
      ${fg('Horário de Atendimento',fi('aux-horario',c.horario||'','text','Ex: 08h às 17h'))}
      ${fg('Contato Preferencial',fsel('aux-pref',c.contato_preferencial||'',['WhatsApp','Telefone','E-mail']))}
    </div>`;
  openModal('aux-ov');
  ['aux-wa','aux-tel'].forEach(id=>{
    const el=document.getElementById('f-'+id);
    if(el&&el.value)maskPhone(el);
    if(el){el.oninput=()=>maskPhone(el);}
  });
}

function editAux(id){
  const c=CACHE_AUX.find(x=>x.id===id);
  if(!c)return;
  openAuxModal(c);
}

async function saveAux(){
  const rec={
    id:curAuxId||uid(),
    orgao:gf('aux-orgao'),
    tribunal:gf('aux-tribunal'),
    whatsapp:gf('aux-wa'),
    telefone:gf('aux-tel'),
    email:gf('aux-email'),
    horario:gf('aux-horario'),
    contato_preferencial:gf('aux-pref'),
    updated_at:new Date().toISOString()
  };
  if(!rec.orgao){alert('O nome do órgão é obrigatório.');return;}
  const{error}=await sb.from('contatos_auxiliares').upsert(rec,{onConflict:'id'});
  if(error){alert('Erro ao salvar: '+error.message);return;}
  closeModal('aux-ov');
  loadAuxiliares();
}

async function deleteAux(id){
  if(!confirm('Excluir este órgão auxiliar?'))return;
  const{error}=await sb.from('contatos_auxiliares').delete().eq('id',id);
  if(error){alert('Erro ao excluir: '+error.message);return;}
  loadAuxiliares();
}

/* ======================================================
   PHONE MASK
====================================================== */
function maskPhone(el){
  let v=el.value.replace(/\D/g,'');
  if(v.length>11)v=v.slice(0,11);
  if(!v.length){el.value='';return;}
  let r='';
  if(v.length<=2){r='('+v;}
  else if(v.length<=6){r='('+v.slice(0,2)+') '+v.slice(2);}
  else if(v.length<=10){r='('+v.slice(0,2)+') '+v.slice(2,6)+'-'+v.slice(6);}
  else{r='('+v.slice(0,2)+') '+v.slice(2,7)+'-'+v.slice(7);}
  el.value=r;
}

/* ======================================================
   ADVBOX SYNC
====================================================== */
function _sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function _limparDescricao(txt){
  if(!txt||txt==='(sem descrição)')return txt;
  let s=txt.trim();
  // Remover padrões verbosos típicos do Advbox
  s=s.replace(/\(referente\s+[^)]{0,200}\)/gi,'');  // (referente À Mov. ...)
  s=s.replace(/\(cnj:[^)]*\)/gi,'');                 // (cnj:12444 - )
  s=s.replace(/\bem\s+\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/gi,''); // Em 11/03/2026 23:59:59
  s=s.replace(/-\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}/g,'');     // - 02/04/2026 15:17:47
  s=s.replace(/\(\s*\)/g,'');                        // parênteses vazios residuais
  // Title case
  s=s.toLowerCase()
    .replace(/(^|[\s\-\(\/→])(\S)/g,(_,sep,c)=>sep+c.toUpperCase());
  // Remove palavras ou pares de palavras duplicados consecutivos
  s=s.replace(/\b(\w+(?:\s+\w+)?)\s+\1\b/gi,'$1');
  // Limpa espaços múltiplos e hífens finais
  return s.replace(/\s{2,}/g,' ').replace(/[-–]\s*$/,'').trim();
}

function _syncProgressShow(){
  let el=document.getElementById('_syncProg');
  if(!el){
    el=document.createElement('div');
    el.id='_syncProg';
    el.style.cssText='position:fixed;right:24px;bottom:24px;width:min(420px,calc(100vw - 48px));background:#15181e;color:#f4f7fb;padding:14px 16px;border:1px solid rgba(140,154,208,.26);border-radius:10px;z-index:9998;font-size:12px;display:grid;gap:9px;box-shadow:0 22px 60px rgba(0,0,0,.38),0 0 0 1px rgba(110,125,187,.08);overflow:hidden';
    document.body.appendChild(el);
  }
  return el;
}
function _syncProgressUpdate(el,{label,pct,sub}){
  el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;gap:14px">
    <div style="display:flex;align-items:center;gap:9px;min-width:0">
      <span style="width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:rgba(110,125,187,.18);color:#8fd0ff;font-size:11px;flex-shrink:0">↻</span>
      <b style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</b>
    </div>
    <span style="color:#8fd0ff;font-size:12px;font-weight:800;flex-shrink:0">${pct}%</span>
  </div>
  ${sub?`<div style="color:#8793a3;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:27px">${sub}</div>`:''}
  <div style="background:#242a35;border-radius:999px;height:5px;overflow:hidden"><div style="background:#6e7dbb;height:100%;width:${pct}%;transition:width .35s ease;border-radius:999px"></div></div>`;
}
function _syncProgressHide(el){el?.remove();}

/* Versão atual do schema das diligências salvas em r._advboxDiligencias.
   Incrementa quando novos campos são adicionados ao objeto salvo. Usada para
   detectar caches velhos e forçar re-fetch, ignorando a otimização (A). */
const DILIGENCIA_SCHEMA_VER = 2;

/* Calcula uma "assinatura" do objeto lawsuit retornado pela Advbox para
   detectar se houve mudança desde a última sincronização. Tenta nomes comuns
   de campos de "última atualização" + indicadores derivados. Se nenhum dos
   candidatos existir, retorna null e a otimização (A) fica desabilitada
   para esse registro — o fluxo normal de fetch acontece. */
function _advboxLawsuitSig(lawsuit){
  if(!lawsuit||typeof lawsuit!=='object')return null;
  const parts=[
    lawsuit.updated_at, lawsuit.updated_on, lawsuit.modified_at, lawsuit.modified_on,
    lawsuit.date_updated, lawsuit.last_update,
    lawsuit.last_movement_at, lawsuit.last_movement_date, lawsuit.last_movement,
    lawsuit.movements_count, lawsuit.total_movements,
    lawsuit.posts_count, lawsuit.activities_count
  ].filter(v=>v!==undefined&&v!==null&&v!=='');
  return parts.length?parts.map(String).join('|'):null;
}

async function syncAdvbox(opts){
  const force = !!(opts && opts.force);
  const btn=document.getElementById('sync-btn');
  if(!btn||btn.disabled)return;
  if(!_secrets.advbox()){showToast('Token Advbox não configurado.');return;}

  const mods=['cessoes','rpv','requerimentos'];
  const allRecs=[];
  for(const mod of mods) load(mod).forEach(r=>{if(r.numeroProcesso)allRecs.push({mod,rec:r});});
  if(!allRecs.length){showToast('Nenhum processo encontrado.');return;}

  btn.disabled=true;
  btn.innerHTML=`<span style="display:inline-block;animation:spin .7s linear infinite">⟳</span> Sincronizando…`;

  const prog=_syncProgressShow();
  const{data:{session}}=await sb.auth.getSession();
  const hdrs={...(session?.access_token?{'Authorization':'Bearer '+session.access_token}:{}),'apikey':_SB_KEY};
  const _PROXY=`${_SB_URL}/functions/v1/advbox-proxy`;

  // Fetch helper com classificação de erros
  async function _advboxGet(url,label){
    let raw;
    try{raw=await fetch(url,{headers:hdrs});}
    catch(e){return{err:`Rede ${label}: ${e.message}`,retryable:true};}
    if(raw.status===204||raw.status===404) return{skip:true};
    let body='';
    try{body=await raw.text();}catch{}
    if(!raw.ok){
      let parsed={};
      try{parsed=JSON.parse(body);}catch{}
      const s=raw.status;
      const msg=parsed.error||
        (s===401||s===403?`Token Advbox expirado (${s})`
        :s===429?'Limite de requisições atingido'
        :body.trimStart().startsWith('<')?`Erro ${s} (resposta HTML da Advbox)`
        :`Erro ${s}: ${body.slice(0,120)}`);
      return{err:msg,retryable:s===429||s>=500};
    }
    if(!body.trim()) return{err:`${label}: resposta vazia`,retryable:true};
    if(body.trimStart().startsWith('<')) return{err:'Token Advbox expirado ou inválido — atualize nas configurações',retryable:false};
    try{return{data:JSON.parse(body)};}
    catch{return{err:`${label}: resposta inválida (${body.slice(0,80)})`,retryable:false};}
  }

  const total=allRecs.length;
  const st={done:0,synced:0,failed:0};
  const erros=[],pendentes=[],paraRetry=[];

  async function _buscarProcesso({mod,rec},tentativa=1){
    const labelFase=tentativa>1?`Tentativa ${tentativa}: Buscando movimentações`:'Buscando movimentações';
    _syncProgressUpdate(prog,{label:`${labelFase} (${st.done}/${total})`,pct:Math.round(st.done/total*100),sub:rec.numeroProcesso});

    const sr=await _advboxGet(`${_PROXY}?action=lawsuits&process_number=${encodeURIComponent(rec.numeroProcesso)}`,'lawsuits');
    if(sr.skip){if(tentativa===1)st.done++;await _sleep(2000);return;}
    const _upd=(sub)=>_syncProgressUpdate(prog,{label:`${labelFase} (${st.done}/${total})`,pct:Math.round(st.done/total*100),sub});
    if(sr.err){
      if(sr.retryable&&tentativa<3){paraRetry.push({mod,rec,tentativa:tentativa+1});}
      else{erros.push(`${rec.numeroProcesso}: ${sr.err}`);st.failed++;}
      if(tentativa===1)st.done++;
      _upd(rec.numeroProcesso);
      await _sleep(2000);return;
    }
    const lawsuits=Array.isArray(sr.data)?sr.data:(sr.data.results||sr.data.data||[]);
    if(!lawsuits.length){if(tentativa===1)st.done++;await _sleep(2000);return;}

    // (A) Skip cedo se a "assinatura" do lawsuit não mudou desde a última sync
    // E o schema das diligências salvas estiver atualizado E o sync não tiver
    // sido invocado com force=true (botão manual).
    const _arr0 = load(mod);
    const _idx0 = _arr0.findIndex(r=>r.id===rec.id);
    const newSig = _advboxLawsuitSig(lawsuits[0]);
    const savedSig = _idx0!==-1 ? (_arr0[_idx0]._advboxLawsuitSig||'') : '';
    const savedSchemaVer = _idx0!==-1 ? (_arr0[_idx0]._advboxDiligenciasSchemaVer||0) : 0;
    const schemaOk = savedSchemaVer >= DILIGENCIA_SCHEMA_VER;
    if(!force && newSig && savedSig && savedSig===newSig && schemaOk){
      // Assinatura igual + schema atualizado → sem mudanças. Pula /movements e /history.
      if(tentativa===1)st.done++;
      _upd(rec.numeroProcesso+' · sem mudança');
      await _sleep(500);
      return;
    }

    const mr=await _advboxGet(`${_PROXY}?action=movements&lawsuit_id=${lawsuits[0].id}`,'movements');
    if(mr.err){
      if(mr.retryable&&tentativa<3){paraRetry.push({mod,rec,tentativa:tentativa+1});}
      else{erros.push(`${rec.numeroProcesso}: ${mr.err}`);st.failed++;}
      if(tentativa===1)st.done++;
      _upd(rec.numeroProcesso);
      await _sleep(2000);return;
    }
    // mr.skip (204/404) → processo existe mas sem movimentações tribunal; seguimos
    // para /history porque diligências são independentes das movimentações.
    const movs = mr.skip ? [] : (Array.isArray(mr.data)?mr.data:(mr.data.results||mr.data.data||[]));

    // Diligências (history) — best effort, falha não derruba processo
    const hr=await _advboxGet(`${_PROXY}?action=history&lawsuit_id=${lawsuits[0].id}`,'history');
    let openDils=null;
    if(!hr.skip && !hr.err){
      const histAll=Array.isArray(hr.data)?hr.data:(hr.data.data||hr.data.results||[]);
      openDils=histAll
        .filter(p=>p.date_deadline && !(p.status==='completed' || (p.completed!=null && p.completed!==false)))
        .map(p=>({
          task:String(p.task||'').slice(0,200),
          notes:String(p.comments||p.notes||'').slice(0,300),
          deadline:String(p.date_deadline).slice(0,10),
          responsible:String(p.responsible||p.author||'').slice(0,80)
        }));
    }

    const arr=load(mod);
    const idx=arr.findIndex(r=>r.id===rec.id);
    const histAtual=idx!==-1?(arr[idx].historicoProcessual||[]):[];
    const savedCount=idx!==-1?(arr[idx]._advboxMovCount||0):0;
    const movsChanged=movs.length>0 && !(movs.length===savedCount && histAtual.length);
    const curDils=idx!==-1?JSON.stringify(arr[idx]._advboxDiligencias||[]):'[]';
    const dilsChanged=openDils!==null && JSON.stringify(openDils)!==curDils;
    const savedSigCur = idx!==-1 ? (arr[idx]._advboxLawsuitSig||'') : '';
    const savedSchemaVerCur = idx!==-1 ? (arr[idx]._advboxDiligenciasSchemaVer||0) : 0;
    const sigNeedsUpdate = !!newSig && savedSigCur !== newSig;
    const schemaNeedsUpdate = openDils !== null && savedSchemaVerCur < DILIGENCIA_SCHEMA_VER;

    if(!movsChanged && !dilsChanged && !sigNeedsUpdate && !schemaNeedsUpdate){
      if(tentativa===1)st.done++;
      await _sleep(2000);
      return;
    }

    pendentes.push({mod,rec,arr,idx,movs,openDils,movsChanged,lawsuitSig:newSig,pi:pendentes.length});
    if(tentativa===1)st.done++;
    _upd(rec.numeroProcesso);
    await _sleep(2000);
  }

  // FASE 1 — primeira passagem
  for(const item of allRecs) await _buscarProcesso(item);

  // Retry automático para falhas transitórias (até 2 tentativas extras)
  while(paraRetry.length){
    const lote=[...paraRetry];
    paraRetry.length=0;
    const backoff=lote[0].tentativa===2?5000:10000;
    _syncProgressUpdate(prog,{label:`🔄 Repetindo ${lote.length} processo(s) com falha transitória…`,pct:100});
    await _sleep(backoff);
    for(const{mod,rec,tentativa}of lote) await _buscarProcesso({mod,rec},tentativa);
  }

  // FASE 2 — Salvar movimentações + diligências + assinatura do lawsuit
  if(pendentes.length){
    for(const[i,{mod,arr,idx,movs,openDils,movsChanged,lawsuitSig}]of pendentes.entries()){
      _syncProgressUpdate(prog,{label:`Salvando (${i+1}/${pendentes.length})`,pct:Math.round((i+1)/pendentes.length*100)});
      if(idx===-1){st.synced++;continue;}
      let updated=arr[idx];
      if(movsChanged){
        const hist=movs.map(mv=>{
          const data=(mv.date||(mv.created_at?mv.created_at.slice(0,10):'')||'').slice(0,10);
          const descricao=_limparDescricao((mv.description||mv.text||mv.content||mv.title||'(sem descrição)').slice(0,1000));
          return{data,descricao};
        }).sort((a,b)=>a.data.localeCompare(b.data));
        updated={...updated,historicoProcessual:hist,_advboxMovCount:movs.length};
      }
      if(openDils!==null){
        updated={...updated,_advboxDiligencias:openDils,_advboxDiligenciasSchemaVer:DILIGENCIA_SCHEMA_VER};
      }
      if(lawsuitSig){
        updated={...updated,_advboxLawsuitSig:lawsuitSig};
      }
      arr[idx]=updated;
      save(mod,arr);
      st.synced++;
    }
  }

  _syncProgressHide(prog);
  btn.disabled=false;
  btn.innerHTML='↺ Sincronizar';

  // Registra "Última execução" — manual ou automática
  try {
    const cfg = _cfgAutosyncRead();
    cfg.lastRun = new Date().toISOString();
    _cfgAutosyncWrite(cfg);
    _cfgAutosyncLoad();
  } catch(e) { console.warn('[Credijuris] não foi possível registrar última execução:', e); }

  const todosAuthErr=st.failed>0&&erros.every(e=>e.includes('Token Advbox expirado'));
  let msg=`Sincronização concluída: ${st.synced} processo(s) atualizado(s)`;
  if(st.failed){
    msg+=`, ${st.failed} com erro`;
    if(todosAuthErr) msg+='\n⚠️ Token Advbox expirado — atualize nas configurações';
    else if(erros.length) msg+=`\nPrimeiro erro: ${erros[0]}`;
  }
  showToast(msg,st.failed?8000:3500);
  if(erros.length){
    console.group('[Advbox] Erros de sincronização ('+erros.length+')');
    erros.forEach(e=>console.warn(e));
    console.groupEnd();
  }
  if(topTab==='acompanhamento')render(subTab);
  else if(topTab!=='dashboard')render(topTab);
  updateDash();
}

/* ======================================================
   INIT
====================================================== */
_initApp();
