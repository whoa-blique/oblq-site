// Encrypts / decrypts the SECRET tab's data so it never sits in the repo as readable text.
//   SECRET_PASSWORD=... node scripts/secret.mjs encrypt secret.plain.json   -> writes secret.enc.json
//   SECRET_PASSWORD=... node scripts/secret.mjs decrypt                     -> prints the plain JSON
// AES-GCM with a key from PBKDF2-SHA256 (same scheme the site uses to unlock it).
import { readFile, writeFile } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";

const [mode, file] = process.argv.slice(2);
const pass = process.env.SECRET_PASSWORD;
if (!pass || !["encrypt", "decrypt"].includes(mode)) {
  console.error("Usage: SECRET_PASSWORD=... node scripts/secret.mjs encrypt <plain.json> | decrypt");
  process.exit(1);
}
const ITER = 250000;
const b64 = buf => Buffer.from(buf).toString("base64");
const unb64 = s => Uint8Array.from(Buffer.from(s, "base64"));
async function key(salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
if (mode === "encrypt") {
  const plain = JSON.stringify(JSON.parse(await readFile(file, "utf8")));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(salt, ITER), new TextEncoder().encode(plain));
  await writeFile("secret.enc.json", JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), data: b64(data) }) + "\n");
  console.log("Wrote secret.enc.json");
} else {
  const enc = JSON.parse(await readFile("secret.enc.json", "utf8"));
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(enc.iv) }, await key(unb64(enc.salt), enc.iter), unb64(enc.data));
  console.log(JSON.stringify(JSON.parse(new TextDecoder().decode(out)), null, 1));
}
