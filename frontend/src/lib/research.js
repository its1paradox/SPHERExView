// Durable research belongs to this device. The server only lends working storage.
const KEY = 'spherex.transfer.key.v2';
const DB = 'spherex-research-v2';
let database;
let activeTarget = null;
const jobs = new Map();
const refreshTool=typeof window==='undefined'?null:new URLSearchParams(window.location.hash.slice(1)).get('refresh');
const randomId=()=>Array.from(window.crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
const request = r => new Promise((resolve, reject) => { r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
const storageError = e => new Error(e?.name === 'QuotaExceededError'
  ? 'Device storage is full. Previous saved results are intact. Free space in your research library and retry.'
  : `Results could not be saved on this device: ${e?.message || e}.`);

export function openResearchDB() {
  if (!database) database = new Promise((resolve,reject)=> {
    if (!window.indexedDB) { reject(new Error('This browser does not support local research storage. Use a browser with IndexedDB enabled.')); return; }
    const r=window.indexedDB.open(DB,1);
    r.onupgradeneeded=()=> {
      r.result.createObjectStore('targets',{keyPath:'id'}).createIndex('spec','specKey',{unique:true});
      for (const name of ['results','assets','sizes']) {
        const store=r.result.createObjectStore(name,{keyPath:'key'});
        store.createIndex('target','target');
      }
    };
    r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error);
  });
  return database;
}
async function transaction(names, mode, action) {
  const db=await openResearchDB();
  return new Promise((resolve,reject)=> {
    const tx=db.transaction(names,mode); let result;
    tx.oncomplete=()=>resolve(result); tx.onabort=()=>reject(storageError(tx.error || new Error('Storage transaction cancelled')));
    tx.onerror=()=>{};
    Promise.resolve(action(tx)).then(value=>{result=value;}).catch(e=>{try{tx.abort();}catch{} reject(e);});
  });
}
const get=(store,key)=>transaction([store],'readonly',tx=>request(tx.objectStore(store).get(key)));
const all=(store,target)=>transaction([store],'readonly',tx=>request(target ? tx.objectStore(store).index('target').getAll(target) : tx.objectStore(store).getAll()));
async function changeTarget(id, fn) {
  const result = await transaction(['targets'],'readwrite',async tx=> {
    const store=tx.objectStore('targets'), row=await request(store.get(id));
    if (!row) throw new Error('This target was removed from your local library.');
    fn(row); store.put(row); return row;
  });
  notifyResearch();
  return result;
}
const ACTIVE_PHASES = new Set(['queued','running','saving']);
const ACTIVITY_TTL = 180000;
function notifyResearch() {
  window.dispatchEvent(new CustomEvent('research-change'));
  try { window.localStorage.setItem('spherex.research.changed', `${Date.now()}:${Math.random()}`); } catch {}
}
export function toolProgress(tool = {}, now = Date.now()) {
  const entries = Object.values(tool.activity || {});
  const active = entries.filter(a => ACTIVE_PHASES.has(a.phase) && now - a.updated <= ACTIVITY_TTL);
  if (active.length) {
    const a = active.find(a => a.phase !== 'saving') || active[0];
    return {...a,label:a.phase === 'saving' ? 'Saving on this device' : a.phase === 'queued' ? 'Waiting for server' : 'Running',message:active.length > 1 ? `${a.message} · ${active.length} tasks active` : a.message};
  }
  if (entries.some(a => ACTIVE_PHASES.has(a.phase))) return {phase:'paused',label:'Progress not updated',message:'Open the tool tab to check progress or resume. Keep it open while processing.'};
  const failed = entries.find(a => a.phase === 'error' || a.phase === 'cancelled');
  if (failed) return {...failed,label:failed.phase === 'error' ? 'Needs attention' : 'Cancelled'};
  if (tool.status === 'incomplete' || entries.some(a => a.phase === 'incomplete')) return {phase:'incomplete',label:'Partial results saved',message:'Some observations were unavailable or excluded. Review processing details.'};
  if (tool.status === 'saved') return {phase:'ready',label:'Results ready',message:'Saved on this device · Open to view'};
  if (tool.pending) return {phase:'paused',label:'Reopen to resume',message:'Processing or saving has not finished.'};
  return {phase:'idle',label:'Not yet run',message:'Opens in a new tab'};
}
// Small per-tool records are shared through IndexedDB; science data never enters
// localStorage. Transactions merge concurrent tabs without losing another task.
async function activity(target, tool, id, update, start = false) {
  await changeTarget(target.id, row => {
    if (row.created_at !== target.created_at || row.revision !== target.revision || row.tools[tool]?.refresh_at !== target.tools[tool]?.refresh_at) return;
    const value = row.tools[tool] ||= {};
    let records = value.activity || {};
    if (start && !Object.values(records).some(a => ACTIVE_PHASES.has(a.phase) && Date.now()-a.updated <= ACTIVITY_TTL)) records = {};
    records[id] = {...records[id],...update,updated:Date.now()};
    value.activity = records;
  }).catch(e => { if (!/target was removed/.test(e.message)) throw e; });
}
export function browserKey() {
  if (typeof window==='undefined') return null;
  let key=window.localStorage.getItem(KEY);
  if (!/^[a-f0-9]{64}$/.test(key || '')) {
    key=Array.from(window.crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
    window.localStorage.setItem(KEY,key);
  }
  return key;
}
export function targetSpec(value) {
  return {ra:Number(value.ra),dec:Number(value.dec),size:Number(value.size ?? value.size_arcsec ?? value.fov ?? Number(value.radius_arcsec)*2),survey:value.survey || 'wide',release:value.release || 'all'};
}
async function ensureTarget(value) {
  const spec=targetSpec(value);
  if (![spec.ra,spec.dec,spec.size].every(Number.isFinite) || spec.ra<0 || spec.ra>=360 || spec.dec< -90 || spec.dec>90 || spec.size<=0) throw new Error('Invalid sky coordinates or field width.');
  // Exact scientific coordinates and field/release, no rounding.
  const specKey=JSON.stringify(spec);
  return transaction(['targets'],'readwrite',async tx=> {
    const store=tx.objectStore('targets');
    const row=await request(store.index('spec').get(specKey)) || {id:randomId(),specKey,...spec,created_at:Date.now()/1000,revision:0,tools:{}};
    row.visited_at=Date.now()/1000; store.put(row); return row;
  });
}
export async function beginResearch(value) {
  if (typeof window==='undefined') return null;
  const row=await ensureTarget(value); activeTarget=row.id; return row;
}
export async function saveResearchView(value,tool,hash) {
  const row=await ensureTarget(value);
  return changeTarget(row.id,t=>{t.tools[tool]={...t.tools[tool],hash};});
}
export async function researchRequest(path='',options={}) {
  if (!path && options.method==='POST') return ensureTarget(JSON.parse(options.body));
  if (!path) {
    const rows=await all('targets'), results=await all('results'), assets=await all('sizes');
    const published=new Set(results.map(r=>r.snapshot));
    const abandoned=assets.filter(a=>!published.has(a.snapshot) && Date.now()-a.staged>86400000);
    if(abandoned.length)await transaction(['assets','sizes'],'readwrite',tx=>{for(const a of abandoned){tx.objectStore('assets').delete(a.key);tx.objectStore('sizes').delete(a.key);}});
    const targets=rows.map(row=> {
      const own=results.filter(r=>r.target===row.id), snapshots=new Set(own.map(r=>r.snapshot));
      const storage={responses:0,assets:0,comparisons:0,exports:0};
      for (const r of own) storage[r.tool==='timeline'?'responses':'comparisons']+=r.bytes;
      for (const a of assets) if(a.target===row.id && snapshots.has(a.snapshot) && a.kind!=='result') storage[a.kind]+=a.bytes;
      return {...row,storage,bytes:Object.values(storage).reduce((a,b)=>a+b,0),busy:Object.values(row.tools).some(t=>ACTIVE_PHASES.has(toolProgress(t).phase))};
    });
    return {targets,bytes:targets.reduce((sum,t)=>sum+t.bytes,0),persistent:await window.navigator.storage?.persisted?.() || false};
  }
  const [id,action]=path.slice(1).split('/');
  if (action?.startsWith('refresh?')) {
    const tool=new URLSearchParams(action.split('?')[1]).get('tool');
    return changeTarget(id,t=>{t.tools[tool]={...t.tools[tool],refresh_at:Date.now()/1000,status:'refresh requested'};});
  }
  if(options.method==='DELETE') return transaction(['targets','results','assets','sizes'],'readwrite',async tx=> {
    const targetStore=tx.objectStore('targets'), row=await request(targetStore.get(id));
    let freed_bytes=0;
    for (const name of ['results','sizes']) {
      const store=tx.objectStore(name), rows=await request(store.index('target').getAll(id));
      for(const r of rows) {if(name==='sizes' && r.kind!=='result')freed_bytes+=r.bytes; if(name==='results')freed_bytes+=r.bytes;store.delete(r.key);if(name==='sizes')tx.objectStore('assets').delete(r.key);}
    }
    if(row && action==='cache') {row.revision++;for(const t of Object.values(row.tools)) {t.status='cache cleared'; t.checked_at=null;t.pending=null;t.activity={};} targetStore.put(row);}
    else targetStore.delete(id);
    return {freed_bytes};
  });
  throw new Error('Unknown local library operation.');
}
export async function persistResearch() { return await window.navigator.storage?.persist?.() || false; }
export function targetLink(target,tool) {
  const params=new URLSearchParams(target.tools?.[tool]?.hash?.slice(1) || new URLSearchParams({ra:target.ra,dec:target.dec,size:target.size,survey:target.survey,release:target.release}));
  params.delete('result');params.delete('refresh');
  return `${tool==='timeline'?'timeline.html':'compare.html'}#${params}`;
}
export function formatBytes(bytes) {
  if(!bytes)return '0 B';const unit=Math.min(3,Math.floor(Math.log(bytes)/Math.log(1024)));
  return `${(bytes/1024**unit).toFixed(unit?1:0)} ${['B','KiB','MiB','GiB'][unit]}`;
}
const canonical=url=>{const p=new URL(url,window.location.origin);p.searchParams.sort();return p.pathname+p.search;};
const recipeKey=recipe=>'recipe:'+JSON.stringify(Object.fromEntries(Object.entries(recipe).sort(([a],[b])=>a.localeCompare(b))));
const responseOf=async row=> {const body=row.body || (await get('assets',row.bodyKey))?.body; if(!body)throw new Error('Saved result files are missing. Refresh this target.');return new Response(body.slice(0),{headers:{'Content-Type':row.type || 'application/json'}});};
async function localAsset(target,url) {
  const rows=await all('results',target);
  for(const row of rows) if(row.urls?.includes(url)) {
    const asset=await get('assets',`${row.snapshot}|${url}`);
    if(asset)return responseOf(asset);
  }
  return null;
}
async function saveResult(target,tool,key,response,network,options,extra={},activityId,json) {
  const snapshot=randomId();
  const progress=(saved,done=false)=>window.dispatchEvent(new CustomEvent('research-save',{detail:{id:snapshot,saved,total:assets.length,done}}));
  const urls=[];
  const assets=[];
  for(const frame of json.cutouts || []) if(frame.data_url) assets.push([frame.data_url,'assets']);
  if(tool==='detectors') {
    const base=extra.url.replace(/\/result$/,'');
    assets.push([`${base}/manifest`,'exports']);
    for(const epoch of json.epochs || []) {
      assets.push([`${base}/epochs/${epoch.index}.fits`,'exports']);
      if(epoch.spectra_enabled || epoch.spectra?.length) assets.push([`${base}/spectra/${epoch.index}.fits`,'exports']);
    }
  }
  // Stage one asset at a time: no giant all-frames array or FITS archive in memory.
  try {
    progress(0);
    if(activityId)await activity(target,tool,activityId,{phase:'saving',message:'Saving result files',done:0,total:assets.length});
    for(const [url,kind] of assets) {
      if(urls.includes(url))continue;
      const res=await network(url,options);
      if(!res.ok)throw new Error(`Could not save all result files (${res.status}). Previous saved results remain available; refresh to retry.`);
      const body=await res.arrayBuffer();
      await transaction(['assets','sizes'],'readwrite',tx=> {const meta={key:`${snapshot}|${url}`,target:target.id,snapshot,bytes:body.byteLength,type:res.headers.get('Content-Type'),kind,staged:Date.now()};tx.objectStore('assets').put({...meta,body});tx.objectStore('sizes').put(meta);});
      urls.push(url);progress(urls.length);
      if(activityId && (urls.length%10===0 || urls.length===assets.length))await activity(target,tool,activityId,{phase:'saving',message:`${urls.length} / ${assets.length} files saved`,done:urls.length,total:assets.length});
    }
    const body=await response.clone().arrayBuffer(), created=Date.now()/1000;
    await transaction(['targets','results','assets','sizes'],'readwrite',async tx=> {
      const store=tx.objectStore('targets'), latest=await request(store.get(target.id));
      if(!latest || latest.created_at!==target.created_at || latest.revision!==target.revision || latest.tools[tool]?.refresh_at!==target.tools[tool]?.refresh_at) throw new Error('Local library changed while processing. Results were not saved; reopen the target.');
      const resultStore=tx.objectStore('results'), old=await request(resultStore.get(key));
      if(old) for(const assetKey of [old.bodyKey,...(old.urls || []).map(url=>`${old.snapshot}|${url}`)]) {tx.objectStore('assets').delete(assetKey);tx.objectStore('sizes').delete(assetKey);}
      const bodyKey=`${snapshot}|@result`, meta={key:bodyKey,target:target.id,snapshot,bytes:body.byteLength,kind:'result',staged:Date.now()};
      tx.objectStore('assets').put({...meta,body});tx.objectStore('sizes').put(meta);
      resultStore.put({key,target:target.id,tool,snapshot,bodyKey,bytes:body.byteLength,type:'application/json',urls,created,...extra});
      const previous=latest.tools[tool] || {};
      const accepted=(json.inputs || []).filter(i=>i.status==='accepted').length;
      latest.tools[tool]={...previous,pending:null,checked_at:created,status:(json.n_exposures_skipped || (json.n_selected!=null && accepted<json.n_selected))?'incomplete':'saved'};
      store.put(latest);
    });
  } catch(e) {
    await transaction(['assets','sizes'],'readwrite',tx=>{for(const url of urls){tx.objectStore('assets').delete(`${snapshot}|${url}`);tx.objectStore('sizes').delete(`${snapshot}|${url}`);}}).catch(()=>{});
    throw storageError(e);
  } finally { progress(urls.length,true); notifyResearch(); }
}
export async function localResearchFetch(url,options,network) {
  if(typeof window==='undefined' || typeof url!=='string' || !(url.startsWith('/api/') || url.startsWith('/static/cutouts/'))) return network(url,options);
  const parsed=new URL(url,window.location.origin), method=options?.method || 'GET';
  const science=/^\/api\/(epoch-stack|cutouts|epoch-coadds|coadd|wise-stack)$/.test(parsed.pathname);
  let target=activeTarget && await get('targets',activeTarget);
  const recipe=parsed.pathname==='/api/detector-comparison' && method==='POST' ? JSON.parse(options.body) : null;
  if(recipe)target=await beginResearch(recipe);
  else if(science && (parsed.pathname!=='/api/wise-stack' || !target))target=await ensureTarget(Object.fromEntries(parsed.searchParams));
  if(!target)return network(url,options);
  const headers=new Headers(options?.headers); headers.set('X-Research-Key',browserKey());headers.set('X-Research-Target',target.id);
  const scoped={...options,headers};
  const tool=parsed.pathname.startsWith('/api/detector-comparison')?'detectors':'timeline';
  const key=`${target.id}|${recipe ? recipeKey(recipe) : canonical(url)}`;
  const prior=await get('results',key);
  const pendingRecipe=recipe && target.tools.detectors?.pending;
  const newerJob=pendingRecipe?.key===key && pendingRecipe.started>(prior?.created || 0);
  if(prior && !newerJob && (!(refreshTool===tool || options?.cache==='reload') || prior.created>=(target.tools[tool]?.refresh_at || 0))) {
    if(recipe)return Response.json({job_id:prior.jobId,status:'saved'});
    return responseOf(prior);
  }
  if(method==='GET' && !science) {
    const own=await all('results',target.id);
    const jobId=parsed.pathname.split('/')[3];
    const saved=own.find(r=>r.jobId===jobId);
    if(saved && /\/result$/.test(url))return responseOf(saved);
    if(saved && /^\/api\/detector-comparison\/[a-f0-9]+$/.test(parsed.pathname))return Response.json({job_id:jobId,status:'complete',message:'Saved on this device'});
    const asset=await localAsset(target.id,url); if(asset)return asset;
  }
  if(recipe) {
    const pending=target.tools.detectors?.pending;
    if(pending?.key===key && pending.started>=(target.tools.detectors?.refresh_at || 0)) {
      const state=await network(`/api/detector-comparison/${pending.jobId}`,{headers});
      if(state.ok && ['queued','running','complete'].includes((await state.json()).status)) {
        jobs.set(pending.jobId,{key,target,activityId:pending.activityId || pending.jobId});
        await activity(target,tool,pending.activityId || pending.jobId,{phase:'running',message:'Resuming comparison'},true);
        return Response.json({job_id:pending.jobId,status:'resuming'});
      }
    }
  }
  const jobId=parsed.pathname.split('/')[3], job=jobs.get(jobId);
  const isStatus=method==='GET' && /^\/api\/detector-comparison\/[a-f0-9]+$/.test(parsed.pathname);
  const isResult=method==='GET' && /\/api\/detector-comparison\/[^/]+\/result$/.test(parsed.pathname);
  // A timeline reload resumes the same scientific request's activity rather
  // than leaving a second, abandoned heartbeat permanently ahead of readiness.
  const activityId=science ? key : recipe ? randomId() : isStatus || isResult ? (job?.activityId || target.tools.detectors?.pending?.activityId || jobId) : null;
  const activityTarget=job?.target || target;
  const report=update=>activityId ? activity(activityTarget,tool,activityId,update) : Promise.resolve();
  let heartbeat;
  if(activityId) {
    const message=recipe?'Starting comparison':isResult?'Downloading comparison':parsed.pathname==='/api/wise-stack'?'Querying and processing WISE observations':science?'Querying and processing all eligible SPHEREx observations':'Checking comparison progress';
    if(recipe || science || isResult)await activity(activityTarget,tool,activityId,{phase:'running',message,done:0,total:0},!isResult);
    heartbeat=window.setInterval(()=>report({}).catch(()=>{}),15000);
    scoped.onResearchWait=()=>report({phase:'queued',message:'Waiting for server capacity; this request will retry automatically',done:0,total:0});
    scoped.onResearchAttempt=()=>report({phase:'running',message,done:0,total:0});
  }
  try {
    const response=await network(url,scoped);
    if(!response.ok) {
      const detail=await response.clone().json().catch(()=>({}));
      await report({phase:'error',message:typeof detail.detail==='string'?detail.detail:`Request failed (${response.status}). Reopen to retry.`,done:0,total:0});
      return response;
    }
    if(recipe) {
      const data=await response.clone().json(); jobs.set(data.job_id,{key,target,activityId});
      await changeTarget(target.id,t=>{t.tools.detectors={...t.tools.detectors,pending:{jobId:data.job_id,key,activityId,started:Date.now()/1000}};});
      await report({phase:'queued',message:'Comparison queued',done:0,total:0});
    } else if(isStatus) {
      const state=await response.clone().json();
      await report({phase:state.status==='complete'?'saving':state.status==='error'?'error':state.status==='cancelled'?'cancelled':state.status==='queued'?'queued':'running',message:state.status==='complete'?'Processing complete; downloading and saving results':state.message || 'Processing observations',done:state.status==='complete'?0:state.done || 0,total:state.status==='complete'?0:state.total || 0});
    } else if(science || isResult) {
      const data=await response.clone().json();
      if(isResult) {
        const spec=targetSpec(data.recipe);
        if(Object.keys(spec).some(k=>spec[k]!==target[k]))throw new Error('The saved result does not match this target or recipe.');
      }
      await saveResult(activityTarget,tool,isResult?(job?.key || `${target.id}|${recipeKey(data.recipe)}`):key,response,network,scoped,isResult?{jobId,url}:{},activityId,data);
      const incomplete=data.n_exposures_skipped || (data.n_selected!=null && (data.inputs || []).filter(i=>i.status==='accepted').length<data.n_selected);
      await report({phase:incomplete?'incomplete':'ready',message:'Results saved on this device',done:0,total:0});
    }
    return response;
  } catch(e) {
    await report({phase:e.name==='AbortError'?'cancelled':'error',message:e.message,done:0,total:0}).catch(()=>{});
    throw e;
  } finally { if(heartbeat)window.clearInterval(heartbeat); }
}
