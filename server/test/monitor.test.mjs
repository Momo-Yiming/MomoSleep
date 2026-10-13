import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Script } from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { monitorRoute, sign, csvValue, recordRequest, runChecks } from '../src/monitor.mjs';
import { monitorPage } from '../src/monitor-page.mjs';
import { trackerScript } from '../src/monitor-tracker.mjs';

function environment() {
  const db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).sort())db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const prepare=(sql,params=[])=>({
    bind(...values){return prepare(sql,values);},
    async first(){return db.prepare(sql).get(...params) || null;},
    async all(){return {results:db.prepare(sql).all(...params)};},
    async run(){return db.prepare(sql).run(...params);}
  });
  return {db,DB:{prepare,async batch(items){return Promise.all(items.map(x=>x.run()));}},MONITOR_PASSWORD:'test-password-only',MONITOR_SECRET:'a'.repeat(64)};
}
const origin='https://smart-sleep-economy-demo.pages.dev';
function req(path,data,cookie='',extra={}) {const request=new Request(origin+path,{method:data?'POST':'GET',headers:{origin,'user-agent':'Mozilla/5.0 (Macintosh) AppleWebKit Safari/605.1.15','CF-Connecting-IP':'203.0.113.17',cookie,...extra},body:data?JSON.stringify(data):undefined});Object.defineProperty(request,'cf',{value:{country:'CN',region:'Guangdong',city:'Guangzhou',asOrganization:'Example network'}});return request;}
async function login(env) { const r=await monitorRoute(req('/api/monitor/login',{password:env.MONITOR_PASSWORD}),env);assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]; }

test('monitor auth is enforced on reports, exports and probes; login is origin-bound and cookies cannot be forged',async()=>{
 const env=environment();
 for(const path of ['/api/monitor/report','/api/monitor/export','/api/monitor/check'])assert.equal((await monitorRoute(req(path),env)).status,401);
 assert.equal((await monitorRoute(req('/api/monitor/login',{password:env.MONITOR_PASSWORD},'',{origin:'https://evil.example'}),env)).status,403);
 assert.equal((await monitorRoute(req('/api/monitor/login',{password:'bad'}),env)).status,401);
 const cookie=await login(env);assert.match(cookie,/__Host-momoMonitor=/);
 assert.equal((await monitorRoute(req('/api/monitor/report',null,cookie),env)).status,200);
 assert.equal((await monitorRoute(req('/api/monitor/report',null,cookie+'x'),env)).status,401);
 assert.equal((await monitorRoute(req('/api/monitor/logout',{},cookie,{origin:'https://evil.example'}),env)).status,403);
 env.MONITOR_PASSWORD='rotated';assert.equal((await monitorRoute(req('/api/monitor/report',null,cookie),env)).status,401);
 env.db.close();
});
test('collection, deduplication, privacy, metrics, conversions, bot separation, CSV and invalid filters',async()=>{
 const env=environment(),cookie=await login(env),id=crypto.randomUUID(),session=crypto.randomUUID();
 const view={id,session,type:'pageview',language:'zh-CN',referrer:'https://example.org/private?secret=sensitive',source:'wechat',campaign:'launch',path:'/secret?email=private',unknown:'should never be saved'};
 assert.equal((await monitorRoute(req('/api/monitor/collect',view),env)).status,204);
 assert.equal((await monitorRoute(req('/api/monitor/collect',view),env)).status,204);
 await monitorRoute(req('/api/monitor/collect',{...view,type:'pulse',duration:12000,scroll:65,lcp:1900,cls:0,inp:80,ttfb:300}),env);
 const event={...view,type:'event',eventId:crypto.randomUUID(),kind:'conversion',name:'claim'};
 await monitorRoute(req('/api/monitor/collect',event),env);await monitorRoute(req('/api/monitor/collect',event),env);
 assert.equal((await monitorRoute(req('/api/monitor/collect',{...event,name:'private free text'}),env)).status,400);
 assert.equal((await monitorRoute(req('/api/monitor/collect',{...view,id:crypto.randomUUID()},'',{'sec-gpc':'1'}),env)).status,204);
 await monitorRoute(req('/api/monitor/collect',{...view,id:crypto.randomUUID()},'',{'user-agent':'crawler-bot'}),env);
 await monitorRoute(req('/api/monitor/collect',{...view,id:crypto.randomUUID(),test:true}),env);
 await recordRequest(req('/api/demo/state?accountId=do-not-store'),new Response('error',{status:500}),env,31);
 const report=await (await monitorRoute(req('/api/monitor/report',null,cookie),env)).json();
 assert.equal(report.totals.views,1);assert.equal(report.totals.visitors,1);assert.equal(report.totals.sessions,1);assert.equal(report.totals.duration,12000);assert.equal(report.sessionStats.bounced,0);assert.equal(report.vitals.lcp_ms.value,1900);assert.equal(report.events[0].count,1);assert.equal(report.requests[0].path,'/api/demo/state');assert.equal(report.visits[0].referrer,'example.org');
 assert.doesNotMatch(JSON.stringify(report),/203\.0\.113|sensitive|should never|do-not-store|Mozilla/);
 assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM web_visits').get().n,3);
 const csv=await monitorRoute(req('/api/monitor/export',null,cookie),env);assert.equal(csv.status,200);assert.match(await csv.text(),/wechat/);
 assert.equal((await monitorRoute(req('/api/monitor/report?from=2026-02-31',null,cookie),env)).status,400);
 assert.equal((await monitorRoute(req('/api/monitor/report?from=2020-01-01&to=2026-01-01',null,cookie),env)).status,400);
 assert.equal((await monitorRoute(req('/api/monitor/collect',{...view,id:crypto.randomUUID()},'',{origin:'https://evil.example'}),env)).status,403);
 assert.equal((await monitorRoute(req('/api/monitor/collect',{...view,huge:'x'.repeat(9000)}),env)).status,400);
 env.db.close();
});
test('cloud checks persist failures and successes and remove data beyond retention',async()=>{
 const env=environment();
 await env.DB.prepare('INSERT INTO health_checks(checked_at,target,ok,status,latency_ms,detail,trigger) VALUES (?,?,?,?,?,?,?)').bind('2020-01-01T00:00:00.000Z','old',1,200,1,'old','scheduled').run();
 const results=await runChecks(env,'scheduled',async url=>url.includes('workers.dev')?new Response('down',{status:503}):url.endsWith('/health')?Response.json({ok:true,build:'test'}):url.endsWith('.png')?new Response('image',{headers:{'Content-Type':'image/png'}}):new Response('<h1>MOMO</h1>'));
 assert.equal(results.length,5);assert.equal(results.find(x=>x.target==='备用 API').ok,0);assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM health_checks').get().n,5);env.db.close();
});
test('login attempts are rate limited, CSV neutralizes formulas, scripts parse',async()=>{
 const env=environment();for(let i=0;i<10;i++)assert.equal((await monitorRoute(req('/api/monitor/login',{password:'wrong'}),env)).status,401);
 assert.equal((await monitorRoute(req('/api/monitor/login',{password:'wrong'}),env)).status,429);
 assert.equal(csvValue('=HYPERLINK("evil")'),'"\'=HYPERLINK(""evil"")"');
 assert.notEqual(await sign('secret','first'),await sign('secret','second'));
 new Script(trackerScript());for(const s of monitorPage().matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(s[1]);env.db.close();
});

// Exercise the same keepNames transform that broke the deployed .toString() scripts.
test('browser scripts survive Worker bundling unchanged, including minification',async()=>{
  const require=createRequire(import.meta.url);
  const {build}=createRequire(require.resolve('wrangler/package.json'))('esbuild');
  for(const [file,exportName,original] of [['monitor-page.mjs','monitorPage',monitorPage()],['monitor-tracker.mjs','trackerScript',trackerScript()]]) {
    const result=await build({entryPoints:[fileURLToPath(new URL('../src/'+file,import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,keepNames:true,minify:true});
    const compiled=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
    assert.equal(compiled[exportName](),original);
    const scripts=exportName==='monitorPage' ? [...original.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]) : [original];
    for(const script of scripts)assert.doesNotMatch(script,/\b__name\b/);
  }
});
