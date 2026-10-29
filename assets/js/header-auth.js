import { watchAuthState, logoutUser } from "./auth.js";

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

// Admin-only link to the continuous text page (view + edit all lessons).
const ADMIN_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";
watchAuthState((user) => {
  const menu = document.querySelector(".brand-menu");
  const old = document.getElementById("admin-text-link");
  if (!user || user.email !== ADMIN_EMAIL) { if (old) old.remove(); return; }
  if (!menu || old) return;
  const a = document.createElement("a");
  a.id = "admin-text-link";
  a.className = "dropdown-item";
  a.href = (location.pathname.includes("/lessons/") ? "../" : "") + "text";
  a.textContent = "טקסט";
  // last in the menu, below the account, set apart by a line
  menu.appendChild(a);
});
