// Zorryfy — decoraciones de Halloween (estilo geométrico, no tradicional)
// que reaccionan al cursor dentro de un radio de 150 px:
//   🎃 calabazas: huyen del cursor y crecen a 1.3x
//   🦇 murciélagos: muy cerca (<75 px) se alejan; entre 75 y 150 px se acercan
//   🧙 sombreros: rotan y ganan opacidad según la cercanía
(() => {
  const RADIUS = 150;
  const layer = document.getElementById("decor");
  if (!layer) return;

  const SVG = {
    pumpkin: `<svg viewBox="0 0 70 62"><defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffa733"/><stop offset="1" stop-color="#e06a00"/></linearGradient></defs>
      <path d="M33 4c3-3 8-3 9 1l-3 9h-6z" fill="#5a2d8c"/>
      <ellipse cx="20" cy="38" rx="16" ry="21" fill="url(#pg)"/><ellipse cx="50" cy="38" rx="16" ry="21" fill="url(#pg)"/>
      <ellipse cx="35" cy="38" rx="16" ry="23" fill="#ff8c00"/>
      <path d="M35 16v44M24 18c-4 12-4 28 0 40M46 18c4 12 4 28 0 40" stroke="#c45c00" stroke-width="1.5" fill="none" opacity=".55"/></svg>`,
    bat: `<svg viewBox="0 0 64 32"><g class="float">
      <path class="wing" d="M32 14C26 6 14 2 2 6c6 2 9 6 9 11 4-3 8-3 11 0 2-3 6-4 10-3z" fill="#2f1650"/>
      <path class="wing" d="M32 14c6-8 18-12 30-8-6 2-9 6-9 11-4-3-8-3-11 0-2-3-6-4-10-3z" fill="#2f1650"/>
      <ellipse cx="32" cy="17" rx="6" ry="8" fill="#22103a"/><path d="M27 10l2 4h6l2-4-3 2h-4z" fill="#22103a"/>
      <circle cx="29.5" cy="16" r="1.4" fill="#ff8c00"/><circle cx="34.5" cy="16" r="1.4" fill="#ff8c00"/></g></svg>`,
    hat: `<svg viewBox="0 0 64 64"><path d="M8 50c8-4 40-4 48 0-6 5-42 5-48 0z" fill="#22103a"/>
      <path d="M18 48c2-14 8-28 22-40-2 8 0 12 4 14-6 6-8 16-6 26z" fill="#5a2d8c"/>
      <path d="M19 43c6-2 14-2 20 0l-1 5c-6-1-12-1-18 0z" fill="#ff8c00"/></svg>`,
  };

  const items = [];
  function place(kind, count) {
    for (let i = 0; i < count; i++) {
      const el = document.createElement("div");
      el.className = `deco ${kind}`;
      el.innerHTML = SVG[kind];
      // Repartidas por toda la ventana, evitando el centro exacto
      el.style.left = `${5 + Math.random() * 88}%`;
      el.style.top = `${6 + Math.random() * 86}%`;
      layer.appendChild(el);
      items.push({ el, kind, phase: Math.random() * Math.PI * 2 });
    }
  }
  place("pumpkin", 6);
  place("bat", 7);
  place("hat", 5);

  let mouse = null;
  let scheduled = false;
  window.addEventListener("mousemove", (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    if (!scheduled) { scheduled = true; requestAnimationFrame(update); }
  }, { passive: true });
  window.addEventListener("mouseleave", () => { mouse = null; requestAnimationFrame(update); });

  function update() {
    scheduled = false;
    for (const item of items) {
      const el = item.el;
      if (!mouse) { el.style.transform = ""; el.style.opacity = ""; el.classList.remove("near"); continue; }
      // Centro "de reposo" (sin la transformación actual)
      const rect = el.getBoundingClientRect();
      const t = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const cx = rect.left + rect.width / 2 - t.m41;
      const cy = rect.top + rect.height / 2 - t.m42;
      const dx = cx - mouse.x;
      const dy = cy - mouse.y;
      const dist = Math.hypot(dx, dy) || 1;
      const near = dist < RADIUS;
      const k = near ? 1 - dist / RADIUS : 0; // 0 lejos … 1 encima
      const ux = dx / dist;
      const uy = dy / dist;

      if (item.kind === "pumpkin") {
        const push = 70 * k;
        el.style.transform = near
          ? `translate(${ux * push}px, ${uy * push}px) scale(1.3) rotate(${ux * 12 * k}deg)`
          : "";
        el.style.opacity = near ? 1 : "";
        el.classList.toggle("near", near);
      } else if (item.kind === "bat") {
        // <75 px huyen; 75-150 px se acercan con curiosidad
        const dir = dist < RADIUS / 2 ? 1 : -0.5;
        const move = 60 * k * dir;
        el.style.transform = near
          ? `translate(${ux * move}px, ${uy * move - 10 * k}px) scale(${1 + 0.25 * k}) rotate(${-ux * 20 * k}deg)`
          : "";
        el.style.opacity = near ? 0.75 + 0.25 * k : "";
      } else {
        const angle = Math.atan2(dy, dx) * 180 / Math.PI;
        el.style.transform = near ? `rotate(${(angle / 6) * k + 25 * k}deg) scale(${1 + 0.2 * k})` : "";
        el.style.opacity = near ? 0.35 + 0.65 * k : "";
      }
    }
  }
})();
