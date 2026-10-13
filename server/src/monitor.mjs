import { monitorPage } from './monitor-page.mjs';
import { trackerScript } from './monitor-tracker.mjs';

const MAIN = 'smart-sleep-economy-demo.pages.dev';
const BACKUP = 'smart-sleep-economy-demo.smart-sleep-economy-server.workers.dev';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'" };
const reply = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
const clean = (v, n = 80) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, n) : '';
const bounded = (v, max) => typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(v, max)) : 0;
const stamp = () => new Date().toISOString();
const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const botUA = /bot|crawler|spider|headless|curl|wget|python|uptime|monitor|preview|facebookexternalhit/i;
const idPattern = /^[a-zA-Z0-9-]{16,80}$/;
const knownPaths = new Set(['/', '/health', '/api/demo/state', '/api/demo/claims', '/api/demo/orders', '/api/demo/reset', '/api/demo/cash-redemptions', '/api/demo/token-mints', '/team-preview']);
const sections = new Set(['opening','team','project','quality-score','sandbox','cashout','tokenize','external-value','stepn','market','hardware','batches','positioning','manifesto']);
export function safePath(path) { return knownPaths.has(path) ? path : path.startsWith('/assets/') ? '/assets/*' : '/other'; }
export function clientInfo(ua = '') {
  return { browser: /Edg/.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other', os: /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other', device: /iPad|Tablet/.test(ua) ? 'Tablet' : /Mobile|iPhone|Android/.test(ua) ? 'Mobile' : 'Desktop', bot: Number(botUA.test(ua)) };
}
export async function sign(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
function equal(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
async function identity(request, env) {
  // Daily rotation; raw IP and full user-agent are never persisted.
  return sign(env.MONITOR_SECRET, `${day()}|${request.headers.get('CF-Connecting-IP') || 'unknown'}|${request.headers.get('user-agent') || ''}`);
}
async function authenticated(request, env) {
  if (!env.MONITOR_SECRET || !env.MONITOR_PASSWORD) return false;
  const value = request.headers.get('cookie')?.match(/(?:^|;\s*)__Host-momoMonitor=([^;]+)/)?.[1] || '';
  const [expires, nonce, signature] = value.split('.');
  if (!/^\d{13}$/.test(expires || '') || Number(expires) <= Date.now() || Number(expires) > Date.now() + 7 * 86400e3 || !/^[a-f0-9]{64}$/.test(signature || '') || !idPattern.test(nonce || '')) return false;
  return equal(signature, await sign(env.MONITOR_SECRET, `${expires}.${nonce}|${env.MONITOR_PASSWORD}`));
}
async function limited(env, key, max, seconds) {
  const window = Math.floor(Date.now() / (seconds * 1000));
  const row = await env.DB.prepare('INSERT INTO monitor_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(`${key}:${window}`, new Date((window + 1) * seconds * 1000).toISOString()).first();
  return row.count > max;
}
async function smallBody(request) {
  if (Number(request.headers.get('content-length')) > 8192) throw new Error('body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body required');
  let bytes = 0, parts = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 8192) { await reader.cancel(); throw new Error('body too large'); } parts.push(value); }
  const all = new Uint8Array(bytes); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.length; }
  const data = JSON.parse(new TextDecoder().decode(all));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid body');
  return data;
}
function cookie(value, age = 604800) { return `__Host-momoMonitor=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`; }
function sameOrigin(request) { return request.headers.get('origin') === new URL(request.url).origin; }
function isTest(request) { const h = new URL(request.url).hostname; return Number(![MAIN, BACKUP].includes(h) || request.headers.get('x-momo-monitor') === 'probe'); }

async function collect(request, env) {
  if (!sameOrigin(request)) return reply({ error: 'origin rejected' }, 403);
  if (request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') return new Response(null, { status: 204, headers });
  const data = await smallBody(request);
  if (!idPattern.test(data.id || '') || !idPattern.test(data.session || '') || !['pageview','pulse','event'].includes(data.type)) return reply({ error: 'invalid event' }, 400);
  const visitor = await identity(request, env);
  if (await limited(env, `collect:${visitor}`, 120, 60)) return reply({ error: 'rate limited' }, 429);
  const session = await sign(env.MONITOR_SECRET, `${day()}|${data.session}`);
  const time = stamp();
  if (data.type === 'pageview') {
    const ua = clientInfo(request.headers.get('user-agent') || '');
    let referrer = ''; try { referrer = new URL(data.referrer).hostname; } catch {}
    if (referrer === new URL(request.url).hostname) referrer = 'internal';
    const cf = request.cf || {};
    // Source tags accept campaign codes only, never arbitrary query strings or URLs.
    const tag = v => /^[a-zA-Z0-9_.-]{1,64}$/.test(v || '') ? v : '';
    await env.DB.prepare(`INSERT OR IGNORE INTO web_visits
      (id,visitor,session,started_at,last_seen,host,path,language,referrer,source,medium,campaign,country,region,city,network,browser,os,device,bot,test)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(data.id, visitor, session, time, time, new URL(request.url).hostname, '/', clean(data.language, 16), clean(referrer, 100), tag(data.source), tag(data.medium), tag(data.campaign), clean(cf.country, 8), clean(cf.region), clean(cf.city), clean(cf.asOrganization), ua.browser, ua.os, ua.device, ua.bot, Number(Boolean(data.test) || isTest(request))).run();
  } else {
    const existing = await env.DB.prepare('SELECT id,session,started_at FROM web_visits WHERE id=?').bind(data.id).first();
    const visitDay = existing ? new Date(Date.parse(existing.started_at)+8*3600e3).toISOString().slice(0,10) : '';
    if (!existing || !equal(existing.session, await sign(env.MONITOR_SECRET, `${visitDay}|${data.session}`))) return reply({ error: 'visit not found' }, 409);
    if (data.type === 'pulse') {
      await env.DB.prepare(`UPDATE web_visits SET last_seen=?,duration_ms=MAX(duration_ms,?),scroll=MAX(scroll,?),
        lcp_ms=CASE WHEN ?>0 THEN ? ELSE lcp_ms END, cls=CASE WHEN ?>=0 THEN ? ELSE cls END,
        inp_ms=CASE WHEN ?>0 THEN ? ELSE inp_ms END,ttfb_ms=CASE WHEN ?>0 THEN ? ELSE ttfb_ms END WHERE id=?`).bind(time, bounded(data.duration, 14400e3), bounded(data.scroll, 100), bounded(data.lcp,120e3),bounded(data.lcp,120e3), typeof data.cls === 'number' ? bounded(data.cls,100) : -1,bounded(data.cls,100), bounded(data.inp,120e3),bounded(data.inp,120e3),bounded(data.ttfb,120e3),bounded(data.ttfb,120e3),data.id).run();
    } else {
      const allowed = { section: sections, click: new Set(['claim','redeem','cash-request','token-request','reset','language','outbound','navigation','team']), error: new Set(['javascript','promise','resource']), conversion: new Set(['claim','redeem','cash-request','token-request']) };
      if (!allowed[data.kind]?.has(data.name)) return reply({ error: 'event not allowed' }, 400);
      if (!idPattern.test(data.eventId || '')) return reply({ error: 'invalid event id' }, 400);
      await env.DB.prepare('INSERT OR IGNORE INTO web_events(id,visit_id,created_at,kind,name,value) VALUES (?,?,?,?,?,?)').bind(data.eventId,data.id,time,data.kind,data.name,bounded(data.value,1e6)).run();
      await env.DB.prepare('UPDATE web_visits SET last_seen=? WHERE id=?').bind(time,data.id).run();
    }
  }
  return new Response(null, { status: 204, headers });
}

export async function recordRequest(request, response, env, ms) {
  if (!env.DB || !env.MONITOR_SECRET) return;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/monitor') || url.pathname === '/observatory' || url.pathname === '/momo-analytics.js' || request.method === 'OPTIONS') return;
  const bot = clientInfo(request.headers.get('user-agent') || '').bot;
  await env.DB.prepare(`INSERT INTO request_metrics(minute,host,path,method,status,bot,test,total_ms,max_ms) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(minute,host,path,method,status,bot,test) DO UPDATE SET requests=requests+1,total_ms=total_ms+excluded.total_ms,max_ms=MAX(max_ms,excluded.max_ms)`)
    .bind(stamp().slice(0,16),url.hostname,safePath(url.pathname),['GET','POST','HEAD'].includes(request.method) ? request.method : 'OTHER',response.status,bot,isTest(request),ms,ms).run();
}

export async function runChecks(env, trigger = 'scheduled', fetcher = fetch) {
  const targets = [ ['官网',`https://${MAIN}/`], ['主站 API',`https://${MAIN}/health`], ['备用 API',`https://${BACKUP}/health`], ['团队静态资源',`https://${MAIN}/assets/team/team-portrait-momo-cutout-v5.png`] ];
  const results = await Promise.all(targets.map(async ([target, url]) => {
    const start = Date.now(); let ok = false, status = 0, detail = '';
    try {
      const response = await fetcher(url, { headers: { 'x-momo-monitor': 'probe', 'user-agent': 'MOMO-Uptime-Monitor/1.0' }, signal: AbortSignal.timeout(10000), redirect:'manual' });
      status = response.status; ok = response.ok;
      if (url.endsWith('/health')) { const body = await response.json(); ok = ok && body.ok === true; detail = clean(body.build); }
      else if (target === '官网') { const body = await response.text(); ok = ok && body.includes('MOMO'); detail = ok ? '首页内容正常' : '首页内容异常'; }
      else { ok = ok && (response.headers.get('content-type') || '').startsWith('image/'); await response.body?.cancel(); detail = ok ? '图片可读取' : '图片异常'; }
    } catch (e) { detail = e.name === 'TimeoutError' ? '请求超时（10 秒）' : `连接或响应失败：${clean(e.message,120)}`; }
    return { target, ok:Number(ok), status, latency_ms:Date.now()-start, detail };
  }));
  const started = Date.now(); let dbOK = 1;
  try { await env.DB.prepare('SELECT 1 AS ok').first(); } catch { dbOK = 0; }
  results.push({ target:'业务数据库',ok:dbOK,status:dbOK ? 200 : 0,latency_ms:Date.now()-started,detail:dbOK ? '读查询正常' : '数据库不可用' });
  await env.DB.batch(results.map(r=>env.DB.prepare('INSERT INTO health_checks(checked_at,target,ok,status,latency_ms,detail,trigger) VALUES (?,?,?,?,?,?,?)').bind(stamp(),r.target,r.ok,r.status,r.latency_ms,r.detail,trigger)));
  // Retention is intentionally bounded: detailed visits/events 90 days; probes/requests 30 days.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM web_events WHERE visit_id IN (SELECT id FROM web_visits WHERE started_at < ?)").bind(new Date(Date.now()-90*86400e3).toISOString()),
    env.DB.prepare('DELETE FROM web_visits WHERE started_at < ?').bind(new Date(Date.now()-90*86400e3).toISOString()),
    env.DB.prepare('DELETE FROM request_metrics WHERE minute < ?').bind(new Date(Date.now()-30*86400e3).toISOString().slice(0,16)),
    env.DB.prepare('DELETE FROM health_checks WHERE checked_at < ?').bind(new Date(Date.now()-30*86400e3).toISOString()),
    env.DB.prepare('DELETE FROM monitor_limits WHERE expires_at < ?').bind(stamp()),
  ]);
  return results;
}
function range(url) {
  const today = day(); const start = url.searchParams.get('from') || today; const end = url.searchParams.get('to') || today;
  if (![start,end].every(s=>/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s) || start > end || (Date.parse(end)-Date.parse(start))/86400e3 > 89) throw new Error('日期区间需为 1–90 天');
  return { start, end, from:new Date(`${start}T00:00:00+08:00`).toISOString(), to:new Date(Date.parse(`${end}T00:00:00+08:00`)+86400e3).toISOString(), test:url.searchParams.get('test') === '1' ? 1 : 0 };
}
async function report(url, env) {
  const r = range(url); const where = 'started_at>=? AND started_at<? AND test=? AND bot=0';
  const args = [r.from,r.to,r.test];
  const all = async (sql, bind=args) => (await env.DB.prepare(sql).bind(...bind).all()).results;
  const one = (sql, bind=args) => env.DB.prepare(sql).bind(...bind).first();
  const group = field => all(`SELECT ${field} AS name,COUNT(*) AS views,COUNT(DISTINCT visitor) AS visitors FROM web_visits WHERE ${where} GROUP BY ${field} ORDER BY views DESC LIMIT 30`);
  const queries = {
    totals:one(`SELECT COUNT(*) AS views,COUNT(DISTINCT visitor) AS visitors,COUNT(DISTINCT session) AS sessions,AVG(duration_ms) AS duration,AVG(scroll) AS scroll FROM web_visits WHERE ${where}`),
    trend:all(`SELECT strftime('%Y-%m-%d',started_at,'+8 hours') AS day,COUNT(*) AS views,COUNT(DISTINCT visitor) AS visitors FROM web_visits WHERE ${where} GROUP BY day ORDER BY day`),
    hours:all(`SELECT strftime('%H',started_at,'+8 hours') AS hour,COUNT(*) AS views FROM web_visits WHERE ${where} GROUP BY hour ORDER BY hour`),
    sessionStats:one(`SELECT COUNT(*) AS total,SUM(CASE WHEN views=1 AND duration<10000 AND conversions=0 THEN 1 ELSE 0 END) AS bounced FROM (SELECT v.session,COUNT(*) AS views,SUM(v.duration_ms) AS duration,(SELECT COUNT(*) FROM web_events e JOIN web_visits w ON w.id=e.visit_id WHERE w.session=v.session AND e.kind='conversion') AS conversions FROM web_visits v WHERE ${where} GROUP BY v.session)`),
    live:one('SELECT COUNT(DISTINCT visitor) AS visitors FROM web_visits WHERE last_seen>=? AND test=? AND bot=0',[new Date(Date.now()-5*60e3).toISOString(),r.test]),
    countries:group("COALESCE(NULLIF(country,''),'Unknown')"), cities:group("COALESCE(NULLIF(country || ' / ' || region || ' / ' || city,' /  / '),'Unknown')"),
    sources:group("COALESCE(NULLIF(source,''),NULLIF(referrer,''),'Direct')"),campaigns:group("COALESCE(NULLIF(campaign,''),'未标记')"),devices:group('device'),browsers:group('browser'),systems:group('os'),languages:group('language'),networks:group("COALESCE(NULLIF(network,''),'Unknown')"),
    events:all(`SELECT e.kind,e.name,COUNT(*) AS count,COUNT(DISTINCT v.session) AS sessions FROM web_events e JOIN web_visits v ON v.id=e.visit_id WHERE v.${where} GROUP BY e.kind,e.name ORDER BY count DESC`),
    visits:all(`SELECT id,substr(visitor,1,12) AS visitor,substr(session,1,12) AS session,started_at,last_seen,host,path,language,referrer,source,medium,campaign,country,region,city,network,browser,os,device,duration_ms,scroll,lcp_ms,cls,inp_ms,ttfb_ms FROM web_visits WHERE ${where} ORDER BY started_at DESC LIMIT 100`),
    performance:all(`SELECT lcp_ms,cls,inp_ms,ttfb_ms FROM web_visits WHERE ${where} AND (lcp_ms IS NOT NULL OR cls IS NOT NULL OR inp_ms IS NOT NULL OR ttfb_ms IS NOT NULL) ORDER BY started_at DESC LIMIT 10000`),
    requests:all('SELECT path,method,status,bot,SUM(requests) AS requests,SUM(total_ms)/SUM(requests) AS latency,MAX(max_ms) AS maxLatency FROM request_metrics WHERE minute>=? AND minute<? AND test=? GROUP BY path,method,status,bot ORDER BY requests DESC',[r.from.slice(0,16),r.to.slice(0,16),r.test]),
    checks:all('SELECT * FROM health_checks WHERE id IN (SELECT MAX(id) FROM health_checks GROUP BY target)',[]),
    uptime:all('SELECT target,COUNT(*) AS samples,AVG(ok)*100 AS uptime,AVG(latency_ms) AS latency FROM health_checks WHERE checked_at>=? AND checked_at<? AND trigger=? GROUP BY target',[r.from,r.to,'scheduled']),
    incidents:all('SELECT * FROM health_checks WHERE ok=0 AND checked_at>=? AND checked_at<? ORDER BY checked_at DESC LIMIT 50',[r.from,r.to]),
    history:all('SELECT * FROM health_checks WHERE target=? ORDER BY checked_at DESC LIMIT 60',['官网']),
    meta:one('SELECT value AS started_at FROM monitor_meta WHERE key=?',['started_at']),
    business:one(`SELECT (SELECT COUNT(*) FROM accounts) AS accounts,(SELECT COUNT(*) FROM claims) AS claims,(SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM cash_redemptions WHERE status='integration_pending') AS pendingCash,(SELECT COUNT(*) FROM token_mints WHERE status='confirmed') AS confirmedMints,(SELECT COUNT(*) FROM token_mints WHERE status='failed') AS failedMints`,[]),
  };
  const result = Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([k,v])=>[k,await v])));
  const p75 = key => { const values = result.performance.map(x=>x[key]).filter(x=>x!==null).sort((a,b)=>a-b); return { value:values.length ? values[Math.ceil(values.length*.75)-1] : null, samples:values.length }; };
  result.vitals = Object.fromEntries(['lcp_ms','cls','inp_ms','ttfb_ms'].map(k=>[k,p75(k)])); delete result.performance;
  result.range = r; result.generated_at=stamp(); result.timezone='Asia/Shanghai';
  return result;
}
export function csvValue(value) {
  let s = value == null ? '' : String(value); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"','""') + '"';
}
async function exportCSV(url, env) {
  const r=range(url), offset=Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset<0) return reply({error:'invalid offset'},400);
  const dataset=url.searchParams.get('dataset') || 'visits';
  const queries={
    visits:['SELECT id,started_at,last_seen,host,path,language,referrer,source,medium,campaign,country,region,city,network,browser,os,device,duration_ms,scroll,lcp_ms,cls,inp_ms,ttfb_ms FROM web_visits WHERE started_at>=? AND started_at<? AND test=? AND bot=0 ORDER BY started_at DESC,id DESC',[r.from,r.to,r.test]],
    events:['SELECT e.id,e.visit_id,e.created_at,e.kind,e.name,e.value FROM web_events e JOIN web_visits v ON v.id=e.visit_id WHERE v.started_at>=? AND v.started_at<? AND v.test=? AND v.bot=0 ORDER BY e.created_at DESC,e.id DESC',[r.from,r.to,r.test]],
    requests:['SELECT * FROM request_metrics WHERE minute>=? AND minute<? AND test=? ORDER BY minute DESC,host,path,method,status,bot,test',[r.from.slice(0,16),r.to.slice(0,16),r.test]],
    checks:['SELECT * FROM health_checks WHERE checked_at>=? AND checked_at<? ORDER BY checked_at DESC,id DESC',[r.from,r.to]],
  };
  if(!queries[dataset])return reply({error:'invalid dataset'},400);
  const [sql,args]=queries[dataset];
  const rows=(await env.DB.prepare(sql+' LIMIT 10000 OFFSET ?').bind(...args,offset).all()).results;
  const cols=rows.length ? Object.keys(rows[0]) : ['id','started_at'];
  return new Response('\uFEFF'+[cols,...rows.map(row=>cols.map(c=>row[c]))].map(row=>row.map(csvValue).join(',')).join('\r\n'),{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="momo-${dataset}-${r.start}-${offset}.csv"`}});
}
export async function monitorRoute(request,env) {
  const url=new URL(request.url), path=url.pathname;
  if (path === '/momo-analytics.js' && request.method==='GET') return new Response(trackerScript(),{headers:{...headers,'Content-Type':'application/javascript; charset=utf-8'}});
  if (path !== '/observatory' && !path.startsWith('/api/monitor/')) return null;
  if (path === '/observatory' && request.method==='GET') return new Response(monitorPage(),{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
  if (!env.MONITOR_PASSWORD || !env.MONITOR_SECRET || !env.DB) return reply({error:'监控尚未配置'},503);
  try {
    if (path==='/api/monitor/collect' && request.method==='POST') return await collect(request,env);
    if (path==='/api/monitor/login' && request.method==='POST') {
      if (!sameOrigin(request)) return reply({error:'origin rejected'},403);
      const ip=await sign(env.MONITOR_SECRET, `login|${day()}|${request.headers.get('CF-Connecting-IP') || 'unknown'}`);
      if (await limited(env,`login:${ip}`,10,900)) return reply({error:'尝试次数过多，请 15 分钟后重试'},429);
      const data=await smallBody(request);
      if (typeof data.password!=='string' || data.password.length>256 || !equal(await sign(env.MONITOR_SECRET,data.password),await sign(env.MONITOR_SECRET,env.MONITOR_PASSWORD))) return reply({error:'密码不正确'},401);
      const value=`${Date.now()+7*86400e3}.${crypto.randomUUID()}`;
      return reply({ok:true},200,{'Set-Cookie':cookie(`${value}.${await sign(env.MONITOR_SECRET,`${value}|${env.MONITOR_PASSWORD}`)}`)});
    }
    if (!(await authenticated(request,env))) return reply({error:'请先登录'},401);
    if (request.method!=='GET' && !sameOrigin(request)) return reply({error:'origin rejected'},403);
    if (path==='/api/monitor/logout' && request.method==='POST') return reply({ok:true},200,{'Set-Cookie':cookie('',0)});
    if (path==='/api/monitor/report' && request.method==='GET') return reply(await report(url,env));
    if (path==='/api/monitor/export' && request.method==='GET') return await exportCSV(url,env);
    if (path==='/api/monitor/check' && request.method==='POST') {
      if (await limited(env,'manual-check',2,60)) return reply({error:'每分钟最多检查两次'},429);
      return reply({checks:await runChecks(env,'manual')});
    }
    return reply({error:'not found'},404);
  } catch(error) {
    if (/body|JSON|日期/.test(error.message)) return reply({error:clean(error.message)},400);
    console.error('Monitor request failed',error.name);
    return reply({error:'监控读取失败，请稍后刷新；统计暂不代表零流量'},503);
  }
}
