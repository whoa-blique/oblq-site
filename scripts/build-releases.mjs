// Builds releases.json from the "Produced by Oblique" Spotify playlist.
// Runs on GitHub Actions (see .github/workflows/deploy.yml).
// Needs repo secrets SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.
//
// One tile per release (single / EP / album), newest first.
// extras.json lets you add links (youtube, apple, ...), a role, or hide a release.

import { readFile, writeFile } from "node:fs/promises";

const PLAYLIST_ID = "3X37nb4RLvwoxeBsE5Cv2y";
const { SPOTIFY_CLIENT_ID: id, SPOTIFY_CLIENT_SECRET: secret } = process.env;

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
async function fail(e) {
  const msg = String(e && e.stack || e).replace(/Basic [A-Za-z0-9+/=]+/g, "Basic ***");
  console.error(msg);
  await writeFile("build-status.json", JSON.stringify({ ok: false, error: msg, at: new Date().toISOString() }, null, 2));
  process.exit(0); // still deploy, so the error can be seen at /build-status.json
}

if (!id || !secret) throw new Error(`Missing secrets: id=${!!id} secret=${!!secret}`);

async function token() {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`Token request failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function get(url, tok) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after") || 2) * 1000;
      await new Promise(res => setTimeout(res, wait));
      continue;
    }
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status} ${await r.text()}`);
    return r.json();
  }
  throw new Error(`Rate limited too many times on ${url}`);
}

// Spotify now blocks playlist reads for apps without a signed-in user, so we
// take the track list from the public playlist embed, then look tracks/albums
// up in the catalog (which still works with app credentials).
async function playlistTrackIds() {
  const r = await fetch(`https://open.spotify.com/embed/playlist/${PLAYLIST_ID}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" },
  });
  if (!r.ok) throw new Error(`Embed page -> ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Embed page: no __NEXT_DATA__ found");
  const data = JSON.parse(m[1]);
  const list = data?.props?.pageProps?.state?.data?.entity?.trackList;
  if (!Array.isArray(list)) throw new Error("Embed page: trackList not found; keys=" + Object.keys(data?.props?.pageProps?.state?.data?.entity || {}).join(","));
  return list.map(t => String(t.uri || "").split(":").pop()).filter(Boolean);
}

let embedCount = 0;
const skipped = [];
const notFound = [];
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function playlistItems(tok) {
  let extra = [];
  try { extra = JSON.parse(await readFile("extras.json", "utf8"))._extraTracks || []; } catch {}
  const ids = [...new Set([...(await playlistTrackIds()), ...extra.map(u => String(u).split(/[/:?]/).filter(Boolean).find(x => /^[A-Za-z0-9]{22}$/.test(x)))].filter(Boolean))];
  const items = [];
  for (const id of ids) {
    try {
      items.push({ track: await get(`https://api.spotify.com/v1/tracks/${id}?market=US`, tok) });
    } catch (e) {
      console.warn(`Skipping track ${id}: ${e.message}`);
      skipped.push(id);
    }
  }
  embedCount = ids.length;
  // Songs past #100 (the public embed stops there): find them by search.
  let songs = [];
  try { songs = JSON.parse(await readFile("extras.json", "utf8"))._extraSongs || []; } catch {}
  for (const s of songs) {
    const q = encodeURIComponent(`track:${s.track} artist:${s.artist}`);
    try {
      const res = await get(`https://api.spotify.com/v1/search?q=${q}&type=track&limit=10&market=US`, tok);
      const hits = res.tracks?.items || [];
      const want = norm(s.album || s.track);
      const hit = hits.find(t => norm(t.album?.name) === want) || hits.find(t => norm(t.name) === norm(s.track)) || hits[0];
      if (hit) items.push({ track: hit, extra: true });
      else notFound.push(s);
    } catch (e) {
      console.warn(`Search failed for ${s.track}: ${e.message}`);
      notFound.push({ ...s, error: e.message.slice(0, 200) });
    }
  }
  return items;
}

const tok = await token();
const items = await playlistItems(tok);
console.log(`Playlist items: ${items.length}`);

let extras = {};
try { extras = JSON.parse(await readFile("extras.json", "utf8")); } catch {}
const extrasByName = Object.fromEntries(
  Object.entries(extras).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [norm(k), v])
);

const releases = new Map();
items.forEach((it, idx) => {
  const t = it.track || it.item;
  if (!t || t.is_local || !t.album || t.type !== "track") return;
  const a = t.album;
  if (!releases.has(a.id)) {
    releases.set(a.id, {
      id: a.id,
      title: a.name,
      artist: (a.artists || []).map(x => x.name).join(", "),
      type: a.album_type === "single" ? (a.total_tracks > 1 ? "EP" : "Single") : a.album_type === "album" ? "Album" : a.album_type,
      date: a.release_date || "",
      year: (a.release_date || "").slice(0, 4),
      cover: (a.images && a.images[0] && a.images[0].url) || "",
      order: idx,
      links: {
        spotify: (a.external_urls && a.external_urls.spotify) || `https://open.spotify.com/album/${a.id}`,
        all: `https://album.link/s/${a.id}`,
      },
    });
  }
});

const out = [];
for (const r of releases.values()) {
  const x = extras[r.id] || extrasByName[norm(r.title)];
  if (x) {
    if (x.hide) continue;
    if (x.role) r.role = x.role;
    if (x.title) r.title = x.title;
    if (x.artist) r.artist = x.artist;
    Object.assign(r.links, x.links || {});
  }
  out.push(r);
}

out.sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);
await writeFile("releases.json", JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${out.length} releases.`);
await writeFile("build-status.json", JSON.stringify({ ok: true, releases: out.length, playlistItems: items.length, embedTracks: embedCount, skipped, notFound, at: new Date().toISOString() }, null, 2));
