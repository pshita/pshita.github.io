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

export async function registerUser({ firstName, lastName, fatherPhone, motherPhone, password }) {
  if (!isFirebaseConfigured) {
    throw new Error("ההרשמה עדיין לא מוגדרת באתר. נסו שוב מאוחר יותר.");
  }
  const email = await nameToEmail(firstName, lastName);
  let credential;
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
  onAuthStateChanged(auth, callback);
}
