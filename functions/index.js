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

// Trouve une fiche client Axonaut par SIRET (chiffres) ou nom, sinon la crée.
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
    if (hit) return { id: hit.id, created: false };
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
      const products = lignes.map(l => ({
        name: (l.designation || "Prestation"),
        price: Number(l.pu) || 0,
        quantity: Number(l.qte) || 1,
        tax_rate: Number(l.tva) || 0,
      }));
      const rawDate = date || new Date().toISOString().slice(0, 10);
      const rfcDate = /T/.test(rawDate) ? rawDate : (rawDate + "T12:00:00+00:00");
      const docBody = {
        company_id: company.id,
        date: rfcDate,
        products,
      };
      // Le BC est porté par l'objet (title/comments), pas par order_number
      // (order_number impose l'unicité chez Axonaut -> 409 sur régénération).
      if (objet) { docBody.title = objet; docBody.comments = "Objet : " + objet; }
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
              filename: att.filename || "rapport.xlsx",
              content: buffer,
              contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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

    const { suiviId, numPassage, kizeoFormDocId, recipientUserId, libelle } = req.body || {};
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
    const passage = passages.find(p => String(p.num) === String(numPassage)) || {};
    const dateVal = (passage.debut ? String(passage.debut).split("T")[0] : (s.dateEmission || ""));
    const reference = s.bc || s.pl || s.devis || "";

    // Construction des champs à pousser (uniquement les champs mappés)
    const passageLabel = String(numPassage) === "1" ? "1er passage" : numPassage + "ème passage";
    const appValues = {
      refInterne: `${suiviId}::${numPassage}`,
      libelle: (libelle && String(libelle).trim()) || ((reference ? reference + " - " : "") + passageLabel),
      reference: reference,
      passage: String(numPassage),
      client: s.client || "",
      adresse: s.adresse || passage.adresse || "",
      date: dateVal,
    };
    const fields = {};
    Object.keys(appValues).forEach(key => {
      const fid = mapping[key];
      if (fid) fields[fid] = { value: appValues[key] };
    });

    const r = await kizeoRequest(KIZEO_API_TOKEN.value(), "POST", "/forms/" + encodeURIComponent(form.formId) + "/push", {
      recipient_user_id: recipient,
      fields,
    });
    if (r.status < 200 || r.status >= 300) {
      res.status(502).json({ error: "Kizeo a refusé le push (" + r.status + ")", detail: (r.body || r.error || "").slice(0, 300) });
      return;
    }
    console.log("Kizeo push OK:", suiviId, "passage", numPassage, "-> user", recipient);
    res.status(200).json({ success: true, refInterne: appValues.refInterne });
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
  const technicien = submission._recipient_name || submission.recipient_name || "";
  const reference = mapping.reference ? String(getField(mapping.reference) || "") : "";

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
  const nomBase = `${reference || dataId}_${passageLabel || "rapport"}`.replace(/\s+/g, "_");
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
    fileUrl,
    gsheetId: null,
    gsheetUrl: null,
    statut: "a-traiter",
    updatedAt: now,
  };

  const existing = await db.collection("reception-rapports").where("kizeoDataId", "==", String(dataId)).limit(1).get();
  if (!existing.empty) {
    await existing.docs[0].ref.update(docData);
    console.log(`Kizeo: soumission ${dataId} mise à jour (reception-rapports/${existing.docs[0].id})`);
  } else {
    docData.createdAt = now;
    const ref = await db.collection("reception-rapports").add(docData);
    console.log(`Kizeo: soumission ${dataId} reçue -> reception-rapports/${ref.id}`);
  }
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
      const r = await kizeoRequest(token, "GET", `/forms/${encodeURIComponent(form.formId)}/data/unread/${action}/50`);
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
      for (const dataId of ids) {
        try { await receiveKizeoSubmission(db, token, form.formId, dataId, "pull"); }
        catch(e) { console.error(`kizeoPull: soumission ${dataId} échouée:`, e.message); }
      }
      try {
        await kizeoRequest(token, "POST", `/forms/${encodeURIComponent(form.formId)}/markasreadbyaction/${action}`, { data_ids: ids });
      } catch(e) {
        console.error(`kizeoPull: marquage lu échoué pour ${form.formId}:`, e.message);
      }
    }
  });
