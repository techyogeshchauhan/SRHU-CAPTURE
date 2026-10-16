const http = require('http');
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams.get('q') || '';
  const name = q === 'slow' ? 'Old result' : 'Fresh result';
  let body;
  if (url.pathname.endsWith('/users')) body = { users: [{ id:'latency-user', name, email:'latency@example.test', role:'teacher', is_active:true, email_verified:true }], total:1, counts:{ all:1, teacher:1 } };
  else if (url.pathname.endsWith('/audit-logs')) body = { logs:[{ id:'latency-log', action:'user_profile_updated', actor_name:name, actor_email:'latency@example.test', created_at:'2026-10-01T09:00:00Z' }], total:1 };
  else if (url.pathname.endsWith('/events')) body = { events:[{ id:'latency-event', event_name:name, status:'pending', event_date:'2026-10-01', location:'Test room', teacher_name:'Faculty' }], total:1, counts:{ all:1, pending:1 } };
  else {res.writeHead(501); return res.end(JSON.stringify({detail:'Endpoint not modeled'}));}
  setTimeout(() => { if (!res.destroyed) {res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(body));} }, q === 'slow' ? 1500 : 20);
}).listen(process.env.PORT);
