// Generic dropdown toggle for the brand menu and the home page lesson groups
(function () {
  var dropdowns = document.querySelectorAll(".dropdown");
  dropdowns.forEach(function (dropdown) {
    var trigger = dropdown.querySelector(".dropdown-trigger");
    var menu = dropdown.querySelector(".dropdown-menu");
    if (!trigger || !menu) return;
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var willOpen = menu.hidden;
      document.querySelectorAll(".dropdown-menu").forEach(function (m) {
        m.hidden = true;
      });
      menu.hidden = !willOpen;
    });
  });
  document.addEventListener("click", function () {
    document.querySelectorAll(".dropdown-menu").forEach(function (m) {
      m.hidden = true;
    });
  });
})();

// The per-page ("דף ב, עמוד א" ...) lesson submenus nested inside the brand menu. Separate
// from the generic dropdown toggle above: that one closes every open
// .dropdown-menu before opening one, which would hide this submenu's own
// ancestor (the brand menu) right along with it. The document-level
// click-outside handler above still closes this submenu too, since it
// targets every .dropdown-menu regardless of how it was opened.
(function () {
  document.querySelectorAll(".submenu-trigger").forEach(function (trigger) {
    var panel = trigger.parentElement.querySelector(".submenu-panel");
    if (!panel) return;
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var willOpen = panel.hidden;
      // One page/amud open at a time inside the menu.
      var menu = trigger.closest(".brand-menu");
      if (willOpen && menu) {
        menu.querySelectorAll(".submenu-panel").forEach(function (p) { p.hidden = true; });
      }
      panel.hidden = !willOpen;
    });
  });
})();
