// OBLQ page-visits counter: a tiny Cloudflare Worker + Durable Object.
//   GET /hit  -> adds one visit, returns {"value": n}
//   GET /get  -> returns {"value": n} without counting
// Also answers JSONP (?callback=fn) like the old service did.

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

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
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
