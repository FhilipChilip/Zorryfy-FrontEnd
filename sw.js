// Zorryfy — service worker de notificaciones push.
// Muestra «¿<email> es tu dirección de correo?» con dos botones y envía la
// respuesta al servidor con el token de un solo uso que trae la notificación.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  if (data.type !== "email-confirm") return;
  event.waitUntil(
    self.registration.showNotification(data.title || "Zorryfy", {
      body: data.body,
      tag: "zorryfy-email-confirm",
      renotify: true,
      requireInteraction: true,
      icon: "/static/icon.svg",
      data: { token: data.token, email: data.email },
      actions: [
        { action: "confirm", title: "Sí, es mío" },
        { action: "reject", title: "No es mi email" },
      ],
    })
  );
});

async function answer(token, accept) {
  const res = await fetch("/auth/email/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, accept }),
  });
  return res.ok ? (await res.json()).email_status : null;
}

async function windows() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

self.addEventListener("notificationclick", (event) => {
  const { token, email } = event.notification.data || {};
  event.notification.close();
  event.waitUntil((async () => {
    if (event.action === "confirm" || event.action === "reject") {
      const status = await answer(token, event.action === "confirm");
      (await windows()).forEach((c) => c.postMessage({ type: "email-status", status }));
      return;
    }
    // Clic en el cuerpo de la notificación: llevar al usuario a la app y preguntar allí
    const open = await windows();
    if (open.length) {
      open[0].postMessage({ type: "email-confirm-prompt", token, email });
      return open[0].focus();
    }
    return self.clients.openWindow("/");
  })());
});
