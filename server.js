require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const mpesa = require('./mpesa');
const notify = require('./notify');
const sms = require('./sms');
const { q, one, tx } = db;

const { JWT_SECRET, ADMIN_TOKEN, MPESA_CALLBACK_SECRET } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET (32+ characters) in your settings');
const FEE = Number(process.env.FEE_PERCENT || 8);
const CATS = ['Web development', 'Graphic design', 'Writing', 'Social media',
  'Accounting', 'Video and photo', 'Virtual assistance'];

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || false }));
app.use(express.json({ limit: '50kb' }));

// ---------- helpers ----------
const limit = (max) => rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false });
const ah = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, min, max) => (typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : null);
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const pid = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 && n < 2147483647 ? n : null; };
const sign = (u) => jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
const dup = (e) => e && e.code === '23505'; // Postgres "already exists"

const auth = (...roles) => (req, res, next) => {
  const h = req.headers.authorization || '';
  try {
    req.user = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
  } catch {
    return bad(res, 'Please log in', 401);
  }
  if (roles.length && !roles.includes(req.user.role)) return bad(res, 'Not allowed for your account type', 403);
  next();
};
const safeEq = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const admin = (req, res, next) => (safeEq(req.headers['x-admin-token'], ADMIN_TOKEN) ? next() : bad(res, 'Not allowed', 403));
const balanceOf = async (uid, run = q) =>
  (await run('SELECT COALESCE(SUM(amount_kes),0)::int AS b FROM ledger WHERE user_id=$1', [uid]))[0].b;

app.get('/', (req, res) => res.send('EBN Work API is running'));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/categories', (req, res) => res.json(CATS));

// ---------- accounts ----------
app.post('/api/auth/register', limit(20), ah(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 2, 80), email = str(b.email, 5, 120)?.toLowerCase();
  const phone = mpesa.normalizePhone(b.phone);
  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'Enter your name and a valid email');
  if (!phone) return bad(res, 'Enter a valid Kenyan phone number, e.g. 0712345678');
  if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 100) return bad(res, 'Password must be 8 to 100 characters');
  if (!['client', 'freelancer'].includes(b.role)) return bad(res, 'Choose client or freelancer');
  try {
    const hash = await bcrypt.hash(b.password, 12);
    const u = await one('INSERT INTO users (name,email,phone,password_hash,role) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, email, phone, hash, b.role]);
    res.status(201).json({ token: sign({ id: u.id, role: b.role }), user: { id: u.id, name, role: b.role } });
  } catch (e) {
    if (dup(e)) return bad(res, 'That email is already registered', 409);
    throw e;
  }
}));

app.post('/api/auth/login', limit(20), ah(async (req, res) => {
  const b = req.body || {};
  const u = typeof b.email === 'string' ? await one('SELECT * FROM users WHERE email=$1', [b.email.trim().toLowerCase()]) : null;
  const ok = u && typeof b.password === 'string' && (await bcrypt.compare(b.password, u.password_hash));
  if (!ok) return bad(res, 'Wrong email or password', 401);
  res.json({ token: sign(u), user: { id: u.id, name: u.name, role: u.role } });
}));

app.get('/api/me', auth(), ah(async (req, res) => {
  const u = await one('SELECT id,name,email,phone,role,county,bio,skills,(phone_verified_at IS NOT NULL) AS phone_verified FROM users WHERE id=$1', [req.user.id]);
  u ? res.json({ ...u, sms_ready: sms.configured() }) : bad(res, 'Account not found', 404);
}));

app.patch('/api/me', auth(), ah(async (req, res) => {
  const b = req.body || {};
  const name = b.name === undefined ? null : str(b.name, 2, 80);
  if (b.name !== undefined && !name) return bad(res, 'Name must be 2 to 80 characters');
  await q('UPDATE users SET name=COALESCE($1::text,name), county=COALESCE($2::text,county), bio=COALESCE($3::text,bio), skills=COALESCE($4::text,skills) WHERE id=$5',
    [name, str(b.county, 2, 40), str(b.bio, 0, 1000), str(b.skills, 0, 300), req.user.id]);
  res.json({ ok: true });
}));

app.get('/api/users/:id', ah(async (req, res) => {
  const id = pid(req);
  const u = id && await one('SELECT id,name,role,county,bio,skills FROM users WHERE id=$1', [id]);
  if (!u) return bad(res, 'Not found', 404);
  const r = await one('SELECT ROUND(AVG(rating),1)::float AS avg, COUNT(*)::int AS n FROM reviews WHERE freelancer_id=$1', [u.id]);
  res.json({ ...u, rating: r.avg, reviews: r.n });
}));

// ---------- jobs ----------
app.get('/api/jobs', ah(async (req, res) => {
  const text = typeof req.query.q === 'string' ? `%${req.query.q.slice(0, 60)}%` : '%';
  const cat = CATS.includes(req.query.category) ? req.query.category : null;
  const lim = Math.min(Number(req.query.limit) || 20, 50), off = Math.max(Number(req.query.offset) || 0, 0);
  res.json(await q(`SELECT j.id,j.title,j.category,j.description,j.budget_kes,j.budget_type,j.county,j.created_at,u.name AS client
    FROM jobs j JOIN users u ON u.id=j.client_id
    WHERE j.status='open' AND (j.title ILIKE $1 OR j.description ILIKE $1) AND ($2::text IS NULL OR j.category=$2)
    ORDER BY j.id DESC LIMIT $3 OFFSET $4`, [text, cat, lim, off]));
}));

app.get('/api/jobs/:id', ah(async (req, res) => {
  const id = pid(req);
  const j = id && await one('SELECT j.*,u.name AS client,(u.phone_verified_at IS NOT NULL) AS client_verified FROM jobs j JOIN users u ON u.id=j.client_id WHERE j.id=$1', [id]);
  j ? res.json(j) : bad(res, 'Job not found', 404);
}));

app.post('/api/jobs', auth('client'), ah(async (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 5, 120), description = str(b.description, 20, 5000);
  const budget = int(b.budget_kes, 100, 5000000);
  if (!title || !description) return bad(res, 'Add a title (5+ characters) and a description (20+ characters)');
  if (!CATS.includes(b.category)) return bad(res, 'Choose a valid category');
  if (!budget) return bad(res, 'Budget must be a whole number of KES, at least 100');
  if (!['fixed', 'hourly', 'monthly'].includes(b.budget_type)) return bad(res, 'Budget type must be fixed, hourly or monthly');
  const r = await one('INSERT INTO jobs (client_id,title,category,description,budget_kes,budget_type,county) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [req.user.id, title, b.category, description, budget, b.budget_type, str(b.county, 2, 40)]);
  notify.jobPosted({ id: r.id, client_id: req.user.id, title, category: b.category, budget_kes: budget, budget_type: b.budget_type, county: str(b.county, 2, 40) }); // emails everyone in the background
  res.status(201).json({ id: r.id });
}));

// ---------- proposals ----------
app.post('/api/jobs/:id/proposals', auth('freelancer'), ah(async (req, res) => {
  const id = pid(req);
  const job = id && await one('SELECT id,status FROM jobs WHERE id=$1', [id]);
  if (!job || job.status !== 'open') return bad(res, 'This job is not open', 404);
  const cover = str(req.body?.cover, 20, 3000), price = int(req.body?.price_kes, 100, 5000000);
  if (!cover || !price) return bad(res, 'Write a cover message (20+ characters) and a price in whole KES');
  try {
    const r = await one('INSERT INTO proposals (job_id,freelancer_id,cover,price_kes) VALUES ($1,$2,$3,$4) RETURNING id', [job.id, req.user.id, cover, price]);
    res.status(201).json({ id: r.id });
  } catch (e) {
    if (dup(e)) return bad(res, 'You already applied to this job', 409);
    throw e;
  }
}));

app.get('/api/jobs/:id/proposals', auth('client'), ah(async (req, res) => {
  const id = pid(req);
  const job = id && await one('SELECT client_id FROM jobs WHERE id=$1', [id]);
  if (!job || job.client_id !== req.user.id) return bad(res, 'Not found', 404);
  res.json(await q(`SELECT p.id,p.cover,p.price_kes,p.status,p.created_at,u.id AS freelancer_id,u.name AS freelancer,(u.phone_verified_at IS NOT NULL) AS phone_verified,
    (SELECT ROUND(AVG(rating),1)::float FROM reviews WHERE freelancer_id=u.id) AS rating
    FROM proposals p JOIN users u ON u.id=p.freelancer_id WHERE p.job_id=$1 ORDER BY p.id`, [id]));
}));

app.post('/api/proposals/:id/accept', auth('client'), ah(async (req, res) => {
  const id = pid(req);
  const p = id && await one('SELECT p.*,j.client_id FROM proposals p JOIN jobs j ON j.id=p.job_id WHERE p.id=$1', [id]);
  if (!p || p.client_id !== req.user.id) return bad(res, 'Not found', 404);
  if (p.status !== 'pending') return bad(res, 'This proposal can no longer be accepted', 409);
  const cid = await tx(async (t) => {
    const j = await t("UPDATE jobs SET status='in_progress' WHERE id=$1 AND status='open' RETURNING id", [p.job_id]);
    if (!j.length) return null;
    await t("UPDATE proposals SET status=CASE WHEN id=$1 THEN 'accepted' ELSE 'rejected' END WHERE job_id=$2", [p.id, p.job_id]);
    return (await t('INSERT INTO contracts (job_id,client_id,freelancer_id,amount_kes,fee_kes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [p.job_id, req.user.id, p.freelancer_id, p.price_kes, Math.round((p.price_kes * FEE) / 100)]))[0].id;
  });
  cid ? res.status(201).json({ contract_id: cid }) : bad(res, 'This proposal can no longer be accepted', 409);
}));

// ---------- lists for the signed-in user ----------
app.get('/api/me/jobs', auth('client'), ah(async (req, res) => {
  res.json(await q(`SELECT id,title,status,budget_kes,budget_type,
    (SELECT COUNT(*) FROM proposals WHERE job_id=jobs.id)::int AS proposals
    FROM jobs WHERE client_id=$1 ORDER BY id DESC`, [req.user.id]));
}));
app.get('/api/me/proposals', auth('freelancer'), ah(async (req, res) => {
  res.json(await q(`SELECT p.id,p.price_kes,p.status,j.title FROM proposals p
    JOIN jobs j ON j.id=p.job_id WHERE p.freelancer_id=$1 ORDER BY p.id DESC`, [req.user.id]));
}));
app.get('/api/me/contracts', auth(), ah(async (req, res) => {
  await autoRelease();
  res.json(await q(`SELECT c.*,j.title FROM contracts c JOIN jobs j ON j.id=c.job_id
    WHERE c.client_id=$1 OR c.freelancer_id=$1 ORDER BY c.id DESC`, [req.user.id]));
}));

// ---------- contracts and escrow ----------
const contractFor = async (req, res, who, status) => {
  const id = pid(req);
  const c = id && await one('SELECT * FROM contracts WHERE id=$1', [id]);
  if (!c || c[who] !== req.user.id) { bad(res, 'Not found', 404); return null; }
  if (c.status !== status) { bad(res, `Not possible while contract is "${c.status}"`, 409); return null; }
  return c;
};

// Client pays: M-Pesa prompt appears on their phone. Money is then held until they approve the work.
app.post('/api/contracts/:id/fund', auth('client'), limit(30), ah(async (req, res) => {
  const c = await contractFor(req, res, 'client_id', 'awaiting_payment');
  if (!c) return;
  const me = await one('SELECT phone FROM users WHERE id=$1', [req.user.id]);
  const phone = mpesa.normalizePhone(req.body?.phone) || me.phone;
  let r;
  try {
    r = await mpesa.stkPush({ phone, amount: c.amount_kes, ref: `EBN${c.id}` });
  } catch (e) {
    console.error('STK push failed:', e.message);
    return bad(res, 'Could not start the M-Pesa payment. Please try again.', 502);
  }
  await q('INSERT INTO payments (contract_id,checkout_request_id,amount_kes,phone) VALUES ($1,$2,$3,$4)', [c.id, r.CheckoutRequestID, c.amount_kes, phone]);
  res.json({ message: 'Check your phone and enter your M-Pesa PIN to pay.' });
}));

// Safaricom calls this after the customer pays or cancels. The secret in the path keeps strangers out.
app.post('/api/pay/callback/:secret', ah(async (req, res) => {
  console.log('Payment callback hit. secret ok:', safeEq(req.params.secret, MPESA_CALLBACK_SECRET), 'result code:', req.body?.Body?.stkCallback?.ResultCode);
  if (!safeEq(req.params.secret, MPESA_CALLBACK_SECRET)) return res.sendStatus(404);
  const cb = req.body?.Body?.stkCallback;
  const pay = cb && await one('SELECT * FROM payments WHERE checkout_request_id=$1', [String(cb.CheckoutRequestID)]);
  if (pay && pay.status === 'pending') {
    const meta = Object.fromEntries((cb.CallbackMetadata?.Item || []).map((i) => [i.Name, i.Value]));
    const paidOk = cb.ResultCode === 0 && Number(meta.Amount) === pay.amount_kes;
    const funded = await tx(async (t) => {
      const u = await t("UPDATE payments SET status=$1, mpesa_receipt=$2 WHERE id=$3 AND status='pending' RETURNING id",
        [paidOk ? 'success' : 'failed', meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null, pay.id]);
            if (!(u.length && paidOk)) return null;
      if (pay.post_id) {
        const p = await t("UPDATE posts SET status='live', paid_at=now(), expires_at=now() + interval '30 days' WHERE id=$1 AND status='awaiting_payment' RETURNING id", [pay.post_id]);
        return p.length > 0 ? 'post' : null;
      }
      const c = await t("UPDATE contracts SET status='funded' WHERE id=$1 AND status='awaiting_payment' RETURNING id", [pay.contract_id]);
      return c.length > 0 ? 'contract' : null;
    });
    if (funded === 'contract') notify.paymentReceived(pay.contract_id);
    if (funded === 'post') notify.postLive(pay.post_id);
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

app.post('/api/contracts/:id/submit', auth('freelancer'), ah(async (req, res) => {
  const c = await contractFor(req, res, 'freelancer_id', 'funded');
  if (!c) return;
  const note = str(req.body?.note, 5, 1000);
  let link = null;
  try {
    const url = new URL(String(req.body?.link || '').trim());
    if (['http:', 'https:'].includes(url.protocol) && url.href.length <= 500) link = url.href;
  } catch (e) { /* not a valid link */ }
  if (!note || !link) return bad(res, 'Please write a short note and paste a link (starting with https://) to the finished work.');
  const u = await q("UPDATE contracts SET status='submitted', delivery_note=$2, delivery_link=$3, delivered_at=now() WHERE id=$1 AND status='funded' RETURNING id", [c.id, note, link]);
  if (u.length) notify.workDelivered(c.id);
  res.json({ ok: true });
}));

const releaseContract = (c) => tx(async (t) => {
  const u = await t("UPDATE contracts SET status='released' WHERE id=$1 AND status='submitted' RETURNING id", [c.id]);
  if (!u.length) return false; // already released: never pay twice
  await t("UPDATE jobs SET status='completed' WHERE id=$1", [c.job_id]);
  await t('INSERT INTO ledger (user_id,contract_id,amount_kes,note) VALUES ($1,$2,$3,$4)',
    [c.freelancer_id, c.id, c.amount_kes - c.fee_kes, `Payment for contract ${c.id} after ${FEE}% fee`]);
  return true;
});

// If a client does not reply for 7 days after work is delivered, the payment is released to the freelancer.
// The check runs every hour, at start-up, and whenever someone opens their contracts (the free server sleeps when idle).
let sweeping = false;
const autoRelease = async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const due = await q("SELECT * FROM contracts WHERE status='submitted' AND delivered_at IS NOT NULL AND delivered_at < now() - interval '7 days'");
    for (const c of due) if (await releaseContract(c)) notify.paymentReleased(c.id, true);
  } catch (e) { console.error('Auto-release error:', e.message); } finally { sweeping = false; }
};
setInterval(autoRelease, 60 * 60 * 1000);

// The client asks for changes: the contract goes back to "funded" so the freelancer can fix the work and deliver again.
app.post('/api/contracts/:id/revise', auth('client'), limit(30), ah(async (req, res) => {
  const c = await contractFor(req, res, 'client_id', 'submitted');
  if (!c) return;
  if (c.revisions >= 3) return bad(res, 'You have already asked for changes 3 times. Please approve the work or contact EBN Work.');
  const note = str(req.body?.note, 5, 1000);
  if (!note) return bad(res, 'Please explain what should be changed.');
  const u = await q("UPDATE contracts SET status='funded', revision_note=$2, revisions=revisions+1 WHERE id=$1 AND status='submitted' RETURNING id", [c.id, note]);
  if (u.length) notify.revisionRequested(c.id);
  res.json({ ok: true });
}));

app.post('/api/contracts/:id/release', auth('client'), ah(async (req, res) => {
  const c = await contractFor(req, res, 'client_id', 'submitted');
  if (!c) return;
  const done = await releaseContract(c);
  if (done) notify.paymentReleased(c.id);
  done ? res.json({ ok: true }) : bad(res, 'This contract was already released', 409);
}));

app.post('/api/contracts/:id/review', auth('client'), ah(async (req, res) => {
  const c = await contractFor(req, res, 'client_id', 'released');
  if (!c) return;
  const rating = int(req.body?.rating, 1, 5);
  if (!rating) return bad(res, 'Rating must be 1 to 5');
  try {
    await q('INSERT INTO reviews (contract_id,freelancer_id,rating,comment) VALUES ($1,$2,$3,$4)', [c.id, c.freelancer_id, rating, str(req.body?.comment, 0, 1000)]);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (dup(e)) return bad(res, 'You already reviewed this contract', 409);
    throw e;
  }
}));

// ---------- wallet and payouts ----------
app.get('/api/me/wallet', auth('freelancer'), ah(async (req, res) => {
  res.json({
    balance_kes: await balanceOf(req.user.id),
    history: await q('SELECT amount_kes,note,created_at FROM ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]),
  });
}));

app.post('/api/me/payouts', auth('freelancer'), limit(20), ah(async (req, res) => {
  const amount = int(req.body?.amount_kes, 100, 5000000);
  if (!amount) return bad(res, 'Minimum withdrawal is KES 100');
  const pv = await one('SELECT phone_verified_at FROM users WHERE id=$1', [req.user.id]);
  // Verification is only required once the SMS service is switched on, so nobody is blocked before then.
  if (sms.configured() && (!pv || !pv.phone_verified_at)) return bad(res, 'Please verify your phone number in My account before withdrawing.');
  const me = await one('SELECT phone FROM users WHERE id=$1', [req.user.id]);
  const phone = mpesa.normalizePhone(req.body?.phone) || me.phone;
  const id = await tx(async (t) => {
    await t('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]); // blocks double withdrawals at the same moment
    if ((await balanceOf(req.user.id, t)) < amount) return null;
    const p = (await t('INSERT INTO payouts (user_id,amount_kes,phone) VALUES ($1,$2,$3) RETURNING id', [req.user.id, amount, phone]))[0].id;
    await t('INSERT INTO ledger (user_id,amount_kes,note) VALUES ($1,$2,$3)', [req.user.id, -amount, `Withdrawal request ${p}`]);
    return p;
  });
  id ? res.status(201).json({ payout_id: id, status: 'requested' }) : bad(res, 'Not enough balance', 409);
}));

// ---------- admin: process withdrawals (send the money, then mark it) ----------
app.get('/api/admin/payouts', admin, ah(async (req, res) => {
  res.json(await q("SELECT p.*,u.name FROM payouts p JOIN users u ON u.id=p.user_id WHERE p.status='requested' ORDER BY p.id"));
}));
app.post('/api/admin/payouts/:id/:action(paid|failed)', admin, ah(async (req, res) => {
  const id = pid(req);
  const ok = id && await tx(async (t) => {
    const p = (await t("UPDATE payouts SET status=$1, reference=$2 WHERE id=$3 AND status='requested' RETURNING *",
      [req.params.action, str(req.body?.reference, 0, 60), id]))[0];
    if (!p) return false;
    if (req.params.action === 'failed') await t('INSERT INTO ledger (user_id,amount_kes,note) VALUES ($1,$2,$3)', [p.user_id, p.amount_kes, `Refund of failed withdrawal ${p.id}`]);
    return true;
  });
  ok ? res.json({ ok: true }) : bad(res, 'Not found', 404);
}));

// ---------- job alert unsubscribe (link inside each alert email) ----------
app.get('/api/unsubscribe', limit(30), ah(async (req, res) => {
  const id = Number(req.query.u);
  if (!Number.isInteger(id) || id < 1 || !safeEq(req.query.t, notify.unsubToken(id))) return res.status(400).send('This link is not valid.');
  await q('UPDATE users SET notify_jobs = FALSE WHERE id = $1', [id]);
  res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title><body style="font:18px Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 20px"><h2>You are unsubscribed</h2><p>You will no longer receive new job alerts from EBN Work. You will still get emails about your own jobs and payments.</p>');
}));

// ---------- phone verification (6-digit code by SMS) ----------
const codeHash = (uid, code) => crypto.createHmac('sha256', process.env.JWT_SECRET || '').update(`phone:${uid}:${code}`).digest('hex');
app.post('/api/phone/send-code', auth(), limit(10), ah(async (req, res) => {
  const u = await one('SELECT phone, phone_verified_at FROM users WHERE id=$1', [req.user.id]);
  if (!u) return bad(res, 'Account not found', 404);
  if (u.phone_verified_at) return res.json({ ok: true, already: true });
  const recent = await one("SELECT COUNT(*)::int AS n FROM phone_codes WHERE user_id=$1 AND created_at > now() - interval '1 hour'", [req.user.id]);
  if (recent.n >= 3) return bad(res, 'Too many codes requested. Please try again in an hour.', 429);
  if (!sms.configured()) return bad(res, 'Phone verification is not available yet. Please try again later.', 503);
  const code = String(crypto.randomInt(100000, 1000000));
  const row = await one("INSERT INTO phone_codes (user_id,phone,code_hash,expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes') RETURNING id", [req.user.id, u.phone, codeHash(req.user.id, code)]);
  try {
    await sms.sendSms(u.phone, `EBN Work: your verification code is ${code}. It expires in 10 minutes. Do not share it with anyone.`);
  } catch (e) {
    await q('DELETE FROM phone_codes WHERE id=$1', [row.id]);
    return bad(res, 'We could not send the SMS right now. Please try again later.', 503);
  }
  res.json({ ok: true });
}));
app.post('/api/phone/verify', auth(), limit(20), ah(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return bad(res, 'Enter the 6-digit code.');
  const row = await one('SELECT id, code_hash, attempts FROM phone_codes WHERE user_id=$1 AND expires_at > now() ORDER BY id DESC LIMIT 1', [req.user.id]);
  if (!row) return bad(res, 'That code has expired. Please request a new one.');
  if (row.attempts >= 5) return bad(res, 'Too many wrong tries. Please request a new code.');
  if (!safeEq(codeHash(req.user.id, code), row.code_hash)) {
    await q('UPDATE phone_codes SET attempts = attempts + 1 WHERE id=$1', [row.id]);
    return bad(res, 'Wrong code. Please check and try again.');
  }
  await q('UPDATE users SET phone_verified_at = now() WHERE id=$1', [req.user.id]);
  await q('DELETE FROM phone_codes WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));

// ---------- quote requests (no account needed) ----------
const QSERVICES = ['Websites', 'Logo and branding', 'Bookkeeping set-up', 'Social media management', 'Something else'];
app.post('/api/quotes', limit(8), ah(async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // hidden field that only bots fill in
  const service = QSERVICES.includes(b.service) ? b.service : null;
  const name = str(b.name, 2, 80);
  const phone = str(b.phone, 7, 20);
  const email = b.email ? str(b.email, 5, 120) : '';
  const details = str(b.details, 10, 1500);
  const pkg = b.package ? (str(b.package, 1, 60) || '') : '';
  if (!service || !name || !phone || !details || email === null) return bad(res, 'Please fill in your name, phone number and a short description of what you need.');
  if (!/^[0-9+() -]{7,20}$/.test(phone)) return bad(res, 'Please enter a valid phone number.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'Please enter a valid email address.');
  const r = await one('INSERT INTO quote_requests (service,package,name,phone,email,details) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [service, pkg, name, phone, email, details]);
  notify.quoteRequest({ id: r.id, service, pkg, name, phone, email, details }); // runs in the background
  res.json({ ok: true });
}));

const posts = require('./posts')(app, { q, one, auth, ah, bad, str, limit, pid, mpesa, notify });
const stats = require('./stats')(app, { q, ah, bad, limit });
require('./testtools')(app);

app.use((req, res) => bad(res, 'Not found', 404));

db.init()
  .then(() => posts.init())
  .then(() => stats.init())
  .then(() => autoRelease())
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('EBN Work API running')))
  .catch((e) => { console.error('Database setup failed:', e.message); process.exit(1); });
