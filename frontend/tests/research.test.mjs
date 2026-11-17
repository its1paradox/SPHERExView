import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { localWindow } from './localWindow.mjs';
const spec={ra:10,dec:-5,size:240,survey:'wide',release:'all'};
 const wait=async fn=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}assert.fail('State did not settle');};
async function setup() {
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});
 localWindow(dom.window);globalThis.window=dom.window;globalThis.CustomEvent=dom.window.CustomEvent;
 return {dom,w:dom.window,lib:await import(`../src/lib/research.js?test=${Math.random()}`),close(){dom.window.close();delete globalThis.window;}};
}
const url='/api/epoch-stack?ra=10&dec=-5&radius_arcsec=120&release=all';
const payload={count:2,n_attempted:2,cutouts:[0,1].map(i=>({id:`f${i}`,data_url:`/api/research/target/files/frame-${i}.json`}))};
const network=async path=>Response.json(path===url?payload:{data_b64:'AAAAAA=='});

test('history and every raw pixel survive reopening without server access; byte accounting is exact',async()=>{
 const app=await setup();try{
 const {lib}=app;const target=await lib.beginResearch(spec);
 assert.deepEqual(await (await lib.localResearchFetch(url,undefined,network)).json(),payload);
 const listing=await lib.researchRequest();
 const expected=new TextEncoder().encode(JSON.stringify(payload)).length+2*new TextEncoder().encode(JSON.stringify({data_b64:'AAAAAA=='})).length;
 assert.equal(listing.bytes,expected);
 const reopened=await import(`../src/lib/research.js?reopen=${Math.random()}`);await reopened.beginResearch(spec);
 const offline=()=>{throw new Error('Network must not be used');};
 assert.deepEqual(await (await reopened.localResearchFetch(url,undefined,offline)).json(),payload);
 for(const frame of payload.cutouts)assert.equal((await (await reopened.localResearchFetch(frame.data_url,undefined,offline)).json()).data_b64,'AAAAAA==');
 assert.equal((await reopened.researchRequest()).targets[0].id,target.id);
 }finally{app.close();}
});

test('detector revisit and all FITS exports work after server expiry',async()=>{
 const app=await setup();try{
 const {lib}=app;await lib.beginResearch(spec);const id='a'.repeat(32),recipe={...spec,size_arcsec:240};delete recipe.size;
 const post={method:'POST',body:JSON.stringify(recipe)};const calls=[];
 const server=async(path,options)=>{calls.push(path);if(options?.method==='POST')return Response.json({job_id:id});if(path.endsWith('/result'))return Response.json({recipe,epochs:[{index:0,spectra_enabled:true}],inputs:[],n_selected:0});return new Response('exact FITS bytes',{headers:{'Content-Type':'application/fits'}});};
 await lib.localResearchFetch('/api/detector-comparison',post,server);await lib.localResearchFetch(`/api/detector-comparison/${id}/result`,undefined,server);assert.equal(calls.length,5);
 const offline=()=>{throw new Error('Server cache expired');};
 assert.equal((await (await lib.localResearchFetch('/api/detector-comparison',post,offline)).json()).job_id,id);
 assert.equal((await (await lib.localResearchFetch(`/api/detector-comparison/${id}`,undefined,offline)).json()).status,'complete');
 for(const path of ['manifest','epochs/0.fits','spectra/0.fits'])assert.equal(await (await lib.localResearchFetch(`/api/detector-comparison/${id}/${path}`,undefined,offline)).text(),'exact FITS bytes');
 }finally{app.close();}
});

test('failed refresh preserves old results; clear keeps recipe; remove isolates other targets',async()=>{
 const app=await setup();try{
 const {lib}=app,target=await lib.beginResearch(spec);await lib.saveResearchView(spec,'timeline','#ra=10&dec=-5&zoom=200');await lib.localResearchFetch(url,undefined,network);const before=(await lib.researchRequest()).bytes;
 await lib.researchRequest(`/${target.id}/refresh?tool=timeline`,{method:'POST'});
 await assert.rejects(lib.localResearchFetch(url,{cache:'reload'},async path=>path===url?Response.json(payload):new Response('expired',{status:410})),/Previous saved results remain/);
 assert.equal((await lib.researchRequest()).bytes,before);
 const other=await lib.beginResearch({...spec,ra:11});assert.equal((await lib.researchRequest(`/${target.id}/cache`,{method:'DELETE'})).freed_bytes,before);
 const kept=(await lib.researchRequest()).targets.find(t=>t.id===target.id);assert.equal(kept.bytes,0);assert.match(kept.tools.timeline.hash,/zoom=200/);
 await lib.researchRequest(`/${target.id}`,{method:'DELETE'});assert.deepEqual((await lib.researchRequest()).targets.map(t=>t.id),[other.id]);
 }finally{app.close();}
});

test('deletion during transfer cannot resurrect a target or leave staged files',async()=>{
 const app=await setup();try{
 const {lib}=app,target=await lib.beginResearch(spec);let deleted=false;
 await assert.rejects(lib.localResearchFetch(url,undefined,async path=>{if(path!==url&&!deleted){deleted=true;await lib.researchRequest(`/${target.id}`,{method:'DELETE'});}return network(path);}),/library changed/);
 assert.equal((await lib.researchRequest()).targets.length,0);
 const db=await lib.openResearchDB();const rows=await new Promise(resolve=>{const r=db.transaction('assets').objectStore('assets').getAll();r.onsuccess=()=>resolve(r.result);});assert.equal(rows.length,0);
 }finally{app.close();}
});

const compiled=build({entryPoints:['src/main.jsx'],bundle:true,format:'iife',jsx:'automatic',write:false,loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
test('dashboard uses local history and labels device storage and deletion clearly',async()=>{
 const app=await setup();try{
 const {w,lib}=app;await lib.beginResearch(spec);await lib.localResearchFetch(url,undefined,network);
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};w.fetch=()=>{throw new Error('Dashboard must never send history to server');};
 vm.runInContext((await compiled).outputFiles[0].text,app.dom.getInternalVMContext());await wait(()=>w.document.querySelector('.research-row'));
 assert.match(w.document.body.textContent,/Stored on this device/);assert.equal(w.document.querySelectorAll('.research-row .research-tool').length,2);
 for(const link of w.document.querySelectorAll('.research-tool')) {assert.equal(link.target,'_blank');assert.match(link.rel,/noopener/);}
 const width=w.document.querySelector('[aria-label="New field width"]');
 width.value='500';assert.equal(width.checkValidity(),true,'500 arcsec must be accepted');
 width.value='501';assert.equal(width.validity.rangeOverflow,true,'larger fields retain an explicit boundary');
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===text);
 button('Refresh data').click();await wait(()=>w.document.querySelector('dialog[open]'));assert.equal(w.document.querySelectorAll('.research-refresh-tools button').length,2);
 w.document.querySelector('[aria-label="Close dialog"]').click();await wait(()=>!w.document.querySelector('dialog[open]'));button('Manage storage').click();await wait(()=>w.document.querySelector('dialog[open]'));
 [...w.document.querySelectorAll('button')].find(b=>/^Clear .* of cache$/.test(b.textContent)).click();await wait(()=>w.document.querySelector('.research-retention > strong')?.textContent==='0 B'&&!w.document.querySelector('dialog[open]'));
 assert.ok(w.document.querySelector('.research-row'));button('Manage storage').click();await wait(()=>w.document.querySelector('dialog[open]'));button('Remove target and data').click();await wait(()=>w.document.querySelector('.research-empty'));
 }finally{app.close();}
});

test('dashboard tracks concurrent mission requests until every local file is saved',async()=>{
 const app=await setup();try{
 const {lib}=app;await lib.beginResearch(spec);
 let releaseWise,releasePixels;
 const wiseGate=new Promise(r=>releaseWise=r),pixelGate=new Promise(r=>releasePixels=r);
 const wise='/api/wise-stack?ra=10&dec=-5&size_arcsec=240';
 const server=async path=>{if(path===wise){await wiseGate;return Response.json({frames:[],count:0});}if(path!==url)await pixelGate;return network(path);};
 const sx=lib.localResearchFetch(url,undefined,server),wi=lib.localResearchFetch(wise,undefined,server);
 const state=async()=>lib.toolProgress((await lib.researchRequest()).targets[0].tools.timeline);
 await wait(async()=>Object.keys((await lib.researchRequest()).targets[0].tools.timeline?.activity || {}).length===2);
 assert.equal((await state()).phase,'running');
 releaseWise();await wi;
 assert.equal((await state()).phase,'saving','WISE finishing must not mark SPHEREx files ready');
 assert.equal((await lib.researchRequest()).targets[0].busy,true);
 releasePixels();await sx;
 assert.equal((await state()).label,'Results ready');
 assert.equal((await lib.researchRequest()).targets[0].busy,false);
 }finally{app.close();}
});

test('detector server completion is not ready until exports are committed; tools stay independent',async()=>{
 const app=await setup();try{
 const {lib}=app;await lib.beginResearch(spec);
 const id='c'.repeat(32),recipe={...spec,size_arcsec:240},post={method:'POST',body:JSON.stringify(recipe)};
 let finish;const gate=new Promise(r=>finish=r);
 let status={status:'running',message:'Processing 12 / 30 observations',done:12,total:30};
 const server=async(path,opts)=>opts?.method==='POST'?Response.json({job_id:id}):path.endsWith('/result')?Response.json({recipe,inputs:[],n_selected:0,epochs:[]}):path.endsWith('/manifest')?(await gate,new Response('manifest')):Response.json(status);
 await lib.localResearchFetch('/api/detector-comparison',post,server);
 await lib.localResearchFetch(`/api/detector-comparison/${id}`,undefined,server);
 let target=(await lib.researchRequest()).targets[0];assert.equal(lib.toolProgress(target.tools.detectors).done,12);assert.equal(lib.toolProgress(target.tools.timeline).phase,'idle');
 status={status:'complete'};await lib.localResearchFetch(`/api/detector-comparison/${id}`,undefined,server);
 assert.equal(lib.toolProgress((await lib.researchRequest()).targets[0].tools.detectors).phase,'saving');
 const result=lib.localResearchFetch(`/api/detector-comparison/${id}/result`,undefined,server);finish();await result;
 target=(await lib.researchRequest()).targets[0];assert.equal(lib.toolProgress(target.tools.detectors).label,'Results ready');
 assert.equal(lib.toolProgress({activity:{x:{phase:'running',updated:Date.now()-181000}}}).phase,'paused');
 }finally{app.close();}
});

test('a failed parallel mission stays visible after the other mission completes',async()=>{
 const app=await setup();try{
 const {lib}=app;await lib.beginResearch(spec);let finish;const gate=new Promise(r=>finish=r);
 const sx=lib.localResearchFetch(url,undefined,async path=>{await gate;return network(path);});
 await new Promise(r=>setTimeout(r,30));
 await lib.localResearchFetch('/api/wise-stack?ra=10&dec=-5&size_arcsec=240',undefined,async()=>new Response('unavailable',{status:503}));
 finish();await sx;
 assert.equal(lib.toolProgress((await lib.researchRequest()).targets[0].tools.timeline).phase,'error');
 }finally{app.close();}
});

test('refresh reserves a new tab synchronously and popup blocking does not alter saved research',async()=>{
 const app=await setup();try{
 const {w,lib}=app;const target=await lib.beginResearch(spec);await lib.localResearchFetch(url,undefined,network);
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 vm.runInContext((await compiled).outputFiles[0].text,app.dom.getInternalVMContext());await wait(()=>w.document.querySelector('.research-row'));
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===text);
 button('Refresh data').click();await wait(()=>w.document.querySelector('dialog[open]'));
 w.open=()=>null;button('Refresh WISE–SPHEREx').click();await wait(()=>w.document.querySelector('dialog [role="alert"]'));
 assert.equal((await lib.researchRequest()).targets[0].tools.timeline.refresh_at,undefined);
 let opened=false,navigated;const tab={opener:{},location:{replace:value=>{navigated=value;}},close(){}};
 w.open=(url,target)=>{assert.equal(url,'about:blank');assert.equal(target,'_blank');opened=true;return tab;};
 button('Refresh WISE–SPHEREx').click();assert.equal(opened,true,'tab must open within the click, before storage awaits');
 await wait(()=>navigated);assert.match(navigated,/refresh=timeline/);assert.equal(tab.opener,null);
 assert.equal(w.location.pathname,'/');assert.equal((await lib.researchRequest()).targets[0].id,target.id);
 }finally{app.close();}
});

test('dashboard receives another tab’s progress without focus or manual reload',async()=>{
 const app=await setup();try{
 const {w,lib}=app;await lib.beginResearch(spec);
 w.HTMLDialogElement.prototype.close=function(){};
 vm.runInContext((await compiled).outputFiles[0].text,app.dom.getInternalVMContext());await wait(()=>w.document.querySelector('.research-row'));
 let finish;const gate=new Promise(r=>finish=r);
 const pending=lib.localResearchFetch(url,undefined,async path=>{await gate;return network(path);});
 await wait(async()=> (await lib.researchRequest()).targets[0].busy);
 w.dispatchEvent(new w.StorageEvent('storage',{key:'spherex.research.changed',newValue:'other-tab'}));
 await wait(()=>w.document.querySelector('.research-tool-state.running'));
 finish();await pending;
 w.dispatchEvent(new w.StorageEvent('storage',{key:'spherex.research.changed',newValue:'other-tab-finished'}));
 await wait(()=>w.document.querySelector('.research-tool-state.ready'));
 assert.match(w.document.querySelector('.research-tool-state.ready').textContent,/Results ready/);
 }finally{app.close();}
});

test('500 arcsec history links preserve the exact width for both tools',async()=>{
 const app=await setup();try{
 const {lib}=app,target=await lib.beginResearch({...spec,size:500});
 for(const tool of ['timeline','detectors'])assert.equal(new URLSearchParams(lib.targetLink(target,tool).split('#')[1]).get('size'),'500');
 assert.equal((await lib.researchRequest()).targets[0].size,500);
 }finally{app.close();}
});

test('device quota failure preserves the previous complete snapshot and cleans staged assets',async()=>{
 const {IDBObjectStore}=await import('fake-indexeddb');const original=IDBObjectStore.prototype.put;
 const app=await setup();try{
 const {lib}=app,target=await lib.beginResearch(spec);await lib.localResearchFetch(url,undefined,network);const before=(await lib.researchRequest()).bytes;
 await lib.researchRequest(`/${target.id}/refresh?tool=timeline`,{method:'POST'});
 let writes=0;
 IDBObjectStore.prototype.put=function(value,...args){if(this.name==='assets' && ++writes===2)throw new DOMException('Synthetic device quota','QuotaExceededError');return original.call(this,value,...args);};
 await assert.rejects(lib.localResearchFetch(url,{cache:'reload'},network),/Device storage is full/);
 IDBObjectStore.prototype.put=original;
 assert.equal((await lib.researchRequest()).bytes,before);
 const offline=()=>{throw new Error('No network');};assert.deepEqual(await (await lib.localResearchFetch(url,undefined,offline)).json(),payload);
 const db=await lib.openResearchDB();const rows=await new Promise(resolve=>{const r=db.transaction('assets').objectStore('assets').getAll();r.onsuccess=()=>resolve(r.result);});assert.equal(rows.length,3,'Only the old JSON and its two frames remain');
 }finally{IDBObjectStore.prototype.put=original;app.close();}
});

test('reopening an unfinished detector job resumes it rather than submitting duplicates',async()=>{
 const app=await setup();try{
 const {lib}=app;await lib.beginResearch(spec);const post={method:'POST',body:JSON.stringify({...spec,size_arcsec:240})},id='b'.repeat(32);let submissions=0;
 const server=async(path,options)=>{if(options?.method==='POST'){submissions++;return Response.json({job_id:id});}return Response.json({status:'running'});};
 await lib.localResearchFetch('/api/detector-comparison',post,server);
 const reopened=await import(`../src/lib/research.js?pending=${Math.random()}`);await reopened.beginResearch(spec);
 assert.equal((await (await reopened.localResearchFetch('/api/detector-comparison',post,server)).json()).job_id,id);
 assert.equal(submissions,1);
 }finally{app.close();}
});

test('reopening a running refresh resumes the newer job instead of returning the old saved result',async()=>{
 const app=await setup();try{
 const {lib}=app,target=await lib.beginResearch(spec),recipe={...spec,size_arcsec:240};
 const oldId='d'.repeat(32),newId='e'.repeat(32),post={method:'POST',body:JSON.stringify(recipe)};
 const oldServer=async(path,options)=>options?.method==='POST'?Response.json({job_id:oldId}):path.endsWith('/result')?Response.json({recipe,epochs:[],inputs:[],n_selected:0}):new Response('manifest');
 await lib.localResearchFetch('/api/detector-comparison',post,oldServer);await lib.localResearchFetch(`/api/detector-comparison/${oldId}/result`,undefined,oldServer);
 await new Promise(r=>setTimeout(r,5));await lib.researchRequest(`/${target.id}/refresh?tool=detectors`,{method:'POST'});
 let posts=0;const server=async(path,options)=>options?.method==='POST'?(posts++,Response.json({job_id:newId})):Response.json({status:'running',done:2,total:30});
 await lib.localResearchFetch('/api/detector-comparison',{...post,cache:'reload'},server);
 const reopened=await import(`../src/lib/research.js?newer=${Math.random()}`);await reopened.beginResearch(spec);
 assert.equal((await (await reopened.localResearchFetch('/api/detector-comparison',post,server)).json()).job_id,newId);
 assert.equal(posts,1);
 }finally{app.close();}
});
