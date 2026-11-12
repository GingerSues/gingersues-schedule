// Cloud Functions for the Ginger Sue's schedule.
//  - linkAccount: after someone signs in by texted code, match their phone to a team member
//    and give them an employee, manager or owner account.
//  - Texts (through Twilio) when a week is published, when a published shift changes,
//    when time off is decided, and for shift-cover asks.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const core = require("./lib/core");

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const OWNER_PHONES = defineSecret("OWNER_PHONES");
const TWILIO_SID = defineSecret("TWILIO_SID");
const TWILIO_TOKEN = defineSecret("TWILIO_TOKEN");
const TWILIO_FROM = defineSecret("TWILIO_FROM");
const TEXT_SECRETS = [TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM];

const listOwners = () => String(OWNER_PHONES.value() || "").split(",").map(s => s.trim()).filter(Boolean);

/* ---------- accounts ---------- */
exports.linkAccount = onCall({ secrets: [OWNER_PHONES] }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const uid = req.auth.uid;
  const phone = core.normPhone(req.auth.token.phone_number);
  if (!phone) throw new HttpsError("permission-denied", "Sign in with a phone number.");

  const hits = await db.collection("private").where("phone", "==", phone).limit(5).get();
  let staffMatch = null;
  for (const h of hits.docs) {
    const st = await db.doc(`staff/${h.id}`).get();
    if (st.exists && st.data().active !== false) { staffMatch = { id: h.id, ...st.data() }; break; }
  }
  const decision = core.decideRole({ phone, ownerPhones: listOwners(), staffMatch });
  if (!decision) {
    await db.doc(`users/${uid}`).delete().catch(() => {});
    throw new HttpsError("permission-denied", "This number isn't on the team list.");
  }

  const batch = db.batch();
  batch.set(db.doc(`users/${uid}`), { ...decision, phone, lastSignIn: Date.now() });
  if (decision.staffId) {
    // One account per team member: clear this uid from anyone else first.
    const others = await db.collection("staff").where("uid", "==", uid).get();
    others.docs.filter(d => d.id !== decision.staffId).forEach(d => batch.update(d.ref, { uid: null }));
    batch.update(db.doc(`staff/${decision.staffId}`), { uid });
  }
  await batch.commit();
  return decision;
});

// Keep roles current when a manager flips Manager or Active on someone who already signed in.
exports.syncRole = onDocumentWritten({ document: "staff/{id}", secrets: [OWNER_PHONES] }, async ev => {
  const before = ev.data.before.exists ? ev.data.before.data() : null;
  const after = ev.data.after.exists ? ev.data.after.data() : null;
  const uid = (after && after.uid) || (before && before.uid);
  if (!uid) return;
  const ref = db.doc(`users/${uid}`);
  const cur = await ref.get();
  if (!cur.exists) return;
  const u = cur.data();
  if (!after || after.active === false || after.uid !== uid) {
    if (u.staffId === ev.params.id) {
      if (listOwners().map(core.normPhone).includes(u.phone)) await ref.set({ ...u, role: "owner", staffId: null });
      else await ref.delete();
    }
    return;
  }
  if (u.role === "owner") return;
  const role = after.isManager ? "manager" : "employee";
  if (u.role !== role || u.staffId !== ev.params.id) await ref.set({ ...u, role, staffId: ev.params.id });
});

// If a manager changes or removes someone's cell number, sign that person out of the app.
exports.phoneChanged = onDocumentWritten("private/{id}", async ev => {
  const b = ev.data.before.exists ? ev.data.before.data().phone : null;
  const a = ev.data.after.exists ? ev.data.after.data().phone : null;
  if (!b || a === b) return;
  const st = await db.doc(`staff/${ev.params.id}`).get();
  const uid = st.exists && st.data().uid;
  if (!uid) return;
  await db.doc(`staff/${ev.params.id}`).update({ uid: null });
  await db.doc(`users/${uid}`).delete().catch(() => {});
  await admin.auth().revokeRefreshTokens(uid).catch(() => {});
});

/* ---------- texting ---------- */
async function loadStaff() {
  const s = await db.collection("staff").get();
  return Object.fromEntries(s.docs.map(d => [d.id, d.data()]));
}
async function loadConfig() {
  const c = await db.doc("config/main").get();
  return c.exists ? c.data() : {};
}

async function sendTexts(msgs, reason) {
  if (!msgs.length) return;
  const sid = TWILIO_SID.value(), token = TWILIO_TOKEN.value(), from = TWILIO_FROM.value();
  const live = sid && sid !== "unset" && token && token !== "unset" && from && from !== "unset";
  for (const m of msgs) {
    const priv = await db.doc(`private/${m.staffId}`).get();
    const to = priv.exists ? core.normPhone(priv.data().phone) : null;
    const log = { staffId: m.staffId, reason, body: m.body, ts: Date.now() };
    if (!to) { await db.collection("outbox").add({ ...log, status: "no-phone" }); continue; }
    if (!live) { await db.collection("outbox").add({ ...log, status: "texting-off" }); continue; }
    try {
      const form = new URLSearchParams({ To: to, Body: m.body });
      if (from.startsWith("MG")) form.set("MessagingServiceSid", from); else form.set("From", from);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      });
      const j = await r.json().catch(() => ({}));
      await db.collection("outbox").add({ ...log, status: r.ok ? "sent" : "failed", sid: j.sid || null, error: r.ok ? null : String(j.message || r.status) });
      if (!r.ok) logger.warn("twilio failed", { status: r.status, message: j.message });
    } catch (e) {
      logger.error("twilio error", e);
      await db.collection("outbox").add({ ...log, status: "failed", error: String(e.message || e) });
    }
  }
}

exports.onPublish = onDocumentCreated({ document: "publishEvents/{id}", secrets: TEXT_SECRETS }, async ev => {
  const e = ev.data.data();
  if (!e || !e.week) return;
  const end = core.addD(e.week, 6);
  const locs = e.locs && e.locs.length ? new Set(e.locs) : null;
  const [snap, notes, staff, config] = await Promise.all([
    db.collection("shifts").where("date", ">=", e.week).where("date", "<=", end).get(),
    db.collection("notify").where("week", "==", e.week).get(),
    loadStaff(), loadConfig(),
  ]);
  const week = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.published);
  const mine = notes.docs.filter(d => !locs || locs.has(d.data().loc));
  const changedIds = [...new Set(mine.map(d => d.data().staffId))];
  await sendTexts(core.publishTexts(e, week, staff, config, changedIds), "publish");
  const batch = db.batch(); mine.forEach(d => batch.delete(d.ref)); if (mine.length) await batch.commit();
});

async function noteChanges(before, after) {
  const notes = core.changeNotes(before, after, core.todayCentral());
  if (!notes.length) return;
  const batch = db.batch();
  notes.forEach(n => batch.set(db.doc(`notify/${n.week}_${n.staffId}_${n.loc}`), { ...n, ts: Date.now() }));
  await batch.commit();
}

// Changes from approved requests are texted right away. Manager edits to a published shift are
// saved up and texted on the next Publish (the manager chooses who gets a text there).
exports.onShiftUpdate = onDocumentUpdated({ document: "shifts/{id}", secrets: TEXT_SECRETS }, async ev => {
  const before = ev.data.before.data(), after = ev.data.after.data();
  if (!before.published) return;
  if (after.lastChange === "request" && before.staffId !== after.staffId) {
    const [staff, config] = await Promise.all([loadStaff(), loadConfig()]);
    await sendTexts(core.shiftChangeTexts(before, after, staff, config, core.todayCentral()), "shift-change");
    return;
  }
  await noteChanges(before, after);
});

exports.onShiftDelete = onDocumentDeleted("shifts/{id}", async ev => {
  const before = ev.data.data();
  if (!before || !before.published || !before.staffId) return;
  await noteChanges(before, null);
});

exports.onTimeoffUpdate = onDocumentUpdated({ document: "timeoff/{id}", secrets: TEXT_SECRETS }, async ev => {
  const msgs = core.timeoffText(ev.data.before.data(), ev.data.after.data(), await loadStaff());
  await sendTexts(msgs, "timeoff");
});

exports.onRequestCreate = onDocumentCreated({ document: "requests/{id}", secrets: TEXT_SECRETS }, async ev => {
  const r = ev.data.data();
  if (!r || r.type !== "cover") return;
  const [staff, config] = await Promise.all([loadStaff(), loadConfig()]);
  await sendTexts(core.coverAskText(r, staff, config), "cover-ask");
});

exports.onRequestUpdate = onDocumentUpdated({ document: "requests/{id}", secrets: TEXT_SECRETS }, async ev => {
  const before = ev.data.before.data(), after = ev.data.after.data();
  if (before.status === after.status) return;
  const [staff, config] = await Promise.all([loadStaff(), loadConfig()]);
  await sendTexts(core.requestUpdateTexts(before, after, staff, config), "request");
});

// Owner tool: send a test text to any number to check Twilio is set up.
exports.testText = onCall({ secrets: TEXT_SECRETS }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in first.");
  const u = await db.doc(`users/${req.auth.uid}`).get();
  if (!u.exists || u.data().role !== "owner") throw new HttpsError("permission-denied", "Owners only.");
  const to = core.normPhone(req.data && req.data.to);
  if (!to) throw new HttpsError("invalid-argument", "Enter a 10-digit number.");
  const sid = TWILIO_SID.value(), token = TWILIO_TOKEN.value(), from = TWILIO_FROM.value();
  if (!sid || sid === "unset") throw new HttpsError("failed-precondition", "Texting isn't set up yet (Twilio secrets are unset).");
  const form = new URLSearchParams({ To: to, Body: "Ginger Sue's schedule: test text. Texting is working." });
  if (from.startsWith("MG")) form.set("MessagingServiceSid", from); else form.set("From", from);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpsError("internal", `Twilio said: ${j.message || r.status}`);
  return { ok: true, sid: j.sid };
});
