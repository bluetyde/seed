const {_electron: electron, expect} = require('@playwright/test');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const output=fs.mkdtempSync(path.join(require('os').tmpdir(),'seed-smoke-'));
console.log('Screenshots and results:',output);
(async()=>{
 const host=await electron.launch({args:[root],env:{...process.env}});
 const errors=[];host.on('window',p=>p.on('pageerror',e=>errors.push({page:p.url().split('?')[0],error:e.message})));
 try {
  let bar; await expect.poll(()=>{bar=host.windows().find(p=>p.url().endsWith('/renderer/index.html'));return !!bar}).toBe(true);
  await bar.waitForSelector('.tabrow');
  await expect.poll(()=>host.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  const results=[];
  for(const [id,title] of [['openmc-studio','OpenMC Studio'],['nodal-studio','NODAL Studio'],['virtual-reactor','Virtual Reactor']]){
   await bar.evaluate(id=>window.host.openApp(id),id);
   await expect.poll(async()=>{const s=await bar.evaluate(()=>window.host.getState());const t=s.tabs.find(t=>t.appId===id);if(t?.status==='error')throw Error(JSON.stringify(t.error));return t?.status},{timeout:150000}).toBe('running');
   let p;await expect.poll(async()=>{for(const w of host.windows()){if(w.url().startsWith('http://127.0.0.1:')&&(await w.title()).includes(title)){p=w;return true}}return false},{timeout:30000}).toBe(true);
   await p.waitForLoadState('domcontentloaded');
   await expect(p.locator('canvas').first()).toBeVisible({timeout:30000});
   if(id==='virtual-reactor') await expect(p.getByText('Operator Panel',{exact:true})).toBeVisible({timeout:60000});
   await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await p.screenshot({path:path.join(output,id+'.png')});
   const detail=await p.evaluate(()=>({title:document.title,canvases:document.querySelectorAll('canvas').length,text:document.body.innerText.slice(0,900)}));
   results.push({id,url:p.url().split('?')[0],...detail});console.log(JSON.stringify(results.at(-1)));
  }
  for(const r of results){await bar.evaluate(id=>window.host.activate('app:'+id),r.id);await expect.poll(async()=> (await bar.evaluate(()=>window.host.getState())).activeId).toBe('app:'+r.id);}
  for(const r of results){await bar.evaluate(id=>window.host.close('app:'+id),r.id);await expect.poll(async()=> (await bar.evaluate(()=>window.host.getState())).tabs.some(t=>t.appId===r.id)).toBe(false);await expect.poll(async()=>{try{await fetch(r.url,{signal:AbortSignal.timeout(1000)});return false}catch{return true}},{timeout:10000}).toBe(true);}
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));
  if(errors.length)throw Error(JSON.stringify(errors));
  console.log('PASS: all three apps rendered in SEED, tabs switched, and owned servers stopped on close.');
 }finally{await host.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
