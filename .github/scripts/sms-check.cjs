// One-off check of the daily parent messages: per student (no names or phones), the
// answers counted, where "today" starts, whether messages are on, and today's archive.
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
initializeApp({ projectId: "avot-926d7" });
const db = getFirestore();
const timesOf = (v) => (v === true ? 1 : Number.isFinite(v) && v > 0 ? Math.min(v, 3) : 0);
(async () => {
  const sms = (await db.doc("settings/sms").get()).data() || {};
  console.log("settings: step", sms.step, "enabled", sms.enabled, "sender is phone", /^0\d{8,9}$/.test(sms.sender || ""), "template has {היום}", String(sms.template || "").includes("{היום}"));
  const users = await db.collection("users").get();
  for (const u of users.docs) {
    const v = u.data(), q = await u.ref.collection("progress").doc("quiz").get();
    const total = Object.values((q.exists && q.get("sections")) || {}).reduce((n, x) => n + timesOf(x), 0);
    console.log(u.id.slice(0, 5), "total", total, "smsBase", v.smsBase, "today", Number.isInteger(v.smsBase) ? total - v.smsBase : "-",
      "mode", v.smsMode || "default", "notify", v.notify, "phones", [v.fatherPhone, v.motherPhone, v.childPhone].filter(Boolean).length,
      "quizUpdated", q.exists ? q.get("updatedAt") : "-", "lastSms", v.lastSms ? `${v.lastSms.at} count ${v.lastSms.count}` : "-",
      "smsSentFor", v.smsSentFor, "smsStep", v.smsStep);
    const t = await u.ref.collection("progress").doc("time").get(), days = (t.exists && t.get("days")) || {};
    console.log("   time by day (min):", Object.entries(days).sort().slice(-4).map(([d, x]) => `${d}:${Math.round(x / 60)}`).join(" "),
      "| correct by day:", JSON.stringify((q.exists && q.get("days")) || {}));
  }
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const log = await db.collection("smsLog").where("at", ">=", since).get();
  console.log("smsLog since", since, ":", log.size);
  log.forEach((d) => { const x = d.data(); console.log(" ", x.at, x.kind, "ok", x.ok, x.error || ""); });
})().catch((e) => { console.error(e); process.exit(1); });
