import { watchAuthState, logoutUser } from "./auth.js";
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
