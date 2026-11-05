// Pull the page down from the top, a long way, to reload it. Only in the app opened from the
// home screen: there the phone has no pull-to-refresh of its own (a browser tab keeps its own).
const standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const PULL = 150;  // px the finger has to travel down: a long pull, not a scroll that bounces

if (standalone && !window.PULL_REFRESH) {
  window.PULL_REFRESH = true;
  const css = document.createElement("style");
  css.textContent = `
    .pull-refresh { position: fixed; top: 0; left: 50%; z-index: 9999; width: 38px; height: 38px; margin-left: -19px;
      border-radius: 50%; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.18); display: grid; place-items: center;
      transform: translateY(-48px); opacity: 0; pointer-events: none; color: #8a6d3b; font: 22px/1 system-ui, sans-serif; }
    .pull-refresh.ready { background: #8a6d3b; color: #fff; }
    .pull-refresh.go span { animation: pull-spin .8s linear infinite; }
    @keyframes pull-spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(css);
  const dot = document.createElement("div");
  dot.className = "pull-refresh";
  dot.innerHTML = "<span>↻</span>";
  const arrow = dot.firstChild;

  let startY = null, dy = 0;
  // the touch begins where nothing above it can scroll up any more
  const atTop = (el) => {
    if ((document.scrollingElement || document.documentElement).scrollTop > 0) return false;
    for (; el && el !== document.body; el = el.parentElement) {
      if (el.scrollTop > 0) return false;
      if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
    }
    return true;
  };
  const show = (d) => {
    const p = Math.min(d / PULL, 1);
    if (!dot.isConnected) document.body.appendChild(dot);
    dot.style.transform = `translateY(${-48 + p * 80}px)`;
    dot.style.opacity = String(Math.min(1, p * 1.5));
    arrow.style.transform = `rotate(${p * 300}deg)`;
    dot.classList.toggle("ready", d >= PULL);
  };
  const hide = () => { dot.style.transition = "transform .2s, opacity .2s"; dot.style.opacity = "0"; dot.style.transform = "translateY(-48px)"; };

  addEventListener("touchstart", (e) => {
    startY = e.touches.length === 1 && atTop(e.target) ? e.touches[0].clientY : null;
    dy = 0;
    dot.style.transition = "";
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (startY === null) return;
    if (e.touches.length !== 1) { startY = null; hide(); return; }
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) { if (dy < -10) { startY = null; hide(); } return; }
    show(dy);
  }, { passive: true });
  const end = () => {
    if (startY === null) return;
    startY = null;
    if (dy >= PULL) {
      dot.classList.add("go");
      arrow.style.transform = "";
      location.reload();
    } else hide();
  };
  addEventListener("touchend", end, { passive: true });
  addEventListener("touchcancel", () => { startY = null; hide(); }, { passive: true });
}
