// OBLQ Worker: page-visits counter + SECRET-tab password-guess log.
//   GET  /hit      -> adds one visit, returns {"value": n}
//   GET  /get      -> returns {"value": n} without counting
//   POST /guess    -> logs one SECRET password guess (body: {"g": "...", "n": 1})
//   GET  /guesses?key=...  -> the guess log as a page (key checked against LOG_KEY_HASH)
// /hit and /get also answer JSONP (?callback=fn) like the old service did.

export class Counter {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    let value = (await this.state.storage.get("value")) ?? Number(this.env.START || 0);
    if (url.pathname === "/hit") {
      value += 1;
      await this.state.storage.put("value", value);
    }
    return new Response(JSON.stringify({ value }), { headers: { "content-type": "application/json" } });
  }
}

export class GuessLog {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS guesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, guess TEXT NOT NULL,
      attempt INTEGER, country TEXT)`);
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/add") {
      const d = await request.json();
      this.sql.exec("INSERT INTO guesses (at, guess, attempt, country) VALUES (?, ?, ?, ?)",
        new Date().toISOString(), d.g, d.n, d.c);
      // keep the newest 5000 entries
      this.sql.exec("DELETE FROM guesses WHERE id <= (SELECT MAX(id) - 5000 FROM guesses)");
      return new Response("ok");
    }
    const rows = this.sql.exec("SELECT at, guess, attempt, country FROM guesses ORDER BY id DESC").toArray();
    return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store",
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const log = () => env.GUESSES.get(env.GUESSES.idFromName("secret-tab"));

    if (url.pathname === "/guess" && request.method === "POST") {
      let d = {};
      try { d = JSON.parse((await request.text()).slice(0, 2000)); } catch {}
      const g = String(d.g ?? "").slice(0, 200);
      if (!g.trim()) return new Response("empty", { status: 400, headers: CORS });
      const n = [1, 2].includes(Number(d.n)) ? Number(d.n) : null;
      await log().fetch(new Request("https://log/add", {
        method: "POST", body: JSON.stringify({ g, n, c: request.cf?.country || null }),
      }));
      return new Response("ok", { headers: CORS });
    }

    if (url.pathname === "/guesses") {
      const key = url.searchParams.get("key") || "";
      if (!env.LOG_KEY_HASH || (await sha256(key)) !== env.LOG_KEY_HASH) {
        return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
      }
      const rows = await (await log().fetch(new Request("https://log/list"))).json();
      if (url.searchParams.get("format") === "json") {
        return new Response(JSON.stringify(rows, null, 1), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      const tr = rows.map(r => `<tr><td>${esc(new Date(r.at).toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" }))}</td><td>${r.attempt === 1 ? "1st (rejected)" : r.attempt === 2 ? "2nd (let in)" : "?"}</td><td class="g">${esc(r.guess)}</td><td>${esc(r.country || "")}</td></tr>`).join("");
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>SECRET guesses</title><style>body{font:15px/1.4 system-ui,sans-serif;background:#0b0b0b;color:#eee;margin:24px}h1{font-size:20px;letter-spacing:.2em}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #333;padding:8px 10px;text-align:left;vertical-align:top}th{color:#999;font-weight:500}.g{font-family:ui-monospace,monospace;word-break:break-all}</style>
<h1>SECRET TAB GUESSES</h1><p>${rows.length} ${rows.length === 1 ? "entry" : "entries"}, newest first. Times are Indiana time.</p>
<table><tr><th>When</th><th>Try</th><th>What they typed</th><th>Country</th></tr>${tr || '<tr><td colspan="4">Nobody has tried yet.</td></tr>'}</table>`,
        { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
    }

    if (url.pathname !== "/hit" && url.pathname !== "/get") {
      return new Response("OBLQ visit counter", { headers: CORS });
    }
    const stub = env.COUNTER.get(env.COUNTER.idFromName("visits"));
    const res = await stub.fetch(new Request(new URL(url.pathname, url.origin)));
    const body = await res.text();
    const cb = url.searchParams.get("callback");
    if (cb && /^[A-Za-z_$][\w$]{0,63}$/.test(cb)) {
      return new Response(`${cb}(${body});`, { headers: { ...CORS, "content-type": "application/javascript" } });
    }
    return new Response(body, { headers: { ...CORS, "content-type": "application/json" } });
  },
};
