// 微澜 · 后端：Node 内置 http + node:sqlite + crypto，零外部依赖。
// 运行： node server.js  然后打开 http://localhost:3000
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(join(__dirname, 'pms.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  cat TEXT, icon TEXT, label TEXT, ind TEXT, time TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  emoji TEXT, title TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, date);
`);

/* ---------- 默认状态 & 历史数据（按日期编入） ---------- */
function defaultState(nickname){
  return {
    nickname,
    cycle:{ last:"2025-06-18", avgLen:28, periodLen:5, conf:"低" },
    tasks:[
      {id:1,name:"出去慢走 10 分钟",done:1,total:1},
      {id:2,name:"发消息前先写下来",done:1,total:2},
      {id:3,name:"拉伸 5 分钟",done:0,total:1}
    ],
    rewards:[
      {em:"🎬",name:"看一部电影",pt:8},
      {em:"💐",name:"买一束花",pt:12},
      {em:"🌙",name:"给自己一个安静晚上",pt:6}
    ],
    points:14, chat:[], ai:{}, onboarded:false
  };
}
// 黄体期 PMS 逐渐加重的历史；注意：不含今天(2025-07-11)，今天从空开始
const SEED = {
  "2025-06-18":[["physical","🤕","身体不适","生活事件","09:20"]],
  "2025-06-19":[["energy","🪫","精力低","精力","10:05"],["physical","🤕","痛经","生活事件","21:30"]],
  "2025-06-20":[["mood","😢","情绪低落","情绪","14:10"]],
  "2025-06-24":[["sleep","😴","睡眠良好","睡眠","08:00"]],
  "2025-06-26":[["mood","😌","情绪平稳","情绪","12:00"]],
  "2025-06-28":[["bowel","🚽","已排便","排便","08:30"],["mood","😌","情绪平稳","情绪","19:00"]],
  "2025-06-30":[["sleep","😴","睡眠良好","睡眠","07:40"],["energy","💪","精力充沛","精力","11:00"]],
  "2025-07-02":[["mood","😌","情绪平稳","情绪","13:00"]],
  "2025-07-03":[["energy","🪫","精力低","精力","16:20"]],
  "2025-07-04":[["mood","😢","情绪低落","情绪","20:10"],["craving","🍰","想吃甜食","情绪","21:00"]],
  "2025-07-05":[["mood","😰","焦虑","情绪","09:50"],["sleep","🌙","睡眠不佳","睡眠","23:40"]],
  "2025-07-06":[["mood","😮‍💨","情绪烦躁","情绪","15:30"],["skin","🌵","皮肤状态变化","皮肤","08:15"]],
  "2025-07-07":[["bowel","🚽","便秘","排便","08:20"],["energy","🪫","精力低","精力","17:00"]],
  "2025-07-08":[["relationship","💔","伴侣冲突","生活事件","21:15"],["mood","😢","情绪低落","情绪","22:00"]],
  "2025-07-09":[["mood","😰","焦虑","情绪","10:30"],["sleep","🌙","睡眠不佳","睡眠","23:50"],["craving","🍰","想吃甜食","情绪","16:40"]],
  "2025-07-10":[["bowel","🚽","排便偏硬","排便","08:10"],["physical","👀","眼睛酸涩","生活事件","14:00"],["mood","😮‍💨","情绪烦躁","情绪","18:30"],["energy","🪫","精力低 / 低动力","精力","20:00"]]
};
function seedEntries(userId){
  const ins=db.prepare('INSERT INTO entries(user_id,date,cat,icon,label,ind,time) VALUES(?,?,?,?,?,?,?)');
  for(const [date, evs] of Object.entries(SEED))
    for(const [cat,icon,label,ind,time] of evs) ins.run(userId,date,cat,icon,label,ind,time);
}
// 播种几天的打卡历史（含"昨天"），演示连续打卡
const SEED_TASKS=[
  ['2025-07-09','😴','10 点预警，早点睡',1],
  ['2025-07-10','🚶‍♀️','出门走 10 分钟',1],
  ['2025-07-10','🫁','3 分钟 4-7-8 呼吸',1],
  ['2025-07-10','🌼','做一件小确幸的事',0]
];
function seedTasks(userId){
  const ins=db.prepare('INSERT INTO tasks(user_id,date,emoji,title,done,done_at,created_at) VALUES(?,?,?,?,?,?,?)');
  const now=new Date().toISOString();
  for(const [date,emoji,title,done] of SEED_TASKS) ins.run(userId,date,emoji,title,done,done?date+'T20:00:00Z':null,now);
}

/* ---------- AI 配置（默认接入真实大模型；密钥从环境或用户 Claude 配置读取，不写进源码） ---------- */
function aiConfig(){
  let base=process.env.ANTHROPIC_BASE_URL, token=process.env.ANTHROPIC_AUTH_TOKEN||process.env.ANTHROPIC_API_KEY, model=process.env.AI_MODEL;
  try{ const c=JSON.parse(readFileSync(join(__dirname,'ai.config.json'),'utf8')); base=c.base||base; token=c.token||token; model=c.model||model; }catch(e){}
  if(!token){ try{ const s=JSON.parse(readFileSync(join(process.env.HOME||'','.claude','settings.json'),'utf8')); base=base||(s.env&&s.env.ANTHROPIC_BASE_URL); token=token||(s.env&&(s.env.ANTHROPIC_AUTH_TOKEN||s.env.ANTHROPIC_API_KEY)); }catch(e){} }
  return { base:(base||'https://api.anthropic.com').replace(/\/+$/,''), token, model:model||'claude-sonnet-4-20250514' };
}

/* ---------- 认证工具 ---------- */
const hashPw=(pw,salt)=>scryptSync(pw,salt,64).toString('hex');
function newSession(userId){
  const token=randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)').run(token,userId,new Date().toISOString());
  return token;
}
function userFromReq(req){
  const cookie=req.headers.cookie||'';
  const m=cookie.match(/(?:^|;\s*)sid=([a-f0-9]+)/);
  if(!m) return null;
  const s=db.prepare('SELECT user_id FROM sessions WHERE token=?').get(m[1]);
  if(!s) return null;
  return db.prepare('SELECT id,username,state_json FROM users WHERE id=?').get(s.user_id);
}
function payload(user){
  const rows=db.prepare('SELECT date,cat,icon,label,ind,time FROM entries WHERE user_id=? ORDER BY date,time').all(user.id);
  const tasks=db.prepare('SELECT id,date,emoji,title,done,done_at FROM tasks WHERE user_id=? ORDER BY date DESC, id').all(user.id);
  return { user:{ username:user.username }, state:JSON.parse(user.state_json), entries:rows, tasks, aiReady: !!aiConfig().token };
}

/* ---------- HTTP 辅助 ---------- */
const send=(res,code,obj,headers={})=>{ res.writeHead(code,{'content-type':'application/json',...headers}); res.end(JSON.stringify(obj)); };
const readBody=req=>new Promise(r=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>{try{r(d?JSON.parse(d):{})}catch(e){r({})}})});
const cookieHeader=token=>`sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`;

const server=createServer(async (req,res)=>{
  const url=new URL(req.url, 'http://x');
  const path=url.pathname;

  // 静态：首页
  if(req.method==='GET' && (path==='/'||path==='/index.html')){
    try{ res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); res.end(readFileSync(join(__dirname,'index.html'))); }
    catch(e){ res.writeHead(500); res.end('index.html not found'); }
    return;
  }

  try{
    if(path==='/api/register' && req.method==='POST'){
      const {username,password}=await readBody(req);
      if(!username||username.length<2||!password||password.length<4) return send(res,400,{error:'用户名≥2位，密码≥4位'});
      if(db.prepare('SELECT id FROM users WHERE username=?').get(username)) return send(res,409,{error:'用户名已存在'});
      const salt=randomBytes(16).toString('hex');
      const state=JSON.stringify(defaultState(username));
      const info=db.prepare('INSERT INTO users(username,pass_hash,salt,state_json,created_at) VALUES(?,?,?,?,?)')
        .run(username,hashPw(password,salt),salt,state,new Date().toISOString());
      const userId=Number(info.lastInsertRowid);
      seedEntries(userId);
      seedTasks(userId);
      const user=db.prepare('SELECT id,username,state_json FROM users WHERE id=?').get(userId);
      return send(res,200,payload(user),{'set-cookie':cookieHeader(newSession(userId))});
    }

    if(path==='/api/login' && req.method==='POST'){
      const {username,password}=await readBody(req);
      const user=db.prepare('SELECT id,username,pass_hash,salt,state_json FROM users WHERE username=?').get(username||'');
      if(!user) return send(res,401,{error:'用户名或密码错误'});
      const h=hashPw(password||'',user.salt);
      const ok = h.length===user.pass_hash.length && timingSafeEqual(Buffer.from(h),Buffer.from(user.pass_hash));
      if(!ok) return send(res,401,{error:'用户名或密码错误'});
      return send(res,200,payload(user),{'set-cookie':cookieHeader(newSession(user.id))});
    }

    if(path==='/api/logout' && req.method==='POST'){
      const cookie=req.headers.cookie||''; const m=cookie.match(/(?:^|;\s*)sid=([a-f0-9]+)/);
      if(m) db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]);
      return send(res,200,{ok:true},{'set-cookie':'sid=; HttpOnly; Path=/; Max-Age=0'});
    }

    // 以下需要登录
    const user=userFromReq(req);
    if(path==='/api/me' && req.method==='GET'){
      if(!user) return send(res,401,{error:'未登录'});
      return send(res,200,payload(user));
    }
    if(!user) return send(res,401,{error:'未登录'});

    if(path==='/api/entries' && req.method==='POST'){
      const {date,events}=await readBody(req);
      if(!date||!Array.isArray(events)) return send(res,400,{error:'参数错误'});
      const ins=db.prepare('INSERT INTO entries(user_id,date,cat,icon,label,ind,time) VALUES(?,?,?,?,?,?,?)');
      for(const e of events) ins.run(user.id,date,e.cat||'',e.icon||'',e.label||'',e.ind||'',e.time||'');
      return send(res,200,{ok:true});
    }
    if(path==='/api/entries' && req.method==='DELETE'){
      const date=url.searchParams.get('date');
      if(!date) return send(res,400,{error:'缺少 date'});
      db.prepare('DELETE FROM entries WHERE user_id=? AND date=?').run(user.id,date);
      return send(res,200,{ok:true});
    }
    if(path==='/api/state' && req.method==='PUT'){
      const {state}=await readBody(req);
      if(!state) return send(res,400,{error:'缺少 state'});
      db.prepare('UPDATE users SET state_json=? WHERE id=?').run(JSON.stringify(state),user.id);
      return send(res,200,{ok:true});
    }
    if(path==='/api/tasks' && req.method==='POST'){
      const {date,emoji,title}=await readBody(req);
      if(!date||!title) return send(res,400,{error:'参数错误'});
      const info=db.prepare('INSERT INTO tasks(user_id,date,emoji,title,done,done_at,created_at) VALUES(?,?,?,?,0,NULL,?)')
        .run(user.id,date,emoji||'',title,new Date().toISOString());
      const row=db.prepare('SELECT id,date,emoji,title,done,done_at FROM tasks WHERE id=?').get(Number(info.lastInsertRowid));
      return send(res,200,row);
    }
    if(path==='/api/tasks/toggle' && req.method==='POST'){
      const {id}=await readBody(req);
      const t=db.prepare('SELECT id,done FROM tasks WHERE id=? AND user_id=?').get(id,user.id);
      if(!t) return send(res,404,{error:'任务不存在'});
      const nd=t.done?0:1;
      db.prepare('UPDATE tasks SET done=?, done_at=? WHERE id=?').run(nd, nd?new Date().toISOString():null, id);
      return send(res,200,{id,done:nd});
    }
    if(path==='/api/tasks' && req.method==='DELETE'){
      const id=url.searchParams.get('id');
      db.prepare('DELETE FROM tasks WHERE id=? AND user_id=?').run(id,user.id);
      return send(res,200,{ok:true});
    }
    if(path==='/api/ai' && req.method==='POST'){
      const cfg=aiConfig();
      if(!cfg.token) return send(res,400,{error:'AI 未配置'});
      const {system,user:uc,maxTokens}=await readBody(req);
      try{
        const r=await fetch(cfg.base+'/v1/messages',{method:'POST',headers:{
          'content-type':'application/json','x-api-key':cfg.token,'authorization':'Bearer '+cfg.token,'anthropic-version':'2023-06-01'
        },body:JSON.stringify({model:cfg.model,max_tokens:maxTokens||1024,system:system||'',messages:[{role:'user',content:uc||''}]})});
        const d=await r.json().catch(()=>({}));
        if(!r.ok) return send(res,502,{error:(d.error&&(d.error.message||d.error.type))||('HTTP '+r.status)});
        const text=(d.content||[]).map(b=>b.text||'').join('');
        return send(res,200,{text});
      }catch(e){ return send(res,502,{error:String(e.message||e)}); }
    }

    send(res,404,{error:'not found'});
  }catch(e){ console.error(e); send(res,500,{error:String(e.message||e)}); }
});

server.listen(PORT,()=>console.log(`微澜 running → http://localhost:${PORT}`));
