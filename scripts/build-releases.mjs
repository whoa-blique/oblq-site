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

const typeOf = a => a.album_type === "single" ? (a.total_tracks > 1 ? "EP" : "Single") : a.album_type === "album" ? "Album" : a.album_type;
const toRelease = (a, order) => ({
  id: a.id,
  title: a.name,
  artist: (a.artists || []).map(x => x.name).join(", "),
  artistIds: (a.artists || []).map(x => x.id),
  type: typeOf(a),
  date: a.release_date || "",
  year: (a.release_date || "").slice(0, 4),
  cover: (a.images && a.images[0] && a.images[0].url) || "",
  order,
  links: {
    spotify: (a.external_urls && a.external_urls.spotify) || `https://open.spotify.com/album/${a.id}`,
    all: `https://album.link/s/${a.id}`,
  },
});
function applyExtras(list) {
  const res = [];
  for (const r of list) {
    const x = extras[r.id] || extrasByName[norm(r.title)];
    if (x) {
      if (x.hide) continue;
      if (x.role) r.role = x.role;
      if (x.title) r.title = x.title;
      if (x.artist) r.artist = x.artist;
      Object.assign(r.links, x.links || {});
    }
    delete r.artistIds;
    res.push(r);
  }
  return res.sort((a, b) => b.date.localeCompare(a.date) || a.order - b.order);
}
const errors = {};
// Search Spotify for releases by one artist (matched by artist ID so same-named artists are skipped)
async function artistReleases(key, artistId, artistName, extraQueries = []) {
  const found = new Map();
  try {
    const queries = [["album", `artist:${artistName}`], ["track", `artist:${artistName}`], ...extraQueries];
    for (const [type, q] of queries) {
      for (let offset = 0; offset < 50; offset += 10) {
        const res = await get(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=10&offset=${offset}&market=US`, tok);
        const list = type === "album" ? (res.albums?.items || []) : (res.tracks?.items || []).map(t => t.album);
        for (const a of list) {
          if (!a || !(a.artists || []).some(x => x.id === artistId)) continue;
          if (!found.has(a.id)) found.set(a.id, toRelease(a, 500 + found.size));
        }
        if (list.length < 10) break;
      }
    }
  } catch (e) { errors[key] = e.message.slice(0, 300); console.warn(`${key} search failed:`, e.message); }
  return [...found.values()];
}

// ---- Oblique: from the "Produced by Oblique" playlist ----
const releases = new Map();
items.forEach((it, idx) => {
  const t = it.track || it.item;
  if (!t || t.is_local || !t.album || t.type !== "track") return;
  if (!releases.has(t.album.id)) releases.set(t.album.id, toRelease(t.album, idx));
});

// ---- Miraflores: pulled out of the Oblique list into its own tab ----
const MIRAFLORES_NAME = "Miraflores";
const miraFromPlaylist = [...releases.values()].filter(r => r.artist.split(", ").includes(MIRAFLORES_NAME));
let MIRAFLORES_ID = null;
for (const r of miraFromPlaylist) {
  const i = r.artist.split(", ").indexOf(MIRAFLORES_NAME);
  if (i >= 0) { MIRAFLORES_ID = r.artistIds[i]; break; }
}
for (const r of miraFromPlaylist) releases.delete(r.id);
const miraMap = new Map(miraFromPlaylist.map(r => [r.id, r]));
if (MIRAFLORES_ID) {
  const extra = (extras._extraSearches || []).filter(x => x.tab === "miraflores").map(x => ["track", `track:${x.track} artist:${x.artist}`]);
  for (const r of await artistReleases("miraflores", MIRAFLORES_ID, MIRAFLORES_NAME, extra)) if (!miraMap.has(r.id)) miraMap.set(r.id, r);
} else errors.miraflores = "Miraflores artist ID not found in playlist";
const miraOut = applyExtras([...miraMap.values()]);
for (const r of miraOut) releases.delete(r.id);

const out = applyExtras([...releases.values()]);
await writeFile("releases.json", JSON.stringify(out, null, 2) + "\n");
if (miraOut.length || !errors.miraflores) await writeFile("miraflores.json", JSON.stringify(miraOut, null, 2) + "\n");

// ---- Mythryx: every release by the mythryx artist ----
const MYTHRYX_ID = "4Y7GkJ69ijDLsgGqAd21yC";
const mythOut = applyExtras(await artistReleases("mythryx", MYTHRYX_ID, "mythryx"));
for (const x of extras._mythryxExtra || []) {
  const same = mythOut.find(r => norm(r.title) === norm(x.title));
  if (same) Object.assign(same.links, x.links || {});
  else mythOut.push({ id: "extra-" + norm(x.title).replace(/ /g, "-"), order: 999, ...x, links: { ...(x.links || {}) } });
}
// Bandcamp links for everything on the mythryx Bandcamp page
const BC = { "myxtape 2": "myxtape-2", "thanks 4 having me": "thanks-4-having-me", "myxtape 3": "myxtape-3" };
for (const r of mythOut) if (BC[norm(r.title)] && !r.links.bandcamp) r.links.bandcamp = `https://mythryx.bandcamp.com/album/${BC[norm(r.title)]}`;
mythOut.sort((a, b) => b.date.localeCompare(a.date));
if (mythOut.length || !errors.mythryx) await writeFile("mythryx.json", JSON.stringify(mythOut, null, 2) + "\n");

console.log(`Wrote ${out.length} Oblique, ${miraOut.length} Miraflores, ${mythOut.length} Mythryx releases.`);
await writeFile("build-status.json", JSON.stringify({ ok: true, releases: out.length, miraflores: miraOut.length, mythryx: mythOut.length, errors, playlistItems: items.length, embedTracks: embedCount, skipped, notFound, at: new Date().toISOString() }, null, 2));
