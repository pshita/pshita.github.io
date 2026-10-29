import { watchAuthState, logoutUser, getDb } from "./auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import "./student.js";  // tells the student when a message was sent to the parents

const loggedOutEl = document.getElementById("auth-area-out");
const loggedInEl = document.getElementById("auth-area-in");
const logoutBtn = document.getElementById("logout-btn");
const userNameEl = document.getElementById("auth-user-name");

if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await logoutUser();
    window.location.reload();
  });
}

watchAuthState((user) => {
  const isLoggedIn = Boolean(user);
  if (loggedOutEl) loggedOutEl.hidden = isLoggedIn;
  if (loggedInEl) loggedInEl.hidden = !isLoggedIn;
  if (userNameEl) userNameEl.textContent = isLoggedIn && user.displayName ? `שלום ${user.displayName}` : "";
});

// Admin-only links at the end of the menu: the continuous text page (view + edit
// all lessons) and the admin page (students, parent messages).
const ADMIN_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";
watchAuthState((user) => {
  const menu = document.querySelector(".brand-menu");
  const old = document.getElementById("admin-text-link");
  if (!user || user.email !== ADMIN_EMAIL) { if (old) old.remove(); document.getElementById("admin-page-link")?.remove(); return; }
  if (!menu || old) return;
  const up = location.pathname.includes("/lessons/") ? "../" : "";
  // last in the menu, below the account, set apart by a line
  [["admin-text-link", "text", "טקסט"], ["admin-page-link", "admin", "ניהול"]].forEach(([id, href, label]) => {
    const a = document.createElement("a");
    a.id = id;
    a.className = "dropdown-item";
    a.href = up + href;
    a.textContent = label;
    menu.appendChild(a);
  });
});

// Students see in the menu only the lessons the admin marked as goals on the admin
// page ("יעדים": settings/goals). None marked: every lesson. The admin sees them all.
watchAuthState(async (user) => {
  const menu = document.querySelector(".brand-menu");
  if (!menu) return;
  let ids = null;
  if (user && user.email !== ADMIN_EMAIL) {
    try {
      const snap = await getDoc(doc(getDb(), "settings", "goals"));
      const v = snap.exists() ? snap.data().lessons : null;
      if (Array.isArray(v) && v.length) ids = new Set(v);
    } catch (e) {}
  }
  menu.querySelectorAll(".submenu").forEach((sub) => {
    let any = false;
    sub.querySelectorAll(".submenu-panel a.dropdown-item").forEach((a) => {
      const id = (a.getAttribute("href") || "").split("/").pop().replace(/\.html$/, "");
      a.hidden = Boolean(ids) && !ids.has(id);
      any = any || !a.hidden;
    });
    sub.hidden = !any;
  });
});

// A ✓ next to each lesson the signed-in user finished with all its questions, one
// for each time (users/{uid}/progress/lessons, see student.js): in the menu and on
// the home page's lesson cards.
watchAuthState(async (user) => {
  document.querySelectorAll(".done-marks").forEach((m) => m.remove());
  if (!user) return;
  let lessons = {};
  try {
    const snap = await getDoc(doc(getDb(), "users", user.uid, "progress", "lessons"));
    lessons = (snap.exists() && snap.data().lessons) || {};
  } catch (e) { return; }
  document.querySelectorAll(".brand-menu a.dropdown-item, a.lesson-card").forEach((a) => {
    const id = (a.getAttribute("href") || "").split("/").pop().replace(/\.html$/, "");
    const n = (lessons[id] && lessons[id].times) || 0;
    if (!n) return;
    const marks = document.createElement("span");
    marks.className = "done-marks";
    marks.textContent = " " + "✓".repeat(Math.min(n, 10));
    (a.querySelector("h3") || a).appendChild(marks);
  });
});
