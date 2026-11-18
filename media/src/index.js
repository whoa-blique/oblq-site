// OBLQ media server: streams files from the R2 bucket "oblq-media".
//   GET /<file>   e.g. /videos/never-finished.mp4  (supports seeking via Range requests)
//   GET /         -> list of files (handy for checking uploads)

const CORS = { "access-control-allow-origin": "*", "access-control-expose-headers": "content-length, content-range, accept-ranges" };

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m) return null;
  let start = m[1] === "" ? null : Number(m[1]);
  let end = m[2] === "" ? null : Number(m[2]);
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return "invalid";
  return { offset: start, length: end - start + 1 };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...CORS, "access-control-allow-headers": "range" } });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: CORS });
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));

    if (!key) {
      const list = await env.MEDIA.list({ limit: 1000 });
      return Response.json(list.objects.map(o => ({ key: o.key, size: o.size })), { headers: CORS });
    }

    const head = await env.MEDIA.head(key);
    if (!head) return new Response("Not found", { status: 404, headers: CORS });
    const size = head.size;
    const headers = new Headers(CORS);
    head.writeHttpMetadata(headers);
    headers.set("accept-ranges", "bytes");
    headers.set("etag", head.httpEtag);
    headers.set("cache-control", "public, max-age=86400");

    const range = parseRange(request.headers.get("range"), size);
    if (range === "invalid") {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (request.method === "HEAD") { headers.set("content-length", size); return new Response(null, { headers }); }

    if (range) {
      const obj = await env.MEDIA.get(key, { range });
      headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
      headers.set("content-length", range.length);
      return new Response(obj.body, { status: 206, headers });
    }
    const obj = await env.MEDIA.get(key);
    headers.set("content-length", size);
    return new Response(obj.body, { headers });
  },
};
