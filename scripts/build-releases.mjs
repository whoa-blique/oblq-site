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

async function playlistItems(tok) {
  const items = [];
  // Spotify has used both /tracks and /items for this endpoint; try both.
  let url = null;
  for (const path of ["tracks", "items"]) {
    try {
      const first = await get(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/${path}?limit=100&market=US`, tok);
      items.push(...first.items);
      url = first.next;
      break;
    } catch (e) {
      if (path === "items") throw e;
      console.warn(`/${path} failed, trying next endpoint: ${e.message}`);
    }
  }
  while (url) {
    const page = await get(url, tok);
    items.push(...page.items);
    url = page.next;
  }
  return items;
}

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

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
await writeFile("build-status.json", JSON.stringify({ ok: true, releases: out.length, playlistItems: items.length, at: new Date().toISOString() }, null, 2));
