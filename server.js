const crypto = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "64kb" }));
app.use(express.static("public", { index: "index.html" }));

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const CHASTIFY_KEY = process.env.CHASTIFY_APP_DEVELOPER_KEY;

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}
function requiredString(value, max = 500) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cleanConfig(body) {
  const rewardMinutes = Number(body.rewardMinutes || 0);
  const punishmentMinutes = Number(body.punishmentMinutes || 0);
  if (!Number.isInteger(rewardMinutes) || rewardMinutes < 0 || rewardMinutes > 525600) {
    throw new Error("Reward minutes must be a whole number between 0 and 525600.");
  }
  if (!Number.isInteger(punishmentMinutes) || punishmentMinutes < 0 || punishmentMinutes > 525600) {
    throw new Error("Punishment minutes must be a whole number between 0 and 525600.");
  }
  return {
    obedienceExtensionId: String(body.obedienceExtensionId || "").trim(),
    obedienceSecret: String(body.obedienceSecret || "").trim(),
    rewardId: String(body.rewardId || "").trim(),
    rewardMinutes,
    punishmentId: String(body.punishmentId || "").trim(),
    punishmentMinutes,
  };
}
async function chastifyRequest(sessionId, mainToken, path, method = "GET", body) {
  if (!CHASTIFY_KEY) throw new Error("Server is missing CHASTIFY_APP_DEVELOPER_KEY.");
  if (!requiredString(sessionId, 200) || !requiredString(mainToken, 2000)) {
    throw new Error("Missing or invalid Chastify launch context.");
  }
  const response = await fetch(`https://chastify.net/api/extensions/sessions/${encodeURIComponent(sessionId)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CHASTIFY_KEY}`,
      "x-chastify-main-token": mainToken,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `Chastify API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function verifyLaunch(sessionId, mainToken) {
  return chastifyRequest(sessionId, mainToken, "");
}
async function obedienceRequest(path, extensionId, secret, method = "GET", body) {
  const url = new URL(`https://app.obedienceapp.com/extensions/${path}`);
  url.searchParams.set("extensionId", extensionId);
  url.searchParams.set("secret", secret);
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Obedience API returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

app.get("/health", (_req, res) => res.json({ ok: true, service: "obedience-chastify" }));

app.post("/api/obedience/options", async (req, res) => {
  try {
    const { sessionId, mainToken } = req.body || {};
    await verifyLaunch(sessionId, mainToken);
    const extensionId = String(req.body.obedienceExtensionId || "").trim();
    const secret = String(req.body.obedienceSecret || "").trim();
    if (!requiredString(extensionId, 200) || !requiredString(secret, 500)) {
      return fail(res, 400, "Enter your Obedience extension ID and secret.");
    }
    const [rewards, punishments] = await Promise.all([
      obedienceRequest("rewards", extensionId, secret),
      obedienceRequest("punishments", extensionId, secret),
    ]);
    return res.json({
      rewards: Array.isArray(rewards) ? rewards.map(({ id, name }) => ({ id, name })) : [],
      punishments: Array.isArray(punishments) ? punishments.map(({ id, name }) => ({ id, name })) : [],
    });
  } catch (error) {
    return fail(res, error.status || 400, error.message || "Unable to load Obedience options.");
  }
});

app.post("/api/configure", async (req, res) => {
  try {
    const { sessionId, mainToken } = req.body || {};
    await verifyLaunch(sessionId, mainToken);
    const config = cleanConfig(req.body || {});
    if (!requiredString(config.obedienceExtensionId, 200) || !requiredString(config.obedienceSecret, 500)) {
      return fail(res, 400, "Obedience extension ID and secret are required.");
    }
    if (!config.rewardId && !config.punishmentId) {
      return fail(res, 400, "Select at least one reward or punishment.");
    }
    if (config.rewardId && config.rewardMinutes < 1) return fail(res, 400, "Set reward minutes to at least 1.");
    if (config.punishmentId && config.punishmentMinutes < 1) return fail(res, 400, "Set punishment minutes to at least 1.");
    if (!PUBLIC_BASE_URL.startsWith("https://")) {
      return fail(res, 500, "Set PUBLIC_BASE_URL to this service's public HTTPS URL.");
    }
    await Promise.all([
      obedienceRequest("rewards", config.obedienceExtensionId, config.obedienceSecret),
      obedienceRequest("punishments", config.obedienceExtensionId, config.obedienceSecret),
    ]);
    await db.collection("installations").doc(sessionId).set({
      ...config, sessionId, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    await obedienceRequest("webhook", config.obedienceExtensionId, config.obedienceSecret, "POST", {
      url: `${PUBLIC_BASE_URL}/api/obedience/webhook`,
      habits: false,
      rewards: Boolean(config.rewardId),
      punishments: Boolean(config.punishmentId),
    });
    return res.json({ ok: true, message: "Settings saved and Obedience webhook registered." });
  } catch (error) {
    return fail(res, error.status || 400, error.message || "Unable to save settings.");
  }
});

app.post("/api/obedience/webhook", async (req, res) => {
  try {
    const payload = req.body || {};
    const { extensionId, secret, type, before, after } = payload;
    if (!requiredString(extensionId, 200) || !requiredString(secret, 500)) {
      return fail(res, 400, "Missing Obedience webhook credentials.");
    }
    const snapshot = await db.collection("installations")
      .where("obedienceExtensionId", "==", extensionId).get();
    const matches = snapshot.docs.filter((doc) => safeEqual(doc.data().obedienceSecret, secret));
    if (!matches.length) return fail(res, 401, "Unknown Obedience installation.");

    const difference = Number(after?.amount) - Number(before?.amount);
    if ((type !== "reward" && type !== "punishment") || !Number.isFinite(difference) || difference <= 0) {
      return res.status(202).json({ ok: true, ignored: true });
    }
    const eventKey = payload.eventId || payload.id || payload.event_id;
    const payloadStamp = payload.createdAt || payload.timestamp || payload.created_at || "";
    const digest = crypto.createHash("sha256").update(JSON.stringify({ payload, payloadStamp })).digest("hex");
    const eventId = requiredString(String(eventKey || ""), 200)
      ? String(eventKey).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180)
      : digest;
    const batch = db.batch();
    for (const doc of matches) {
      const cfg = doc.data();
      const selectedId = type === "reward" ? cfg.rewardId : cfg.punishmentId;
      if (!selectedId || selectedId !== after?.id) continue;
      const actionRef = db.collection("pendingActions").doc(`${doc.id}_${eventId}`);
      batch.create(actionRef, {
        sessionId: cfg.sessionId, type, amount: difference,
        minutesPerUnit: type === "reward" ? cfg.rewardMinutes : cfg.punishmentMinutes,
        status: "pending", createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    return res.status(202).json({ ok: true, queued: true });
  } catch (error) {
    // Firestore ALREADY_EXISTS means the event was already queued; acknowledge it.
    if (error.code === 6 || error.code === "already-exists") return res.status(202).json({ ok: true, duplicate: true });
    console.error("Obedience webhook failed:", error.message);
    return fail(res, 500, "Unable to queue webhook event.");
  }
});

app.post("/api/sync", async (req, res) => {
  try {
    const { sessionId, mainToken } = req.body || {};
    await verifyLaunch(sessionId, mainToken);
    const query = await db.collection("pendingActions")
      .where("sessionId", "==", sessionId).where("status", "==", "pending").limit(20).get();
    const results = [];
    for (const doc of query.docs) {
      const action = doc.data();
      const seconds = Math.floor(Number(action.amount) * Number(action.minutesPerUnit) * 60);
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 31536000) {
        await doc.ref.update({ status: "rejected", reason: "Invalid configured time amount." });
        results.push({ status: "rejected", message: "Invalid time amount." });
        continue;
      }
      await doc.ref.update({ status: "processing", startedAt: admin.firestore.FieldValue.serverTimestamp() });
      try {
        const actionName = action.type === "reward" ? "remove_time" : "add_time";
        await chastifyRequest(sessionId, mainToken, "/action", "POST", { name: actionName, params: seconds });
        await doc.ref.update({ status: "applied", appliedAt: admin.firestore.FieldValue.serverTimestamp() });
        results.push({ status: "applied", type: action.type, seconds });
      } catch (error) {
        await doc.ref.update({ status: "needs_review", reason: String(error.message).slice(0, 300) });
        results.push({ status: "needs_review", message: error.message });
      }
    }
    return res.json({ ok: true, processed: results.length, results });
  } catch (error) {
    return fail(res, error.status || 400, error.message || "Unable to sync pending actions.");
  }
});

app.use((error, _req, res, _next) => {
  console.error("Unhandled request error:", error.message);
  res.status(400).json({ error: "Invalid request." });
});
app.listen(PORT, () => console.log(`Obedience-Chastify backend listening on ${PORT}`));