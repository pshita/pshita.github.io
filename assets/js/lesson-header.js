// The site's header on a lesson page: the "📖 פשיטא" button with the same menu as
// every other page (site-menu.js). It looks the same thanks to site-header.css.
import { buildMenu, activateMenu } from "./site-menu.js?v=1";

const header = document.createElement("header");
header.className = "site-header";
header.innerHTML = '<div class="sh-wrap"></div>';
buildMenu({ up: "../", lessonHref: (id) => id, current: document.body.dataset.lesson }).then((menu) => {
  header.firstChild.appendChild(menu);
  document.body.prepend(header);
  return activateMenu();
});
