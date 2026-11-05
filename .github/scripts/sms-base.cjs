// One-off, by hand: set where "today" starts for some students (users/{uid}.smsBase), given as
// "uidPrefix=number,uidPrefix=number". No names or phones printed.
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
initializeApp({ projectId: "avot-926d7" });
const db = getFirestore();
(async () => {
  const pairs = String(process.env.BASES || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split("="));
  const users = await db.collection("users").get();
  for (const [prefix, n] of pairs) {
    const hits = users.docs.filter((u) => u.id.startsWith(prefix));
    if (hits.length !== 1 || !/^\d+$/.test(n)) throw new Error(`bad pair ${prefix}=${n} (${hits.length} students)`);
    await hits[0].ref.update({ smsBase: Number(n) });
    console.log(prefix, "smsBase", n);
  }
})().catch((e) => { console.error(e); process.exit(1); });
