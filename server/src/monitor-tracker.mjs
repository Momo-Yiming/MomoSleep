// Serve literal browser JavaScript, independent of Worker bundler transformations.
export const trackerScript = () => String.raw`(function tracker() {
  if (location.pathname !== '/') return;
  const en = document.documentElement.lang === 'en';
  const text = (zh, eng) => en ? eng : zh;
  const get = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const set = value => { try { localStorage.setItem('momoAnalyticsConsent', value); } catch {} };
  const excluded = navigator.globalPrivacyControl || navigator.doNotTrack === '1';
  let enabled = false, begun = false, visit, session, timer, elapsed = 0, last = performance.now(), scroll = 0;
  let wasVisible = document.visibilityState === 'visible';
  let lcp = null, cls = null, inp = null, ttfb = null;
  const api = '/api/monitor/collect';
  let ready = Promise.resolve(false);
  const send = async (data, beacon = false) => {
    if (!enabled) return;
    if (data.type !== 'pageview' && !(await ready)) return;
    const payload = JSON.stringify({ id:visit,session,...data });
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon(api,new Blob([payload],{type:'application/json'})); return; }
    try { return (await fetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:payload,keepalive:true})).ok; } catch { return false; }
  };
  const event = (kind,name,value=0) => send({type:'event',kind,name,value,eventId:crypto.randomUUID()});
  const tick = () => { const now = performance.now(); if (wasVisible) elapsed += Math.min(now-last,30000); last=now; wasVisible=document.visibilityState === 'visible'; const denominator=document.documentElement.scrollHeight-innerHeight; scroll=Math.max(scroll,denominator>0 ? Math.round(scrollY/denominator*100) : 100); };
  const pulse = beacon => { tick(); send({type:'pulse',duration:Math.round(elapsed),scroll,lcp,cls,inp,ttfb},beacon); };
  function start() {
    if (begun || excluded) return; begun=true; enabled=true;
    visit=crypto.randomUUID();
    // Only consenting visitors use a tab-scoped session, refreshed after 30 min of inactivity.
    try { const old=JSON.parse(sessionStorage.getItem('momoAnalyticsSession') || 'null'); session=old && Date.now()-old.at<1800000 ? old.id : crypto.randomUUID(); sessionStorage.setItem('momoAnalyticsSession',JSON.stringify({id:session,at:Date.now()})); } catch { session=crypto.randomUUID(); }
    const params = new URLSearchParams(location.search);
    ready=send({type:'pageview',session,language:document.documentElement.lang,referrer:document.referrer,source:params.get('utm_source'),medium:params.get('utm_medium'),campaign:params.get('utm_campaign'),test:params.get('momo_test')==='1'});
    last=performance.now();
    timer=setInterval(()=>{ pulse(false); try { sessionStorage.setItem('momoAnalyticsSession',JSON.stringify({id:session,at:Date.now()})); } catch {} },15000);
    const observe=(type,callback,options={})=>{ try { new PerformanceObserver(list=>callback(list.getEntries())).observe({type,buffered:true,...options}); } catch {} };
    observe('largest-contentful-paint',entries=>{lcp=entries.at(-1)?.startTime ?? lcp;});
    // CLS uses the standard 1 second gap / 5 second session window.
    let clsWindow=0, clsStart=0, clsLast=0;
    observe('layout-shift',entries=>{ cls ??= 0; for(const e of entries) if(!e.hadRecentInput) { if(e.startTime-clsLast>1000 || e.startTime-clsStart>5000) { clsWindow=0; clsStart=e.startTime; } clsWindow+=e.value; clsLast=e.startTime; cls=Math.max(cls,clsWindow); } });
    // Approximate INP: longest measured event duration, without the web-vitals library's outlier trimming.
    observe('event',entries=>{ for(const e of entries) if(e.interactionId) inp=Math.max(inp || 0,e.duration); },{durationThreshold:40});
    const navigation=performance.getEntriesByType('navigation')[0]; if(navigation) ttfb=navigation.responseStart-navigation.requestStart;
    const viewed=new Set();
    const ids=new Set(['opening','team','project','quality-score','sandbox','cashout','tokenize','external-value','stepn','market','hardware','batches','positioning','manifesto']);
    if ('IntersectionObserver' in window) { const observer=new IntersectionObserver(entries=>{for(const e of entries) if(e.isIntersecting && !viewed.has(e.target.id)){viewed.add(e.target.id);event('section',e.target.id);}},{threshold:0.15}); document.querySelectorAll('section[id]').forEach(el=>{if(ids.has(el.id))observer.observe(el);}); }
    document.addEventListener('click',e=>{
      const el=e.target.closest('button,a'); if(!el) return;
      const action=el.getAttribute('onclick') || '';
      const name=el.matches('[data-team-member]') ? 'team' : el.classList.contains('buy') ? 'redeem' : /claim\(/.test(action) ? 'claim' : /requestCashRedemption/.test(action) ? 'cash-request' : /requestTokenMint/.test(action) ? 'token-request' : /resetDemo/.test(action) ? 'reset' : el.classList.contains('language-switch') ? 'language' : el.tagName==='A' && el.getAttribute('href')?.startsWith('#') ? 'navigation' : el.tagName==='A' && el.hostname!==location.hostname ? 'outbound' : null;
      if(name) event('click',name);
    });
    let errors=0;
    addEventListener('error',e=>{if(errors++<10)event('error',e.target===window?'javascript':'resource');},true);
    addEventListener('unhandledrejection',()=>{if(errors++<10)event('error','promise');});
    addEventListener('momo:conversion',e=>{if(['claim','redeem','cash-request','token-request'].includes(e.detail))event('conversion',e.detail);});
    addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){pulse(true);} last=performance.now();wasVisible=document.visibilityState === 'visible';});
    addEventListener('pagehide',()=>pulse(true));
    addEventListener('pageshow',e=>{if(e.persisted){last=performance.now();}});
  }
  const panel=document.createElement('aside');
  panel.setAttribute('aria-label',text('访问统计偏好','Analytics preferences'));
  panel.style.cssText='position:fixed;bottom:12px;left:12px;right:12px;z-index:50;max-width:680px;padding:14px 16px;border:1px solid #3b526c;border-radius:12px;background:#101d30;color:#eaf1ff;box-shadow:0 8px 36px #0005;font:14px/1.6 system-ui';
  function preference() {
    panel.replaceChildren();
    const description=document.createElement('div');
    description.textContent=excluded ? text('已遵循浏览器隐私偏好，详细访问统计关闭。','Browser privacy preference honored. Detailed analytics is off.') : text('允许匿名访问统计，帮助改进官网？记录页面互动、设备与大致地区，明细保留 90 天；不收集姓名、完整 IP、睡眠数据或输入内容。','Allow anonymous analytics? Page interactions, device and approximate location are retained for 90 days. No names, full IP addresses, sleep data or form input.');
    panel.append(description);
    const button=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.type='button';b.style.cssText='margin:10px 8px 0 0;padding:7px 12px;font:inherit;border:1px solid #52769d;border-radius:7px;background:#203952;color:#fff;cursor:pointer';b.onclick=fn;panel.append(b);};
    if(!excluded)button(text('允许匿名统计','Allow analytics'),()=>{set('yes');panel.remove(); if(!begun)start(); else location.reload();});
    button(text('仅必要 / 关闭统计','Necessary only / Disable'),()=>{set('no');enabled=false;clearInterval(timer);panel.remove();try{sessionStorage.removeItem('momoAnalyticsSession');}catch{}});
    document.body.append(panel);
  }
  const footer=document.createElement('div');footer.style.cssText='padding:18px;text-align:center;color:#9cb0cc;font:14px system-ui';
  const toggle=document.createElement('button');toggle.type='button';toggle.textContent=text('访问统计偏好','Analytics preferences');toggle.style.cssText='font:inherit;color:inherit;background:none;border:0;text-decoration:underline;cursor:pointer';toggle.onclick=preference;footer.append(toggle);document.body.append(footer);
  if(get('momoAnalyticsConsent')==='yes')start();else if(!get('momoAnalyticsConsent') && !excluded)preference();
})();`;
