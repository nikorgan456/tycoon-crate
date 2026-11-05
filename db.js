// Mint Rush online server: one Vercel serverless function backed by Upstash Redis.
// Connect "Upstash for Redis" in your Vercel project's Storage tab and redeploy; the
// connection details arrive as environment variables automatically.
const crypto = require("crypto");
// Find the database details whatever prefix Vercel gave them (KV_, UPSTASH_, STORAGE_, REDIS_ ...)
const envFind = (re, skip) => { const k = Object.keys(process.env).find(n => re.test(n) && !(skip && skip.test(n)) && /^https?:\/\//.test(process.env[n] || "") === /URL$/.test(n) && process.env[n]); return k ? process.env[k] : null; };
const RURL = envFind(/(KV_REST_API_URL|REDIS_REST_URL|REST_API_URL)$/);
const RTOK = envFind(/(KV_REST_API_TOKEN|REDIS_REST_TOKEN|REST_API_TOKEN)$/, /READ_ONLY/);
const P = "mr:";
const COLS = new Set(["players", "market", "trades", "duels"]);
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

    // ---------- writes (need a logged-in session) ----------
    const k = await who();
    if (!k) fail(403, "Log in again to keep playing online.");
    if (op === "acquire") {
      const [c, id] = splitPath(b.path);
      const ttl = Math.max(1000, Math.min(60000, +b.ttlMs || 30000));
      const [r] = await redis([["SET", P + "lock:" + c + ":" + id, String(b.holder || k).slice(0, 100), "NX", "PX", ttl]]);
      return res.status(200).json({ acquired: r === "OK" });
    }
    if (op === "set" || op === "update" || op === "delete") {
      const [c, id] = splitPath(b.path);
      if (c === "players" && id !== k) fail(403, "You can only change your own account.");
      const [raw] = await redis([["HGET", P + c, id]]);
      const cur = raw ? parse(raw) : null;
      if (op === "delete") {
        if (c === "players") fail(403, "Accounts can't be deleted here.");
        if (c === "market" && cur && cur.seller !== k) fail(403, "Only the seller can remove a listing.");
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
      return res.status(200).json({ ok: true });
    }
    fail(400, "Unknown request");
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ code: e.code, error: e.error });
    console.error(e);
    return res.status(500).json({ code: "unavailable", error: "Server error" });
  }
};
