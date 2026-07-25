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
