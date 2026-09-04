const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("crypto");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const https = require("https");
const http = require("http");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

admin.initializeApp();

// ── SECRETS (Secret Manager, via firebase functions:secrets:set) ──
// Remplace l'ancien functions.config() déprécié. Chaque fonction déclare
// les secrets qu'elle consomme via .runWith({ secrets: [...] }).
const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");
const OVH_APP_KEY = defineSecret("OVH_APP_KEY");
const OVH_APP_SECRET = defineSecret("OVH_APP_SECRET");
const OVH_CONSUMER_KEY = defineSecret("OVH_CONSUMER_KEY");
const OVH_SMS_ACCOUNT = defineSecret("OVH_SMS_ACCOUNT");
const GCAL_SA = defineSecret("GCAL_SA"); // service account complet en JSON
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const AXONAUT_API_KEY = defineSecret("AXONAUT_API_KEY");
const KIZEO_API_TOKEN = defineSecret("KIZEO_API_TOKEN"); // token API Kizeo Forms (header Authorization, brut)
const KIZEO_WEBHOOK_SECRET = defineSecret("KIZEO_WEBHOOK_SECRET"); // secret vérifié en header du webhook Kizeo

// Transporter Gmail créé à l'exécution (les secrets ne sont dispo qu'au runtime).
function makeTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() },
  });
}

// ── SÉCURITÉ : exiger un jeton Firebase valide + rôle admin ───────
// Lève { code, msg } si le jeton est absent/invalide ou si l'utilisateur
// n'est pas administrateur. Protège les fonctions HTTP (sinon ouvertes à tous).
async function verifyAdmin(req) {
  const authz = req.get("Authorization") || req.headers.authorization || "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) throw { code: 401, msg: "Authentification requise" };
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(m[1]);
  } catch(e) {
    throw { code: 401, msg: "Jeton invalide ou expiré" };
  }
  // Compte maître (gère les comptes via admin.html) : toujours admin, même
  // sans doc dans `users`. Cohérent avec le verrou de admin.html.
  if (decoded.email === "belledonne.multiservices@gmail.com") return decoded;
  // Custom claim role posé par setUserClaims (source de vérité pour les règles).
  if (decoded.role === "admin" || decoded.role === "administrateur") return decoded;
  // Repli : lecture du rôle dans la collection `users` (comptes pas encore backfillés).
  const { getFirestore } = require("firebase-admin/firestore");
  const db = getFirestore(admin.app(), "belledonne-client");
  let role = null;
  try {
    const snap = await db.collection("users").where("uid", "==", decoded.uid).limit(1).get();
    if (!snap.empty) role = snap.docs[0].data().role || null;
  } catch(e) {
    throw { code: 500, msg: "Erreur vérification du rôle" };
  }
  if (role !== "admin" && role !== "administrateur") {
    throw { code: 403, msg: "Accès réservé aux administrateurs" };
  }
  return decoded;
}

// ── SUPPRIMER UTILISATEUR FIREBASE AUTH ───────────────────────────
exports.deleteAuthUser = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { uid } = req.body;
    if (!uid) { res.status(400).json({ error: "uid manquant" }); return; }

    try {
      await admin.auth().deleteUser(uid);
      console.log("Utilisateur supprime de Auth:", uid);
      res.status(200).json({ success: true });
    } catch(err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

// ── POSER LES CUSTOM CLAIMS (role + client) SUR UN COMPTE ─────────
// Source de vérité pour les règles Firestore/Storage. Appelé par admin.html
// à la création d'un compte, + mode backfill pour (re)synchroniser tous les
// comptes existants depuis la collection `users`.
exports.setUserClaims = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { uid, role, client, backfill } = req.body || {};
    try {
      if (backfill) {
        const { getFirestore } = require("firebase-admin/firestore");
        const db = getFirestore(admin.app(), "belledonne-client");
        const snap = await db.collection("users").get();
        let updated = 0; const errors = [];
        for (const d of snap.docs) {
          const u = d.data();
          if (!u.uid) continue;
          try {
            await admin.auth().setCustomUserClaims(u.uid, { role: u.role || null, client: u.client || null });
            updated++;
          } catch(e) { errors.push({ uid: u.uid, identifiant: u.identifiant || null, error: e.message }); }
        }
        res.status(200).json({ success: true, updated, errors });
        return;
      }
      if (!uid) { res.status(400).json({ error: "uid requis" }); return; }
      await admin.auth().setCustomUserClaims(uid, { role: role || null, client: client || null });
      res.status(200).json({ success: true });
    } catch(err) {
      console.error("setUserClaims:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ── REINITIALISER LE MOT DE PASSE D'UN COMPTE (Firebase Auth) ─────
// Change le vrai mot de passe Auth (les mots de passe ne sont plus stockés
// en clair dans Firestore). Admin only.
exports.resetUserPassword = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { uid, password } = req.body || {};
    if (!uid || !password || password.length < 8) {
      res.status(400).json({ error: "uid et mot de passe (min. 8 caractères) requis" });
      return;
    }
    try {
      await admin.auth().updateUser(uid, { password });
      res.status(200).json({ success: true });
    } catch(err) {
      console.error("resetUserPassword:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ── MODE ASSISTANCE : se connecter en tant qu'un client (admin only) ──
// Génère un jeton personnalisé (custom token) pour le compte cible. La session
// obtenue porte les claims persistants du client (role/client) => cloisonnée
// exactement comme lui par les règles. Le claim `impersonatedBy` sert au bandeau.
exports.impersonateClient = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    let adminUser;
    try { adminUser = await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { uid } = req.body || {};
    if (!uid) { res.status(400).json({ error: "uid requis" }); return; }
    try {
      // Sécurité : on n'imite que des comptes existants et non-admin.
      const target = await admin.auth().getUser(uid);
      const role = target.customClaims && target.customClaims.role;
      if (role === "admin" || role === "administrateur") {
        res.status(403).json({ error: "Impossible d'imiter un compte administrateur" });
        return;
      }
      const adminEmail = (adminUser && adminUser.email) || "admin";
      console.log("IMPERSONATION:", adminEmail, "->", target.email || uid);
      const customToken = await admin.auth().createCustomToken(uid, {
        impersonatedBy: adminEmail,
        assist: true,
      });
      res.status(200).json({ token: customToken });
    } catch(err) {
      console.error("impersonateClient:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ── SONDE AXONAUT (lecture seule) : découvrir les champs + récupération PDF ──
function axonautGet(key, path, extraHeaders) {
  return new Promise((resolve) => {
    const headers = Object.assign({ userApiKey: key, Accept: "application/json" }, extraHeaders || {});
    https.get({ hostname: "axonaut.com", path, headers }, (r) => {
      let d = ""; r.on("data", c => d += c);
      r.on("end", () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
    }).on("error", e => resolve({ status: 0, error: e.message }));
  });
}
exports.axonautProbe = functions
  .region("europe-west1")
  .runWith({ secrets: [AXONAUT_API_KEY] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }
    const key = AXONAUT_API_KEY.value();
    // Scanner les fiches clients pour trouver ACTIS (le filtre ?name= n'est pas fiable)
    const found = [];
    for (let page = 1; page <= 4; page++) {
      const r = await axonautGet(key, "/api/v2/companies", { page: String(page) });
      if (r.status !== 200) break;
      let arr = [];
      try { arr = JSON.parse(r.body); } catch(e) { break; }
      if (!Array.isArray(arr) || !arr.length) break;
      arr.forEach(co => { if (/actis/i.test(co.name || "")) found.push({ id: co.id, name: co.name, siret: co.siret, tva: co.intracommunity_number, ville: co.address_city }); });
      if (arr.length < 500) break;
    }
    console.log("AXONAUT fiches ACTIS trouvees:", JSON.stringify(found));
    // Première page de factures : structure d'une facture
    const invoices = await axonautGet(key, "/api/v2/invoices", { page: "1" });
    let invoicesStatus = invoices.status;
    let firstInvoice = null;
    try { const arr = JSON.parse(invoices.body); if (Array.isArray(arr) && arr.length) firstInvoice = arr[0]; } catch(e) {}
    console.log("AXONAUT invoices status:", invoices.status, "premiere facture:", JSON.stringify(firstInvoice).slice(0, 2500));
    // Détail de la première facture (pour voir le champ PDF)
    let detailStatus = null, detailBody = "";
    if (firstInvoice && firstInvoice.id) {
      const detail = await axonautGet(key, "/api/v2/invoices/" + firstInvoice.id, { page: "1" });
      detailStatus = detail.status; detailBody = detail.body || "";
      console.log("AXONAUT invoice detail status:", detail.status, "body:", detailBody.slice(0, 3000));
    }
    res.status(200).json({
      actisStatus: actis.status,
      invoicesStatus,
      invoiceKeys: firstInvoice ? Object.keys(firstInvoice) : [],
      detailStatus,
    });
  });

// ── AXONAUT : création facture/devis + récupération du PDF ────────
function axonautPost(key, path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = https.request({
      hostname: "axonaut.com", path, method: "POST",
      headers: { userApiKey: key, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Accept: "application/json" },
    }, (x) => { let d = ""; x.on("data", c => d += c); x.on("end", () => resolve({ status: x.statusCode, body: d })); });
    r.on("error", e => resolve({ status: 0, error: e.message }));
    r.write(data); r.end();
  });
}

function axonautPatch(key, path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const r = https.request({
      hostname: "axonaut.com", path, method: "PATCH",
      headers: { userApiKey: key, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Accept: "application/json" },
    }, (x) => { let d = ""; x.on("data", c => d += c); x.on("end", () => resolve({ status: x.statusCode, body: d })); });
    r.on("error", e => resolve({ status: 0, error: e.message }));
    r.write(data); r.end();
  });
}

// Trouve une fiche client Axonaut par SIRET (chiffres) ou nom, sinon la crée.
// Si la fiche existe déjà, on la remet à jour (adresse/SIRET/TVA) avec ce qui est
// sélectionné dans l'app : sinon Axonaut garde l'ancienne adresse enregistrée,
// même si elle ne correspond plus à ce qu'on a choisi côté app.
async function axonautFindOrCreateCompany(key, client) {
  const digits = (client.siret || "").replace(/\D/g, "");
  const nomNorm = (client.nom || "").trim().toLowerCase();
  for (let page = 1; page <= 6; page++) {
    const r = await axonautGet(key, "/api/v2/companies", { page: String(page) });
    if (r.status !== 200) break;
    let arr = []; try { arr = JSON.parse(r.body); } catch(e) { break; }
    if (!Array.isArray(arr) || !arr.length) break;
    const hit = arr.find(co => {
      const coSiret = (co.siret || "").replace(/\D/g, "");
      if (digits && coSiret && coSiret === digits) return true;
      return nomNorm && (co.name || "").trim().toLowerCase() === nomNorm;
    });
    if (hit) {
      const patch = {
        address_street: client.adresse || "", address_zip_code: client.cp || "",
        address_city: client.ville || "", address_country: "France",
      };
      if (client.siret) patch.siret = client.siret;
      if (client.tva) patch.intracommunity_number = client.tva;
      try { await axonautPatch(key, "/api/v2/companies/" + hit.id, patch); }
      catch(e) { console.error("Axonaut: mise à jour adresse échouée pour", hit.id, e.message); }
      return { id: hit.id, created: false };
    }
    if (arr.length < 500) break;
  }
  // Création
  const payload = {
    name: client.nom, is_customer: true, isB2C: client.type === "particulier",
    address_street: client.adresse || "", address_zip_code: client.cp || "",
    address_city: client.ville || "", address_country: "France",
  };
  if (client.siret) payload.siret = client.siret;
  if (client.tva) payload.intracommunity_number = client.tva;
  const cr = await axonautPost(key, "/api/v2/companies", payload);
  if (cr.status < 200 || cr.status >= 300) throw { code: 502, msg: "Création client Axonaut échouée (" + cr.status + "): " + (cr.body || "").slice(0, 200) };
  const created = JSON.parse(cr.body);
  return { id: created.id, created: true };
}

exports.createAxonautInvoice = functions
  .region("europe-west1")
  .runWith({ secrets: [AXONAUT_API_KEY] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { client, lignes, objet, bc, date, mode } = req.body || {};
    if (!client || !client.nom) { res.status(400).json({ error: "Client (nom) requis" }); return; }
    if (!Array.isArray(lignes) || !lignes.length) { res.status(400).json({ error: "Au moins une ligne requise" }); return; }
    const key = AXONAUT_API_KEY.value();
    try {
      const company = await axonautFindOrCreateCompany(key, client);
      const products = lignes.map((l, i) => ({
        name: (l.designation || "Prestation"),
        price: Number(l.pu) || 0,
        quantity: Number(l.qte) || 1,
        tax_rate: Number(l.tva) || 0,
        // Axonaut n'a pas de champ "objet" visible sur la facture : on le met en
        // description de la première ligne (seul champ texte visible au client).
        ...(i === 0 && objet ? { description: "Objet : " + objet } : {}),
      }));
      const rawDate = date || new Date().toISOString().slice(0, 10);
      const rfcDate = /T/.test(rawDate) ? rawDate : (rawDate + "T12:00:00+00:00");
      const docBody = {
        company_id: company.id,
        date: rfcDate,
        products,
      };
      const path = (mode === "devis") ? "/api/v2/quotations" : "/api/v2/invoices";
      console.log("AXONAUT create body:", JSON.stringify(docBody));
      const cr = await axonautPost(key, path, docBody);
      console.log("AXONAUT create", mode, "status", cr.status, "resp:", (cr.body || cr.error || "").slice(0, 1500));
      if (cr.status < 200 || cr.status >= 300) {
        res.status(502).json({ error: "Axonaut (" + cr.status + "): " + (cr.body || "").slice(0, 300) });
        return;
      }
      let out = JSON.parse(cr.body);
      // Certaines créations ne renvoient pas immédiatement le numéro / le PDF :
      // on relit la facture pour être sûr de les récupérer.
      if (out.id && (!out.number || !out.public_path)) {
        const detailPath = (mode === "devis") ? "/api/v2/quotations/" : "/api/v2/invoices/";
        const det = await axonautGet(key, detailPath + out.id, { page: "1" });
        if (det.status === 200) { try { out = JSON.parse(det.body); } catch(e) {} }
      }
      res.status(200).json({
        mode: mode || "devis",
        companyId: company.id,
        companyCreated: company.created,
        id: out.id,
        number: out.number || null,
        pdfUrl: out.public_path || null,
        portalUrl: out.customer_portal_url || null,
        totalHT: out.pre_tax_amount, totalTTC: out.total,
      });
    } catch(err) {
      console.error("createAxonautInvoice:", err);
      res.status(err.code || 500).json({ error: err.msg || err.message });
    }
  });

// ── ENVOYER NOTIFICATION EMAIL ────────────────────────────────────
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function guessContentType(filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  const map = {
    pdf: "application/pdf",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png"
  };
  return map[ext] || "application/octet-stream";
}

exports.sendNotification = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 120, memory: "512MB", secrets: [GMAIL_USER, GMAIL_PASS] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { to, subject, body, attachments } = req.body;
    if (!to || !subject || !body) {
      res.status(400).json({ error: "Champs manquants" });
      return;
    }

    try {
      const mailAttachments = [];
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          try {
            const buffer = await downloadFile(att.url);
            mailAttachments.push({
              filename: att.filename || "document.pdf",
              content: buffer,
              contentType: guessContentType(att.filename)
            });
          } catch(e) {
            console.error("Erreur PJ:", att.url, e.message);
          }
        }
      }

      await makeTransporter().sendMail({
        from: '"Belledonne Multiservices" <' + GMAIL_USER.value() + '>',
        to, subject, text: body,
        attachments: mailAttachments
      });

      console.log("Email envoye a " + to + " avec " + mailAttachments.length + " PJ");
      res.status(200).json({ success: true, attachments: mailAttachments.length });
    } catch(err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  });

// ── ENVOYER SMS VIA OVH ──────────────────────────────────────────
exports.sendSMS = functions
  .region("europe-west1")
  .runWith({ secrets: [OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY, OVH_SMS_ACCOUNT] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { to, message } = req.body;
    if (!to || !message) {
      res.status(400).json({ error: "Champs manquants: to, message" });
      return;
    }

    // Normalize phone to international format
    let phone = to.replace(/[\s\-\.]/g, "");
    if (phone.startsWith("0")) phone = "+33" + phone.slice(1);
    if (!phone.startsWith("+")) phone = "+33" + phone;

    // Strip accents to avoid signature issues with UTF-8
    const cleanMessage = message
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x00-\x7F]/g, "");

    const appKey      = OVH_APP_KEY.value();
    const appSecret   = OVH_APP_SECRET.value();
    const consumerKey = OVH_CONSUMER_KEY.value();
    const smsAccount  = OVH_SMS_ACCOUNT.value();

    // Get OVH server time first to avoid clock skew
    const timeRes = await new Promise((resolve, reject) => {
      https.get("https://eu.api.ovh.com/1.0/auth/time", (r) => {
        let d = ""; r.on("data", c => d += c); r.on("end", () => resolve(parseInt(d)));
      }).on("error", reject);
    });

    const timestamp  = timeRes.toString();
    const urlPath    = "/1.0/sms/" + smsAccount + "/jobs";
    const fullUrl    = "https://eu.api.ovh.com" + urlPath;
    const body       = JSON.stringify({ message: cleanMessage, receivers: [phone], senderForResponse: true, priority: "high" });
    // Signature OVH : SHA1 de "AS+CK+METHOD+URL+BODY+TIMESTAMP" avec le corps BRUT
    // (et non son hash — c'était le bug qui provoquait "Invalid signature").
    const sigStr     = [appSecret, consumerKey, "POST", fullUrl, body, timestamp].join("+");
    const signature  = "$1$" + crypto.createHash("sha1").update(sigStr).digest("hex");

    try {
      const result = await new Promise((resolve, reject) => {
        const options = {
          hostname: "eu.api.ovh.com",
          path: urlPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "X-Ovh-Application": appKey,
            "X-Ovh-Consumer": consumerKey,
            "X-Ovh-Signature": signature,
            "X-Ovh-Timestamp": timestamp,
          }
        };
        const r = https.request(options, (res2) => {
          let d = ""; res2.on("data", c => d += c);
          res2.on("end", () => resolve({ status: res2.statusCode, body: d }));
        });
        r.on("error", reject);
        r.write(body);
        r.end();
      });

      console.log("SMS status:", result.status, result.body);
      const parsed = JSON.parse(result.body);

      if (result.status === 200 || result.status === 201) {
        res.status(200).json({ success: true, details: parsed });
      } else {
        console.error("OVH error body:", result.body);
        console.error("Phone used:", phone);
        console.error("Message:", cleanMessage);
        res.status(200).json({ success: false, ovhStatus: result.status, ovhError: parsed, phone, messageLength: cleanMessage.length });
      }
    } catch(err) {
      console.error("Erreur SMS:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ── CONSO SERVICES EXTERNES (crédits SMS OVH) ──
// Requête signée OVH GET (corps vide) pour lire les crédits SMS restants.
function ovhGetSmsCredits() {
  return new Promise((resolve) => {
    try {
      const appKey      = OVH_APP_KEY.value();
      const appSecret   = OVH_APP_SECRET.value();
      const consumerKey = OVH_CONSUMER_KEY.value();
      const smsAccount  = OVH_SMS_ACCOUNT.value();
      https.get("https://eu.api.ovh.com/1.0/auth/time", (r) => {
        let t = ""; r.on("data", c => t += c); r.on("end", () => {
          const timestamp = t.toString();
          const urlPath = "/1.0/sms/" + smsAccount;
          const fullUrl = "https://eu.api.ovh.com" + urlPath;
          // OVH: signature sur le corps BRUT (vide en GET)
          const sigStr = [appSecret, consumerKey, "GET", fullUrl, "", timestamp].join("+");
          const signature = "$1$" + crypto.createHash("sha1").update(sigStr).digest("hex");
          const req = https.request({
            hostname: "eu.api.ovh.com", path: urlPath, method: "GET",
            headers: {
              "X-Ovh-Application": appKey, "X-Ovh-Consumer": consumerKey,
              "X-Ovh-Signature": signature, "X-Ovh-Timestamp": timestamp,
            },
          }, (res2) => {
            let d = ""; res2.on("data", c => d += c);
            res2.on("end", () => {
              try {
                const parsed = JSON.parse(d);
                if (res2.statusCode === 200) resolve({ creditsLeft: parsed.creditsLeft, status: parsed.status });
                else resolve({ error: parsed.message || ("OVH " + res2.statusCode) });
              } catch(e) { resolve({ error: "Réponse OVH illisible" }); }
            });
          });
          req.on("error", e => resolve({ error: e.message }));
          req.end();
        });
      }).on("error", e => resolve({ error: e.message }));
    } catch(e) { resolve({ error: e.message }); }
  });
}

exports.getServicesUsage = functions
  .region("europe-west1")
  .runWith({ secrets: [OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY, OVH_SMS_ACCOUNT] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }
    try {
      const ovh = await ovhGetSmsCredits();
      res.status(200).json({ ovh, checkedAt: new Date().toISOString() });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

// ── AJOUTER PASSAGES AU GOOGLE CALENDAR DU TECHNICIEN ────────────
exports.addToCalendar = functions
  .region("europe-west1")
  .runWith({ secrets: [GCAL_SA] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { technicienEmail, passages, nature, nomClient, adresse, bc, observations, interventionId, operation, calEventId, colorId } = req.body;

    if (!technicienEmail) {
      res.status(400).json({ error: "technicienEmail requis" });
      return;
    }
    if (operation === 'delete') {
      if (!calEventId) { res.status(400).json({ error: "calEventId requis pour delete" }); return; }
      try {
        const { google } = require("googleapis");
        const serviceAccountKey = JSON.parse(GCAL_SA.value());
        const auth = new google.auth.GoogleAuth({ credentials:serviceAccountKey, scopes:["https://www.googleapis.com/auth/calendar"] });
        const calendar = google.calendar({ version:"v3", auth });
        await calendar.events.delete({ calendarId: technicienEmail, eventId: calEventId });
        res.status(200).json({ success: true, deleted: true });
      } catch(err) {
        // 404 = événement déjà absent du calendrier, on traite comme un succès
        if (err.code === 404 || err.status === 404 || (err.errors && err.errors[0]?.domain === 'calendar' && err.errors[0]?.reason === 'notFound')) {
          res.status(200).json({ success: true, deleted: true, alreadyGone: true });
        } else {
          res.status(500).json({ error: err.message });
        }
      }
      return;
    }
    if (!passages || !passages.length) {
      res.status(400).json({ error: "passages requis" });
      return;
    }

    try {
      const { google } = require("googleapis");

      // Authentification via Service Account avec délégation sur le calendrier du technicien
      const serviceAccountKey = JSON.parse(GCAL_SA.value());

      const auth = new google.auth.GoogleAuth({
        credentials: serviceAccountKey,
        scopes: ["https://www.googleapis.com/auth/calendar"],
      });

      const calendar = google.calendar({ version: "v3", auth });

      const results = [];
      const errors = [];

      for (const passage of passages) {
        // Format attendu : "2024-06-15T08:00|2024-06-15T12:00"
        const parts = passage.split("|");
        const debut = parts[0];
        const fin = parts[1] || "";

        if (!debut) continue;

        // Si pas de fin, on met 1h par défaut
        // Les dates arrivent au format "YYYY-MM-DDTHH:MM" (datetime-local, heure locale Paris)
        // On les traite directement comme heure Europe/Paris via le timeZone du calendrier
        let startDt, endDt;
        try {
          // Ajouter ":00" si secondes manquantes pour compatibilité
          const debutStr = debut.length === 16 ? debut + ":00" : debut;
          const finStr = fin ? (fin.length === 16 ? fin + ":00" : fin) : "";
          startDt = debutStr; // On passe la date telle quelle, Google Calendar respecte timeZone
          endDt = finStr || (() => {
            // +1h : calculer manuellement sur la chaîne
            const d = new Date(debutStr);
            d.setHours(d.getHours() + 1);
            const pad = n => String(n).padStart(2,'0');
            return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
          })();
        } catch(e) {
          errors.push({ passage, error: "Format date invalide" });
          continue;
        }

        // Construction de la description de l'événement
        const { customSummary, customDescription } = req.body;
        const tels = Array.isArray(req.body.tels) ? req.body.tels : [];
        const description = customDescription !== undefined ? customDescription : [
          bc ? `N° BC : ${bc}` : "",
          nature ? `Nature : ${nature}` : "",
          nomClient ? `Client : ${nomClient}` : "",
          tels.length ? `Téléphone(s) : ${tels.join(" / ")}` : "",
          adresse ? `Adresse : ${adresse}` : "",
          observations ? `Observations : ${observations}` : "",
        ].filter(Boolean).join("\n");

        const event = {
          summary: customSummary || `${nature || "Intervention"} — ${nomClient || "Client"}`,
          location: adresse || "",
          description,
          start: { dateTime: startDt, timeZone: "Europe/Paris" },
          end: { dateTime: endDt, timeZone: "Europe/Paris" },
          colorId: colorId ? String(colorId) : "9",
          reminders: {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: 60 },
            ],
          },
        };

        try {
          if (operation === 'update' && calEventId) {
            const patchResult = await calendar.events.patch({ calendarId: technicienEmail, eventId: calEventId, resource: event });
            results.push({ passage, eventId: patchResult.data.id });
            console.log("Événement mis à jour:", patchResult.data.id);
          } else {
            const insertResult = await calendar.events.insert({ calendarId: technicienEmail, resource: event });
            results.push({ passage, eventId: insertResult.data.id, htmlLink: insertResult.data.htmlLink });
            console.log("Événement créé:", insertResult.data.id, "pour", technicienEmail);
          }
        } catch(insertErr) {
          console.error("Erreur opération événement:", insertErr.message);
          errors.push({ passage, error: insertErr.message });
        }
      }

      res.status(200).json({
        success: results.length > 0,
        created: results.length,
        errors: errors.length,
        results,
        errors,
      });

    } catch(err) {
      console.error("Erreur addToCalendar:", err);
      res.status(500).json({ error: err.message });
    }
  });

// ── IMPORT EMAIL GÉNÉRIQUE (toutes les 15 min) ────────────────────

const EXTRACTION_TOOL = {
  name: "save_document_data",
  description: "Enregistre les données extraites du document PDF.",
  input_schema: {
    type: "object",
    properties: {
      data: {
        type: "object",
        description: "Les données extraites du document, toutes les valeurs en chaîne de caractères",
        additionalProperties: { type: "string" },
      },
    },
    required: ["data"],
  },
};

// Crée un dossier/label IMAP s'il n'existe pas (Gmail expose ses labels comme dossiers IMAP).
async function ensureMailbox(client, path) {
  if (!path) return;
  try { await client.mailboxCreate(path); } catch(e) { /* existe déjà */ }
}

async function parsePdfWithClaude(anthropic, pdfBase64, filename, systemPrompt) {
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: systemPrompt,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "save_document_data" },
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: `Extrais les données de ce document (${filename}) et appelle l'outil save_document_data.` },
      ],
    }],
  });
  const toolUse = response.content.find(b => b.type === "tool_use");
  if (!toolUse) throw new Error(`Claude n'a pas utilisé l'outil. stop_reason=${response.stop_reason}`);
  return toolUse.input.data || {};
}

async function parseDocWithClaude(anthropic, docBuffer, filename, systemPrompt) {
  const mammoth = require("mammoth");
  let text;
  try {
    const result = await mammoth.extractRawText({ buffer: docBuffer });
    text = result.value;
  } catch(e) {
    throw new Error(`Impossible de lire le fichier DOC (${filename}): ${e.message}`);
  }
  if (!text || text.trim().length < 20) {
    throw new Error(`Fichier DOC vide ou illisible: ${filename}`);
  }
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: systemPrompt,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "save_document_data" },
    messages: [{
      role: "user",
      content: [{ type: "text", text: `Extrais les données de ce document (${filename}) :\n\n${text}\n\nAppelle l'outil save_document_data avec le résultat.` }],
    }],
  });
  const toolUse = response.content.find(b => b.type === "tool_use");
  if (!toolUse) throw new Error(`Claude n'a pas utilisé l'outil. stop_reason=${response.stop_reason}`);
  return toolUse.input.data || {};
}

// Traite un email déjà téléchargé et parsé (via IMAP + mailparser).
// Retourne { ok:true, finalBc } si un document a été importé, { skipped:true } sinon.
async function processParsedEmail(anthropic, db, parsed, source, sourceId) {
  const subject = parsed.subject || "";

  let docNumber = "";
  if (source.subjectNumberRegex) {
    try {
      const match = subject.match(new RegExp(source.subjectNumberRegex));
      if (match && match[1]) docNumber = match[1];
    } catch(e) {
      console.warn(`Source ${sourceId}: regex invalide "${source.subjectNumberRegex}"`);
    }
  }
  console.log(`Email: sujet="${subject}", N°="${docNumber}"`);

  const atts = parsed.attachments || [];
  const isPdf = a => a.contentType === "application/pdf" || (a.filename || "").toUpperCase().endsWith(".PDF");
  const isDoc = a => {
    const f = (a.filename || "").toUpperCase();
    return a.contentType === "application/msword" ||
           a.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
           f.endsWith(".DOC") || f.endsWith(".DOCX");
  };
  const pdfAtt = atts.find(isPdf);
  const docAtt = !pdfAtt && atts.find(isDoc);
  const attach = pdfAtt || docAtt;

  if (!attach) {
    console.log(`Email "${subject}": aucune pièce jointe PDF/DOC — ignoré (probablement hors-sujet)`);
    return { skipped: true };
  }

  const fileBuffer = attach.content; // Buffer fourni par mailparser
  const fileBase64 = fileBuffer.toString("base64");
  const filename = attach.filename || (pdfAtt ? "document.pdf" : "document.doc");

  console.log(`Email: pièce jointe "${filename}" — extraction Claude...`);
  let extractedData;
  if (pdfAtt) {
    extractedData = await parsePdfWithClaude(anthropic, fileBase64, filename, source.claudeSystemPrompt || "");
  } else {
    extractedData = await parseDocWithClaude(anthropic, fileBuffer, filename, source.claudeSystemPrompt || "");
  }

  console.log(`Email: upload Storage...`);
  const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
  const storageFolder = source.pdfType === "PL" ? "suivi/pl" : "suivi/bc";
  const storagePath = `${storageFolder}/${Date.now()}_${filename.replace(/\s/g, "_")}`;
  const downloadToken = crypto.randomUUID();
  try {
    await bucket.file(storagePath).save(fileBuffer, {
      contentType: pdfAtt ? "application/pdf" : "application/octet-stream",
      metadata: { metadata: { firebaseStorageDownloadTokens: downloadToken } },
    });
  } catch(e) {
    throw new Error(`Storage ERREUR: ${e.message}`);
  }
  const fileUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;

  console.log(`Email: écriture Firestore...`);
  const isPL = source.pdfType === "PL";
  // Pour un PL : le n° va dans le champ `pl` (extrait par Claude, ou n° du sujet en secours)
  // et le PDF dans `plUrl`. Pour un BC : n° dans `bc`, PDF dans `bcUrl`.
  const finalBc = isPL ? "" : (extractedData.bc || docNumber || "");
  const finalPl = isPL ? (extractedData.pl || docNumber || "") : (extractedData.pl || "");
  const docFields = isPL ? { plUrl: fileUrl } : { bcUrl: fileUrl };
  const numRef = isPL ? finalPl : finalBc;
  try {
    const docRef = await db.collection("suivi").add({
      ...extractedData,
      bc: finalBc,
      pl: finalPl,
      client: source.clientFirestore || extractedData.client || "",
      ...docFields,
      clientType: "contrat",
      statut: "À valider",
      source: "auto",
      sourceId,
      pdfType: source.pdfType || "BC",
      createdAt: new Date().toISOString(),
    });
    console.log(`Email: Firestore OK doc=${docRef.id}`);
  } catch(e) {
    throw new Error(`Firestore ERREUR: ${e.message}`);
  }

  console.log(`✅ ${source.pdfType || "BC"} ${numRef || "?"} importé — ${source.clientLabel}`);
  return { ok: true, finalBc: numRef };
}

async function processSource(client, anthropic, db, source, sourceRef) {
  // S'assurer que les dossiers/labels de destination existent
  await ensureMailbox(client, source.gmailLabelTraite);
  if (source.gmailDossierArchive) await ensureMailbox(client, source.gmailDossierArchive);

  // Même logique de recherche qu'avant, via la recherche Gmail brute (X-GM-RAW) sur la boîte de réception
  const fromFilter = (source.senderEmails || []).map(e => `from:${e}`).join(" OR ");
  let q = `(${fromFilter})`;
  if (source.gmailLabelTraite) q += ` -label:"${source.gmailLabelTraite}"`;
  if (source.subjectContains) q += ` subject:"${source.subjectContains}"`;
  if (source.startDate) q += ` after:${source.startDate.replace(/-/g, "/")}`;

  let processed = 0;
  const lock = await client.getMailboxLock("INBOX");
  try {
    let uids = await client.search({ gmailRaw: q }, { uid: true });
    uids = (uids || []).slice(0, 20);
    console.log(`Source ${sourceRef.id}: ${uids.length} email(s) à traiter`);

    for (const uid of uids) {
      try {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) { console.warn(`uid ${uid}: source vide`); continue; }
        const parsed = await simpleParser(msg.source);
        const result = await processParsedEmail(anthropic, db, parsed, source, sourceRef.id);
        if (result && result.ok) {
          // Marquer lu, poser le label "traité" (sort de la boîte de réception) et archiver
          await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
          if (source.gmailDossierArchive) {
            try { await client.messageCopy(uid, source.gmailDossierArchive, { uid: true }); }
            catch(e) { console.warn(`Archive copy échouée (uid ${uid}):`, e.message); }
          }
          await client.messageMove(uid, source.gmailLabelTraite, { uid: true });
          processed++;
        }
      } catch(e) {
        console.error(`Source ${sourceRef.id} - uid ${uid}:`, e.message);
      }
    }
  } finally {
    lock.release();
  }

  await sourceRef.update({
    lastRun: new Date().toISOString(),
    totalProcessed: (source.totalProcessed || 0) + processed,
  });

  return processed;
}

exports.processIncomingBC = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300, memory: "1GB", secrets: [GMAIL_USER, GMAIL_PASS, ANTHROPIC_API_KEY] })
  .pubsub.schedule("every 15 minutes")
  .timeZone("Europe/Paris")
  .onRun(async () => {
    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const Anthropic = require("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    let sourcesSnap;
    try {
      sourcesSnap = await db.collection("email-sources").where("enabled", "==", true).get();
    } catch(e) {
      console.error("Erreur lecture email-sources:", e.message);
      return;
    }

    if (sourcesSnap.empty) {
      console.log("processIncomingBC: aucune source active dans email-sources.");
      return;
    }

    // Connexion Gmail via IMAP + mot de passe d'application (ne périme jamais,
    // contrairement au refresh token OAuth qui expirait tous les 7 jours).
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: GMAIL_USER.value(), pass: GMAIL_PASS.value() },
      logger: false,
    });
    try {
      await client.connect();
    } catch(e) {
      console.error("Connexion IMAP échouée:", e.message);
      return;
    }

    const now = new Date();
    try {
      for (const sourceDoc of sourcesSnap.docs) {
        const source = sourceDoc.data();

        // Pour les fréquences > 15 min, vérifier si assez de temps s'est écoulé
        if (source.lastRun && (source.checkFrequencyMinutes || 15) > 15) {
          const minutesSinceLast = (now - new Date(source.lastRun)) / 60000;
          if (minutesSinceLast < source.checkFrequencyMinutes) {
            console.log(`Source ${sourceDoc.id}: skip (${Math.round(minutesSinceLast)}min / ${source.checkFrequencyMinutes}min requis)`);
            continue;
          }
        }

        try {
          const processed = await processSource(client, anthropic, db, source, sourceDoc.ref);
          console.log(`Source ${sourceDoc.id}: ${processed} document(s) importé(s).`);
        } catch(e) {
          console.error(`Source ${sourceDoc.id}: erreur:`, e.message);
        }
      }
    } finally {
      try { await client.logout(); } catch(e) { /* ignore */ }
    }
  });

// ══════════════════════════════════════════════════════════════════
//  KIZEO FORMS — rapports d'intervention
//  API v3, base https://forms.kizeo.com/rest/v3/
//  Auth : header Authorization = token brut (pas de préfixe Bearer).
// ══════════════════════════════════════════════════════════════════

// Requête générique vers l'API Kizeo. Retourne { status, body(text) }.
// `binary=true` retourne body en Buffer (pour récupérer PDF/Excel).
function kizeoRequest(token, method, path, jsonBody, binary) {
  return new Promise((resolve) => {
    const data = jsonBody ? JSON.stringify(jsonBody) : null;
    const headers = { Authorization: token, Accept: "application/json" };
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    const r = https.request({ hostname: "forms.kizeo.com", path: "/rest/v3" + path, method, headers }, (x) => {
      const chunks = [];
      x.on("data", c => chunks.push(c));
      x.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: x.statusCode, body: binary ? buf : buf.toString("utf8") });
      });
    });
    r.on("error", e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

// ── LISTER LES CHAMPS D'UN FORMULAIRE (pour le configurateur) ─────
// Entrée : { formId }. Retourne la liste { id (field_id), libelle, type }
// pour permettre le mapping en menus déroulants côté configurateur.
exports.kizeoListFields = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const formId = (req.body && req.body.formId ? String(req.body.formId) : "").trim();
    if (!formId) { res.status(400).json({ error: "formId manquant" }); return; }

    const r = await kizeoRequest(KIZEO_API_TOKEN.value(), "GET", "/forms/" + encodeURIComponent(formId));
    if (r.status !== 200) {
      res.status(502).json({ error: "Kizeo a répondu " + r.status, detail: (r.body || r.error || "").slice(0, 300) });
      return;
    }
    let form;
    try { form = JSON.parse(r.body); } catch(e) { res.status(502).json({ error: "Réponse Kizeo illisible" }); return; }

    // La définition d'un formulaire expose ses champs sous form.fields (objet indexé par field_id).
    const def = (form && (form.form || form)) || {};
    const rawFields = def.fields || {};
    const fields = [];
    Object.keys(rawFields).forEach(fid => {
      const f = rawFields[fid] || {};
      fields.push({ id: fid, libelle: f.caption || f.label || fid, type: f.type || "" });
    });

    // Liste des exports Word/Excel configurés sur le formulaire (pour choisir l'exportId).
    let exports = [];
    const ex = await kizeoRequest(KIZEO_API_TOKEN.value(), "GET", "/forms/" + encodeURIComponent(formId) + "/exports");
    if (ex.status === 200) {
      try {
        const parsed = JSON.parse(ex.body);
        const arr = parsed.exports || parsed.data || (Array.isArray(parsed) ? parsed : []);
        exports = (arr || []).map(e => ({ id: String(e.id), nom: e.name || e.label || ("Export " + e.id), type: e.type || "" }));
      } catch(e) { /* liste d'exports non critique */ }
    }

    res.status(200).json({
      formId,
      nom: def.name || def.class || "",
      fields,
      exports,
    });
  });

// ── LISTER LES UTILISATEURS KIZEO (pour choisir le destinataire) ──
// Retourne [{ id, prenom, nom, login }] pour alimenter un menu dans la fiche technicien.
exports.kizeoListUsers = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const r = await kizeoRequest(KIZEO_API_TOKEN.value(), "GET", "/users");
    if (r.status !== 200) { res.status(502).json({ error: "Kizeo a répondu " + r.status, detail: (r.body || r.error || "").slice(0, 300) }); return; }
    let parsed; try { parsed = JSON.parse(r.body); } catch(e) { res.status(502).json({ error: "Réponse Kizeo illisible" }); return; }
    let arr = [];
    if (Array.isArray(parsed)) arr = parsed;
    else if (Array.isArray(parsed.users)) arr = parsed.users;
    else if (parsed.data && Array.isArray(parsed.data.users)) arr = parsed.data.users;
    else if (Array.isArray(parsed.data)) arr = parsed.data;
    const users = arr.map(u => ({
      id: String(u.id),
      prenom: u.first_name || u.firstName || u.prenom || "",
      nom: u.last_name || u.lastName || u.nom || "",
      login: u.user_name || u.login || u.email || u.name || "",
    }));
    res.status(200).json({ users });
  });

// ── GÉNÉRER UN RAPPORT PRÉ-REMPLI (push vers le mobile du technicien) ──
// Entrée : { suiviId, numPassage, kizeoFormDocId, recipientUserId }.
// Écrit un ref_interne unique "{suiviId}::{numPassage}" (lien de rattachement)
// + pré-remplit référence/passage/client/adresse/date selon le mapping.
exports.pushKizeoForm = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { suiviId, numPassage, passageId, kizeoFormDocId, recipientUserId, libelle } = req.body || {};
    if (!suiviId || !numPassage || !kizeoFormDocId) { res.status(400).json({ error: "suiviId, numPassage et kizeoFormDocId requis" }); return; }
    const recipient = parseInt(recipientUserId, 10);
    if (!recipient) { res.status(400).json({ error: "Technicien Kizeo (recipientUserId) manquant ou invalide" }); return; }

    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");

    // Config du formulaire
    const formSnap = await db.collection("kizeo-forms").doc(String(kizeoFormDocId)).get();
    if (!formSnap.exists) { res.status(404).json({ error: "Formulaire Kizeo introuvable" }); return; }
    const form = formSnap.data();
    const mapping = form.mapping || {};
    if (!form.formId) { res.status(400).json({ error: "formId manquant dans la config" }); return; }
    if (!mapping.refInterne) { res.status(400).json({ error: "Champ Référence interne non associé dans la config" }); return; }

    // Doc suivi (source de vérité)
    const sSnap = await db.collection("suivi").doc(String(suiviId)).get();
    if (!sSnap.exists) { res.status(404).json({ error: "Intervention introuvable" }); return; }
    const s = sSnap.data();
    const passages = Array.isArray(s.passages) ? s.passages : [];
    // Un même numéro de passage peut exister en double (contrat récurrent relancé) :
    // on cible en priorité par passageId (identifiant stable envoyé par le front),
    // avec repli sur num pour les anciens passages sans passageId.
    const passage = (passageId && passages.find(p => p.passageId === passageId))
      || passages.find(p => String(p.num) === String(numPassage))
      || {};
    const dateVal = (passage.debut ? String(passage.debut).split("T")[0] : (s.dateEmission || ""));
    const reference = s.bc || s.pl || s.devis || "";
    // Format figé par le contrat externe Kizeo (webhook attend suiviId::numPassage, cf. regex
    // de réception) : ne pas y injecter passageId, qui ne sert qu'à cibler la bonne occurrence
    // ci-dessus quand plusieurs passages partagent le même num (contrat récurrent relancé).
    const refInterne = `${suiviId}::${numPassage}`;

    // Ligne existante pour ce passage (même en attente, déjà reçue, envoyée...) :
    // détermine si c'est un premier envoi ou un renvoi (compteur + suffixe libellé),
    // et sert de base pour reprendre les réponses déjà saisies par le technicien.
    const existingSnap = await db.collection("reception-rapports").where("refInterne", "==", refInterne).limit(1).get();
    const existingDoc = existingSnap.empty ? null : existingSnap.docs[0];
    const existingData = existingDoc ? existingDoc.data() : null;
    const renvois = existingData ? (existingData.renvois || 0) + 1 : 0;

    // Construction des champs à pousser (uniquement les champs mappés)
    const passageLabel = String(numPassage) === "1" ? "1er passage" : numPassage + "ème passage";
    let baseLibelle = (libelle && String(libelle).trim()) || ((reference ? reference + " - " : "") + passageLabel);
    if (renvois > 0) baseLibelle += ` (${renvois})`;
    const appValues = {
      refInterne,
      libelle: baseLibelle,
      reference: reference,
      passage: String(numPassage),
      client: s.client || "",
      adresse: s.adresse || passage.adresse || "",
      date: dateVal,
    };

    // Renvoi après une soumission déjà reçue : on reprend ses réponses (texte, listes,
    // dates...) pour que le technicien n'ait qu'à corriger, pas tout ressaisir.
    // Les photos/signatures ne se pré-remplissent pas via l'API Kizeo (limite connue).
    const fields = {};
    if (existingData && existingData.kizeoDataId) {
      try {
        const prev = await kizeoRequest(KIZEO_API_TOKEN.value(), "GET", "/forms/" + encodeURIComponent(form.formId) + "/data/" + encodeURIComponent(existingData.kizeoDataId));
        if (prev.status === 200) {
          const prevParsed = JSON.parse(prev.body);
          const prevFields = (prevParsed.data || prevParsed).fields || {};
          const SKIP_TYPES = new Set(["section", "photo", "image", "signature", "video", "audio", "drawing", "barcode", "gps"]);
          Object.keys(prevFields).forEach(fid => {
            const f = prevFields[fid];
            if (!f || SKIP_TYPES.has(f.type) || f.value === undefined || f.value === "") return;
            fields[fid] = { value: f.value };
          });
        }
      } catch(e) {
        console.error("Kizeo: reprise des réponses précédentes échouée:", e.message);
      }
    }
    Object.keys(appValues).forEach(key => {
      const fid = mapping[key];
      if (fid) fields[fid] = { value: appValues[key] }; // les champs de l'app priment sur les valeurs reprises
    });

    const r = await kizeoRequest(KIZEO_API_TOKEN.value(), "POST", "/forms/" + encodeURIComponent(form.formId) + "/push", {
      recipient_user_id: recipient,
      fields,
    });
    if (r.status < 200 || r.status >= 300) {
      res.status(502).json({ error: "Kizeo a refusé le push (" + r.status + ")", detail: (r.body || r.error || "").slice(0, 300) });
      return;
    }
    console.log("Kizeo push OK:", suiviId, "passage", numPassage, "-> user", recipient, renvois > 0 ? `(renvoi ${renvois})` : "");

    // Ligne "en attente" dans Gestion rapports : créée (ou réutilisée si un envoi
    // précédent existait déjà pour ce passage) dès le push, avant même que le
    // technicien ait répondu. Permet de suivre qui doit encore rendre son rapport.
    let technicien = "";
    try {
      const tSnap = await db.collection("techniciens").where("kizeoUserId", "==", String(recipient)).limit(1).get();
      if (!tSnap.empty) {
        const t = tSnap.docs[0].data();
        technicien = t.nomComplet || `${t.prenom || ""} ${t.nom || ""}`.trim();
      }
      const now = new Date().toISOString();
      const pendingData = {
        kizeoDataId: null,
        kizeoFormId: form.formId,
        kizeoFormDocId: String(kizeoFormDocId),
        recipientUserId: recipient,
        refInterne,
        reference,
        libelle: baseLibelle,
        arriveeAt: now,
        pushedAt: now,
        dateFin: passage.fin || null,
        technicien,
        renvois,
        origine: "app",
        suiviId,
        passageId: passageId || null,
        client: s.client || "",
        bc: reference,
        numPassage: parseInt(numPassage, 10),
        passageLabel,
        type: form.typeSortie === "excel" ? "excel" : "pdf",
        fileUrl: null,
        gsheetId: null,
        gsheetUrl: null,
        statut: "en-attente",
        updatedAt: now,
      };
      if (existingDoc) {
        await existingDoc.ref.update(pendingData);
      } else {
        await db.collection("reception-rapports").add({ ...pendingData, createdAt: now });
      }
    } catch(e) {
      console.error("Kizeo push : création de la ligne en attente échouée:", e.message);
    }

    // Reflète l'envoi sur le passage du Suivi (badge "✓ Envoyé le..."), pour rester
    // cohérent que le renvoi ait été déclenché depuis le Suivi ou depuis Gestion rapports.
    try {
      const nowIso = new Date().toISOString();
      const targetPassageId = passageId || passage.passageId || null;
      const updatedPassages = passages.map(p => {
        const isTarget = targetPassageId ? p.passageId === targetPassageId : String(p.num) === String(numPassage);
        return isTarget
          ? { ...p, kizeoPush: { at: nowIso, technicien, formNom: form.nom || "", libelle: baseLibelle, kizeoFormDocId: String(kizeoFormDocId), recipientUserId: String(recipientUserId) } }
          : p;
      });
      await db.collection("suivi").doc(String(suiviId)).update({ passages: updatedPassages });
    } catch(e) {
      console.error("Kizeo push : mise à jour du badge Suivi échouée:", e.message);
    }

    res.status(200).json({ success: true, refInterne: appValues.refInterne, renvois });
  });

// ── RÉCEPTION D'UNE SOUMISSION (commun au webhook et au pull) ─────
// Lit la soumission Kizeo, résout le rattachement via ref_interne, télécharge
// le fichier (PDF ou Excel selon la config du formulaire), le dépose dans
// Storage et écrit/met à jour le doc `reception-rapports`. Idempotent sur
// kizeoDataId (un renvoi de webhook ou un second pull mettent à jour, pas dupliquent).
async function receiveKizeoSubmission(db, token, formId, dataId, origine) {
  const formsSnap = await db.collection("kizeo-forms").where("formId", "==", String(formId)).limit(1).get();
  if (formsSnap.empty) {
    console.warn(`Kizeo: formulaire ${formId} non configuré dans kizeo-forms, soumission ${dataId} ignorée`);
    return;
  }
  const formConf = formsSnap.docs[0].data();
  const mapping = formConf.mapping || {};

  const r = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(formId)}/data/${encodeURIComponent(dataId)}`);
  if (r.status !== 200) {
    console.error(`Kizeo: lecture soumission ${dataId} échouée (${r.status})`);
    return;
  }
  let parsed;
  try { parsed = JSON.parse(r.body); } catch(e) { console.error(`Kizeo: réponse illisible pour ${dataId}`); return; }
  const submission = parsed.data || parsed;
  const fields = submission.fields || {};
  const getField = (fid) => {
    if (!fid) return "";
    const raw = fields[fid];
    if (raw && typeof raw === "object") return raw.value !== undefined ? raw.value : "";
    return raw || "";
  };

  const refInterne = mapping.refInterne ? String(getField(mapping.refInterne) || "").trim() : "";
  const reference = mapping.reference ? String(getField(mapping.reference) || "") : "";

  // Un push crée déjà la donnée côté Kizeo (avec nos valeurs par défaut), donc elle
  // apparaît "non lue" dès l'envoi, même si le technicien n'a jamais ouvert le
  // formulaire. Le champ signature (jamais pré-rempli par nous) sert de preuve
  // d'intervention réelle : tant qu'il est vide, on laisse la donnée "non lue" côté
  // Kizeo (pas de markasreadbyaction) pour la retester au prochain pull.
  if (mapping.signature) {
    const signatureVal = getField(mapping.signature);
    const isSigned = signatureVal && (typeof signatureVal !== "object" || Object.keys(signatureVal).length > 0) && signatureVal !== "";
    if (!isSigned) {
      console.log(`Kizeo: soumission ${dataId} pas encore signée par le technicien, laissée en attente`);
      return false;
    }
  }

  // Le nom du technicien ne revient pas dans la réponse Kizeo (recipient_name vide) :
  // on le résout via user_id (l'auteur de la soumission) -> techniciens.kizeoUserId.
  let technicien = submission._recipient_name || submission.recipient_name || "";
  const submissionUserId = submission.user_id || submission.userId || null;
  if (!technicien && submissionUserId) {
    try {
      const tSnap = await db.collection("techniciens").where("kizeoUserId", "==", String(submissionUserId)).limit(1).get();
      if (!tSnap.empty) {
        const t = tSnap.docs[0].data();
        technicien = t.nomComplet || `${t.prenom || ""} ${t.nom || ""}`.trim();
      }
    } catch(e) {
      console.error("Kizeo: résolution technicien échouée:", e.message);
    }
  }

  // ── Circuit Campagnes (bâtiment > passage 1 ou 2), distinct des deux autres
  // circuits. refInterne = campagne::semaineId::passage(1|2)::batimentId.
  // Les données de reporting (statut/niveau d'infestation par logement) sont
  // lues directement dans le JSON de la soumission (fields.tableau.value),
  // plus fiable que de re-parser le fichier Excel généré par Kizeo. Ce fichier
  // Excel est quand même téléchargé et archivé pour consultation.
  if (refInterne.startsWith("campagne::")) {
    const partsA = refInterne.split("::");
    if (partsA.length !== 4) { console.warn(`Kizeo campagne: refInterne invalide (${refInterne}), soumission ${dataId} ignorée`); return; }
    const [, semaineId, passageStr, batimentId] = partsA;
    const passageNum = parseInt(passageStr, 10);
    if (passageNum !== 1 && passageNum !== 2) { console.warn(`Kizeo campagne: numéro de passage invalide (${refInterne})`); return; }
    const passageKey = passageNum === 1 ? "passage1" : "passage2";

    const batimentRefA = db.collection("campagnes-batiments").doc(batimentId);
    const batimentSnapA = await batimentRefA.get();
    if (!batimentSnapA.exists) { console.warn(`Kizeo campagne: bâtiment ${batimentId} introuvable, soumission ${dataId} ignorée`); return; }
    const batimentA = batimentSnapA.data();
    if (batimentA.semaineId !== semaineId) { console.warn(`Kizeo campagne: semaineId incohérent pour ${refInterne}`); return; }

    // Extraction des résultats par logement depuis le champ liste "tableau".
    // statut_1er_passage = choix UNIQUE -> on lit .value (texte simple).
    // niveau_infestation = choix MULTIPLE -> on lit .valuesAsArray (liste).
    const getRowText = (row, key) => {
      const cell = row && row[key];
      return (cell && cell.value !== undefined) ? cell.value : "";
    };
    const getRowArray = (row, key) => {
      const cell = row && row[key];
      if (!cell) return [];
      if (Array.isArray(cell.valuesAsArray)) return cell.valuesAsArray;
      return cell.value ? [cell.value] : [];
    };
    const tableauRows = (fields.tableau && fields.tableau.value) || [];
    const resultatsA = tableauRows.map(row => ({
      nom: getRowText(row, "nom"),
      numero: getRowText(row, "numero_logement"),
      etage: getRowText(row, "etage"),
      statut: getRowText(row, "statut_1er_passage"),
      niveauInfestation: getRowArray(row, "niveau_infestation"),
    }));

    // PDF (obligatoire) + Excel Kizeo (archive, non bloquant si absent/échoue).
    const pdfA = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(formId)}/data/${encodeURIComponent(dataId)}/pdf`, null, true);
    if (pdfA.status !== 200) { console.error(`Kizeo campagne: téléchargement PDF échoué (${pdfA.status}) pour ${dataId}`); return; }

    const bucketA = admin.storage().bucket("belledonne-client.firebasestorage.app");
    const nomBaseA = `${batimentA.adresseRue || "adresse"}_passage_${passageNum}`.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_");
    const storagePathPdfA = `campagnes-reception/${semaineId}/${passageNum}/${Date.now()}_${nomBaseA}.pdf`;
    const tokenPdfA = crypto.randomUUID();
    await bucketA.file(storagePathPdfA).save(pdfA.body, { contentType: "application/pdf", metadata: { metadata: { firebaseStorageDownloadTokens: tokenPdfA } } });
    const fileUrlPdfA = `https://firebasestorage.googleapis.com/v0/b/${bucketA.name}/o/${encodeURIComponent(storagePathPdfA)}?alt=media&token=${tokenPdfA}`;

    let fileUrlExcelA = null;
    if (formConf.exportId) {
      try {
        const exA = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(formId)}/data/${encodeURIComponent(dataId)}/exports/${encodeURIComponent(formConf.exportId)}`, null, true);
        if (exA.status === 200) {
          const storagePathXlsA = `campagnes-reception/${semaineId}/${passageNum}/${Date.now()}_${nomBaseA}.xlsx`;
          const tokenXlsA = crypto.randomUUID();
          await bucketA.file(storagePathXlsA).save(exA.body, { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", metadata: { metadata: { firebaseStorageDownloadTokens: tokenXlsA } } });
          fileUrlExcelA = `https://firebasestorage.googleapis.com/v0/b/${bucketA.name}/o/${encodeURIComponent(storagePathXlsA)}?alt=media&token=${tokenXlsA}`;
        }
      } catch(e) { console.error(`Kizeo campagne: export Excel archive échoué pour ${dataId}:`, e.message); }
    }

    const nowA = new Date().toISOString();
    await batimentRefA.set({
      [passageKey]: {
        ...(batimentA[passageKey] || {}),
        statut: "a-traiter",
        kizeoDataId: String(dataId),
        resultats: resultatsA,
        fileUrlPdf: fileUrlPdfA,
        fileUrlExcel: fileUrlExcelA,
        receivedAt: nowA,
      },
      updatedAt: nowA,
    }, { merge: true });
    console.log(`Kizeo campagne: soumission ${dataId} reçue -> campagnes-batiments/${batimentId}.${passageKey}`);
    return true;
  }

  // ── Circuit garantie (semaine > bloc > ligne locataire), distinct du circuit
  // "suivi" classique ci-dessous. refInterne = garantie::semaineId::blocId::ligneId.
  if (refInterne.startsWith("garantie::")) {
    const parts = refInterne.split("::");
    if (parts.length !== 4) { console.warn(`Kizeo: refInterne garantie invalide (${refInterne}), soumission ${dataId} ignorée`); return; }
    const [, semaineId, blocId, ligneId] = parts;
    const semaineSnap = await db.collection("garanties-semaines").doc(semaineId).get();
    if (!semaineSnap.exists) { console.warn(`Kizeo: semaine garantie ${semaineId} introuvable, soumission ${dataId} ignorée`); return; }
    const semaine = semaineSnap.data();
    const blocs = Array.isArray(semaine.blocs) ? semaine.blocs : [];
    const bloc = blocs.find(b => b.id === blocId);
    const ligne = bloc ? (bloc.lignes || []).find(l => l.id === ligneId) : null;
    if (!bloc || !ligne) { console.warn(`Kizeo: bloc/ligne garantie introuvable (${refInterne}), soumission ${dataId} ignorée`); return; }

    const typeSortieG = formConf.typeSortie === "excel" ? "excel" : "pdf";
    let fileBufferG, extG, contentTypeG;
    if (typeSortieG === "excel") {
      if (!formConf.exportId) { console.error(`Kizeo: exportId manquant pour le formulaire ${formId}`); return; }
      const ex = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(formId)}/data/${encodeURIComponent(dataId)}/exports/${encodeURIComponent(formConf.exportId)}`, null, true);
      if (ex.status !== 200) { console.error(`Kizeo: export échoué (${ex.status}) pour ${dataId}`); return; }
      fileBufferG = ex.body; extG = "xlsx"; contentTypeG = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else {
      const pdf = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(formId)}/data/${encodeURIComponent(dataId)}/pdf`, null, true);
      if (pdf.status !== 200) { console.error(`Kizeo: téléchargement PDF échoué (${pdf.status}) pour ${dataId}`); return; }
      fileBufferG = pdf.body; extG = "pdf"; contentTypeG = "application/pdf";
    }

    const bucketG = admin.storage().bucket("belledonne-client.firebasestorage.app");
    const folderG = ligne.client || "_inconnu";
    const nomBaseG = `Garantie_${ligne.client || "client"}_${ligne.nom || "locataire"}_${bloc.date || ""}`.replace(/\s+/g, "_");
    const storagePathG = `garanties-reception/${folderG}/${Date.now()}_${nomBaseG}.${extG}`;
    const downloadTokenG = crypto.randomUUID();
    try {
      await bucketG.file(storagePathG).save(fileBufferG, { contentType: contentTypeG, metadata: { metadata: { firebaseStorageDownloadTokens: downloadTokenG } } });
    } catch(e) { console.error(`Kizeo: upload Storage garantie échoué pour ${dataId}:`, e.message); return; }
    const fileUrlG = `https://firebasestorage.googleapis.com/v0/b/${bucketG.name}/o/${encodeURIComponent(storagePathG)}?alt=media&token=${downloadTokenG}`;

    const nowG = new Date().toISOString();
    const docDataG = {
      kizeoDataId: String(dataId),
      kizeoFormId: String(formId),
      kizeoFormDocId: formsSnap.docs[0].id,
      recipientUserId: submissionUserId ? parseInt(submissionUserId, 10) : null,
      refInterne,
      semaineId, blocId, ligneId,
      nomLocataire: ligne.nom || "",
      client: ligne.client || "",
      technicien,
      origine,
      type: typeSortieG,
      fileUrl: fileUrlG,
      statut: "a-traiter",
      arriveeAt: nowG,
      updatedAt: nowG,
    };

    let existingG = await db.collection("garanties-rapports").where("kizeoDataId", "==", String(dataId)).limit(1).get();
    if (existingG.empty) {
      existingG = await db.collection("garanties-rapports").where("refInterne", "==", refInterne).where("statut", "==", "en-attente").limit(1).get();
    }
    if (!existingG.empty) {
      await existingG.docs[0].ref.update(docDataG);
      console.log(`Kizeo garantie: soumission ${dataId} mise à jour (garanties-rapports/${existingG.docs[0].id})`);
    } else {
      const newRef = await db.collection("garanties-rapports").add(docDataG);
      console.log(`Kizeo garantie: soumission ${dataId} reçue -> garanties-rapports/${newRef.id}`);
    }

    // Compteur client "passages garantie" (espace client) : un passage confirmé par
    // ligne/bloc, daté du jour réel de l'intervention (pas de la réception du rapport).
    // Id déterministe pour éviter les doublons en cas de renvoi/régénération.
    try {
      const passageId = `${semaineId}__${blocId}__${ligneId}`;
      await db.collection("garanties-passages").doc(passageId).set({
        client: ligne.client || "",
        nomLocataire: ligne.nom || "",
        adresse: ligne.adresse || "",
        codePostal: ligne.codePostal || "",
        ville: ligne.ville || "",
        date: bloc.date || nowG.split("T")[0],
        semaineId, blocId, ligneId,
        updatedAt: nowG,
      }, { merge: true });
    } catch(e) { console.error(`Kizeo garantie: enregistrement passage échoué pour ${dataId}:`, e.message); }

    return true;
  }

  let suiviId = null, client = "", bc = "", numPassage = null, passageLabel = "";
  const m = refInterne.match(/^(.+)::(\d+)$/);
  if (m) {
    const candidateSuiviId = m[1];
    numPassage = parseInt(m[2], 10);
    passageLabel = numPassage === 1 ? "1er passage" : numPassage + "ème passage";
    try {
      const sSnap = await db.collection("suivi").doc(candidateSuiviId).get();
      if (sSnap.exists) {
        suiviId = candidateSuiviId;
        const s = sSnap.data();
        client = s.client || "";
        bc = s.bc || s.pl || s.devis || "";
      }
    } catch(e) {
      console.error("Kizeo: résolution suivi échouée:", e.message);
    }
  }

  // Soumission non déclenchée depuis l'app (ref_interne absent/illisible ou intervention
  // introuvable) : on l'ignore plutôt que de l'afficher "à rattacher". Seuls les rapports
  // générés via le bouton "Générer le rapport Kizeo" du Suivi doivent apparaître ici.
  if (!suiviId) {
    console.log(`Kizeo: soumission ${dataId} ignorée (ref_interne absent ou intervention introuvable, hors app)`);
    return;
  }

  // Téléchargement du fichier (PDF ou Excel selon la config du formulaire)
  const typeSortie = formConf.typeSortie === "excel" ? "excel" : "pdf";
  let fileBuffer, ext, contentType;
  if (typeSortie === "excel") {
    if (!formConf.exportId) { console.error(`Kizeo: exportId manquant pour le formulaire ${formId}`); return; }
    const ex = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(formId)}/data/${encodeURIComponent(dataId)}/exports/${encodeURIComponent(formConf.exportId)}`, null, true);
    if (ex.status !== 200) { console.error(`Kizeo: export Excel échoué (${ex.status}) pour ${dataId}`); return; }
    fileBuffer = ex.body; ext = "xlsx";
    contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  } else {
    const pdf = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(formId)}/data/${encodeURIComponent(dataId)}/pdf`, null, true);
    if (pdf.status !== 200) { console.error(`Kizeo: téléchargement PDF échoué (${pdf.status}) pour ${dataId}`); return; }
    fileBuffer = pdf.body; ext = "pdf"; contentType = "application/pdf";
  }

  const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
  const folder = client || "_inconnu";
  // Nom du fichier = Nom du rapport Kizeo _ N° BC/PL/Devis _ passage_N
  const rapportNom = (formConf.nom || "Rapport").trim();
  const bcRef = bc || reference || dataId || "sans-bc";
  const nomBase = `${rapportNom}_${bcRef}_passage_${numPassage}`.replace(/\s+/g, "_");
  const storagePath = `reception/${folder}/${Date.now()}_${nomBase}.${ext}`;
  const downloadToken = crypto.randomUUID();
  try {
    await bucket.file(storagePath).save(fileBuffer, {
      contentType,
      metadata: { metadata: { firebaseStorageDownloadTokens: downloadToken } },
    });
  } catch(e) {
    console.error(`Kizeo: upload Storage échoué pour ${dataId}:`, e.message);
    return;
  }
  const fileUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;

  const now = new Date().toISOString();
  const docData = {
    kizeoDataId: String(dataId),
    kizeoFormId: String(formId),
    kizeoFormDocId: formsSnap.docs[0].id,
    recipientUserId: submissionUserId ? parseInt(submissionUserId, 10) : null,
    refInterne: refInterne || null,
    reference: reference || "",
    arriveeAt: now,
    technicien,
    origine,
    suiviId,
    client,
    bc,
    numPassage,
    passageLabel,
    type: typeSortie,
    typeRapport: formConf.nature === "absence-annulation" ? "absence-annulation" : "intervention",
    fileUrl,
    gsheetId: null,
    gsheetUrl: null,
    statut: "a-traiter",
    updatedAt: now,
  };

  // 1) Déjà reçue avant (renvoi de webhook, second pull) : on retrouve la ligne par kizeoDataId.
  // 2) Sinon, ligne "en attente" créée au push (via ref_interne) : on la transforme en place.
  // 3) Sinon (ligne supprimée entre-temps, ou soumission jamais suivie côté app) : on en crée une,
  //    pour ne jamais perdre un rapport reçu.
  let existing = await db.collection("reception-rapports").where("kizeoDataId", "==", String(dataId)).limit(1).get();
  if (existing.empty && refInterne) {
    existing = await db.collection("reception-rapports").where("refInterne", "==", refInterne).where("statut", "==", "en-attente").limit(1).get();
  }
  if (!existing.empty) {
    await existing.docs[0].ref.update(docData);
    console.log(`Kizeo: soumission ${dataId} mise à jour (reception-rapports/${existing.docs[0].id})`);
  } else {
    docData.createdAt = now;
    const ref = await db.collection("reception-rapports").add(docData);
    console.log(`Kizeo: soumission ${dataId} reçue -> reception-rapports/${ref.id}`);
  }
  return true;
}

// ── WEBHOOK KIZEO (public, sécurisé par secret partagé en header) ─
// Déclencheur "Recording" configuré côté Kizeo. Kizeo n'offre pas de
// signature HMAC native : la protection repose uniquement sur ce secret,
// à faire tourner (KIZEO_WEBHOOK_SECRET) s'il est un jour compromis.
exports.kizeoWebhook = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN, KIZEO_WEBHOOK_SECRET] })
  .https.onRequest(async (req, res) => {
    if (req.get("X-Kizeo-Secret") !== KIZEO_WEBHOOK_SECRET.value()) {
      res.status(401).json({ error: "Non autorisé" });
      return;
    }
    const body = req.body || {};
    // Format réel observé : { id: "<dataId>", eventType: "finished", data: { form_id: "...", fields: {...}, ... } }
    const formId = (body.data && body.data.form_id) || body.form_id || body.formId || (body.form && body.form.id);
    const dataId = body.id || body.data_id || body.dataId;
    if (!formId || !dataId) {
      console.warn("Kizeo webhook: payload incomplet:", JSON.stringify(body).slice(0, 300));
      res.status(200).json({ ok: true }); // accuser réception (éviter les retries en boucle sur un format non géré)
      return;
    }
    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    try {
      await receiveKizeoSubmission(db, KIZEO_API_TOKEN.value(), formId, dataId, "webhook");
    } catch(e) {
      console.error("Kizeo webhook:", e.message);
    }
    res.status(200).json({ ok: true });
  });

// ── PULL KIZEO (planifié, filet de sécurité si un webhook se perd) ─
// Parcourt les formulaires actifs, récupère leurs soumissions non lues sur
// le canal "espace-client" et les marque lues une fois traitées.
exports.kizeoPull = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300, secrets: [KIZEO_API_TOKEN] })
  .pubsub.schedule("every 15 minutes")
  .timeZone("Europe/Paris")
  .onRun(async () => {
    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const token = KIZEO_API_TOKEN.value();
    const action = "espace-client";

    let formsSnap;
    try {
      formsSnap = await db.collection("kizeo-forms").where("actif", "==", true).get();
    } catch(e) {
      console.error("kizeoPull: lecture kizeo-forms échouée:", e.message);
      return;
    }

    for (const doc of formsSnap.docs) {
      const form = doc.data();
      if (!form.formId) continue;
      const r = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(form.formId)}/data/unread/${action}/500`);
      if (r.status !== 200) {
        if (r.status !== 404) console.error(`kizeoPull: formulaire ${form.formId} -> ${r.status}`);
        continue;
      }
      let parsed;
      try { parsed = JSON.parse(r.body); } catch(e) { continue; }
      const list = parsed.data || parsed.list || (Array.isArray(parsed) ? parsed : []);
      const ids = (list || []).map(d => d.id || d._id).filter(Boolean);
      if (!ids.length) continue;
      console.log(`kizeoPull: ${ids.length} soumission(s) non lue(s) pour ${form.formId}`);
      const readyIds = [];
      for (const dataId of ids) {
        try {
          const processed = await receiveKizeoSubmission(db, token, form.formId, dataId, "pull");
          // processed === false : pas encore signée par le technicien, on la laisse
          // "non lue" côté Kizeo pour la retester au prochain pull (pas de perte).
          if (processed !== false) readyIds.push(dataId);
        }
        catch(e) { console.error(`kizeoPull: soumission ${dataId} échouée:`, e.message); readyIds.push(dataId); }
      }
      if (readyIds.length) {
        try {
          await kizeoRequest(token, "POST", `/forms/${encodeURIComponent(form.formId)}/markasreadbyaction/${action}`, { data_ids: readyIds });
        } catch(e) {
          console.error(`kizeoPull: marquage lu échoué pour ${form.formId}:`, e.message);
        }
      }
    }
  });

// ── GARANTIES : POUSSER UN RAPPORT KIZEO PAR LIGNE (bloc d'une semaine garantie) ─
// Pousse, pour chaque locataire du bloc, un rapport Kizeo pré-rempli
// (nom, adresse, code postal, ville, étage) au technicien assigné. Le libellé
// visible sur l'app mobile = nom du locataire. Formulaire identifié par son
// formId Kizeo (indépendant du système de mapping "suivi" classique).
const GARANTIE_KIZEO_FORM_ID = "1086949"; // "Garantie blattes"
exports.pushGarantieKizeo = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN] })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { semaineId, blocId } = req.body || {};
    if (!semaineId || !blocId) { res.status(400).json({ error: "semaineId et blocId requis" }); return; }

    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const ref = db.collection("garanties-semaines").doc(semaineId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: "Semaine introuvable" }); return; }
    const semaine = snap.data();
    const blocs = Array.isArray(semaine.blocs) ? semaine.blocs : [];
    const bloc = blocs.find(b => b.id === blocId);
    if (!bloc) { res.status(404).json({ error: "Bloc introuvable" }); return; }
    const recipient = parseInt(bloc.technicienKizeoUserId, 10);
    if (!recipient) { res.status(400).json({ error: "Technicien Kizeo manquant (assignez un technicien avec un ID Kizeo configuré)" }); return; }

    const formsSnap = await db.collection("kizeo-forms").where("formId", "==", GARANTIE_KIZEO_FORM_ID).limit(1).get();
    if (formsSnap.empty) { res.status(400).json({ error: "Formulaire Kizeo garantie non configuré dans kizeo-forms" }); return; }
    const form = formsSnap.docs[0].data();
    const mapping = form.mapping || {};
    if (!mapping.refInterne) { res.status(400).json({ error: "Champ Référence interne non mappé pour ce formulaire" }); return; }

    const token = KIZEO_API_TOKEN.value();
    const lignes = Array.isArray(bloc.lignes) ? bloc.lignes : [];
    let pushed = 0;
    const errorsList = [];

    // Régénération : suffixe (1), (2)... sur le libellé pour distinguer chaque
    // envoi et permettre de retrouver/supprimer les anciens rapports dans Kizeo.
    const pushCount = (bloc.kizeoPushCount || 0) + 1;
    const libelleSuffix = pushCount > 1 ? ` (${pushCount - 1})` : "";

    for (const ligne of lignes) {
      const refInterne = `garantie::${semaineId}::${blocId}::${ligne.id}`;

      // Ne jamais re-pousser une ligne dont le rapport est déjà "archive"
      // (agrégé + envoyé au client) : évite un double envoi Kizeo au
      // technicien ET l'écrasement accidentel du rapport archivé.
      const existingSnap = await db.collection("garanties-rapports").where("refInterne", "==", refInterne).limit(1).get();
      const existingDoc = existingSnap.empty ? null : existingSnap.docs[0];
      if (existingDoc && existingDoc.data().statut === "archive") {
        errorsList.push({ ligneId: ligne.id, nom: ligne.nom, status: "skipped", detail: "Rapport déjà archivé (agrégé/envoyé) — non renvoyé. Supprimez/réinitialisez l'agrégé existant si vous voulez vraiment le refaire." });
        continue;
      }

      const values = {
        refInterne,
        libelle: (ligne.nom || "") + libelleSuffix,
        nom: ligne.nom || "",
        etage: ligne.etage || "",
        adresse: ligne.adresse || "",
        codePostal: ligne.codePostal || "",
        ville: ligne.ville || "",
        passage: "1",
      };
      const fields = {};
      Object.keys(values).forEach(key => {
        const fid = mapping[key];
        if (fid) fields[fid] = { value: values[key] };
      });

      const r = await kizeoRequest(token, "POST", `/forms/${encodeURIComponent(GARANTIE_KIZEO_FORM_ID)}/push`, {
        recipient_user_id: recipient,
        fields,
      });
      if (r.status >= 200 && r.status < 300) {
        pushed++;
        const nowPush = new Date().toISOString();
        ligne.kizeoPushedAt = nowPush;

        // Ligne "en attente" dans Gestion garanties > Rapports, comme pour le
        // circuit suivi classique : permet de suivre qui doit encore rendre
        // son rapport, avant même que le technicien ait répondu.
        try {
          const pendingData = {
            kizeoDataId: null,
            kizeoFormId: GARANTIE_KIZEO_FORM_ID,
            kizeoFormDocId: formsSnap.docs[0].id,
            recipientUserId: recipient,
            refInterne,
            semaineId, blocId, ligneId: ligne.id,
            nomLocataire: ligne.nom || "",
            client: ligne.client || "",
            technicien: bloc.technicienNom || "",
            origine: "app",
            statut: "en-attente",
            arriveeAt: nowPush,
            pushedAt: nowPush,
            dateFin: bloc.date && bloc.heureFin ? `${bloc.date}T${bloc.heureFin}` : null,
            type: null,
            fileUrl: null,
            updatedAt: nowPush,
          };
          const existingPending = await db.collection("garanties-rapports").where("refInterne", "==", refInterne).limit(1).get();
          if (!existingPending.empty) await existingPending.docs[0].ref.update(pendingData);
          else await db.collection("garanties-rapports").add(pendingData);
        } catch(e) { console.error("pushGarantieKizeo: création ligne en attente échouée:", e.message); }
      } else {
        errorsList.push({ ligneId: ligne.id, nom: ligne.nom, status: r.status, detail: (r.body || r.error || "").toString().slice(0, 200) });
      }
    }

    bloc.lignes = lignes;
    bloc.kizeoSentAt = new Date().toISOString();
    bloc.kizeoPushCount = pushCount;
    try { await ref.update({ blocs, updatedAt: new Date().toISOString() }); }
    catch(e) { console.error("pushGarantieKizeo: mise à jour du bloc échouée:", e.message); }

    const skippedList = errorsList.filter(e => e.status === "skipped");
    const realErrorsList = errorsList.filter(e => e.status !== "skipped");
    res.status(200).json({ pushed, skipped: skippedList.length, skippedList, errors: realErrorsList.length, errorsList: realErrorsList });
  });

// ── GARANTIES : GÉNÉRER LES RAPPORTS AGRÉGÉS PAR CLIENT (semaine) ──
// Regroupe tous les rapports "à traiter" (reçus, signés) d'une semaine garantie
// par client, fusionne leurs PDF en un seul par client (page de garde + rapports),
// archive les rapports sources, et remplace l'agrégé existant s'il y en a déjà un
// pour ce client sur cette semaine (un seul agrégé par client/semaine, toujours à jour).
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error("HTTP " + res.statusCode)); return; }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── CAMPAGNES : construction du reporting Excel 3 onglets ─────────
// Reprend le format historique (Absentsrefus / Logements Surinfestés /
// Logements punaises de lit). `rows` = une ligne par logement, avec
// {adresse, codePostal, ville, secteur, technicien, nom, numero, etage,
//  statut, niveauInfestation(array)}. Un logement peut apparaître dans
// plusieurs onglets infestation.
function buildReportWorkbook(ExcelJS, rows) {
  const wb = new ExcelJS.Workbook();
  const header = ["Adresse", "Code postal", "Ville", "Secteur", "Technicien", "Nom", "Numéro logement", "Etage", "Statut", "Niveau infestation"];
  const rowValues = (r) => [r.adresse, r.codePostal, r.ville, r.secteur, r.technicien, r.nom, r.numero, r.etage, r.statut, (r.niveauInfestation || []).join(", ")];

  const wsAbsents = wb.addWorksheet("Absentsrefus");
  wsAbsents.addRow(header);
  rows.filter(r => r.statut && r.statut !== "Présent").forEach(r => wsAbsents.addRow(rowValues(r)));

  const wsSurinf = wb.addWorksheet("Logements Surinfestés");
  wsSurinf.addRow(header);
  rows.filter(r => (r.niveauInfestation || []).includes("Sur-infestation")).forEach(r => wsSurinf.addRow(rowValues(r)));

  const wsPunaises = wb.addWorksheet("Logements punaises de lit");
  wsPunaises.addRow(header);
  rows.filter(r => (r.niveauInfestation || []).includes("Présence punaises de lit")).forEach(r => wsPunaises.addRow(rowValues(r)));

  return wb;
}

// ── CAMPAGNES : rapports de la semaine (retour 1er passage) ───────
// Pour chaque bâtiment "à traiter" de la semaine : zippe les PDF reçus
// (renommés adresse_passage_1) et construit le reporting Excel de la
// semaine à partir de passage1.resultats (données brutes déjà extraites
// à la réception, pas de reparsing du fichier Excel Kizeo).
exports.generateCampagneRapportsSemaine = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { semaineId, force } = req.body || {};
    if (!semaineId) { res.status(400).json({ error: "semaineId requis" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      // force=true : régénère à partir de TOUS les rapports déjà reçus (a-traiter + archive),
      // utile si les fichiers générés ont été perdus. Sinon, seulement les nouveaux ("a-traiter").
      const snap = force
        ? await db.collection("campagnes-batiments").where("semaineId", "==", semaineId).where("passage1.statut", "in", ["a-traiter", "archive"]).get()
        : await db.collection("campagnes-batiments").where("semaineId", "==", semaineId).where("passage1.statut", "==", "a-traiter").get();
      if (snap.empty) { res.status(400).json({ error: force ? "Aucun rapport reçu pour cette période" : "Aucun rapport 'à traiter' pour cette semaine" }); return; }
      const batiments = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      const JSZip = require("jszip");
      const ExcelJS = require("exceljs");
      const zip = new JSZip();
      const rows = [];

      for (const b of batiments) {
        const p1 = b.passage1 || {};
        if (p1.fileUrlPdf) {
          try {
            const buf = await fetchBuffer(p1.fileUrlPdf);
            const nomFichier = `${(b.adresseRue || "adresse")}_passage_1.pdf`.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_");
            zip.file(nomFichier, buf);
          } catch(e) { console.error(`generateCampagneRapportsSemaine: PDF illisible pour ${b.id}:`, e.message); }
        }
        (p1.resultats || []).forEach(l => rows.push({
          adresse: b.adresseRue, codePostal: b.codePostal, ville: b.ville, secteur: b.secteur,
          technicien: p1.technicienNom, nom: l.nom, numero: l.numero, etage: l.etage,
          statut: l.statut, niveauInfestation: l.niveauInfestation,
        }));
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const wb = buildReportWorkbook(ExcelJS, rows);
      const xlsxBuffer = await wb.xlsx.writeBuffer();

      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const basePath = `campagnes-reportings/${semaineId}`;
      const tokenZip = crypto.randomUUID();
      const zipPath = `${basePath}/rapports_1er_passage_${Date.now()}.zip`;
      await bucket.file(zipPath).save(zipBuffer, { contentType: "application/zip", metadata: { metadata: { firebaseStorageDownloadTokens: tokenZip } } });
      const zipUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(zipPath)}?alt=media&token=${tokenZip}`;

      const tokenXlsx = crypto.randomUUID();
      const xlsxPath = `${basePath}/reporting_semaine_${Date.now()}.xlsx`;
      await bucket.file(xlsxPath).save(Buffer.from(xlsxBuffer), { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", metadata: { metadata: { firebaseStorageDownloadTokens: tokenXlsx } } });
      const xlsxUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(xlsxPath)}?alt=media&token=${tokenXlsx}`;

      const nowIso = new Date().toISOString();
      const batch = db.batch();
      batiments.forEach(b => batch.update(db.collection("campagnes-batiments").doc(b.id), { "passage1.statut": "archive", updatedAt: nowIso }));
      await batch.commit();

      const recapId = `${semaineId}__semaine_${Date.now()}`;
      await db.collection("campagnes-reportings-semaine").doc(recapId).set({
        semaineId, zipUrl, xlsxUrl, nbBatiments: batiments.length, generatedAt: nowIso,
      });

      res.status(200).json({ zipUrl, xlsxUrl, nbBatiments: batiments.length });
    } catch(e) {
      console.error("generateCampagneRapportsSemaine:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ── CAMPAGNES : reporting complet d'une semaine (fusion 1er + 2ème passage) ──
// Pour chaque bâtiment de la semaine, fusionne passage1.resultats et
// passage2.resultats logement par logement (clé nom+numero) :
// - statut 1er = Présent/Refus/Vacant (traité) -> on garde les données du 1er passage
// - statut 1er = Absent -> on prend le résultat du 2ème passage s'il existe,
//   sinon on garde le 1er passage tel quel (rapport 2ème passage manquant).
function fusionnerLogements(resultats1, resultats2) {
  const cle = (l) => `${(l.nom || "").trim().toLowerCase()}|${(l.numero || "").trim()}`;
  const map2 = new Map((resultats2 || []).map(l => [cle(l), l]));
  return (resultats1 || []).map(l1 => {
    if (l1.statut !== "Absent") return { ...l1 };
    const l2 = map2.get(cle(l1));
    if (l2) return { ...l2 };
    return { ...l1, note: "2ème passage non reçu" };
  });
}

exports.generateCampagneRapportComplet = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { semaineId } = req.body || {};
    if (!semaineId) { res.status(400).json({ error: "semaineId requis" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const snap = await db.collection("campagnes-batiments").where("semaineId", "==", semaineId).get();
      if (snap.empty) { res.status(400).json({ error: "Aucun bâtiment pour cette semaine" }); return; }
      const batiments = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => (b.passage1 && b.passage1.resultats && b.passage1.resultats.length));
      if (!batiments.length) { res.status(400).json({ error: "Aucun rapport 1er passage reçu pour cette semaine" }); return; }

      const JSZip = require("jszip");
      const ExcelJS = require("exceljs");
      const zip = new JSZip();
      const rows = [];
      const batimentsAvecPassage2 = [];

      for (const b of batiments) {
        const p1 = b.passage1 || {};
        const p2 = b.passage2 || {};
        if (p2.fileUrlPdf) {
          try {
            const buf = await fetchBuffer(p2.fileUrlPdf);
            const nomFichier = `${(b.adresseRue || "adresse")}_passage_2.pdf`.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_");
            zip.file(nomFichier, buf);
          } catch(e) { console.error(`generateCampagneRapportComplet: PDF passage 2 illisible pour ${b.id}:`, e.message); }
        }
        if (p2.statut === "a-traiter") batimentsAvecPassage2.push(b.id);

        const fusion = fusionnerLogements(p1.resultats, p2.resultats);
        fusion.forEach(l => rows.push({
          adresse: b.adresseRue, codePostal: b.codePostal, ville: b.ville, secteur: b.secteur,
          technicien: (p2.technicienNom || p1.technicienNom), nom: l.nom, numero: l.numero, etage: l.etage,
          statut: l.statut, niveauInfestation: l.niveauInfestation,
        }));
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const wb = buildReportWorkbook(ExcelJS, rows);
      const xlsxBuffer = await wb.xlsx.writeBuffer();

      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const basePath = `campagnes-reportings/${semaineId}`;
      const tokenZip = crypto.randomUUID();
      const zipPath = `${basePath}/rapports_2eme_passage_${Date.now()}.zip`;
      await bucket.file(zipPath).save(zipBuffer, { contentType: "application/zip", metadata: { metadata: { firebaseStorageDownloadTokens: tokenZip } } });
      const zipUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(zipPath)}?alt=media&token=${tokenZip}`;

      const tokenXlsx = crypto.randomUUID();
      const xlsxPath = `${basePath}/reporting_complet_${Date.now()}.xlsx`;
      await bucket.file(xlsxPath).save(Buffer.from(xlsxBuffer), { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", metadata: { metadata: { firebaseStorageDownloadTokens: tokenXlsx } } });
      const xlsxUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(xlsxPath)}?alt=media&token=${tokenXlsx}`;

      const nowIso = new Date().toISOString();
      if (batimentsAvecPassage2.length) {
        const batch = db.batch();
        batimentsAvecPassage2.forEach(id => batch.update(db.collection("campagnes-batiments").doc(id), { "passage2.statut": "archive", updatedAt: nowIso }));
        await batch.commit();
      }

      const recapId = `${semaineId}__complet_${Date.now()}`;
      await db.collection("campagnes-reportings-complet").doc(recapId).set({
        semaineId, zipUrl, xlsxUrl, nbBatiments: batiments.length, generatedAt: nowIso,
      });

      res.status(200).json({ zipUrl, xlsxUrl, nbBatiments: batiments.length });
    } catch(e) {
      console.error("generateCampagneRapportComplet:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ── CAMPAGNES : rapport consolidé de toute la campagne (toutes semaines) ──
// Agrège tous les bâtiments de la campagne (peu importe la semaine),
// applique la même fusion 1er/2ème passage par bâtiment, et regroupe tous
// les PDF dans un zip à 2 sous-dossiers "1er passage"/"2nd passage" (pas
// de déduplication : les deux passages y figurent quand ils existent).
exports.generateCampagneRapportConsolide = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId } = req.body || {};
    if (!campagneId) { res.status(400).json({ error: "campagneId requis" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const snap = await db.collection("campagnes-batiments").where("campagneId", "==", campagneId).get();
      if (snap.empty) { res.status(400).json({ error: "Aucun bâtiment pour cette campagne" }); return; }
      const batiments = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => (b.passage1 && b.passage1.resultats && b.passage1.resultats.length));
      if (!batiments.length) { res.status(400).json({ error: "Aucun rapport reçu pour cette campagne" }); return; }

      const JSZip = require("jszip");
      const ExcelJS = require("exceljs");
      const zip = new JSZip();
      const folder1 = zip.folder("1er passage");
      const folder2 = zip.folder("2nd passage");
      const rows = [];

      for (const b of batiments) {
        const p1 = b.passage1 || {};
        const p2 = b.passage2 || {};
        if (p1.fileUrlPdf) {
          try {
            const buf = await fetchBuffer(p1.fileUrlPdf);
            const nomFichier = `${(b.adresseRue || "adresse")}_passage_1.pdf`.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_");
            folder1.file(nomFichier, buf);
          } catch(e) { console.error(`generateCampagneRapportConsolide: PDF passage 1 illisible pour ${b.id}:`, e.message); }
        }
        if (p2.fileUrlPdf) {
          try {
            const buf = await fetchBuffer(p2.fileUrlPdf);
            const nomFichier = `${(b.adresseRue || "adresse")}_passage_2.pdf`.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_");
            folder2.file(nomFichier, buf);
          } catch(e) { console.error(`generateCampagneRapportConsolide: PDF passage 2 illisible pour ${b.id}:`, e.message); }
        }

        const fusion = fusionnerLogements(p1.resultats, p2.resultats);
        fusion.forEach(l => rows.push({
          adresse: b.adresseRue, codePostal: b.codePostal, ville: b.ville, secteur: b.secteur,
          technicien: (p2.technicienNom || p1.technicienNom), nom: l.nom, numero: l.numero, etage: l.etage,
          statut: l.statut, niveauInfestation: l.niveauInfestation,
        }));
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const wb = buildReportWorkbook(ExcelJS, rows);
      const xlsxBuffer = await wb.xlsx.writeBuffer();

      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const basePath = `campagnes-reportings/${campagneId}`;
      const tokenZip = crypto.randomUUID();
      const zipPath = `${basePath}/rapports_consolides_${Date.now()}.zip`;
      await bucket.file(zipPath).save(zipBuffer, { contentType: "application/zip", metadata: { metadata: { firebaseStorageDownloadTokens: tokenZip } } });
      const zipUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(zipPath)}?alt=media&token=${tokenZip}`;

      const tokenXlsx = crypto.randomUUID();
      const xlsxPath = `${basePath}/reporting_consolide_${Date.now()}.xlsx`;
      await bucket.file(xlsxPath).save(Buffer.from(xlsxBuffer), { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", metadata: { metadata: { firebaseStorageDownloadTokens: tokenXlsx } } });
      const xlsxUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(xlsxPath)}?alt=media&token=${tokenXlsx}`;

      const nowIso = new Date().toISOString();
      const recapId = `${campagneId}__consolide_${Date.now()}`;
      await db.collection("campagnes-reportings-consolide").doc(recapId).set({
        campagneId, zipUrl, xlsxUrl, nbBatiments: batiments.length, generatedAt: nowIso,
      });

      res.status(200).json({ zipUrl, xlsxUrl, nbBatiments: batiments.length });
    } catch(e) {
      console.error("generateCampagneRapportConsolide:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ── SUPPRESSION EN CASCADE (campagne / période) ─────────────────────
// Supprime les documents Firestore ET les fichiers Storage associés,
// contrairement à la suppression simple côté app (qui ne retirait que le
// document racine, laissant tout le reste orphelin).
async function deleteQueryDocs(db, query) {
  const snap = await query.get();
  let n = 0;
  let batch = db.batch();
  for (const d of snap.docs) {
    batch.delete(d.ref);
    n++;
    if (n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  if (n % 400 !== 0) await batch.commit();
  return n;
}
async function deleteStoragePrefix(bucket, prefix) {
  try {
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map(f => f.delete().catch(() => {})));
    return files.length;
  } catch(e) { console.error(`deleteStoragePrefix (${prefix}):`, e.message); return 0; }
}
// Extrait le chemin Storage d'une URL de téléchargement Firebase
// (".../o/<chemin-encodé>?alt=media&token=..."). Retourne null si non reconnue.
function storagePathFromDownloadUrl(url) {
  const m = String(url || "").match(/\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function deleteStorageFileFromUrl(bucket, url) {
  const path = storagePathFromDownloadUrl(url);
  if (!path) return 0;
  try { await bucket.file(path).delete(); return 1; }
  catch(e) { console.error(`deleteStorageFileFromUrl (${path}):`, e.message); return 0; }
}

exports.deleteCampagneCascade = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId } = req.body || {};
    if (!campagneId) { res.status(400).json({ error: "campagneId requis" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");

      const semainesSnap = await db.collection("campagnes-semaines").where("campagneId", "==", campagneId).get();
      const semaineIds = semainesSnap.docs.map(d => d.id);
      const dernierFichierUrls = semainesSnap.docs
        .map(d => d.data().config && d.data().config.dernierFichier && d.data().config.dernierFichier.url)
        .filter(Boolean);

      const nbBatiments = await deleteQueryDocs(db, db.collection("campagnes-batiments").where("campagneId", "==", campagneId));
      let nbReportingsSemaine = 0;
      for (const sid of semaineIds) {
        nbReportingsSemaine += await deleteQueryDocs(db, db.collection("campagnes-reportings-semaine").where("semaineId", "==", sid));
        nbReportingsSemaine += await deleteQueryDocs(db, db.collection("campagnes-reportings-complet").where("semaineId", "==", sid));
      }
      const nbConsolide = await deleteQueryDocs(db, db.collection("campagnes-reportings-consolide").where("campagneId", "==", campagneId));
      const nbDocsGeneres = await deleteQueryDocs(db, db.collection("campagnes-documents-generes").where("campagneId", "==", campagneId));
      const nbSemaines = await deleteQueryDocs(db, db.collection("campagnes-semaines").where("campagneId", "==", campagneId));

      let nbFichiers = 0;
      nbFichiers += await deleteStoragePrefix(bucket, `campagnes-documents/${campagneId}/`);
      nbFichiers += await deleteStoragePrefix(bucket, `campagnes-templates/${campagneId}/`);
      nbFichiers += await deleteStoragePrefix(bucket, `campagnes-reportings/${campagneId}/`);
      for (const sid of semaineIds) {
        nbFichiers += await deleteStoragePrefix(bucket, `campagnes-reportings/${sid}/`);
        nbFichiers += await deleteStoragePrefix(bucket, `campagnes-reception/${sid}/`);
      }
      // Fichiers Excel du push 1er passage (push-campagne/...), retrouvés via les URLs
      // mémorisées sur chaque période (config.dernierFichier).
      for (const url of dernierFichierUrls) {
        nbFichiers += await deleteStorageFileFromUrl(bucket, url);
      }

      await db.collection("gestion-campagnes").doc(campagneId).delete();

      console.log(`deleteCampagneCascade: campagne ${campagneId} -> ${nbSemaines} période(s), ${nbBatiments} bâtiment(s), ${nbReportingsSemaine + nbConsolide} recap(s), ${nbDocsGeneres} doc(s) générés, ${nbFichiers} fichier(s) Storage`);
      res.status(200).json({ success: true, nbSemaines, nbBatiments, nbFichiers });
    } catch(e) {
      console.error("deleteCampagneCascade:", e);
      res.status(500).json({ error: e.message });
    }
  });

exports.deleteSemaineCascade = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { semaineId } = req.body || {};
    if (!semaineId) { res.status(400).json({ error: "semaineId requis" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");

      const semaineSnap = await db.collection("campagnes-semaines").doc(semaineId).get();
      const semaineData = semaineSnap.exists ? semaineSnap.data() : {};
      const campagneId = semaineData.campagneId || null;

      const nbBatiments = await deleteQueryDocs(db, db.collection("campagnes-batiments").where("semaineId", "==", semaineId));
      const nbRecaps = (await deleteQueryDocs(db, db.collection("campagnes-reportings-semaine").where("semaineId", "==", semaineId)))
        + (await deleteQueryDocs(db, db.collection("campagnes-reportings-complet").where("semaineId", "==", semaineId)));

      let nbFichiers = 0;
      nbFichiers += await deleteStoragePrefix(bucket, `campagnes-reportings/${semaineId}/`);
      nbFichiers += await deleteStoragePrefix(bucket, `campagnes-reception/${semaineId}/`);
      if (campagneId) nbFichiers += await deleteStoragePrefix(bucket, `campagnes-documents/${campagneId}/planning-passage2/${semaineId}`);
      // Fichier Excel du push 1er passage (push-campagne/...), retrouvé via l'URL mémorisée
      // sur la période (config.dernierFichier) : chemin non déductible autrement.
      const dernierFichierUrl = semaineData.config && semaineData.config.dernierFichier && semaineData.config.dernierFichier.url;
      if (dernierFichierUrl) nbFichiers += await deleteStorageFileFromUrl(bucket, dernierFichierUrl);

      await db.collection("campagnes-semaines").doc(semaineId).delete();

      console.log(`deleteSemaineCascade: période ${semaineId} -> ${nbBatiments} bâtiment(s), ${nbRecaps} recap(s), ${nbFichiers} fichier(s) Storage`);
      res.status(200).json({ success: true, nbBatiments, nbFichiers });
    } catch(e) {
      console.error("deleteSemaineCascade:", e);
      res.status(500).json({ error: e.message });
    }
  });

exports.generateGarantieRapportsParClient = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { semaineId } = req.body || {};
    if (!semaineId) { res.status(400).json({ error: "semaineId requis" }); return; }

    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const semaineSnap = await db.collection("garanties-semaines").doc(semaineId).get();
    if (!semaineSnap.exists) { res.status(404).json({ error: "Semaine introuvable" }); return; }
    const semaine = semaineSnap.data();

    const rapportsSnap = await db.collection("garanties-rapports")
      .where("semaineId", "==", semaineId).where("statut", "==", "a-traiter").get();
    const rapports = rapportsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!rapports.length) { res.status(400).json({ error: "Aucun rapport \"à traiter\" pour cette semaine" }); return; }

    const byClient = {};
    rapports.forEach(r => { const c = r.client || "_inconnu"; (byClient[c] = byClient[c] || []).push(r); });

    const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
    const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
    const periode = `${fmtDateFR(semaine.dateDebut)} au ${fmtDateFR(semaine.dateFin)}`;
    const results = [];

    for (const client of Object.keys(byClient)) {
      const rapportsClient = byClient[client];
      try {
        const merged = await PDFDocument.create();
        const font = await merged.embedFont(StandardFonts.HelveticaBold);

        const cover = merged.addPage([595.28, 841.89]); // A4
        const title = "Rapport de garantie traitement blattes";
        const lignes = [title, `Période : ${periode}`, client];
        let y = 500;
        lignes.forEach((ligne, i) => {
          const size = i === 0 ? 20 : 14;
          const textWidth = font.widthOfTextAtSize(ligne, size);
          cover.drawText(ligne, { x: (595.28 - textWidth) / 2, y, size, font, color: rgb(0, 0, 0) });
          y -= size + 16;
        });

        for (const r of rapportsClient) {
          if (!r.fileUrl) continue;
          try {
            const buf = await fetchBuffer(r.fileUrl);
            const srcPdf = await PDFDocument.load(buf);
            const pages = await merged.copyPages(srcPdf, srcPdf.getPageIndices());
            pages.forEach(p => merged.addPage(p));
          } catch(e) {
            console.error(`generateGarantieRapportsParClient: rapport ${r.id} illisible:`, e.message);
          }
        }

        const mergedBytes = await merged.save();
        const clientSafe = client.replace(/[^a-zA-Z0-9_-]/g, "_");
        const nomFichier = `Garantie_${clientSafe}_${semaine.dateDebut}_au_${semaine.dateFin}.pdf`.replace(/[^a-zA-Z0-9_.-]/g, "_");
        const storagePath = `garanties-agreges/${semaineId}/${nomFichier}`;
        const downloadToken = crypto.randomUUID();
        await bucket.file(storagePath).save(Buffer.from(mergedBytes), {
          contentType: "application/pdf",
          metadata: {
            contentDisposition: `inline; filename="${nomFichier}"`,
            metadata: { firebaseStorageDownloadTokens: downloadToken },
          },
        });
        const fileUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(storagePath)}?alt=media&token=${downloadToken}`;

        const now = new Date().toISOString();
        const aggDocId = `${semaineId}__${clientSafe}`;
        await db.collection("garanties-rapports-agreges").doc(aggDocId).set({
          semaineId, client, fileUrl, storagePath, nomFichier,
          nbRapports: rapportsClient.length,
          periode,
          generatedAt: now, updatedAt: now,
        });

        const batch = db.batch();
        rapportsClient.forEach(r => batch.update(db.collection("garanties-rapports").doc(r.id), { statut: "archive", updatedAt: now }));
        await batch.commit();

        results.push({ client, nbRapports: rapportsClient.length, fileUrl });
      } catch(e) {
        console.error(`generateGarantieRapportsParClient: échec pour client ${client}:`, e.message);
        results.push({ client, error: e.message });
      }
    }

    res.status(200).json({ results });
  });

function fmtDateFR(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-");
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

// ── CAMPAGNES : utilitaires de parsing de l'export Excel ───────────
// Regroupe l'export Excel client par bâtiment (secteur/adresse/logements).

function nettoyerNombre(valeur) {
  if (valeur === null || valeur === undefined || valeur === "") return "";
  const f = Number(valeur);
  if (!Number.isNaN(f) && String(valeur).trim() !== "") return String(f);
  return String(valeur).trim();
}

function formaterSecteur(secteurBrut) {
  if (!secteurBrut) return "";
  const secteur = String(secteurBrut).trim();
  const match = secteur.match(/(Secteur\s+\d+\s+(?:TMR|TPC))/i);
  if (match) return match[1];
  const parts = secteur.split(/\s+/);
  if (parts.length >= 3) {
    for (let i = 0; i < parts.length; i++) {
      if (["TMR", "TPC"].includes(parts[i].toUpperCase())) return parts.slice(0, i + 1).join(" ");
    }
  }
  return secteur;
}

function extraire4DerniersChiffres(ref) {
  if (!ref) return "";
  const refClean = String(ref).replace(/-/g, "").replace(/\s/g, "");
  return refClean.length >= 4 ? refClean.slice(-4) : refClean;
}

function cellStr(row, idx) {
  if (idx === null || idx === undefined || Number.isNaN(idx)) return "";
  const cell = row.getCell(idx + 1); // ExcelJS 1-indexé
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v.result !== undefined) return String(v.result).trim(); // formule
  if (typeof v === "object" && v.text !== undefined) return String(v.text).trim(); // rich text
  return String(v).trim();
}

// ── CAMPAGNES : PUSH 1ER PASSAGE — ENVOI DIRECT VIA L'API KIZEO ────
// Pousse un enregistrement par bâtiment directement sur l'app Kizeo du
// technicien (recipient_user_id = kizeoUserId déjà lié sur sa fiche
// technicien). Format du champ liste "tableau" (subform) et "adresse_*"
// (address) vérifiés empiriquement (la doc
// officielle Kizeo ne documente pas le format d'écriture des subforms).
exports.pushCampagnePassage1Kizeo = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN], timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { storagePath, envois, semaineId } = req.body || {};
    if (!storagePath) { res.status(400).json({ error: "storagePath requis" }); return; }
    if (!Array.isArray(envois) || !envois.length) { res.status(400).json({ error: "envois requis (au moins un couple feuille + technicien)" }); return; }
    for (const e of envois) {
      if (!e || !String(e.nomFeuille || "").trim() || !String(e.destinataireKizeoUserId || "").trim()) {
        res.status(400).json({ error: "Chaque envoi doit avoir une feuille ET un technicien" }); return;
      }
    }
    if (!semaineId) { res.status(400).json({ error: "semaineId requis" }); return; }

    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const semaineSnap = await db.collection("campagnes-semaines").doc(semaineId).get();
    if (!semaineSnap.exists) { res.status(404).json({ error: "Semaine introuvable" }); return; }
    const semaine = semaineSnap.data();
    const campagneId = semaine.campagneId;
    const campagneSnap = await db.collection("gestion-campagnes").doc(campagneId).get();
    if (!campagneSnap.exists) { res.status(404).json({ error: "Campagne introuvable" }); return; }
    const kizeoFormId = campagneSnap.data().kizeoFormId1;
    if (!kizeoFormId) { res.status(400).json({ error: "ID du formulaire Kizeo 1er passage non configuré pour cette campagne" }); return; }
    const config = semaine.config || {};
    const colonnes = config.colonnes || {};

    try {
      const ExcelJS = require("exceljs");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [buffer] = await bucket.file(storagePath).download();

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const dateHeure = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

      const results = [];
      let totalBatiments = 0;

      for (const envoi of envois) {
        const nomFeuille = String(envoi.nomFeuille).trim();
        const recipient = String(envoi.destinataireKizeoUserId).trim();

        const ws = workbook.getWorksheet(nomFeuille);
        if (!ws) {
          const dispo = workbook.worksheets.map(s => s.name).join(", ");
          results.push({ nomFeuille, success: false, error: `Feuille introuvable. Feuilles disponibles : ${dispo}` });
          continue;
        }

        // Nom affiché sur la fiche Kizeo : celui du technicien réellement sélectionné
        // dans l'app (fiche Techniciens), pas le nom brut de la colonne Excel.
        let technicienNom = "";
        try {
          const tSnap = await db.collection("techniciens").where("kizeoUserId", "==", recipient).limit(1).get();
          if (!tSnap.empty) {
            const t = tSnap.docs[0].data();
            technicienNom = t.nomComplet || `${t.prenom || ""} ${t.nom || ""}`.trim();
          }
        } catch(e) { console.error("pushCampagnePassage1Kizeo: lookup technicien échoué:", e.message); }

        const batiments = new Map();
        ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowNumber === 1) return;
          try {
            const secteurBrut = cellStr(row, colonnes.secteur);
            const numeroRue = nettoyerNombre(cellStr(row, colonnes.numeroRue));
            const nomRue = cellStr(row, colonnes.nomRue);
            const codePostal = nettoyerNombre(cellStr(row, colonnes.codePostal));
            const ville = cellStr(row, colonnes.ville);
            if (!nomRue) return;
            const secteur = formaterSecteur(secteurBrut);
            const adresseRue = `${numeroRue} ${nomRue}`.trim();
            const cle = `${secteur}|${numeroRue}|${nomRue}|${codePostal}|${ville}`;
            const nomLocataire = cellStr(row, colonnes.locataire);
            const reference = cellStr(row, colonnes.referenceLogement);
            const etage = cellStr(row, colonnes.etage);
            const numeroCourt = extraire4DerniersChiffres(reference);

            if (!batiments.has(cle)) {
              batiments.set(cle, { secteur, adresse_rue: adresseRue, code_postal: codePostal, ville, logements: [] });
            }
            batiments.get(cle).logements.push({ nom: nomLocataire, numero: numeroCourt, etage });
          } catch (e) { /* ligne ignorée, cohérent avec le script Python */ }
        });

        if (batiments.size === 0) {
          results.push({ nomFeuille, technicien: technicienNom, success: false, error: "Aucune donnée trouvée dans cette feuille" });
          continue;
        }
        totalBatiments += batiments.size;

        for (const data of batiments.values()) {
          const batimentRef = db.collection("campagnes-batiments").doc();
          const refInterne = `campagne::${semaineId}::1::${batimentRef.id}`;
          const fields = {
            ref_interne: { value: refInterne },
            secteur: { value: data.secteur },
            technicien: { value: technicienNom },
            passage: { value: "N°1" },
            adresse_address: { value: data.adresse_rue },
            adresse_zip: { value: data.code_postal },
            adresse_city: { value: data.ville },
            date_et_heure_1er_passage: { value: dateHeure },
            tableau: {
              value: data.logements.map(log => ({
                nom: { value: log.nom },
                numero_logement: { value: log.numero },
                etage: { value: log.etage },
              })),
            },
          };
          const r = await kizeoRequest(KIZEO_API_TOKEN.value(), "POST", `/forms/${encodeURIComponent(kizeoFormId)}/push`, {
            recipient_user_id: Number(recipient),
            fields,
          });
          if (r.status >= 200 && r.status < 300) {
            let dataId = null;
            try { dataId = JSON.parse(r.body).data.data_id; } catch(e) {}
            const nowIso = new Date().toISOString();
            await batimentRef.set({
              campagneId,
              semaineId,
              secteur: data.secteur,
              adresseRue: data.adresse_rue,
              codePostal: data.code_postal,
              ville: data.ville,
              passage1: {
                technicienKizeoUserId: recipient,
                technicienNom,
                logements: data.logements,
                statut: "en-attente",
                kizeoDataId: dataId ? String(dataId) : null,
                pushedAt: nowIso,
              },
              createdAt: nowIso,
              updatedAt: nowIso,
            });
            results.push({ nomFeuille, adresse: data.adresse_rue, technicien: technicienNom, success: true, dataId, batimentId: batimentRef.id });
          } else {
            results.push({ nomFeuille, adresse: data.adresse_rue, technicien: technicienNom, success: false, error: `Kizeo a répondu ${r.status}` });
          }
        }
      }

      const nbEnvoyes = results.filter(r => r.success).length;
      const nbErreurs = results.length - nbEnvoyes;
      console.log(`pushCampagnePassage1Kizeo: ${nbEnvoyes} envoyés, ${nbErreurs} erreurs sur ${results.length} bâtiments, ${envois.length} feuille(s)`);
      res.status(200).json({ results, nbEnvoyes, nbErreurs, nbBatiments: totalBatiments });
    } catch (e) {
      console.error("pushCampagnePassage1Kizeo:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ── RENVOI D'UN FORMULAIRE 1ER PASSAGE (campagne) — reprend les données déjà
// stockées sur le bâtiment (mêmes logements, secteur, adresse, technicien) et
// pousse un nouveau formulaire Kizeo. L'ancien envoi n'est pas supprimé côté
// Kizeo (à faire manuellement dans l'interface), seul kizeoDataId est mis à jour.
exports.resendCampagnePassage1Kizeo = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN], timeoutSeconds: 60 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { batimentId } = req.body || {};
    if (!batimentId) { res.status(400).json({ error: "batimentId requis" }); return; }

    const { getFirestore } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const batimentSnap = await db.collection("campagnes-batiments").doc(batimentId).get();
    if (!batimentSnap.exists) { res.status(404).json({ error: "Bâtiment introuvable" }); return; }
    const batiment = batimentSnap.data();
    const p1 = batiment.passage1;
    if (!p1) { res.status(400).json({ error: "Aucun 1er passage enregistré pour ce bâtiment" }); return; }

    const campagneSnap = await db.collection("gestion-campagnes").doc(batiment.campagneId).get();
    if (!campagneSnap.exists) { res.status(404).json({ error: "Campagne introuvable" }); return; }
    const kizeoFormId = campagneSnap.data().kizeoFormId1;
    if (!kizeoFormId) { res.status(400).json({ error: "ID du formulaire Kizeo 1er passage non configuré pour cette campagne" }); return; }

    try {
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const dateHeure = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const refInterne = `campagne::${batiment.semaineId}::1::${batimentId}`;

      // Reprend la soumission précédente TELLE QUELLE (mêmes clés/formats que Kizeo
      // a lui-même renvoyés) plutôt que de reconstruire le tableau à la main : évite
      // de mal deviner le format attendu pour les champs liste/choix multiple.
      const fields = {};
      if (p1.kizeoDataId) {
        try {
          const prev = await kizeoRequest(KIZEO_API_TOKEN.value(), "GET", `/forms/${encodeURIComponent(kizeoFormId)}/data/${encodeURIComponent(p1.kizeoDataId)}`);
          if (prev.status === 200) {
            const prevParsed = JSON.parse(prev.body);
            const prevFields = (prevParsed.data || prevParsed).fields || {};
            const SKIP_TYPES = new Set(["section", "photo", "image", "signature", "video", "audio", "drawing", "barcode", "gps"]);
            Object.keys(prevFields).forEach(fid => {
              const f = prevFields[fid];
              if (!f || SKIP_TYPES.has(f.type) || f.value === undefined || f.value === "") return;
              fields[fid] = { value: f.value };
            });
          }
        } catch(e) { console.error("resendCampagnePassage1Kizeo: reprise soumission précédente échouée:", e.message); }
      }
      // Formulaire jamais répondu (ou reprise échouée) : tableau vierge d'origine.
      if (!fields.tableau) {
        fields.tableau = {
          value: (p1.logements || []).map(log => ({
            nom: { value: log.nom },
            numero_logement: { value: log.numero },
            etage: { value: log.etage },
          })),
        };
      }
      // Les champs pilotés par l'app priment sur ce qui a été repris.
      Object.assign(fields, {
        ref_interne: { value: refInterne },
        secteur: { value: batiment.secteur || "" },
        technicien: { value: p1.technicienNom || "" },
        passage: { value: "N°1" },
        adresse_address: { value: batiment.adresseRue || "" },
        adresse_zip: { value: batiment.codePostal || "" },
        adresse_city: { value: batiment.ville || "" },
        date_et_heure_1er_passage: { value: dateHeure },
      });
      const r = await kizeoRequest(KIZEO_API_TOKEN.value(), "POST", `/forms/${encodeURIComponent(kizeoFormId)}/push`, {
        recipient_user_id: Number(p1.technicienKizeoUserId),
        fields,
      });
      if (r.status < 200 || r.status >= 300) {
        console.error("resendCampagnePassage1Kizeo: push échoué", r.status, (r.body || r.error || "").slice(0, 1000), "fields envoyés:", JSON.stringify(fields).slice(0, 1000));
        res.status(502).json({ error: `Kizeo a répondu ${r.status}`, detail: (r.body || "").slice(0, 300) });
        return;
      }
      let dataId = null;
      try { dataId = JSON.parse(r.body).data.data_id; } catch(e) {}
      const nowIso = new Date().toISOString();
      await batimentSnap.ref.set({
        passage1: { ...p1, statut: "en-attente", kizeoDataId: dataId ? String(dataId) : null, pushedAt: nowIso },
        updatedAt: nowIso,
      }, { merge: true });
      res.status(200).json({ ok: true, dataId });
    } catch (e) {
      console.error("resendCampagnePassage1Kizeo:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ── PUSH CAMPAGNE 2ÈME PASSAGE — ENVOI DIRECT VIA L'API KIZEO ───────
// Reprend, pour chaque bâtiment sélectionné, uniquement les logements
// marqués "Absent" au 1er passage (passage1.resultats), et pousse un
// nouveau formulaire (form 2ème passage) vers le technicien choisi.
exports.pushCampagnePassage2Kizeo = functions
  .region("europe-west1")
  .runWith({ secrets: [KIZEO_API_TOKEN], timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { semaineId, envois } = req.body || {};
    if (!semaineId) { res.status(400).json({ error: "semaineId requis" }); return; }
    if (!Array.isArray(envois) || !envois.length) { res.status(400).json({ error: "envois requis (batimentId + destinataireKizeoUserId)" }); return; }
    for (const e of envois) {
      if (!e || !e.batimentId || !String(e.destinataireKizeoUserId || "").trim()) {
        res.status(400).json({ error: "Chaque envoi doit avoir un batimentId ET un destinataireKizeoUserId" }); return;
      }
    }

    const { getFirestore, FieldValue } = require("firebase-admin/firestore");
    const db = getFirestore(admin.app(), "belledonne-client");
    const semaineSnap = await db.collection("campagnes-semaines").doc(semaineId).get();
    if (!semaineSnap.exists) { res.status(404).json({ error: "Semaine introuvable" }); return; }
    const campagneSnap = await db.collection("gestion-campagnes").doc(semaineSnap.data().campagneId).get();
    if (!campagneSnap.exists) { res.status(404).json({ error: "Campagne introuvable" }); return; }
    const kizeoFormId2 = campagneSnap.data().kizeoFormId2;
    if (!kizeoFormId2) { res.status(400).json({ error: "ID du formulaire Kizeo 2ème passage non configuré pour cette campagne" }); return; }

    // Cache des noms techniciens (un envoi peut réutiliser le même destinataire).
    const nomsTechniciens = new Map();
    async function nomTechnicien(kizeoUserId) {
      if (nomsTechniciens.has(kizeoUserId)) return nomsTechniciens.get(kizeoUserId);
      let nom = "";
      try {
        const tSnap = await db.collection("techniciens").where("kizeoUserId", "==", kizeoUserId).limit(1).get();
        if (!tSnap.empty) {
          const t = tSnap.docs[0].data();
          nom = t.nomComplet || `${t.prenom || ""} ${t.nom || ""}`.trim();
        }
      } catch(e) { console.error("pushCampagnePassage2Kizeo: lookup technicien échoué:", e.message); }
      nomsTechniciens.set(kizeoUserId, nom);
      return nom;
    }

    const now2 = new Date();
    const pad2 = n => String(n).padStart(2, "0");
    const dateHeure2 = `${now2.getFullYear()}-${pad2(now2.getMonth() + 1)}-${pad2(now2.getDate())} ${pad2(now2.getHours())}:${pad2(now2.getMinutes())}`;

    const results2 = [];
    for (const envoi of envois) {
      const batimentId = String(envoi.batimentId);
      const recipient2 = String(envoi.destinataireKizeoUserId).trim();
      try {
        const bRef = db.collection("campagnes-batiments").doc(batimentId);
        const bSnap = await bRef.get();
        if (!bSnap.exists) { results2.push({ batimentId, success: false, error: "Bâtiment introuvable" }); continue; }
        const b = bSnap.data();
        if (b.semaineId !== semaineId) { results2.push({ batimentId, success: false, error: "Bâtiment hors semaine" }); continue; }
        const resultats1 = (b.passage1 && b.passage1.resultats) || [];
        const absents = resultats1.filter(l => l.statut === "Absent").map(l => ({ nom: l.nom, numero: l.numero, etage: l.etage }));
        if (!absents.length) { results2.push({ batimentId, adresse: b.adresseRue, success: false, error: "Aucun absent, rien à repasser" }); continue; }

        const technicienNom2 = await nomTechnicien(recipient2);
        const refInterne2 = `campagne::${semaineId}::2::${batimentId}`;
        const fields2 = {
          ref_interne: { value: refInterne2 },
          secteur: { value: b.secteur || "" },
          technicien: { value: technicienNom2 },
          passage: { value: "N°2" },
          adresse_address: { value: b.adresseRue || "" },
          adresse_zip: { value: b.codePostal || "" },
          adresse_city: { value: b.ville || "" },
          date_et_heure_2nd_passage: { value: dateHeure2 },
          tableau: {
            value: absents.map(log => ({
              nom: { value: log.nom },
              numero_logement: { value: log.numero },
              etage: { value: log.etage },
            })),
          },
        };
        const r = await kizeoRequest(KIZEO_API_TOKEN.value(), "POST", `/forms/${encodeURIComponent(kizeoFormId2)}/push`, {
          recipient_user_id: Number(recipient2),
          fields: fields2,
        });
        if (r.status >= 200 && r.status < 300) {
          let dataId2 = null;
          try { dataId2 = JSON.parse(r.body).data.data_id; } catch(e) {}
          const nowIso2 = new Date().toISOString();
          await bRef.set({
            passage2: {
              technicienKizeoUserId: recipient2,
              technicienNom: technicienNom2,
              logements: absents,
              statut: "en-attente",
              kizeoDataId: dataId2 ? String(dataId2) : null,
              pushedAt: nowIso2,
              // Efface les éventuelles réponses/PDF d'un envoi précédent (ex: renvoi
              // à un autre technicien après une 1ère réception) plutôt que de les
              // laisser traîner en attendant d'être écrasées par la prochaine réception.
              resultats: FieldValue.delete(),
              fileUrlPdf: FieldValue.delete(),
              fileUrlExcel: FieldValue.delete(),
              receivedAt: FieldValue.delete(),
            },
            updatedAt: nowIso2,
          }, { merge: true });
          results2.push({ batimentId, adresse: b.adresseRue, technicien: technicienNom2, nbAbsents: absents.length, success: true, dataId: dataId2 });
        } else {
          results2.push({ batimentId, adresse: b.adresseRue, success: false, error: `Kizeo a répondu ${r.status}` });
        }
      } catch(e) {
        console.error(`pushCampagnePassage2Kizeo: échec bâtiment ${batimentId}:`, e.message);
        results2.push({ batimentId, success: false, error: e.message });
      }
    }

    const nbEnvoyes2 = results2.filter(r => r.success).length;
    const nbErreurs2 = results2.length - nbEnvoyes2;
    console.log(`pushCampagnePassage2Kizeo: ${nbEnvoyes2} envoyés, ${nbErreurs2} erreurs/ignorés sur ${results2.length} bâtiments`);
    res.status(200).json({ results: results2, nbEnvoyes: nbEnvoyes2, nbErreurs: nbErreurs2 });
  });

// ══════════════════════════════════════════════════════════════════
// GESTION DOCUMENTATION (campagnes) : lecture du planning source (format
// fixe "Planning_Desinsectisation" : en-têtes ligne 4, données à partir
// de la ligne 5, colonnes A=Jour B=Date1 C=Heure1 D=Tech E=Adresse
// F=NbLogements G=Remarque H=Date2 I=Heure2) + génération de documents
// à partir de templates bundlés dans functions/templates/.
// ══════════════════════════════════════════════════════════════════

// Lit le fichier source et retourne une ligne par ligne de données (pas
// de déduplication par adresse : certaines adresses sont scindées entre
// plusieurs techniciens, on garde l'ordre et le contenu bruts du fichier).
function lirePlanningSource(ws) {
  const lignes = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < 5) return;
    const adresse = String(row.getCell(5).value || "").trim();
    if (!adresse || adresse.toUpperCase() === "LIBRE") return;
    lignes.push({
      jour: row.getCell(1).value,
      date1: String(row.getCell(2).value || "").trim(),
      heure1: String(row.getCell(3).value || "").trim(),
      tech: String(row.getCell(4).value || "").trim(),
      adresse,
      nbLogements: Number(row.getCell(6).value) || 0,
      remarque: String(row.getCell(7).value || "").trim(),
      date2: String(row.getCell(8).value || "").trim(),
      heure2: String(row.getCell(9).value || "").trim(),
    });
  });
  return lignes;
}

// "08H00 - 16H00" -> "Lundi 19 octobre 2026 - 08H00 entre 16H00"
// (le mot "entre" remplace le tiret entre les deux horaires, pas entre la date et l'horaire)
function formaterDateHeure2ndPassage(date2, heure2) {
  if (!date2) return "";
  const parts = String(heure2 || "").split(" - ");
  const heureTxt = parts.length === 2 ? `${parts[0]} entre ${parts[1]}` : (heure2 || "");
  return heureTxt ? `${date2} - ${heureTxt}` : date2;
}

function sanitizeNomFichier(nom) {
  return String(nom || "").replace(/[^a-zA-Z0-9\-_ àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇ]/g, "_").trim() || "document";
}

// Force le nom de fichier via l'en-tête HTTP (fonctionne sur un lien direct,
// contrairement à l'attribut HTML "download" que Safari ignore sur les URLs
// cross-origin). asciiName = repli sans accents pour les vieux clients.
function contentDispositionHeader(fileName) {
  const asciiName = fileName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

exports.campagneGenererPlanningClient = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId, storagePath, nom, templateStoragePath } = req.body || {};
    if (!campagneId || !storagePath || !nom) { res.status(400).json({ error: "campagneId, storagePath et nom requis" }); return; }

    try {
      const ExcelJS = require("exceljs");
      const path = require("path");
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [buffer] = await bucket.file(storagePath).download();

      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.load(buffer);
      const srcWs = srcWb.worksheets[0];
      if (!srcWs) { res.status(400).json({ error: "Feuille source introuvable" }); return; }

      const toutesLignes = lirePlanningSource(srcWs);
      if (!toutesLignes.length) { res.status(400).json({ error: "Aucune adresse trouvée dans le fichier source" }); return; }
      // Une adresse peut être scindée entre plusieurs techniciens (même horaire) :
      // on ne garde que la 1ère occurrence par adresse, dans l'ordre du fichier.
      const vues = new Set();
      const lignes = toutesLignes.filter(l => {
        if (vues.has(l.adresse)) return false;
        vues.add(l.adresse);
        return true;
      });

      const wb = new ExcelJS.Workbook();
      if (templateStoragePath) {
        const [tplBuffer] = await bucket.file(templateStoragePath).download();
        await wb.xlsx.load(tplBuffer);
      } else {
        const tplPath = path.join(__dirname, "templates", "Template-Planning-client.xlsx");
        await wb.xlsx.readFile(tplPath);
      }
      const ws = wb.worksheets[0];

      // Localise les placeholders où qu'ils soient dans le fichier (le template
      // peut varier d'un client à l'autre) plutôt que de supposer une position fixe.
      const placeholders = {}; // "##adresse" -> {row, col}
      ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const v = String(cell.value || "").trim().toLowerCase();
          if (v.startsWith("##")) placeholders[v] = { row: rowNumber, col: colNumber };
        });
      });
      const pNomFichier = placeholders["##nom-fichier"];
      const pAdresse = placeholders["##adresse"];
      const p1erPassage = placeholders["##1er-passage"];
      const p2ndPassage = placeholders["##2nd-passage"];
      if (!pAdresse || !p1erPassage || !p2ndPassage) {
        res.status(400).json({ error: "Template invalide : placeholders ##Adresse / ##1er-passage / ##2nd-passage introuvables" });
        return;
      }
      if (pNomFichier) ws.getRow(pNomFichier.row).getCell(pNomFichier.col).value = nom;

      const modelRowNumber = pAdresse.row;
      const modelStyles = {
        adresse: ws.getRow(modelRowNumber).getCell(pAdresse.col).style,
        p1: ws.getRow(modelRowNumber).getCell(p1erPassage.col).style,
        p2: ws.getRow(modelRowNumber).getCell(p2ndPassage.col).style,
      };

      lignes.forEach((l, i) => {
        const r = ws.getRow(modelRowNumber + i);
        r.getCell(pAdresse.col).value = l.adresse;
        r.getCell(pAdresse.col).style = modelStyles.adresse;
        r.getCell(p1erPassage.col).value = l.date1 ? `${l.date1} - ${l.heure1}` : "";
        r.getCell(p1erPassage.col).style = modelStyles.p1;
        r.getCell(p2ndPassage.col).value = l.date2 ? `${l.date2} - ${l.heure2}` : "";
        r.getCell(p2ndPassage.col).style = modelStyles.p2;
        r.commit();
      });

      const outBuffer = await wb.xlsx.writeBuffer();
      const safeNom = sanitizeNomFichier(nom);
      // Chemin/ID fixes (pas d'horodatage) : une régénération écrase le fichier
      // précédent au lieu d'en accumuler un nouveau à chaque clic.
      const outPath = `campagnes-documents/${campagneId}/planning-client/planning-client.xlsx`;
      const token = crypto.randomUUID();
      const outFileName = `${safeNom}.xlsx`;
      await bucket.file(outPath).save(Buffer.from(outBuffer), {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        metadata: {
          contentDisposition: contentDispositionHeader(outFileName),
          metadata: { firebaseStorageDownloadTokens: token },
        },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outPath)}?alt=media&token=${token}`;

      const nowIso = new Date().toISOString();
      await db.collection("campagnes-documents-generes").doc(`${campagneId}__planning-client`).set({
        campagneId, type: "planning-client", fileName: outFileName, url, storagePath: outPath,
        nbAdresses: lignes.length, createdAt: nowIso,
      });

      res.status(200).json({ success: true, url, nbAdresses: lignes.length, fileName: outFileName });
    } catch(e) {
      console.error("campagneGenererPlanningClient:", e);
      res.status(500).json({ error: e.message });
    }
  });

// Repère les placeholders "##..." où qu'ils soient dans la feuille (position libre,
// le template peut varier). Retourne { "##xxx": {row, col} }.
function trouverPlaceholders(ws) {
  const placeholders = {};
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const v = String(cell.value || "").trim().toLowerCase();
      if (v.startsWith("##")) placeholders[v] = { row: rowNumber, col: colNumber };
    });
  });
  return placeholders;
}

exports.campagneGenererPlanningTechnicien = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId, storagePath, templateStoragePath } = req.body || {};
    if (!campagneId || !storagePath) { res.status(400).json({ error: "campagneId et storagePath requis" }); return; }

    try {
      const ExcelJS = require("exceljs");
      const path = require("path");
      const fs = require("fs");
      const JSZip = require("jszip");
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [buffer] = await bucket.file(storagePath).download();

      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.load(buffer);
      const srcWs = srcWb.worksheets[0];
      if (!srcWs) { res.status(400).json({ error: "Feuille source introuvable" }); return; }

      const toutesLignes = lirePlanningSource(srcWs);
      if (!toutesLignes.length) { res.status(400).json({ error: "Aucune adresse trouvée dans le fichier source" }); return; }

      // Regroupe par technicien puis par jour, dans l'ordre d'apparition du fichier.
      const parTech = new Map();
      const ordreTech = [];
      toutesLignes.forEach(l => {
        const tech = l.tech || "Sans technicien";
        if (!parTech.has(tech)) { parTech.set(tech, new Map()); ordreTech.push(tech); }
        const jours = parTech.get(tech);
        if (!jours.has(l.date1)) jours.set(l.date1, []);
        jours.get(l.date1).push(l);
      });

      let templateBuffer;
      if (templateStoragePath) {
        const [tplBuffer] = await bucket.file(templateStoragePath).download();
        templateBuffer = tplBuffer;
      } else {
        templateBuffer = fs.readFileSync(path.join(__dirname, "templates", "Template-Planning-technicien.xlsx"));
      }

      const zip = new JSZip();

      for (const tech of ordreTech) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(templateBuffer);
        const ws = wb.worksheets[0];

        const placeholders = trouverPlaceholders(ws);
        const pNom = placeholders["##nom-fichier"];
        const pJour = placeholders["##jour-date"];
        const pAdresse = placeholders["##adresse"];
        const pHoraire = placeholders["##horaire"];
        const pNbLog = placeholders["##nblogements"];
        const pDateHeure2 = placeholders["##dateheure2ndpassage"];
        if (!pJour || !pAdresse || !pHoraire || !pNbLog || !pDateHeure2) {
          res.status(400).json({ error: "Template invalide : placeholders ##Jour-date/##Adresse/##Horaire/##NbLogements/##DateHeure2ndPassage introuvables" });
          return;
        }

        if (pNom) ws.getRow(pNom.row).getCell(pNom.col).value = `Planning technicien - ${tech}`;

        const minCol = pAdresse.col, maxCol = pDateHeure2.col;
        const bannerStyle = ws.getRow(pJour.row).getCell(pJour.col).style;
        const bannerHeight = ws.getRow(pJour.row).height;
        const headerRowNumber = pJour.row + 1;
        const headerCells = [];
        for (let c = minCol; c <= maxCol; c++) {
          headerCells.push({ value: ws.getRow(headerRowNumber).getCell(c).value, style: ws.getRow(headerRowNumber).getCell(c).style });
        }
        const dataStyles = {
          adresse: ws.getRow(pAdresse.row).getCell(pAdresse.col).style,
          horaire: ws.getRow(pHoraire.row).getCell(pHoraire.col).style,
          nbLog: ws.getRow(pNbLog.row).getCell(pNbLog.col).style,
          dateHeure2: ws.getRow(pDateHeure2.row).getCell(pDateHeure2.col).style,
        };

        // Vide le bloc modèle d'origine (banner + en-têtes + ligne de données) pour repartir propre.
        for (let r = pJour.row; r <= pAdresse.row; r++) {
          for (let c = 1; c <= maxCol; c++) ws.getRow(r).getCell(c).value = null;
        }

        const jours = parTech.get(tech);
        let cursor = pJour.row;
        let premierBloc = true;
        for (const [jour, lignesJour] of jours) {
          const bRow = ws.getRow(cursor);
          bRow.getCell(minCol).value = jour;
          bRow.getCell(minCol).style = bannerStyle;
          if (bannerHeight) bRow.height = bannerHeight;
          if (!premierBloc) ws.mergeCells(cursor, minCol, cursor, maxCol); // 1er bloc déjà fusionné par le template
          premierBloc = false;
          cursor++;

          const hRow = ws.getRow(cursor);
          headerCells.forEach((hc, i) => { hRow.getCell(minCol + i).value = hc.value; hRow.getCell(minCol + i).style = hc.style; });
          cursor++;

          lignesJour.forEach(l => {
            const dRow = ws.getRow(cursor);
            dRow.getCell(pAdresse.col).value = l.adresse; dRow.getCell(pAdresse.col).style = dataStyles.adresse;
            dRow.getCell(pHoraire.col).value = l.heure1; dRow.getCell(pHoraire.col).style = dataStyles.horaire;
            dRow.getCell(pNbLog.col).value = l.nbLogements || ""; dRow.getCell(pNbLog.col).style = dataStyles.nbLog;
            dRow.getCell(pDateHeure2.col).value = formaterDateHeure2ndPassage(l.date2, l.heure2); dRow.getCell(pDateHeure2.col).style = dataStyles.dateHeure2;
            cursor++;
          });
          cursor++; // ligne d'espacement entre jours
        }

        const outBuffer = await wb.xlsx.writeBuffer();
        zip.folder("Planning technicien").file(`${sanitizeNomFichier(tech)}.xlsx`, outBuffer);
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const outPath = `campagnes-documents/${campagneId}/planning-technicien/planning-technicien.zip`;
      const zipFileName = "Planning technicien.zip";
      const token = crypto.randomUUID();
      await bucket.file(outPath).save(zipBuffer, {
        contentType: "application/zip",
        metadata: { contentDisposition: contentDispositionHeader(zipFileName), metadata: { firebaseStorageDownloadTokens: token } },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outPath)}?alt=media&token=${token}`;

      const nowIso = new Date().toISOString();
      const statsText = `${ordreTech.length} technicien(s)`;
      await db.collection("campagnes-documents-generes").doc(`${campagneId}__planning-technicien`).set({
        campagneId, type: "planning-technicien", fileName: zipFileName, url, storagePath: outPath,
        statsText, createdAt: nowIso,
      });

      res.status(200).json({ success: true, url, fileName: zipFileName, statsText });
    } catch(e) {
      console.error("campagneGenererPlanningTechnicien:", e);
      res.status(500).json({ error: e.message });
    }
  });

const MOIS_FR_IDX = { janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11 };
// "Lundi 19 octobre 2026" -> Date triable. Retourne null si non parsable.
function parseDateJourFr(str) {
  const s = String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const m = s.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (!m) return null;
  const mois = MOIS_FR_IDX[m[2]];
  if (mois === undefined) return null;
  return new Date(Number(m[3]), mois, Number(m[1]));
}
// Adresse batiment ("8 RUE CLAUDE KOGAN") vs adresse planning source ("8 Rue Claude Kogan, 38100 Grenoble") :
// compare la partie avant la 1ère virgule, normalisée (accents/casse).
function normaliserAdresseComparaison(adresse) {
  return String(adresse || "").split(",")[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}

// ── PLANNING 2ÈME PASSAGE PAR TECHNICIEN ────────────────────────────
// Croise les bâtiments déjà repassés (passage2 renseigné, donc déjà pushés
// vers Kizeo) avec le fichier planning source de la campagne (date/horaire
// du 2nd passage par adresse, déjà utilisé pour Gestion documentation).
// Groupe par le technicien RÉELLEMENT utilisé au push (passage2.technicienNom),
// pas celui du 1er passage : une réassignation est donc bien prise en compte.
exports.campagneGenererPlanningPassage2 = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { semaineId } = req.body || {};
    if (!semaineId) { res.status(400).json({ error: "semaineId requis" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const semaineSnap = await db.collection("campagnes-semaines").doc(semaineId).get();
      if (!semaineSnap.exists) { res.status(404).json({ error: "Semaine introuvable" }); return; }
      const campagneId = semaineSnap.data().campagneId;
      const campagneSnap = await db.collection("gestion-campagnes").doc(campagneId).get();
      if (!campagneSnap.exists) { res.status(404).json({ error: "Campagne introuvable" }); return; }
      const docSourceStoragePath = campagneSnap.data().docSourceStoragePath;
      if (!docSourceStoragePath) { res.status(400).json({ error: "Fichier source planning (Gestion documentation) non configuré pour cette campagne" }); return; }

      const bSnap = await db.collection("campagnes-batiments").where("semaineId", "==", semaineId).get();
      const batiments = bSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const candidats = batiments.filter(b => b.passage1 && b.passage1.statut === "archive" && (b.passage1.resultats || []).some(l => l.statut === "Absent"));
      if (!candidats.length) { res.status(400).json({ error: "Aucun bâtiment avec des absents pour cette période" }); return; }
      const sansPush2 = candidats.filter(b => !b.passage2);
      if (sansPush2.length) {
        res.status(400).json({ error: `${sansPush2.length} bâtiment(s) n'ont pas encore reçu leur push 2ème passage. Termine d'abord tous les envois.` });
        return;
      }

      const ExcelJS = require("exceljs");
      const JSZip = require("jszip");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [srcBuffer] = await bucket.file(docSourceStoragePath).download();
      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.load(srcBuffer);
      const srcWs = srcWb.worksheets[0];
      if (!srcWs) { res.status(400).json({ error: "Feuille source introuvable" }); return; }
      const lignesSource = lirePlanningSource(srcWs);
      const dateHeureParAdresse = new Map();
      lignesSource.forEach(l => {
        const cle = normaliserAdresseComparaison(l.adresse);
        if (!dateHeureParAdresse.has(cle)) dateHeureParAdresse.set(cle, { date2: l.date2, heure2: l.heure2 });
      });

      let nbSansDate = 0;
      const parTech = new Map(); // tech -> [{adresse, horaire, nbLogements, dateTri}]
      const ordreTech = [];
      candidats.forEach(b => {
        const tech = (b.passage2.technicienNom || "").trim() || "Sans technicien";
        if (!parTech.has(tech)) { parTech.set(tech, []); ordreTech.push(tech); }
        const cle = normaliserAdresseComparaison(b.adresseRue);
        const infosDate = dateHeureParAdresse.get(cle);
        if (!infosDate || !infosDate.date2) nbSansDate++;
        parTech.get(tech).push({
          adresse: b.adresseRue,
          horaire: (infosDate && infosDate.heure2) || "",
          nbLogements: (b.passage2.logements || []).length,
          jour: (infosDate && infosDate.date2) || "Date non trouvée",
          dateTri: infosDate ? parseDateJourFr(infosDate.date2) : null,
        });
      });

      const zip = new JSZip();
      for (const tech of ordreTech) {
        const lignes = parTech.get(tech);
        // Groupe par jour (ordre chronologique quand la date est parsable, sinon ordre d'arrivée).
        lignes.sort((a, b2) => {
          if (a.dateTri && b2.dateTri) return a.dateTri - b2.dateTri;
          if (a.dateTri) return -1;
          if (b2.dateTri) return 1;
          return 0;
        });
        const parJour = new Map();
        lignes.forEach(l => { if (!parJour.has(l.jour)) parJour.set(l.jour, []); parJour.get(l.jour).push(l); });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Planning");
        ws.getColumn(1).width = 42; ws.getColumn(2).width = 18; ws.getColumn(3).width = 14;
        const titleRow = ws.addRow([`Planning technicien - ${tech} - 2ème passage`]);
        titleRow.font = { bold: true, size: 14 };
        ws.addRow(["Belledonne Multiservices"]);
        ws.addRow([]);
        for (const [jour, lignesJour] of parJour) {
          const bannerRow = ws.addRow([jour]);
          bannerRow.font = { bold: true, size: 12 };
          bannerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEEDD" } };
          const headerRow = ws.addRow(["Adresse", "Horaire", "Nb logements"]);
          headerRow.font = { bold: true };
          lignesJour.forEach(l => { ws.addRow([l.adresse, l.horaire, l.nbLogements]); });
          ws.addRow([]);
        }

        const outBuffer = await wb.xlsx.writeBuffer();
        zip.folder("Planning 2eme passage").file(`${sanitizeNomFichier(tech)}.xlsx`, outBuffer);
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const outPath = `campagnes-documents/${campagneId}/planning-passage2/${semaineId}_${Date.now()}.zip`;
      const zipFileName = "Planning 2eme passage.zip";
      const token = crypto.randomUUID();
      await bucket.file(outPath).save(zipBuffer, {
        contentType: "application/zip",
        metadata: { contentDisposition: contentDispositionHeader(zipFileName), metadata: { firebaseStorageDownloadTokens: token } },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outPath)}?alt=media&token=${token}`;
      const statsText = `${ordreTech.length} technicien(s), ${candidats.length} bâtiment(s)` + (nbSansDate ? `, ${nbSansDate} sans date trouvée` : "");

      res.status(200).json({ success: true, url, fileName: zipFileName, statsText, nbSansDate });
    } catch(e) {
      console.error("campagneGenererPlanningPassage2:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ── PLANNING TECHNICIEN GLOBAL (campagne) ───────────────────────────
// Même croisement que campagneGenererPlanningPassage2, mais agrège TOUTES
// les périodes de la campagne (au lieu d'une seule) : un fichier par
// technicien qui cumule ses adresses/jours sur l'ensemble de la campagne.
exports.campagneGenererPlanningTechnicienGlobal = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId } = req.body || {};
    if (!campagneId) { res.status(400).json({ error: "campagneId requis" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const campagneSnap = await db.collection("gestion-campagnes").doc(campagneId).get();
      if (!campagneSnap.exists) { res.status(404).json({ error: "Campagne introuvable" }); return; }
      const docSourceStoragePath = campagneSnap.data().docSourceStoragePath;
      if (!docSourceStoragePath) { res.status(400).json({ error: "Fichier source planning (Gestion documentation) non configuré pour cette campagne" }); return; }

      const bSnap = await db.collection("campagnes-batiments").where("campagneId", "==", campagneId).get();
      const batiments = bSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const candidats = batiments.filter(b => b.passage1 && b.passage1.statut === "archive" && (b.passage1.resultats || []).some(l => l.statut === "Absent"));
      if (!candidats.length) { res.status(400).json({ error: "Aucun bâtiment avec des absents pour cette campagne" }); return; }
      const sansPush2 = candidats.filter(b => !b.passage2);
      if (sansPush2.length) {
        res.status(400).json({ error: `${sansPush2.length} bâtiment(s) n'ont pas encore reçu leur push 2ème passage, toutes périodes confondues. Termine d'abord tous les envois.` });
        return;
      }

      const ExcelJS = require("exceljs");
      const JSZip = require("jszip");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [srcBuffer] = await bucket.file(docSourceStoragePath).download();
      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.load(srcBuffer);
      const srcWs = srcWb.worksheets[0];
      if (!srcWs) { res.status(400).json({ error: "Feuille source introuvable" }); return; }
      const lignesSource = lirePlanningSource(srcWs);
      const dateHeureParAdresse = new Map();
      lignesSource.forEach(l => {
        const cle = normaliserAdresseComparaison(l.adresse);
        if (!dateHeureParAdresse.has(cle)) dateHeureParAdresse.set(cle, { date2: l.date2, heure2: l.heure2 });
      });

      let nbSansDate = 0;
      const parTech = new Map();
      const ordreTech = [];
      candidats.forEach(b => {
        const tech = (b.passage2.technicienNom || "").trim() || "Sans technicien";
        if (!parTech.has(tech)) { parTech.set(tech, []); ordreTech.push(tech); }
        const cle = normaliserAdresseComparaison(b.adresseRue);
        const infosDate = dateHeureParAdresse.get(cle);
        if (!infosDate || !infosDate.date2) nbSansDate++;
        parTech.get(tech).push({
          adresse: b.adresseRue,
          horaire: (infosDate && infosDate.heure2) || "",
          nbLogements: (b.passage2.logements || []).length,
          jour: (infosDate && infosDate.date2) || "Date non trouvée",
          dateTri: infosDate ? parseDateJourFr(infosDate.date2) : null,
        });
      });

      const zip = new JSZip();
      for (const tech of ordreTech) {
        const lignes = parTech.get(tech);
        lignes.sort((a, b2) => {
          if (a.dateTri && b2.dateTri) return a.dateTri - b2.dateTri;
          if (a.dateTri) return -1;
          if (b2.dateTri) return 1;
          return 0;
        });
        const parJour = new Map();
        lignes.forEach(l => { if (!parJour.has(l.jour)) parJour.set(l.jour, []); parJour.get(l.jour).push(l); });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet("Planning");
        ws.getColumn(1).width = 42; ws.getColumn(2).width = 18; ws.getColumn(3).width = 14;
        const titleRow = ws.addRow([`Planning technicien - ${tech} - 2ème passage (campagne complète)`]);
        titleRow.font = { bold: true, size: 14 };
        ws.addRow(["Belledonne Multiservices"]);
        ws.addRow([]);
        for (const [jour, lignesJour] of parJour) {
          const bannerRow = ws.addRow([jour]);
          bannerRow.font = { bold: true, size: 12 };
          bannerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEEDD" } };
          const headerRow = ws.addRow(["Adresse", "Horaire", "Nb logements"]);
          headerRow.font = { bold: true };
          lignesJour.forEach(l => { ws.addRow([l.adresse, l.horaire, l.nbLogements]); });
          ws.addRow([]);
        }

        const outBuffer = await wb.xlsx.writeBuffer();
        zip.folder("Planning technicien").file(`${sanitizeNomFichier(tech)}.xlsx`, outBuffer);
      }

      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      const outPath = `campagnes-documents/${campagneId}/planning-technicien-global/${Date.now()}.zip`;
      const zipFileName = "Planning technicien (campagne complete).zip";
      const token = crypto.randomUUID();
      await bucket.file(outPath).save(zipBuffer, {
        contentType: "application/zip",
        metadata: { contentDisposition: contentDispositionHeader(zipFileName), metadata: { firebaseStorageDownloadTokens: token } },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outPath)}?alt=media&token=${token}`;
      const statsText = `${ordreTech.length} technicien(s), ${candidats.length} bâtiment(s)` + (nbSansDate ? `, ${nbSansDate} sans date trouvée` : "");

      res.status(200).json({ success: true, url, fileName: zipFileName, statsText, nbSansDate });
    } catch(e) {
      console.error("campagneGenererPlanningTechnicienGlobal:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ── RECHERCHE LOGEMENT (campagne) ───────────────────────────────────
// Cherche par adresse/nom/numéro de logement dans les fichiers Excel de
// push 1er passage de TOUTES les périodes de la campagne (même non
// envoyés à Kizeo, cf. config.dernierFichier sauvegardé dès la sélection
// du fichier), puis complète avec la date/heure 1er passage retrouvée
// dans le fichier planning source (Gestion documentation), par adresse.
exports.campagneRechercheLogement = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 120 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId, q } = req.body || {};
    if (!campagneId) { res.status(400).json({ error: "campagneId requis" }); return; }
    const terme = String(q || "").trim().toLowerCase();
    if (terme.length < 2) { res.status(400).json({ error: "Recherche trop courte (2 caractères minimum)" }); return; }

    try {
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const ExcelJS = require("exceljs");

      const campagneSnap = await db.collection("gestion-campagnes").doc(campagneId).get();
      const docSourceStoragePath = campagneSnap.exists ? campagneSnap.data().docSourceStoragePath : null;
      let dateHeureParAdresse = new Map();
      if (docSourceStoragePath) {
        try {
          const [srcBuffer] = await bucket.file(docSourceStoragePath).download();
          const srcWb = new ExcelJS.Workbook();
          await srcWb.xlsx.load(srcBuffer);
          const srcWs = srcWb.worksheets[0];
          if (srcWs) {
            lirePlanningSource(srcWs).forEach(l => {
              const cle = normaliserAdresseComparaison(l.adresse);
              if (!dateHeureParAdresse.has(cle)) dateHeureParAdresse.set(cle, { date1: l.date1, heure1: l.heure1 });
            });
          }
        } catch(e) { console.error("campagneRechercheLogement: lecture fichier source échouée:", e.message); }
      }

      const nomsTechniciens = new Map();
      async function nomTechnicienParKizeoId(kizeoUserId) {
        if (!kizeoUserId) return "";
        if (nomsTechniciens.has(kizeoUserId)) return nomsTechniciens.get(kizeoUserId);
        let nom = "";
        try {
          const tSnap = await db.collection("techniciens").where("kizeoUserId", "==", String(kizeoUserId)).limit(1).get();
          if (!tSnap.empty) {
            const t = tSnap.docs[0].data();
            nom = t.nomComplet || `${t.prenom || ""} ${t.nom || ""}`.trim();
          }
        } catch(e) { /* ignore */ }
        nomsTechniciens.set(kizeoUserId, nom);
        return nom;
      }

      const semainesSnap = await db.collection("campagnes-semaines").where("campagneId", "==", campagneId).get();
      const resultats = [];
      const LIMITE = 30;

      for (const semDoc of semainesSnap.docs) {
        if (resultats.length >= LIMITE) break;
        const config = semDoc.data().config || {};
        const dernierFichier = config.dernierFichier;
        const envois = config.envois || [];
        const colonnes = config.colonnes;
        if (!dernierFichier || !dernierFichier.url || !envois.length || !colonnes) continue;

        const path = storagePathFromDownloadUrl(dernierFichier.url);
        if (!path) continue;
        let wb;
        try {
          const [buf] = await bucket.file(path).download();
          wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf);
        } catch(e) { console.error(`campagneRechercheLogement: lecture ${path} échouée:`, e.message); continue; }

        for (const envoi of envois) {
          if (resultats.length >= LIMITE) break;
          const ws = wb.getWorksheet(envoi.nomFeuille);
          if (!ws) continue;
          const techNom = await nomTechnicienParKizeoId(envoi.destinataireKizeoUserId);
          ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1 || resultats.length >= LIMITE) return;
            try {
              const numeroRue = nettoyerNombre(cellStr(row, colonnes.numeroRue));
              const nomRue = cellStr(row, colonnes.nomRue);
              if (!nomRue) return;
              const adresseRue = `${numeroRue} ${nomRue}`.trim();
              const nomLocataire = cellStr(row, colonnes.locataire);
              const reference = cellStr(row, colonnes.referenceLogement);
              const numeroCourt = extraire4DerniersChiffres(reference);
              const haystack = `${adresseRue} ${nomLocataire} ${numeroCourt}`.toLowerCase();
              if (!haystack.includes(terme)) return;

              const cle = normaliserAdresseComparaison(adresseRue);
              const infosDate = dateHeureParAdresse.get(cle);
              resultats.push({
                nom: nomLocataire,
                numero: numeroCourt,
                adresse: adresseRue,
                dateHeure1erPassage: infosDate && infosDate.date1 ? `${infosDate.date1}${infosDate.heure1 ? " - " + infosDate.heure1 : ""}` : "Non trouvée",
                technicien: techNom || "—",
                periode: `${semDoc.data().dateDebut || ""} → ${semDoc.data().dateFin || ""}`,
              });
            } catch(e) { /* ligne ignorée */ }
          });
        }
      }

      res.status(200).json({ resultats });
    } catch(e) {
      console.error("campagneRechercheLogement:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ══════════════════════════════════════════════════════════════════
// AVIS DE PASSAGE (docx) : le template reste un .docx normal, une seule
// page, avec des balises {Adresse} / {date-heure} (syntaxe docxtemplater).
// Le générateur enveloppe ce contenu dans une boucle {#pages}/{#break}
// injectée automatiquement dans le XML au moment de la génération (pas
// besoin que l'utilisateur ajoute quoi que ce soit dans son template) :
// une page par adresse, saut de page entre chaque, jamais de page finale
// blanche. Sortie : un seul .docx multi-pages, à convertir en PDF par
// l'utilisateur (Word / Aperçu) — pas de conversion serveur (pas de
// LibreOffice disponible dans ce runtime Cloud Functions).
// ══════════════════════════════════════════════════════════════════

// Injecte dans le XML brut du document une boucle Docxtemplater autour de
// tout le contenu du corps (entre le 1er tableau et le sectPr final) :
// {#pages} ... {#break}<saut de page>{/break} ... {/pages}. Le dernier
// paragraphe avant sectPr (paragraphe vide que Word ajoute automatiquement
// après un tableau) est remplacé par la fermeture de boucle plutôt que
// complété : les laisser tous les deux provoque un double saut de page
// sous Word/LibreOffice (bug constaté et vérifié empiriquement).
function envelopperBouclePages(xml) {
  const PAGES_OPEN = '<w:p><w:r><w:t xml:space="preserve">{#pages}</w:t></w:r></w:p>';
  const BREAK_OPEN = '<w:p><w:r><w:t xml:space="preserve">{#break}</w:t></w:r></w:p>';
  const PAGEBREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const BREAK_CLOSE = '<w:p><w:r><w:t xml:space="preserve">{/break}</w:t></w:r></w:p>';
  const CLOSE_P = '<w:p><w:r><w:t xml:space="preserve">{/pages}</w:t></w:r></w:p>';

  const tblIdx = xml.indexOf("<w:tbl>");
  const insertBeforeIdx = tblIdx !== -1 ? tblIdx : xml.indexOf("<w:p");
  let out = xml.slice(0, insertBeforeIdx) + PAGES_OPEN + BREAK_OPEN + PAGEBREAK + BREAK_CLOSE + xml.slice(insertBeforeIdx);

  const sectIdx = out.indexOf("<w:sectPr");
  const before = out.slice(0, sectIdx);
  const lastPStart = Math.max(before.lastIndexOf("<w:p "), before.lastIndexOf("<w:p>"));
  out = lastPStart > -1 ? out.slice(0, lastPStart) + CLOSE_P + out.slice(sectIdx) : out.slice(0, sectIdx) + CLOSE_P + out.slice(sectIdx);
  return out;
}

// ── Dates françaises longues ("Lundi 5 octobre 2026") : parsing + calcul ──
const JOURS_SEMAINE = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
function parseDateFrancaise(str) {
  const m = String(str || "").trim().match(/^\S+\s+(\d{1,2})\s+(\S+)\s+(\d{4})$/);
  if (!m) return null;
  const monthIdx = MOIS_FR.indexOf(m[2].toLowerCase());
  if (monthIdx === -1) return null;
  return new Date(parseInt(m[3], 10), monthIdx, parseInt(m[1], 10));
}
function formatDateFrancaise(date) {
  return `${JOURS_SEMAINE[date.getDay()]} ${date.getDate()} ${MOIS_FR[date.getMonth()]} ${date.getFullYear()}`;
}
function dateLimiteAffichage(dateStr, joursAvant) {
  const d = parseDateFrancaise(dateStr);
  if (!d) return "";
  const d2 = new Date(d);
  d2.setDate(d2.getDate() - joursAvant);
  return formatDateFrancaise(d2);
}

exports.campagneGenererAvisPassage = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId, storagePath, templateStoragePath } = req.body || {};
    if (!campagneId || !storagePath) { res.status(400).json({ error: "campagneId et storagePath requis" }); return; }

    try {
      const ExcelJS = require("exceljs");
      const PizZip = require("pizzip");
      const Docxtemplater = require("docxtemplater");
      const path = require("path");
      const fs = require("fs");
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [buffer] = await bucket.file(storagePath).download();

      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.load(buffer);
      const srcWs = srcWb.worksheets[0];
      if (!srcWs) { res.status(400).json({ error: "Feuille source introuvable" }); return; }

      const toutesLignes = lirePlanningSource(srcWs);
      if (!toutesLignes.length) { res.status(400).json({ error: "Aucune adresse trouvée dans le fichier source" }); return; }
      const vues = new Set();
      const lignes = toutesLignes.filter(l => { if (vues.has(l.adresse)) return false; vues.add(l.adresse); return true; });

      let templateBytes;
      if (templateStoragePath) {
        const [tplBuffer] = await bucket.file(templateStoragePath).download();
        templateBytes = tplBuffer;
      } else {
        templateBytes = fs.readFileSync(path.join(__dirname, "templates", "Template-Avis-de passage.docx"));
      }

      const zip = new PizZip(templateBytes);
      const rawXml = zip.file("word/document.xml").asText();
      zip.file("word/document.xml", envelopperBouclePages(rawXml));
      const docxtpl = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

      const pages = lignes.map((l, i) => ({
        "Adresse": l.adresse,
        "date-heure": l.date1 ? `${l.date1} entre ${l.heure1}` : "",
        break: i > 0,
      }));
      docxtpl.render({ pages });
      const outBytes = docxtpl.getZip().generate({ type: "nodebuffer" });

      const outPath = `campagnes-documents/${campagneId}/avis-passage/avis-passage.docx`;
      const outFileName = "avis-passage.docx";
      const token = crypto.randomUUID();
      await bucket.file(outPath).save(outBytes, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        metadata: { contentDisposition: contentDispositionHeader(outFileName), metadata: { firebaseStorageDownloadTokens: token } },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outPath)}?alt=media&token=${token}`;

      const nowIso = new Date().toISOString();
      const statsText = `${lignes.length} avis (${lignes.length} page(s))`;
      await db.collection("campagnes-documents-generes").doc(`${campagneId}__avis-passage`).set({
        campagneId, type: "avis-passage", fileName: outFileName, url, storagePath: outPath, statsText, createdAt: nowIso,
      });

      res.status(200).json({ success: true, url, fileName: outFileName, statsText });
    } catch(e) {
      console.error("campagneGenererAvisPassage:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ══════════════════════════════════════════════════════════════════
// PLANNING D'AFFICHAGE (docx indépendant) : template = 1 tableau à 3
// lignes (date prévue+limite / labels Adresse-Commentaire / ligne modèle
// ##adresse), balises ##dateprévue / ##datelimite / ##adresse. Le
// générateur duplique ce tableau une fois par journée de désinsectisation
// (avec autant de lignes ##adresse que d'adresses ce jour-là).
// ══════════════════════════════════════════════════════════════════

function genererTableauJour(tblPrXml, tblGridXml, rowDateXml, rowLabelsXml, rowAdresseXml, jour, adresses, joursAvant) {
  const limite = dateLimiteAffichage(jour, joursAvant);
  const rowDate = rowDateXml
    .replace(/##datepr[ée]vue/gi, escapeXml(jour))
    .replace(/##datelimite/gi, escapeXml(limite));
  const rowsAdresses = adresses.map(a => rowAdresseXml.replace(/##adresse/gi, escapeXml(a))).join("");
  return `<w:tbl>${tblPrXml}${tblGridXml}${rowDate}${rowLabelsXml}${rowsAdresses}</w:tbl>`;
}
function escapeXml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

exports.campagneGenererPlanningAffichage = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300 })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId, storagePath, templateStoragePath, joursAvant } = req.body || {};
    if (!campagneId || !storagePath) { res.status(400).json({ error: "campagneId et storagePath requis" }); return; }
    const nbJoursAvant = parseInt(joursAvant, 10);
    if (!nbJoursAvant || nbJoursAvant < 1) { res.status(400).json({ error: "joursAvant requis (nombre de jours avant la désinsectisation)" }); return; }

    try {
      const ExcelJS = require("exceljs");
      const PizZip = require("pizzip");
      const path = require("path");
      const fs = require("fs");
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [buffer] = await bucket.file(storagePath).download();

      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.load(buffer);
      const srcWs = srcWb.worksheets[0];
      if (!srcWs) { res.status(400).json({ error: "Feuille source introuvable" }); return; }

      const toutesLignes = lirePlanningSource(srcWs);
      if (!toutesLignes.length) { res.status(400).json({ error: "Aucune adresse trouvée dans le fichier source" }); return; }
      const vues = new Set();
      const lignes = toutesLignes.filter(l => { if (vues.has(l.adresse)) return false; vues.add(l.adresse); return true; });

      const joursMap = new Map();
      lignes.forEach(l => {
        if (!joursMap.has(l.date1)) joursMap.set(l.date1, []);
        joursMap.get(l.date1).push(l.adresse);
      });

      let templateBytes;
      if (templateStoragePath) {
        const [tplBuffer] = await bucket.file(templateStoragePath).download();
        templateBytes = tplBuffer;
      } else {
        templateBytes = fs.readFileSync(path.join(__dirname, "templates", "Template-planning-affichage.docx"));
      }

      const zip = new PizZip(templateBytes);
      const xml = zip.file("word/document.xml").asText();
      const tblStart = xml.indexOf("<w:tbl>");
      const tblEnd = xml.indexOf("</w:tbl>") + "</w:tbl>".length;
      if (tblStart === -1 || tblEnd === -1) { res.status(400).json({ error: "Template invalide : aucun tableau trouvé" }); return; }
      const tblXml = xml.slice(tblStart, tblEnd);
      const tblPrMatch = tblXml.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/);
      // w:tblGrid peut contenir un w:tblGridChange imbriqué avec son PROPRE w:tblGrid
      // interne (historique Google Docs) : on prend tout jusqu'au 1er <w:tr, pas jusqu'à
      // la 1ère fermeture </w:tblGrid> (qui serait celle, imbriquée, de trop tôt).
      const tblGridStart = tblXml.indexOf("<w:tblGrid>");
      const firstTrIdx = tblXml.indexOf("<w:tr");
      const tblGridXml = (tblGridStart !== -1 && firstTrIdx !== -1) ? tblXml.slice(tblGridStart, firstTrIdx) : "";
      const rows = tblXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
      const rowDateXml = rows.find(r => /##datepr[ée]vue/i.test(r));
      const rowAdresseXml = rows.find(r => /##adresse/i.test(r));
      const rowLabelsXml = rows.find(r => r !== rowDateXml && r !== rowAdresseXml);
      if (!tblPrMatch || !tblGridXml || !rowDateXml || !rowAdresseXml || !rowLabelsXml) {
        res.status(400).json({ error: "Template invalide : structure attendue (3 lignes : dates / labels / ##adresse) introuvable" });
        return;
      }

      const spacer = "<w:p/>";
      let tables = "";
      for (const [jour, adresses] of joursMap) {
        tables += genererTableauJour(tblPrMatch[0], tblGridXml, rowDateXml, rowLabelsXml, rowAdresseXml, jour, adresses, nbJoursAvant) + spacer;
      }

      const finalXml = xml.slice(0, tblStart) + tables + xml.slice(tblEnd);
      zip.file("word/document.xml", finalXml);
      const outBytes = zip.generate({ type: "nodebuffer" });

      const outPath = `campagnes-documents/${campagneId}/planning-affichage/planning-affichage.docx`;
      const outFileName = "planning-affichage.docx";
      const token = crypto.randomUUID();
      await bucket.file(outPath).save(outBytes, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        metadata: { contentDisposition: contentDispositionHeader(outFileName), metadata: { firebaseStorageDownloadTokens: token } },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outPath)}?alt=media&token=${token}`;

      const nowIso = new Date().toISOString();
      const statsText = `${joursMap.size} jour(s), ${lignes.length} adresse(s), affichage ${nbJoursAvant}j avant`;
      await db.collection("campagnes-documents-generes").doc(`${campagneId}__planning-affichage`).set({
        campagneId, type: "planning-affichage", fileName: outFileName, url, storagePath: outPath, statsText, createdAt: nowIso,
      });

      res.status(200).json({ success: true, url, fileName: outFileName, statsText });
    } catch(e) {
      console.error("campagneGenererPlanningAffichage:", e);
      res.status(500).json({ error: e.message });
    }
  });

// ══════════════════════════════════════════════════════════════════
// CONVOCATIONS 2ND PASSAGE (docx indépendant) : template = 3 blocs
// identiques par page (##Adresse + ##date-heure, avec un espace variable
// dans ce dernier selon le fichier d'origine). Nombre de convocations par
// adresse = arrondi supérieur(nbLogements × pourcentage/100) ; réparties
// par groupes de 3 par page, dernière page d'une adresse jamais partagée
// avec l'adresse suivante (cases vides plutôt que mélangées).
// ══════════════════════════════════════════════════════════════════

function remplirBlocConvocation(blockXml, adresse, dateHeure) {
  return blockXml
    .replace(/##Adresse/g, escapeXml(adresse))
    .replace(/##date-\s*heure\s*/g, escapeXml(dateHeure));
}
// Découpe le XML du template en {preamble, block1, gap1, block2, gap2, block3, postamble, sectPr}
// en repérant les 3 tableaux de premier niveau (chacun = 1 bloc convocation).
function decouperTemplateConvocation(xml) {
  let depth = 0, idx = 0;
  const blocks = [];
  while (true) {
    const o = xml.indexOf("<w:tbl>", idx);
    const c = xml.indexOf("</w:tbl>", idx);
    if (o === -1 && c === -1) break;
    if (o !== -1 && (o < c || c === -1)) {
      depth++;
      if (depth === 1) blocks.push({ start: o });
      idx = o + 7;
    } else {
      depth--;
      if (depth === 0) blocks[blocks.length - 1].end = c;
      idx = c + 8;
    }
  }
  if (blocks.length !== 3) return null;
  const sectIdx = xml.indexOf("<w:sectPr");
  return {
    preamble: xml.slice(0, blocks[0].start),
    block1: xml.slice(blocks[0].start, blocks[0].end + 8),
    gap1: xml.slice(blocks[0].end + 8, blocks[1].start),
    block2: xml.slice(blocks[1].start, blocks[1].end + 8),
    gap2: xml.slice(blocks[1].end + 8, blocks[2].start),
    block3: xml.slice(blocks[2].start, blocks[2].end + 8),
    postamble: xml.slice(blocks[2].end + 8, sectIdx),
    sectPr: xml.slice(sectIdx),
  };
}

exports.campagneGenererConvocations = functions
  .region("europe-west1")
  .runWith({ timeoutSeconds: 300, memory: "1GB" })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }
    try { await verifyAdmin(req); } catch(e) { res.status(e.code || 401).json({ error: e.msg || "Non autorisé" }); return; }

    const { campagneId, storagePath, templateStoragePath, pourcentage } = req.body || {};
    if (!campagneId || !storagePath) { res.status(400).json({ error: "campagneId et storagePath requis" }); return; }
    const pct = parseFloat(pourcentage);
    if (!pct || pct <= 0 || pct > 100) { res.status(400).json({ error: "pourcentage requis (entre 1 et 100)" }); return; }

    try {
      const ExcelJS = require("exceljs");
      const PizZip = require("pizzip");
      const path = require("path");
      const fs = require("fs");
      const { getFirestore } = require("firebase-admin/firestore");
      const db = getFirestore(admin.app(), "belledonne-client");
      const bucket = admin.storage().bucket("belledonne-client.firebasestorage.app");
      const [buffer] = await bucket.file(storagePath).download();

      const srcWb = new ExcelJS.Workbook();
      await srcWb.xlsx.load(buffer);
      const srcWs = srcWb.worksheets[0];
      if (!srcWs) { res.status(400).json({ error: "Feuille source introuvable" }); return; }

      const toutesLignes = lirePlanningSource(srcWs);
      if (!toutesLignes.length) { res.status(400).json({ error: "Aucune adresse trouvée dans le fichier source" }); return; }
      // Pas de dédup par adresse ici (contrairement au Planning client) : une adresse
      // scindée entre 2 techniciens doit générer les convocations des DEUX, chacun dans
      // son propre fichier jour. Dédupliquer aurait fait disparaître les lignes du 2e
      // technicien pour ce jour (bug constaté : jours manquants pour certains techniciens).

      let templateBytes;
      if (templateStoragePath) {
        const [tplBuffer] = await bucket.file(templateStoragePath).download();
        templateBytes = tplBuffer;
      } else {
        templateBytes = fs.readFileSync(path.join(__dirname, "templates", "Template-convocation.docx"));
      }

      const tplZip = new PizZip(templateBytes);
      const xml = tplZip.file("word/document.xml").asText();
      const parts = decouperTemplateConvocation(xml);
      if (!parts) { res.status(400).json({ error: "Template invalide : 3 blocs (tableaux) attendus" }); return; }

      // Génère un .docx (convocations, 3 blocs/page) pour un sous-ensemble de lignes.
      // Retourne null si aucune convocation pour ce sous-ensemble (jour sans logement à convoquer).
      function genererDocxConvocations(sousLignes) {
        const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
        let total = 0;
        let body = parts.preamble;
        let firstGroup = true;
        for (const l of sousLignes) {
          const dateHeure = l.date2 ? `${l.date2} entre ${l.heure2}` : "";
          const nbConvocations = Math.ceil((l.nbLogements || 0) * pct / 100);
          if (nbConvocations <= 0) continue;
          total += nbConvocations;
          const items = [];
          for (let i = 0; i < nbConvocations; i++) items.push({ adresse: l.adresse, dateHeure });
          while (items.length % 3 !== 0) items.push({ adresse: "", dateHeure: "" });
          for (let i = 0; i < items.length; i += 3) {
            if (!firstGroup) body += PAGE_BREAK;
            firstGroup = false;
            body += remplirBlocConvocation(parts.block1, items[i].adresse, items[i].dateHeure);
            body += parts.gap1;
            body += remplirBlocConvocation(parts.block2, items[i + 1].adresse, items[i + 1].dateHeure);
            body += parts.gap2;
            body += remplirBlocConvocation(parts.block3, items[i + 2].adresse, items[i + 2].dateHeure);
          }
        }
        if (total === 0) return null;
        body += parts.postamble + parts.sectPr;
        const docZip = new PizZip(templateBytes);
        docZip.file("word/document.xml", body);
        return { buffer: docZip.generate({ type: "nodebuffer" }), total };
      }

      // Regroupe par technicien puis par jour (1er passage), même logique que le Planning technicien :
      // le zip demandé doit correspondre à qui doit distribuer/déposer quelles convocations, et quand.
      const parTech = new Map();
      const ordreTech = [];
      toutesLignes.forEach(l => {
        const tech = l.tech || "Sans technicien";
        if (!parTech.has(tech)) { parTech.set(tech, new Map()); ordreTech.push(tech); }
        const jours = parTech.get(tech);
        if (!jours.has(l.date1)) jours.set(l.date1, []);
        jours.get(l.date1).push(l);
      });

      const JSZip = require("jszip");
      const outZip = new JSZip();
      let totalConvocations = 0;
      let nbFichiers = 0;
      const convocationsFolder = outZip.folder("Convocations");
      for (const tech of ordreTech) {
        const jours = parTech.get(tech);
        const folder = convocationsFolder.folder(sanitizeNomFichier(tech));
        for (const [jour, sousLignes] of jours) {
          const result = genererDocxConvocations(sousLignes);
          if (!result) continue;
          totalConvocations += result.total;
          nbFichiers++;
          folder.file(`${sanitizeNomFichier(jour)}.docx`, result.buffer);
        }
      }

      if (totalConvocations === 0) { res.status(400).json({ error: "Aucune convocation à générer (vérifie le nombre de logements et le pourcentage)" }); return; }

      const outBytes = await outZip.generateAsync({ type: "nodebuffer" });

      const outPath = `campagnes-documents/${campagneId}/convocations/convocations.zip`;
      const outFileName = "Convocations.zip";
      const token = crypto.randomUUID();
      await bucket.file(outPath).save(outBytes, {
        contentType: "application/zip",
        metadata: { contentDisposition: contentDispositionHeader(outFileName), metadata: { firebaseStorageDownloadTokens: token } },
      });
      const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(outPath)}?alt=media&token=${token}`;

      const nowIso = new Date().toISOString();
      const statsText = `${totalConvocations} convocation(s) (${pct}%), ${nbFichiers} fichier(s), ${ordreTech.length} technicien(s)`;
      await db.collection("campagnes-documents-generes").doc(`${campagneId}__convocations`).set({
        campagneId, type: "convocations", fileName: outFileName, url, storagePath: outPath, statsText, createdAt: nowIso,
      });

      res.status(200).json({ success: true, url, fileName: outFileName, statsText });
    } catch(e) {
      console.error("campagneGenererConvocations:", e);
      res.status(500).json({ error: e.message });
    }
  });
