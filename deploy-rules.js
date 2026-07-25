#!/usr/bin/env node
// Déploie firestore.rules + storage.rules sur la base nommée "belledonne-client".
// Le CLI Firebase ne sait pas déployer les règles Firestore d'une base NOMMÉE via
// firebase.json ; ce script fait ce que le CLI fait en interne (create ruleset +
// release) en réutilisant le jeton d'auth du CLI (firebase login déjà fait).
//
// Usage : node deploy-rules.js
const fs = require("fs");
const https = require("https");
const os = require("os");

const PROJECT = "belledonne-client";
const RELEASES = {
  "firestore.rules": "cloud.firestore/belledonne-client",
  "storage.rules": "firebase.storage/belledonne-client.firebasestorage.app",
};

function token() {
  const p = os.homedir() + "/.config/configstore/firebase-tools.json";
  return JSON.parse(fs.readFileSync(p, "utf8")).tokens.access_token;
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opt = {
      hostname: "firebaserules.googleapis.com", path, method,
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
    };
    if (data) opt.headers["Content-Length"] = Buffer.byteLength(data);
    const r = https.request(opt, (x) => {
      let d = ""; x.on("data", (c) => d += c);
      x.on("end", () => resolve({ status: x.statusCode, body: d }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  for (const [file, releaseId] of Object.entries(RELEASES)) {
    const content = fs.readFileSync(file, "utf8");
    const cr = await api("POST", `/v1/projects/${PROJECT}/rulesets`, { source: { files: [{ name: file, content }] } });
    if (cr.status !== 200) { console.error(`${file}: create ERR ${cr.status}\n${cr.body.slice(0, 400)}`); process.exit(1); }
    const rulesetName = JSON.parse(cr.body).name;
    const relName = `projects/${PROJECT}/releases/${releaseId}`;
    const up = await api("PATCH", `/v1/${relName}`, { release: { name: relName, rulesetName } });
    if (up.status !== 200) { console.error(`${file}: release ERR ${up.status}\n${up.body.slice(0, 400)}`); process.exit(1); }
    console.log(`${file} -> deploye (${rulesetName.split("/rulesets/")[1]})`);
  }
  console.log("Regles deployees.");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
