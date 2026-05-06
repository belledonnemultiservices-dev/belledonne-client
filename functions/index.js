const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const https = require("https");
const http = require("http");
const crypto = require("crypto");

admin.initializeApp();

const gmailUser = functions.config().gmail.user;
const gmailPass = functions.config().gmail.pass;

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: gmailUser, pass: gmailPass },
});

// ── SUPPRIMER UTILISATEUR FIREBASE AUTH ───────────────────────────
exports.deleteAuthUser = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

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
  .runWith({ timeoutSeconds: 120, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }

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

      await transporter.sendMail({
        from: '"Belledonne Multiservices" <' + gmailUser + '>',
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
function ovhRequest(method, path, body, config) {
  return new Promise((resolve, reject) => {
    const appKey    = config.appKey;
    const appSecret = config.appSecret;
    const consumerKey = config.consumerKey;
    const timestamp = Math.round(Date.now() / 1000).toString();
    const bodyStr   = body ? JSON.stringify(body) : "";
    const bodyHash  = crypto.createHash("sha1").update(bodyStr).digest("hex");
    const url       = "https://eu.api.ovh.com/1.0" + path;
    const sigStr    = [appSecret, consumerKey, method, url, bodyHash, timestamp].join("+");
    const signature = "$1$" + crypto.createHash("sha1").update(sigStr).digest("hex");

    const options = {
      hostname: "eu.api.ovh.com",
      path: "/1.0" + path,
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Ovh-Application": appKey,
        "X-Ovh-Consumer": consumerKey,
        "X-Ovh-Signature": signature,
        "X-Ovh-Timestamp": timestamp,
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

exports.sendSMS = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "Methode non autorisee" }); return; }

    const { to, message } = req.body;
    if (!to || !message) {
      res.status(400).json({ error: "Champs manquants: to, message" });
      return;
    }

    // Normalize phone number to international format
    let phone = to.replace(/\s/g, "").replace(/-/g, "");
    if (phone.startsWith("0")) phone = "+33" + phone.slice(1);
    if (!phone.startsWith("+")) phone = "+33" + phone;

    const config = {
      appKey:      functions.config().ovh.app_key,
      appSecret:   functions.config().ovh.app_secret,
      consumerKey: functions.config().ovh.consumer_key,
    };
    const smsAccount = functions.config().ovh.sms_account; // sms-su78206-1

    try {
      const result = await ovhRequest(
        "POST",
        `/sms/${smsAccount}/jobs`,
        {
          message,
          receivers: [phone],
          senderForResponse: true,
          priority: "high",
          charset: "UTF-8",
          coding: "7bit",
        },
        config
      );

      console.log("SMS envoye a", phone, "- Status:", result.status, result.body);

      if (result.status === 200 || result.status === 201) {
        res.status(200).json({ success: true, details: result.body });
      } else {
        res.status(result.status).json({ error: result.body });
      }
    } catch(err) {
      console.error("Erreur SMS:", err);
      res.status(500).json({ error: err.message });
    }
  });
