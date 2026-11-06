// Mint Rush online server: one Vercel serverless function backed by Upstash Redis.
// Connect "Upstash for Redis" in your Vercel project's Storage tab and redeploy; the
// connection details arrive as environment variables automatically.
const crypto = require("crypto");
// Find the database details whatever prefix Vercel gave them (KV_, UPSTASH_, STORAGE_, REDIS_ ...)
const envFind = (re, skip) => { const k = Object.keys(process.env).find(n => re.test(n) && !(skip && skip.test(n)) && /^https?:\/\//.test(process.env[n] || "") === /URL$/.test(n) && process.env[n]); return k ? process.env[k] : null; };
const RURL = envFind(/(KV_REST_API_URL|REDIS_REST_URL|REST_API_URL)$/);
const RTOK = envFind(/(KV_REST_API_TOKEN|REDIS_REST_TOKEN|REST_API_TOKEN)$/, /READ_ONLY/);
const P = "mr:";
const COLS = new Set(["players", "market", "trades", "duels", "chat"]);
// admin code is checked by its SHA-256 so the plain code isn't in this file
const ADMIN_HASH = "39b473bdd8d11d8203c3049066937de12ec3a6f8abc60ef7daddb82bc191c813";
const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const isAdminCode = c => typeof c === "string" && sha256("mr-admin:" + c) === ADMIN_HASH;
const SESSION_SECONDS = 60 * 60 * 24 * 90;

async function redis(cmds) {
  const r = await fetch(RURL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + RTOK, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}
const fail = (status, error, code) => { throw { status, error, code: code || (status === 403 ? "invalid_argument" : "invalid_argument") }; };
function splitPath(path) {
  const p = String(path || "").split("/");
  if (p.length !== 2 || !COLS.has(p[0]) || !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(p[1])) fail(400, "Bad path");
  return p;
}
const strip = d => { if (d && typeof d === "object") { const c = Object.assign({}, d); delete c.ph; return c; } return d; };
const parse = raw => { try { return JSON.parse(raw); } catch (e) { return null; } };
const validKey = k => typeof k === "string" && /^[a-z0-9_]{3,20}$/.test(k);
async function newSession(key) {
  const t = crypto.randomBytes(24).toString("hex");
  await redis([["SET", P + "tok:" + t, key, "EX", SESSION_SECONDS]]);
  return t;
}
async function prune(col) {
  // keep finished trades/battles for 14 days, then tidy them away
  const [arr] = await redis([["HGETALL", P + col]]);
  const old = [], cutoff = Date.now() - 14 * 864e5;
  for (let i = 0; i < (arr || []).length; i += 2) {
    const d = parse(arr[i + 1]);
    if (d && d.status !== "pending" && (d.doneAt || d.t || 0) < cutoff) old.push(arr[i]);
  }
  if (old.length) await redis([["HDEL", P + col, ...old]]);
}

async function pruneChat() {
  // keep the newest 400 messages
  const [arr] = await redis([["HGETALL", P + "chat"]]);
  const list = []; for (let i = 0; i < (arr || []).length; i += 2) { const m = parse(arr[i + 1]); list.push({ id: arr[i], t: (m && m.t) || 0 }); }
  if (list.length <= 450) return;
  list.sort((a, b) => b.t - a.t);
  const old = list.slice(400).map(x => x.id);
  if (old.length) await redis([["HDEL", P + "chat", ...old]]);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!RURL || !RTOK) {
    const found = Object.keys(process.env).filter(n => /REDIS|KV|UPSTASH/i.test(n));
    return res.status(503).json({ ok: false,
      error: found.length ? "Found database settings, but not the Upstash REST URL and token this server needs. Make sure the database is Upstash for Redis, then redeploy." : "Database not connected yet. Add Upstash for Redis in your Vercel project's Storage tab, connect it to this project, then redeploy.",
      found });
  }
  try {
    if (req.method === "GET") return res.status(200).json({ ok: true });
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
    const b = typeof req.body === "string" ? (parse(req.body) || {}) : (req.body || {});
    const token = req.headers["x-vr-token"];
    const who = async () => { if (!token || typeof token !== "string") return null; const [k] = await redis([["GET", P + "tok:" + token]]); return k || null; };
    const op = b.op;

    // ---------- accounts ----------
    if (op === "signup") {
      if (!validKey(b.key) || typeof b.ph !== "string" || !b.account || typeof b.account !== "object") fail(400, "Bad sign-up details");
      const acc = Object.assign({}, b.account, { key: b.key, ph: b.ph, created: Date.now() });
      const s = JSON.stringify(acc); if (s.length > 250000) fail(400, "Account too large");
      const [ok] = await redis([["HSETNX", P + "players", b.key, s]]);
      if (!ok) return res.status(200).json({ error: "That username is taken. Log in instead?" });
      return res.status(200).json({ token: await newSession(b.key), account: strip(acc) });
    }
    if (op === "login") {
      if (!validKey(b.key)) return res.status(200).json({ error: "Username must be 3–20 letters, numbers or underscores." });
      const [raw] = await redis([["HGET", P + "players", b.key]]);
      if (!raw) return res.status(200).json({ error: `No player called "${b.key}" yet. Sign up first.` });
      const acc = parse(raw);
      if (!acc || acc.ph !== b.ph) return res.status(200).json({ error: "That password doesn't match. Check it and try again." });
      return res.status(200).json({ token: await newSession(b.key), account: strip(acc) });
    }
    if (op === "resume") {
      const k = await who();
      if (!k || k !== b.key) return res.status(200).json({ error: "Session expired. Log in again." });
      const [raw] = await redis([["HGET", P + "players", k]]);
      return res.status(200).json(raw ? { account: strip(parse(raw)) } : { error: "Account not found." });
    }

    // ---------- reads ----------
    if (op === "get") {
      const [c, id] = splitPath(b.path);
      const [raw] = await redis([["HGET", P + c, id]]);
      return res.status(200).json({ data: raw ? strip(parse(raw)) : null });
    }
    if (op === "multi") {
      const qs = (Array.isArray(b.queries) ? b.queries : []).slice(0, 12).filter(q => q && COLS.has(q.col));
      const cols = [...new Set(qs.map(q => q.col))];
      const all = cols.length ? await redis(cols.map(c => ["HGETALL", P + c])) : [];
      const byCol = {};
      cols.forEach((c, i) => {
        const arr = all[i] || [], docs = [];
        for (let j = 0; j < arr.length; j += 2) { const d = parse(arr[j + 1]); if (d) docs.push({ id: arr[j], data: strip(d) }); }
        byCol[c] = docs;
      });
      const results = qs.map(q => (byCol[q.col] || [])
        .filter(d => (Array.isArray(q.where) ? q.where : []).every(([f, o, v]) => o === "==" ? d.data[f] === v : o === "!=" ? d.data[f] !== v : true))
        .slice(0, Math.min(1000, Math.max(1, +q.limit || 500))));
      return res.status(200).json({ results });
    }

    if (op === "mutes") {
      const [m] = await redis([["HGETALL", P + "mutes"]]);
      const out = {}; for (let i = 0; i < (m || []).length; i += 2) { const until = +m[i + 1]; if (until > Date.now()) out[m[i]] = until; }
      return res.status(200).json({ mutes: out });
    }

    // ---------- writes (need a logged-in session) ----------
    const k = await who();
    if (!k) fail(403, "Log in again to keep playing online.");

    // ---------- admin: delete chat messages, mute and unmute players ----------
    if (op === "admin") {
      if (!isAdminCode(b.code)) fail(403, "Wrong admin code.");
      if (b.action === "delete") { const [, id] = splitPath("chat/" + b.id); await redis([["HDEL", P + "chat", id]]); return res.status(200).json({ ok: true }); }
      if (b.action === "mute") { if (!validKey(b.target)) fail(400, "Bad player"); const mins = Math.max(1, Math.min(60 * 24 * 30, +b.minutes || 60)); await redis([["HSET", P + "mutes", b.target, String(Date.now() + mins * 60000)]]); return res.status(200).json({ ok: true }); }
      if (b.action === "unmute") { await redis([["HDEL", P + "mutes", String(b.target || "")]]); return res.status(200).json({ ok: true }); }
      fail(400, "Unknown admin action");
    }

    // ---------- change your username (moves the whole account) ----------
    if (op === "rename") {
      const nk = b.newKey;
      if (!validKey(nk)) fail(400, "Usernames are 3-20 letters, numbers or underscores.");
      if (nk === k) fail(400, "That's already your username.");
      const [raw] = await redis([["HGET", P + "players", k]]);
      const acc = raw ? parse(raw) : null;
      if (!acc) fail(400, "Account not found.");
      if (acc.ph !== b.oldPh) fail(403, "That password doesn't match.");
      if (typeof b.newPh !== "string" || b.newPh.length < 32) fail(400, "Bad password details.");
      Object.assign(acc, { key: nk, name: String(b.newName || nk).slice(0, 20), ph: b.newPh, aliases: [...new Set([...(acc.aliases || []), k])].slice(-5) });
      const [ok] = await redis([["HSETNX", P + "players", nk, JSON.stringify(acc)]]);
      if (!ok) return res.status(200).json({ error: "That username is taken." });
      await redis([["HDEL", P + "players", k], ["SET", P + "tok:" + token, nk, "EX", SESSION_SECONDS]]);
      // point everything that mentioned the old name at the new one
      const fields = ["seller", "buyer", "from", "to", "winner", "company"];
      const cols = ["market", "trades", "duels", "chat", "players"];
      const all = await redis(cols.map(c => ["HGETALL", P + c]));
      const writes = [];
      cols.forEach((c, ci) => { const arr = all[ci] || [];
        for (let i = 0; i < arr.length; i += 2) { const doc = parse(arr[i + 1]); if (!doc) continue; let ch = false;
          fields.forEach(f => { if (doc[f] === k) { doc[f] = nk; ch = true; } });
          if (doc.holdings && doc.holdings[k] !== undefined) { doc.holdings[nk] = (doc.holdings[nk] || 0) + doc.holdings[k]; delete doc.holdings[k]; ch = true; }
          if (c === "chat" && doc.from === nk && b.newName) { doc.fromName = String(b.newName).slice(0, 20); ch = true; }
          if (ch) writes.push(["HSET", P + c, arr[i], JSON.stringify(doc)]); } });
      const [mu] = await redis([["HGET", P + "mutes", k]]); if (mu) writes.push(["HSET", P + "mutes", nk, mu], ["HDEL", P + "mutes", k]);
      for (let i = 0; i < writes.length; i += 50) await redis(writes.slice(i, i + 50));
      return res.status(200).json({ ok: true, account: strip(acc) });
    }
    if (op === "acquire") {
      const [c, id] = splitPath(b.path);
      const ttl = Math.max(1000, Math.min(60000, +b.ttlMs || 30000));
      const [r] = await redis([["SET", P + "lock:" + c + ":" + id, String(b.holder || k).slice(0, 100), "NX", "PX", ttl]]);
      return res.status(200).json({ acquired: r === "OK" });
    }
    if (op === "set" || op === "update" || op === "delete") {
      const [c, id] = splitPath(b.path);
      if (c === "players" && id !== k) fail(403, "You can only change your own account.");
      if (c === "chat") {
        if (op === "update") fail(403, "Messages can't be edited.");
        if (op === "set") {
          const [mu] = await redis([["HGET", P + "mutes", k]]);
          if (mu && +mu > Date.now()) fail(403, "You're muted for now.");
          if (!b.data || b.data.from !== k || typeof b.data.text !== "string" || !b.data.text.trim() || b.data.text.length > 240) fail(400, "Bad message");
        }
      }
      const [raw] = await redis([["HGET", P + c, id]]);
      const cur = raw ? parse(raw) : null;
      if (op === "delete") {
        if (c === "players") fail(403, "Accounts can't be deleted here.");
        if (c === "market" && cur && cur.seller !== k) fail(403, "Only the seller can remove a listing.");
        if (c === "chat" && cur && cur.from !== k && !isAdminCode(b.code)) fail(403, "You can only delete your own messages.");
        await redis([["HDEL", P + c, id]]);
        return res.status(200).json({ ok: true });
      }
      let data = b.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "Bad data");
      if (op === "update") { if (!cur) fail(400, "Not found"); data = Object.assign({}, cur, data); }
      else if (!cur) {
        if (c === "market" && data.seller !== k) fail(403, "Listings must be your own.");
        if ((c === "trades" || c === "duels") && data.from !== k) fail(403, "Requests must come from you.");
      }
      if (c === "players") { data.key = k; data.ph = cur ? cur.ph : data.ph; }
      const s = JSON.stringify(data); if (s.length > 250000) fail(400, "Too large");
      await redis([["HSET", P + c, id, s]]);
      if (!cur && (c === "trades" || c === "duels") && Math.random() < 0.05) prune(c).catch(() => {});
      if (!cur && c === "chat" && Math.random() < 0.1) pruneChat().catch(() => {});
      return res.status(200).json({ ok: true });
    }
    fail(400, "Unknown request");
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ code: e.code, error: e.error });
    console.error(e);
    return res.status(500).json({ code: "unavailable", error: "Server error" });
  }
};
