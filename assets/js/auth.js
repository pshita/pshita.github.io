import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

// Firebase Auth needs an email + a 6+ character password. Users only enter a
// first/last name and a password of 4+ characters (once a 4-digit PIN), so both
// are turned into values Firebase will accept:
// - the email is a deterministic hash of the normalized name, so login can
//   recompute the same value from the name alone (no separate lookup table).
// - the password is padded with a fixed suffix to clear the 6-character minimum.
//   This is NOT extra security (the suffix is public, right here); it only
//   satisfies Firebase's API requirement so a short password can be used.
const EMAIL_DOMAIN = "arba-avot-users.local";
const PIN_PAD_SUFFIX = "-avot-pin";

let app = null;
let auth = null;
let db = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

// Students are signed out automatically (the admin stays signed in): when the site was
// closed (a new browser session: nothing in sessionStorage) and after IDLE_MS with no
// use of the site in any tab (the last use is kept in localStorage).
const ADMIN_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";
const SESSION_KEY = "pshita.session", ACTIVE_KEY = "pshita.lastActive", IDLE_MS = 30 * 60 * 1000;
const store = (s, k, v) => { try { if (v === undefined) return s.getItem(k); s.setItem(k, v); } catch (e) { return null; } return null; };
function markActive() {
  store(sessionStorage, SESSION_KEY, "1");
  store(localStorage, ACTIVE_KEY, String(Date.now()));
}
function expired(user) {
  if (!user || user.email === ADMIN_EMAIL) return false;
  const last = +store(localStorage, ACTIVE_KEY) || 0;
  return !store(sessionStorage, SESSION_KEY) || Date.now() - last > IDLE_MS;
}
if (isFirebaseConfigured) {
  let lastMark = 0;
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((t) => addEventListener(t, () => {
    // signed in and still within the time: this use counts (at most every few seconds)
    if (!auth.currentUser || expired(auth.currentUser) || Date.now() - lastMark < 5000) return;
    lastMark = Date.now();
    markActive();
  }, { passive: true, capture: true }));
  const check = () => { if (expired(auth.currentUser)) signOut(auth); };
  onAuthStateChanged(auth, check);
  setInterval(check, 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
}

function normalizeName(name) {
  return String(name || "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function nameToEmail(firstName, lastName) {
  const key = `${normalizeName(firstName)}|${normalizeName(lastName)}`;
  const bytes = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `u${hashHex.slice(0, 32)}@${EMAIL_DOMAIN}`;
}

function pinToPassword(pin) {
  return `${pin}${PIN_PAD_SUFFIX}`;
}

export function isReady() {
  return isFirebaseConfigured;
}

export function getDb() {
  return db;
}

export function getApp() {
  return app;
}

export function getAuthInstance() {
  return auth;
}

export async function registerUser({ firstName, lastName, fatherPhone, motherPhone, childPhone = "", password }) {
  if (!isFirebaseConfigured) {
    throw new Error("ההרשמה עדיין לא מוגדרת באתר. נסו שוב מאוחר יותר.");
  }
  const email = await nameToEmail(firstName, lastName);
  let credential;
  markActive();
  try {
    credential = await createUserWithEmailAndPassword(auth, email, pinToPassword(password));
  } catch (err) {
    if (err.code === "auth/email-already-in-use") {
      throw new Error("כבר קיים משתמש רשום עם השם הזה. אם זה אתה, נסו להתחבר במקום להירשם.");
    }
    throw new Error("ההרשמה נכשלה, נסו שוב.");
  }

  await updateProfile(credential.user, { displayName: `${firstName} ${lastName}` });

  await setDoc(doc(db, "users", credential.user.uid), {
    firstName,
    lastName,
    fatherPhone,
    motherPhone,
    ...(childPhone ? { childPhone } : {}),
    createdAt: new Date().toISOString(),
  });

  return credential.user;
}

// Login from the list of users (see listUsers in functions/index.js): the
// account's email comes from the list, the user types only the password.
export async function loginWithEmail(email, password) {
  if (!isFirebaseConfigured) {
    throw new Error("ההתחברות עדיין לא מוגדרת באתר. נסו שוב מאוחר יותר.");
  }
  markActive();
  try {
    await signInWithEmailAndPassword(auth, email, pinToPassword(password));
  } catch (err) {
    if (err.code === "auth/too-many-requests") throw new Error("היו יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.");
    throw new Error("הסיסמה שגויה.");
  }
}

export async function logoutUser() {
  if (!isFirebaseConfigured) return;
  await signOut(auth);
}

export function watchAuthState(callback) {
  if (!isFirebaseConfigured) {
    callback(null);
    return;
  }
  // a student whose time ran out counts as signed out (the sign-out itself follows)
  onAuthStateChanged(auth, (user) => callback(expired(user) ? null : user));
}
