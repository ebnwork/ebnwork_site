// Private dashboard for the owner (/admin-stats): income, people, jobs, posts and website visitors.
// Visits are counted with a random anonymous ID kept in the visitor's browser. No names, emails or phone numbers are stored.
const crypto = require('crypto');

const D = "(now() AT TIME ZONE 'Africa/Nairobi')::date"; // days are counted in Kenya time

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS page_hits (day DATE NOT NULL, path TEXT NOT NULL, visitor TEXT NOT NULL, PRIMARY KEY (day, path, visitor))',
  'CREATE INDEX IF NOT EXISTS idx_hits_day ON page_hits(day)',
];

const PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EBN Work dashboard</title>
<style>body{font:16px/1.5 Arial,sans-serif;max-width:760px;margin:0 auto;padding:18px;background:#eef3ff;color:#0c1730}h1{margin:0 0 4px}input{width:100%;padding:11px;font-size:16px;border:1px solid #c9d6ea;border-radius:8px;box-sizing:border-box}
button{padding:11px 20px;font-size:15px;border:0;border-radius:999px;background:#0f2e6b;color:#fff;font-weight:700;margin-top:8px}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:14px}
.card{background:#fff;border:1px solid #cdd8ef;border-radius:14px;padding:14px 16px}.card.hl{background:#0f2e6b;color:#fff;border:0}.t{font-size:13px;font-weight:700;opacity:.75;text-transform:uppercase;letter-spacing:.4px}.big{font-size:30px;font-weight:800;margin:2px 0 6px}.m{font-size:14px;opacity:.85}
h2{font-size:18px;margin:22px 0 6px}.row{display:flex;justify-content:space-between;background:#fff;border:1px solid #cdd8ef;border-radius:10px;padding:8px 12px;margin:5px 0;font-size:15px}#msg{margin:12px 0;font-weight:700}.note{font-size:13px;color:#4b5a78;margin-top:16px}</style></head><body>
<h1>EBN Work dashboard</h1><p class="note" style="margin:0 0 12px">Private. Enter your admin password to see the numbers.</p><input id="t" type="password" placeholder="ADMIN_TOKEN" autocomplete="off"><button id="go">Show numbers</button><div id="msg" role="status"></div><div id="out"></div>
<script src="/admin-stats.js"></script></body></html>`;

const JS = `
var $=function(i){return document.getElementById(i)};
function n(v){return Number(v||0)}
function kes(v){return "KES "+n(v).toLocaleString("en-KE")}
function card(title,big,lines,hl){var d=document.createElement("div");d.className="card"+(hl?" hl":"");
 var h=document.createElement("div");h.className="t";h.textContent=title;d.appendChild(h);
 var b=document.createElement("div");b.className="big";b.textContent=big;d.appendChild(b);
 (lines||[]).forEach(function(l){var p=document.createElement("div");p.className="m";p.textContent=l;d.appendChild(p)});return d}
function head(t){var h=document.createElement("h2");h.textContent=t;return h}
function row(a,b){var r=document.createElement("div");r.className="row";var x=document.createElement("span");x.textContent=a;var y=document.createElement("b");y.textContent=b;r.appendChild(x);r.appendChild(y);return r}
function by(list,key,val){var o={};(list||[]).forEach(function(r){o[r[key]]=r});return o[val]||{}}
var KIND={vacancy:"Vacancies",listing:"For sale",ad:"Adverts"},PAGE={home:"Home page",marketplace:"Marketplace",pricing:"Pricing",terms:"Terms"};
async function load(){var msg=$("msg");msg.textContent="Loading... (the first time can take up to a minute)";$("out").innerHTML="";
 try{var r=await fetch("/api/admin/stats",{headers:{"x-admin-token":$("t").value}});var s=await r.json();if(!r.ok)throw new Error(s.error||("Error "+r.status));msg.textContent="";
  var o=$("out"),c=s.contracts||[],rel=by(c,"status","released"),fu=by(c,"status","funded"),su=by(c,"status","submitted"),aw=by(c,"status","awaiting_payment");
  var postIncome=0,postPaid=0,live=0;(s.posts||[]).forEach(function(p){postIncome+=n(p.income);postPaid+=n(p.paid);live+=n(p.live)});
  var jobFees=n(rel.fee),total=jobFees+postIncome,held=n(fu.amount)+n(su.amount),heldFee=n(fu.fee)+n(su.fee),u=s.users||{},v=s.visits||{},j=s.jobs||{},q=s.quotes||{};
  var g=document.createElement("div");g.className="g";
  g.appendChild(card("Your total income",kes(total),["Job fees (8%): "+kes(jobFees)+" from "+n(rel.n)+" finished jobs","Post fees: "+kes(postIncome)+" from "+postPaid+" paid posts","Includes test payments until real M-Pesa is live"],true));
  g.appendChild(card("Waiting in escrow",kes(held),[(n(fu.n)+n(su.n))+" jobs paid by clients, not yet approved","Your fee on these: "+kes(heldFee)+" (yours once approved)"]));
  g.appendChild(card("People",n(u.total),[n(u.freelancers)+" freelancers, "+n(u.clients)+" clients","New in 7 days: "+n(u.d7)+", in 30 days: "+n(u.d30),"Phone verified: "+n(u.verified)]));
  g.appendChild(card("Visitors today",n(v.today),["Last 7 days: "+n(v.d7),"Last 30 days: "+n(v.d30),"All time: "+n(v.total)]));
  g.appendChild(card("Jobs",n(j.total),["Open: "+n(j.open)+", in progress: "+n(j.in_progress)+", completed: "+n(j.completed),"New in 7 days: "+n(j.d7),"Proposals sent: "+n(s.proposals)]));
  g.appendChild(card("Posts live now",live,(s.posts||[]).map(function(p){return (KIND[p.kind]||p.kind)+": "+n(p.live)+" live, "+n(p.paid)+" paid, "+kes(p.income)})));
  g.appendChild(card("Quote requests",n(q.total),["Last 7 days: "+n(q.d7)]));
  var po=s.payouts||[],rq=by(po,"status","requested"),pd=by(po,"status","paid");
  g.appendChild(card("Withdrawals",n(rq.n)+" waiting",[kes(rq.amount)+" to pay out (use admin tools)","Paid so far: "+n(pd.n)+" ("+kes(pd.amount)+")"]));
  o.appendChild(g);
  o.appendChild(head("Contracts"));[["awaiting_payment","Waiting for the client to pay"],["funded","Paid, freelancer working"],["submitted","Delivered, waiting for approval"],["released","Approved and paid out"]].forEach(function(x){var r=by(c,"status",x[0]);o.appendChild(row(x[1],n(r.n)+" ("+kes(r.amount)+")"))});
  o.appendChild(head("Visitors in the last 14 days"));(s.daily||[]).forEach(function(d){o.appendChild(row(d.day,n(d.u)))});if(!(s.daily||[]).length)o.appendChild(row("No visits counted yet","0"));
  o.appendChild(head("Most visited pages (30 days)"));(s.pages||[]).forEach(function(p){o.appendChild(row(PAGE[p.path]||p.path,n(p.n)))});
  var f=document.createElement("p");f.className="note";f.textContent="Days are counted in Kenya time. A visitor is counted once per day per page, using an anonymous random ID in their browser.";o.appendChild(f)
 }catch(e){msg.textContent=e.message}}
$("go").onclick=load;
`;

module.exports = (app, d) => {
  const { q, ah, bad, limit } = d;
  const safeEq = (a, b) => {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
  };
  const admin = (req, res, next) =>
    safeEq(req.headers['x-admin-token'], process.env.ADMIN_TOKEN) ? next() : res.status(403).json({ error: 'Wrong admin password' });
  // A failed query shows zeros for that box only, never a broken page.
  const run = async (sql, params) => { try { return await q(sql, params || []); } catch (e) { console.error('Stats query failed:', e.message); return []; } };

  const init = async () => {
    for (const s of SCHEMA) {
      try { await q(s); } catch (e) { console.error('Schema step failed:', e.message, '|', s.slice(0, 60)); }
    }
  };

  // Counts one visit per person per page per day.
  app.post('/api/hit', limit(300), ah(async (req, res) => {
    const b = req.body || {};
    const v = /^[a-z0-9]{8,40}$/.test(String(b.v || '')) ? b.v : null;
    if (v) {
      const p = String(b.p || '');
      const page = /board/.test(p) ? 'marketplace' : /pricing/.test(p) ? 'pricing' : /terms/.test(p) ? 'terms' : 'home';
      await q(`INSERT INTO page_hits (day, path, visitor) VALUES (${D}, $1, $2) ON CONFLICT DO NOTHING`, [page, v]);
    }
    res.json({ ok: true });
  }));

  app.get('/admin-stats', (req, res) => res.type('html').send(PAGE));
  app.get('/admin-stats.js', (req, res) => res.type('js').send(JS));

  app.get('/api/admin/stats', limit(30), admin, ah(async (req, res) => {
    const [users, jobs, proposals, contracts, posts, quotes, payouts, visits, pages, daily] = await Promise.all([
      run(`SELECT COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days'))::int AS d7,
        (COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days'))::int AS d30,
        (COUNT(*) FILTER (WHERE role = 'client'))::int AS clients,
        (COUNT(*) FILTER (WHERE role = 'freelancer'))::int AS freelancers,
        (COUNT(*) FILTER (WHERE phone_verified_at IS NOT NULL))::int AS verified
        FROM users`),
      run(`SELECT COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE status = 'open'))::int AS open,
        (COUNT(*) FILTER (WHERE status = 'in_progress'))::int AS in_progress,
        (COUNT(*) FILTER (WHERE status = 'completed'))::int AS completed,
        (COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days'))::int AS d7
        FROM jobs`),
      run('SELECT COUNT(*)::int AS total FROM proposals'),
      run(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_kes), 0)::bigint AS amount, COALESCE(SUM(fee_kes), 0)::bigint AS fee
        FROM contracts GROUP BY status`),
      run(`SELECT kind,
        (COUNT(*) FILTER (WHERE paid_at IS NOT NULL))::int AS paid,
        (COUNT(*) FILTER (WHERE status = 'live' AND expires_at > now()))::int AS live,
        COALESCE(SUM(fee_kes) FILTER (WHERE paid_at IS NOT NULL), 0)::bigint AS income
        FROM posts GROUP BY kind`),
      run(`SELECT COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days'))::int AS d7 FROM quote_requests`),
      run('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_kes), 0)::bigint AS amount FROM payouts GROUP BY status'),
      run(`SELECT (COUNT(DISTINCT visitor) FILTER (WHERE day = ${D}))::int AS today,
        (COUNT(DISTINCT visitor) FILTER (WHERE day >= ${D} - 6))::int AS d7,
        (COUNT(DISTINCT visitor) FILTER (WHERE day >= ${D} - 29))::int AS d30,
        COUNT(DISTINCT visitor)::int AS total FROM page_hits`),
      run(`SELECT path, COUNT(*)::int AS n FROM page_hits WHERE day >= ${D} - 29 GROUP BY path ORDER BY n DESC LIMIT 8`),
      run(`SELECT day::text AS day, COUNT(DISTINCT visitor)::int AS u FROM page_hits WHERE day >= ${D} - 13 GROUP BY day ORDER BY day DESC`),
    ]);
    res.json({
      users: users[0] || {}, jobs: jobs[0] || {}, proposals: (proposals[0] || {}).total || 0, contracts, posts,
      quotes: quotes[0] || {}, payouts, visits: visits[0] || {}, pages, daily,
    });
  }));

  return { init };
};
