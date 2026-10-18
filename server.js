// ============================================================
//  blo. — мини-соцсеть в одном файле
//  Поддержка: картинки, загрузка видео, встраивание YouTube
//  Запуск:  node server.js
//  Открыть: http://localhost:3000
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_FILE = path.join(ROOT, 'data.json');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 200 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let db = { users: [], posts: [] };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) { console.error('data.json повреждён:', e.message); }
if (!Array.isArray(db.users)) db.users = [];
if (!Array.isArray(db.posts)) db.posts = [];

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), err => { if (err) console.error(err); });
  }, 150);
}

const sessions = new Map();
const uid = () => crypto.randomBytes(9).toString('hex');

function json(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, h] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  return db.users.find(u => u.id === s.userId) || null;
}

function startSession(user) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { userId: user.id, ts: Date.now() });
  return `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}

const pubUser = u => ({ id: u.id, username: u.username, name: u.name });

function postOut(p, me) {
  const author = db.users.find(u => u.id === p.userId);
  let media = p.media || null;
  if (!media && p.image) media = { url: p.image, kind: 'image' };
  return {
    id: p.id,
    text: p.text,
    media,
    ts: p.ts,
    author: author ? pubUser(author) : { username: 'deleted', name: '—' },
    likes: p.likes.length,
    liked: me ? p.likes.includes(me.id) : false,
    comments: p.comments.length,
    mine: me ? p.userId === me.id : false
  };
}

// ---------- приём файлов потоком ----------
const IMG_EXT = ['png', 'jpg', 'gif', 'webp'];
const VID_EXT = ['mp4', 'webm', 'mov', 'ogg', 'm4v'];
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function handleUpload(req, res, me) {
  if (!me) { req.resume(); return json(res, 401, { error: 'Нужно войти' }); }
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const m = /^(image|video)\/([a-z0-9.+-]+)$/.exec(ct);
  if (!m) { req.resume(); return json(res, 400, { error: 'Только изображения и видео' }); }
  const kind = m[1];
  let sub = m[2];
  if (sub === 'jpeg') sub = 'jpg';
  if (sub === 'quicktime') sub = 'mov';
  const allowed = kind === 'image' ? IMG_EXT : VID_EXT;
  if (!allowed.includes(sub)) { req.resume(); return json(res, 400, { error: 'Неподдерживаемый тип: ' + ct }); }
  const max = kind === 'video' ? MAX_VIDEO : MAX_IMAGE;

  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared && declared > max) {
    req.resume();
    return json(res, 400, { error: `Файл слишком большой (макс ${kind === 'video' ? 200 : 10} МБ)` });
  }

  const filename = uid() + '.' + sub;
  const filepath = path.join(UPLOAD_DIR, filename);
  const writeStream = fs.createWriteStream(filepath);
  let size = 0;
  let aborted = false;

  function fail(msg) {
    if (aborted) return;
    aborted = true;
    try { writeStream.destroy(); } catch (e) {}
    fs.unlink(filepath, () => {});
    try { json(res, 400, { error: msg }); } catch (e) {}
    try { req.destroy(); } catch (e) {}
  }

  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > max) return fail(`Файл слишком большой (макс ${kind === 'video' ? 200 : 10} МБ)`);
    if (!writeStream.write(chunk)) req.pause();
  });
  writeStream.on('drain', () => req.resume());
  writeStream.on('error', () => fail('Не удалось записать файл'));
  req.on('error', () => fail('Обрыв соединения'));
  req.on('end', () => {
    if (aborted) return;
    writeStream.end(() => {
      json(res, 200, { url: '/uploads/' + filename, kind });
    });
  });
}

async function api(req, res, pathname) {
  const me = currentUser(req);
  const method = req.method;
  const parts = pathname.split('/').filter(Boolean);

  if (pathname === '/api/upload' && method === 'PUT') {
    return handleUpload(req, res, me);
  }

  if (pathname === '/api/me' && method === 'GET') {
    return json(res, 200, { user: me ? pubUser(me) : null });
  }

  if (pathname === '/api/register' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    const password = String(b.password || '');
    const name = String(b.name || '').trim().slice(0, 40);
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return json(res, 400, { error: 'Ник: 3–20 символов, латиница, цифры, _' });
    if (password.length < 6) return json(res, 400, { error: 'Пароль минимум 6 символов' });
    if (db.users.some(u => u.username === username)) return json(res, 400, { error: 'Такой ник уже занят' });
    const user = { id: uid(), username, name: name || username, pass: hashPassword(password), ts: Date.now() };
    db.users.push(user);
    save();
    return json(res, 200, { user: pubUser(user) }, { 'Set-Cookie': startSession(user) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim().toLowerCase();
    const user = db.users.find(u => u.username === username);
    if (!user || !checkPassword(String(b.password || ''), user.pass)) {
      return json(res, 400, { error: 'Неверный ник или пароль' });
    }
    return json(res, 200, { user: pubUser(user) }, { 'Set-Cookie': startSession(user) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) sessions.delete(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Max-Age=0' });
  }

  if (pathname === '/api/posts' && method === 'GET') {
    const list = [...db.posts].sort((a, b) => b.ts - a.ts).map(p => postOut(p, me));
    return json(res, 200, { posts: list });
  }

  if (pathname === '/api/posts' && method === 'POST') {
    if (!me) return json(res, 401, { error: 'Нужно войти' });
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 5000);
    const mediaUrl = b.mediaUrl ? String(b.mediaUrl) : null;
    const mediaKind = ['video', 'image', 'youtube'].includes(b.mediaKind) ? b.mediaKind : null;

    if (!text && !mediaUrl) return json(res, 400, { error: 'Пустой пост' });

    let media = null;
    if (mediaUrl) {
      if (!mediaKind) return json(res, 400, { error: 'Не указан тип медиа' });

      if (mediaKind === 'youtube') {
        if (!YT_ID_RE.test(mediaUrl)) return json(res, 400, { error: 'Неверный YouTube-идентификатор' });
        media = { url: mediaUrl, kind: 'youtube' };
      } else {
        if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(mediaUrl)) return json(res, 400, { error: 'Неверная ссылка на файл' });
        const fpath = path.join(UPLOAD_DIR, mediaUrl.slice('/uploads/'.length));
        if (!fs.existsSync(fpath)) return json(res, 400, { error: 'Файл не найден на сервере' });
        media = { url: mediaUrl, kind: mediaKind };
      }
    }

    const post = { id: uid(), userId: me.id, text, media, ts: Date.now(), likes: [], comments: [] };
    db.posts.push(post);
    save();
    return json(res, 200, { post: postOut(post, me) });
  }

  if (parts[1] === 'posts' && parts[2]) {
    const post = db.posts.find(p => p.id === parts[2]);
    if (!post) return json(res, 404, { error: 'Пост не найден' });

    if (parts.length === 3 && method === 'GET') {
      return json(res, 200, {
        post: postOut(post, me),
        comments: post.comments.map(c => {
          const a = db.users.find(u => u.id === c.userId);
          return { id: c.id, text: c.text, ts: c.ts, author: a ? pubUser(a) : { username: 'deleted', name: '—' } };
        })
      });
    }

    if (parts[3] === 'like' && method === 'POST') {
      if (!me) return json(res, 401, { error: 'Нужно войти' });
      const i = post.likes.indexOf(me.id);
      if (i === -1) post.likes.push(me.id); else post.likes.splice(i, 1);
      save();
      return json(res, 200, { likes: post.likes.length, liked: i === -1 });
    }

    if (parts[3] === 'comments' && method === 'POST') {
      if (!me) return json(res, 401, { error: 'Нужно войти' });
      const b = await readBody(req);
      const text = String(b.text || '').trim().slice(0, 1000);
      if (!text) return json(res, 400, { error: 'Пустой комментарий' });
      const c = { id: uid(), userId: me.id, text, ts: Date.now() };
      post.comments.push(c);
      save();
      return json(res, 200, { comment: { id: c.id, text: c.text, ts: c.ts, author: pubUser(me) } });
    }

    if (parts.length === 3 && method === 'DELETE') {
      if (!me || post.userId !== me.id) return json(res, 403, { error: 'Нельзя' });
      if (post.media && post.media.kind !== 'youtube') {
        const fpath = path.join(UPLOAD_DIR, post.media.url.slice('/uploads/'.length));
        fs.unlink(fpath, () => {});
      }
      db.posts = db.posts.filter(p => p.id !== post.id);
      save();
      return json(res, 200, { ok: true });
    }
  }

  if (parts[1] === 'users' && parts[2] && method === 'GET') {
    const user = db.users.find(u => u.username === parts[2].toLowerCase());
    if (!user) return json(res, 404, { error: 'Нет такого пользователя' });
    const posts = db.posts.filter(p => p.userId === user.id).sort((a, b) => b.ts - a.ts).map(p => postOut(p, me));
    return json(res, 200, { user: pubUser(user), posts });
  }

  req.resume();
  return json(res, 404, { error: 'not found' });
}

// ---------- HTML ----------
const HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>blo.</title>
<style>
  :root{--bg:#0b0b0e;--card:#141419;--card2:#1b1b22;--text:#e9e9ef;--muted:#8a8a99;--line:#26262f;--accent:#b6ff3d;--accent2:#7c5cff;--danger:#ff5c6c}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,"Segoe UI",Roboto,system-ui,sans-serif;padding-bottom:60px}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:620px;margin:0 auto;padding:0 14px}
  .hidden{display:none!important}
  #topbar{position:sticky;top:0;z-index:10;background:rgba(11,11,14,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  #topbar .wrap{display:flex;align-items:center;justify-content:space-between;height:54px}
  .logo{font-size:22px;font-weight:800;letter-spacing:-1px;color:var(--accent)}
  #topbar .right{display:flex;align-items:center;gap:12px;font-size:14px;color:var(--muted)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin:14px 0}
  .avatar{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:#0b0b0e;flex:0 0 auto}
  .card-head{display:flex;gap:10px;align-items:center}
  .who{display:flex;flex-direction:column;min-width:0}
  .name{font-weight:700}
  .name:hover{color:var(--accent)}
  .handle{color:var(--muted);font-size:13px}
  .del{margin-left:auto;background:none;border:0;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
  .del:hover{color:var(--danger)}
  .text{margin:10px 0 0;word-wrap:break-word}
  .media{margin-top:10px;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:#000}
  .media img,.media video{display:block;width:100%;height:auto;max-height:80vh;object-fit:contain}
  .media.yt{position:relative;padding-bottom:56.25%;height:0;border:1px solid var(--line)}
  .media.yt iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
  .card-foot{display:flex;gap:16px;margin-top:12px}
  .act{background:none;border:0;color:var(--muted);font-size:14px;cursor:pointer;padding:4px 0}
  .act:hover{color:var(--text)}
  .act.liked{color:var(--danger)}
  .composer textarea{width:100%;background:transparent;border:0;color:var(--text);font:inherit;resize:vertical;min-height:60px;outline:none}
  .composer-extra{display:flex;gap:10px;margin-top:10px;flex-wrap:wrap;align-items:center}
  .yt-input{flex:1;min-width:180px;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px 11px;color:var(--text);font:inherit;font-size:14px;outline:none}
  .yt-input:focus{border-color:var(--accent2)}
  .yt-input.bad{border-color:var(--danger)}
  .composer-foot{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--line);padding-top:10px;margin-top:10px;gap:10px}
  .file-btn{color:var(--muted);cursor:pointer;font-size:14px;white-space:nowrap}
  .file-btn:hover{color:var(--accent)}
  button.primary{background:var(--accent);color:#0b0b0e;border:0;border-radius:10px;padding:8px 16px;font-weight:700;cursor:pointer}
  button.primary:hover{filter:brightness(1.1)}
  button.primary:disabled{opacity:.6;cursor:wait}
  button.ghost{background:none;border:1px solid var(--line);color:var(--muted);border-radius:10px;padding:6px 12px;cursor:pointer}
  button.ghost:hover{color:var(--text)}
  #preview img,#preview video{max-width:100%;max-height:60vh;border-radius:12px;margin-top:10px;background:#000;display:block}
  #preview .media.yt{margin-top:10px}
  .error{color:var(--danger);font-size:13px;margin-top:8px;min-height:18px}
  .empty{color:var(--muted);text-align:center;padding:30px 0}
  .empty.small{padding:12px 0;font-size:14px}
  .auth{max-width:340px;margin:15vh auto 0;text-align:center}
  .auth .brand{font-size:44px;font-weight:800;letter-spacing:-2px;color:var(--accent)}
  .auth .sub{color:var(--muted);margin:-6px 0 24px}
  .tabs{display:flex;gap:6px;margin-bottom:16px;background:var(--card);border-radius:12px;padding:4px}
  .tab{flex:1;background:none;border:0;color:var(--muted);padding:8px;border-radius:9px;cursor:pointer;font:inherit}
  .tab.active{background:var(--card2);color:var(--text);font-weight:600}
  #auth-form{display:flex;flex-direction:column;gap:10px}
  #auth-form input{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px 13px;color:var(--text);font:inherit;outline:none}
  #auth-form input:focus{border-color:var(--accent2)}
  #auth-form button{padding:12px;font-size:15px}
  .profile{display:flex;gap:14px;align-items:center;margin:22px 0 6px}
  .profile .avatar{width:64px;height:64px;font-size:24px}
  .pname{font-size:20px;font-weight:800}
  #modal{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 14px}
  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.7)}
  .modal-card{position:relative;width:100%;max-width:620px;background:var(--card)}
  .close{position:absolute;top:8px;right:12px;z-index:2;background:none;border:0;color:var(--muted);font-size:26px;cursor:pointer}
  .comments{border-top:1px solid var(--line);margin-top:6px;padding-top:8px}
  .comment{display:flex;gap:10px;padding:8px 0;font-size:14px}
  .comment .avatar{width:30px;height:30px;font-size:12px}
  .comment-form{display:flex;gap:8px;margin-top:8px}
  .comment-form input{flex:1;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--text);font:inherit;outline:none}
</style>
</head>
<body>

<header id="topbar" class="hidden">
  <div class="wrap">
    <a class="logo" href="#/">blo.</a>
    <div class="right">
      <span id="me-label"></span>
      <button id="logout" class="ghost">выйти</button>
    </div>
  </div>
</header>

<main class="wrap" id="main"></main>
<div id="modal" class="hidden"></div>

<script>
const $=s=>document.querySelector(s);
const main=$('#main'),topbar=$('#topbar'),modal=$('#modal');
const state={me:null};

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function timeAgo(ts){const d=(Date.now()-ts)/1000;if(d<60)return'только что';if(d<3600)return Math.floor(d/60)+' мин';if(d<86400)return Math.floor(d/3600)+' ч';if(d<604800)return Math.floor(d/86400)+' д';return new Date(ts).toLocaleDateString('ru-RU');}
function avatar(u){const colors=['#b6ff3d','#7c5cff','#3ddc97','#ffb703','#4cc9f0','#ff5c8a'];let h=0;for(const ch of (u.username||'?'))h=(h*31+ch.charCodeAt(0))>>>0;const initial=(u.name||u.username||'?').trim()[0]||'?';return '<div class="avatar" style="background:'+colors[h%colors.length]+'">'+esc(initial.toUpperCase())+'</div>';}
async function api(p,opts){opts=opts||{};const r=await fetch('/api'+p,{method:opts.method||'GET',headers:{'Content-Type':'application/json'},body:opts.body!==undefined?JSON.stringify(opts.body):undefined});let data={};try{data=await r.json();}catch(e){}if(!r.ok)throw new Error(data.error||'Ошибка');return data;}

function extractYouTubeId(input){
  if(!input)return null;
  const s=String(input).trim();
  if(!s)return null;
  if(/^[A-Za-z0-9_-]{11}$/.test(s))return s;
  let m;
  m=/(?:youtube\\.com\\/watch\\?(?:[^#]*&)?v=)([A-Za-z0-9_-]{11})/i.exec(s);if(m)return m[1];
  m=/(?:youtu\\.be\\/)([A-Za-z0-9_-]{11})/i.exec(s);if(m)return m[1];
  m=/(?:youtube\\.com\\/shorts\\/)([A-Za-z0-9_-]{11})/i.exec(s);if(m)return m[1];
  m=/(?:youtube\\.com\\/embed\\/)([A-Za-z0-9_-]{11})/i.exec(s);if(m)return m[1];
  m=/(?:youtube\\.com\\/live\\/)([A-Za-z0-9_-]{11})/i.exec(s);if(m)return m[1];
  return null;
}

function mediaHtml(m){
  if(!m)return '';
  if(m.kind==='youtube')return '<div class="media yt"><iframe src="https://www.youtube.com/embed/'+esc(m.url)+'" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div>';
  if(m.kind==='video')return '<div class="media"><video controls playsinline preload="metadata" src="'+esc(m.url)+'"></video></div>';
  return '<div class="media"><img src="'+esc(m.url)+'" loading="lazy" alt=""></div>';
}

function showAuth(){
  topbar.classList.add('hidden');
  main.innerHTML='<div class="auth"><div class="brand">blo.</div><p class="sub">своя маленькая лента</p><div class="tabs"><button class="tab active" data-tab="login">вход</button><button class="tab" data-tab="register">регистрация</button></div><form id="auth-form"><input name="username" placeholder="ник (латиница)" autocomplete="username" required><input name="name" placeholder="имя (необязательно)" class="hidden" id="name-field"><input name="password" type="password" placeholder="пароль" autocomplete="current-password" required><button type="submit" class="primary" id="auth-submit">войти</button><div class="error" id="auth-error"></div></form></div>';
  let mode='login';
  const form=$('#auth-form');
  document.querySelectorAll('.tab').forEach(t=>{t.onclick=()=>{mode=t.dataset.tab;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===t));$('#name-field').classList.toggle('hidden',mode!=='register');$('#auth-submit').textContent=mode==='login'?'войти':'создать аккаунт';$('#auth-error').textContent='';};});
  form.onsubmit=async e=>{
    e.preventDefault();$('#auth-error').textContent='';
    try{
      const body={username:form.username.value,password:form.password.value,name:form.name.value};
      const {user}=await api(mode==='login'?'/login':'/register',{method:'POST',body});
      state.me=user;await showApp();
    }catch(err){$('#auth-error').textContent=err.message;}
  };
}

function postCard(p){
  return '<article class="card" data-post="'+p.id+'"><div class="card-head">'+avatar(p.author)+'<div class="who"><a class="name" href="#/u/'+esc(p.author.username)+'">'+esc(p.author.name||p.author.username)+'</a><span class="handle">@'+esc(p.author.username)+' · '+timeAgo(p.ts)+'</span></div>'+(p.mine?'<button class="del" data-del="'+p.id+'" title="удалить">×</button>':'')+'</div>'+(p.text?'<div class="text">'+esc(p.text).replace(/\\n/g,'<br>')+'</div>':'')+mediaHtml(p.media)+'<div class="card-foot"><button class="act '+(p.liked?'liked':'')+'" data-like="'+p.id+'">♥ <span>'+(p.likes||'')+'</span></button><button class="act" data-open="'+p.id+'">💬 <span>'+(p.comments||'')+'</span></button></div></article>';
}

async function renderFeed(){
  main.innerHTML='<div class="empty">загрузка...</div>';
  const {posts}=await api('/posts');
  main.innerHTML='<section class="composer card">'
    +'<textarea id="compose-text" placeholder="что нового?" rows="3"></textarea>'
    +'<div class="composer-extra">'
      +'<label class="file-btn">📷/🎬 файл<input type="file" id="compose-file" accept="image/*,video/*" hidden></label>'
      +'<input type="text" id="compose-yt" class="yt-input" placeholder="или вставь ссылку YouTube" autocomplete="off">'
    +'</div>'
    +'<div id="preview"></div>'
    +'<div class="composer-foot"><span class="handle" id="mode-hint"></span><button class="primary" id="compose-send">запостить</button></div>'
    +'<div class="error" id="compose-error"></div>'
    +'</section>'
    +'<div id="feed">'+(posts.length?posts.map(postCard).join(''):'<div class="empty">Пока пусто. Будь первым.</div>')+'</div>';

  let pendingFile=null;
  let pendingYT=null;
  let prevObjectUrl=null;

  function clearFile(){
    if(prevObjectUrl){URL.revokeObjectURL(prevObjectUrl);prevObjectUrl=null;}
    pendingFile=null;
    const f=$('#compose-file');if(f)f.value='';
  }

  function updateHint(){
    const hint=$('#mode-hint');
    if(pendingYT)hint.textContent='YouTube · '+pendingYT;
    else if(pendingFile)hint.textContent=(pendingFile.type.startsWith('video/')?'видео':'картинка')+' · '+Math.round(pendingFile.size/1024/1024*10)/10+' МБ';
    else hint.textContent='';
  }

  $('#compose-file').onchange=e=>{
    const f=e.target.files[0];
    if(!f)return;
    pendingYT=null;
    $('#compose-yt').value='';
    $('#compose-yt').classList.remove('bad');
    if(prevObjectUrl)URL.revokeObjectURL(prevObjectUrl);
    pendingFile=f;
    prevObjectUrl=URL.createObjectURL(f);
    const isVideo=f.type.startsWith('video/');
    $('#preview').innerHTML=isVideo
      ?'<video controls playsinline src="'+prevObjectUrl+'"></video>'
      :'<img src="'+prevObjectUrl+'" alt="">';
    updateHint();
    $('#compose-error').textContent='';
  };

  $('#compose-yt').oninput=e=>{
    const raw=e.target.value.trim();
    const input=e.target;
    if(!raw){
      input.classList.remove('bad');
      pendingYT=null;
      if(!pendingFile)$('#preview').innerHTML='';
      updateHint();
      return;
    }
    const id=extractYouTubeId(raw);
    if(id){
      pendingYT=id;
      input.classList.remove('bad');
      clearFile();
      $('#preview').innerHTML='<div class="media yt"><iframe src="https://www.youtube.com/embed/'+id+'" allowfullscreen></iframe></div>';
      updateHint();
      $('#compose-error').textContent='';
    } else {
      pendingYT=null;
      input.classList.add('bad');
      if(!pendingFile)$('#preview').innerHTML='';
      updateHint();
    }
  };

  $('#compose-send').onclick=async()=>{
    const err=$('#compose-error');err.textContent='';
    const text=$('#compose-text').value.trim();
    const ytRaw=$('#compose-yt').value.trim();

    if(ytRaw && !pendingYT){err.textContent='Не распознал ссылку YouTube — проверь её';return;}
    if(!text && !pendingFile && !pendingYT){err.textContent='Пустой пост';return;}

    if(pendingFile){
      const isVideo=pendingFile.type.startsWith('video/');
      const max=isVideo?200*1024*1024:10*1024*1024;
      if(pendingFile.size>max){err.textContent='Файл слишком большой (макс '+(isVideo?'200':'10')+' МБ)';return;}
    }

    const btn=$('#compose-send');
    btn.disabled=true;btn.textContent='публикуем...';
    try{
      let mediaUrl=null,mediaKind=null;
      if(pendingYT){
        mediaUrl=pendingYT;mediaKind='youtube';
      } else if(pendingFile){
        const up=await fetch('/api/upload',{method:'PUT',headers:{'Content-Type':pendingFile.type},body:pendingFile});
        const upData=await up.json().catch(()=>({}));
        if(!up.ok)throw new Error(upData.error||'Не удалось загрузить файл');
        mediaUrl=upData.url;mediaKind=upData.kind;
      }
      await api('/posts',{method:'POST',body:{text,mediaUrl,mediaKind}});
      clearFile();
      await renderFeed();
    }catch(e){
      err.textContent=e.message;
      btn.disabled=false;btn.textContent='запостить';
    }
  };
}

async function renderProfile(username){
  main.innerHTML='<div class="empty">загрузка...</div>';
  try{
    const {user,posts}=await api('/users/'+encodeURIComponent(username));
    main.innerHTML='<div class="profile">'+avatar(user)+'<div><div class="pname">'+esc(user.name)+'</div><div class="handle">@'+esc(user.username)+'</div></div></div>'+(posts.length?posts.map(postCard).join(''):'<div class="empty">Постов пока нет.</div>');
  }catch(e){main.innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}

async function openPost(id){
  const {post,comments}=await api('/posts/'+id);
  modal.classList.remove('hidden');
  modal.innerHTML='<div class="modal-bg" data-close></div><div class="modal-card card"><button class="close" data-close>×</button>'+postCard(post)+'<div class="comments">'+(comments.length?comments.map(c=>'<div class="comment">'+avatar(c.author)+'<div><b>'+esc(c.author.name)+'</b> <span class="handle">'+timeAgo(c.ts)+'</span><div>'+esc(c.text).replace(/\\n/g,'<br>')+'</div></div></div>').join(''):'<div class="empty small">Комментариев нет</div>')+'</div><form class="comment-form" id="comment-form"><input name="text" placeholder="написать комментарий..." autocomplete="off"><button class="primary">→</button></form></div>';
  $('#comment-form').onsubmit=async e=>{e.preventDefault();const text=e.target.text.value.trim();if(!text)return;try{await api('/posts/'+id+'/comments',{method:'POST',body:{text}});await openPost(id);}catch(err){alert(err.message);}};
}
function closeModal(){modal.classList.add('hidden');modal.innerHTML='';}

document.body.addEventListener('click',async e=>{
  if(e.target.closest('[data-close]'))return closeModal();
  const like=e.target.closest('[data-like]');
  if(like){try{const r=await api('/posts/'+like.dataset.like+'/like',{method:'POST'});like.classList.toggle('liked',r.liked);like.querySelector('span').textContent=r.likes||'';}catch(err){alert(err.message);}return;}
  const open=e.target.closest('[data-open]');
  if(open){try{await openPost(open.dataset.open);}catch(err){alert(err.message);}return;}
  const del=e.target.closest('[data-del]');
  if(del){if(!confirm('Удалить пост?'))return;try{await api('/posts/'+del.dataset.del,{method:'DELETE'});document.querySelectorAll('[data-post="'+del.dataset.del+'"]').forEach(el=>el.remove());if(!modal.classList.contains('hidden'))closeModal();}catch(err){alert(err.message);}return;}
});

async function showApp(){
  topbar.classList.remove('hidden');
  $('#me-label').innerHTML='<a href="#/u/'+esc(state.me.username)+'">@'+esc(state.me.username)+'</a>';
  onRoute();
}
function onRoute(){
  if(!state.me)return;
  closeModal();
  const m=/^#\\/u\\/([a-z0-9_]+)$/i.exec(location.hash||'');
  if(m)renderProfile(m[1].toLowerCase());else renderFeed();
}
window.addEventListener('hashchange',onRoute);

$('#logout').onclick=async()=>{await api('/logout',{method:'POST'});state.me=null;location.hash='';showAuth();};

(async function init(){
  try{const {user}=await api('/me');if(user){state.me=user;await showApp();}else showAuth();}catch(e){showAuth();}
})();
</script>
</body>
</html>`;

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp',
  '.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.ogg':'video/ogg'
};

function sendFile(req, res, file) {
  fs.stat(file, (err, stat) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        if (isNaN(start) || isNaN(end) || start > end || end >= stat.size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, p);
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    if (p.startsWith('/uploads/')) {
      const name = p.slice('/uploads/'.length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(404); return res.end(); }
      return sendFile(req, res, path.join(UPLOAD_DIR, name));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Ошибка сервера' }); }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════╗');
  console.log('  ║  blo. запущен!                     ║');
  console.log('  ║  Открой: http://localhost:' + PORT + '      ║');
  console.log('  ║  Остановить: Ctrl + C              ║');
  console.log('  ╚════════════════════════════════════╝');
  console.log('');
});