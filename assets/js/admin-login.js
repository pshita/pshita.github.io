// The admin signs in here, on the text page and the admin page (not from the site's
// sign-in list): a password over the whole page until the admin is signed in.
import { loginWithEmail } from "./auth.js";

const ADMIN_EMAIL = "ufd5a4a70e876fc8672e3d112e6866c55@arba-avot-users.local";
let box = null;

export function showAdminLogin() {
  if (box) { box.hidden = false; box.querySelector("input[type=password]").focus(); return; }
  const css = document.createElement("style");
  css.textContent = `.adm-login{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:#faf6ee;padding:16px;font-family:"Rubik","Heebo",Arial,sans-serif}
.adm-login[hidden]{display:none}
.adm-login form{display:flex;flex-direction:column;gap:12px;width:min(320px,100%)}
.adm-login label{display:flex;flex-direction:column;gap:6px;font-weight:600;color:#2b241b}
.adm-login input{font:inherit;font-size:16px;padding:10px 12px;border:1px solid #d9cfbd;border-radius:10px;background:#fff}
.adm-login button{font:inherit;font-weight:700;padding:10px;border:0;border-radius:10px;background:#2b241b;color:#fff;cursor:pointer}
.adm-login button:disabled{opacity:.6}
.adm-login .err{margin:0;color:#b23b2e;font-size:.9rem}`;
  document.head.appendChild(css);
  box = document.createElement("div");
  box.className = "adm-login";
  box.innerHTML = `<form><input type="text" name="username" value="ניהול" autocomplete="username" hidden>
    <label>סיסמה <input type="password" name="password" autocomplete="current-password" required></label>
    <button type="submit">כניסה</button><p class="err" hidden></p></form>`;
  document.body.appendChild(box);
  const form = box.querySelector("form"), err = box.querySelector(".err"), btn = box.querySelector("button");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    try {
      await loginWithEmail(ADMIN_EMAIL, form.password.value);
      box.hidden = true;  // the page goes on once it sees the admin signed in
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
    }
    btn.disabled = false;
  });
  box.querySelector("input[type=password]").focus();
}

export function hideAdminLogin() { if (box) box.hidden = true; }
