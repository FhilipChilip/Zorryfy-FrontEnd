// Zorryfy — interfaz principal.
// Flujo: Login -> 2FA (Google Authenticator) -> Términos -> Reproductor.
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "zorryfy_token";
  const STORAGE_LIMIT_MB = 200;

  const state = {
    config: { demo_mode: false, terms_version: null },
    token: null,
    user: null,
    mfaToken: null,
    termsToken: null,
    termsFor: null,          // "login" | "register"
    setupToken: null,
    useRecovery: false,
    queue: { items: [], pointers: {}, buffer: {} },
    loadedTrackId: null,
    blobUrls: new Map(),
    dragFrom: null,
    playlists: [],
    openPlaylist: null,      // detalle de la playlist abierta (o null = vista de cola)
    coverUrls: new Map(),    // cover_url -> blob URL (las portadas requieren el token)
    newCover: null,          // File elegido en el modal de crear playlist
    emailPrompt: null,       // { token, email } recibido desde la notificación
  };

  // ------------------------------------------------------------ utilidades
  function storage() { try { return window.sessionStorage; } catch { return null; } }
  function saveToken(token) { state.token = token; const s = storage(); if (s) token ? s.setItem(TOKEN_KEY, token) : s.removeItem(TOKEN_KEY); }

  async function api(path, { method = "GET", body, form, auth = true } = {}) {
    const headers = {};
    if (auth && state.token) headers.Authorization = "Bearer " + state.token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && auth && state.token) { sessionExpired(); }
    if (!res.ok) {
      throw new Error(Array.isArray(data.detail) ? "Revisa los datos del formulario" : (data.detail || `Error ${res.status}`));
    }
    return data;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function toast(text, kind = "") {
    const t = el("div", `toast ${kind}`, text);
    $("toasts").appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, 3800);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) return "0:00";
    const m = Math.floor(sec / 60);
    return `${m}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  }

  // ------------------------------------------------------------ modales
  const MODALS = ["m-login", "m-mfa", "m-terms", "m-register", "m-setup", "m-recovery", "m-qr", "m-playlist", "m-email"];
  function openModal(id, focusId) {
    MODALS.forEach((m) => $(m).classList.toggle("hidden", m !== id));
    document.querySelectorAll(".error").forEach((e) => { e.textContent = ""; });
    if (focusId) setTimeout(() => $(focusId).focus(), 60);
  }
  function closeModals() { MODALS.forEach((m) => $(m).classList.add("hidden")); }
  function showError(id, msg, inputId) {
    $(id).textContent = "";
    requestAnimationFrame(() => { $(id).textContent = msg; });
    if (inputId) { $(inputId).classList.add("invalid"); $(inputId).select?.(); }
  }
  document.addEventListener("input", (e) => e.target.classList?.remove("invalid"));
  document.querySelectorAll("[data-back-login]").forEach((b) => { b.onclick = () => openModal("m-login", "login-user"); });
  document.querySelectorAll("[data-close]").forEach((b) => { b.onclick = closeModals; });

  // ------------------------------------------------------------ login
  $("form-login").onsubmit = async (e) => {
    e.preventDefault();
    const username = $("login-user").value.trim();
    const password = $("login-pass").value;
    if (!username || !password) return showError("login-error", "Escribe tu nombre de usuario y tu contraseña");
    try {
      const data = await api("/auth/login", { method: "POST", body: { username, password }, auth: false });
      $("login-pass").value = "";
      if (data.status === "mfa_setup_required") return showSetup(data);
      state.mfaToken = data.mfa_token;
      setRecoveryMode(false);
      $("mfa-code").value = "";
      openModal("m-mfa", "mfa-code");
    } catch (err) { showError("login-error", err.message, "login-pass"); }
  };
  $("to-register").onclick = () => openModal("m-register", "reg-user");

  // ------------------------------------------------------------ 2FA del login
  function setRecoveryMode(on) {
    state.useRecovery = on;
    $("mfa-code-field").classList.toggle("hidden", on);
    $("mfa-recovery-field").classList.toggle("hidden", !on);
    $("mfa-toggle").textContent = on ? "Usar Google Authenticator" : "Usar un código de respaldo";
  }
  $("mfa-toggle").onclick = () => { setRecoveryMode(!state.useRecovery); $(state.useRecovery ? "mfa-recovery" : "mfa-code").focus(); };
  $("mfa-code").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    if (e.target.value.length === 6) $("form-mfa").requestSubmit();
  });

  $("form-mfa").onsubmit = async (e) => {
    e.preventDefault();
    const body = { mfa_token: state.mfaToken };
    if (state.useRecovery) body.recovery_code = $("mfa-recovery").value.trim();
    else body.code = $("mfa-code").value.trim();
    if (!body.code && !body.recovery_code) return showError("mfa-error", "Escribe el código");
    try {
      const data = await api("/auth/login/verify", { method: "POST", body, auth: false });
      if (data.status === "terms_required") {
        state.termsToken = data.terms_token;
        return showTerms("login", data.terms);
      }
      enterApp(data);
    } catch (err) {
      showError("mfa-error", err.message, state.useRecovery ? "mfa-recovery" : "mfa-code");
      if (/expir/i.test(err.message)) setTimeout(() => openModal("m-login", "login-user"), 1600);
    }
  };

  // ------------------------------------------------------------ términos
  async function showTerms(forWhat, terms) {
    state.termsFor = forWhat;
    if (!terms) terms = await api("/auth/terms", { auth: false });
    $("terms-version").textContent = terms.version;
    const box = $("terms-sections");
    box.replaceChildren(...terms.sections.map((s) => {
      const sec = el("div", "terms-section");
      sec.append(el("h3", "", s.title), el("p", "", s.body));
      return sec;
    }));
    $("terms-check").checked = false;
    $("terms-accept").disabled = true;
    openModal("m-terms");
  }
  $("terms-check").onchange = (e) => { $("terms-accept").disabled = !e.target.checked; };
  $("terms-reject").onclick = () => {
    toast("Debes aceptar los Términos y Condiciones para usar Zorryfy.", "err");
    openModal(state.termsFor === "register" ? "m-register" : "m-login");
  };
  $("terms-accept").onclick = async () => {
    if (!$("terms-check").checked) return;
    $("terms-accept").disabled = true;
    try {
      if (state.termsFor === "register") {
        const data = await api("/auth/register", {
          method: "POST", auth: false,
          body: {
            username: $("reg-user").value.trim(), email: $("reg-email").value.trim(), password: $("reg-pass").value,
            accept_terms: true, terms_version: state.config.terms_version,
          },
        });
        $("reg-pass").value = "";
        showSetup(data);
      } else {
        const data = await api("/auth/terms/accept", {
          method: "POST", auth: false,
          body: { terms_token: state.termsToken, accept_terms: true, terms_version: $("terms-version").textContent },
        });
        enterApp(data);
      }
    } catch (err) {
      $("terms-accept").disabled = false;
      if (state.termsFor === "register") { openModal("m-register"); showError("register-error", err.message); }
      else showError("terms-error", err.message);
    }
  };

  // ------------------------------------------------------------ registro
  $("form-register").onsubmit = (e) => {
    e.preventDefault();
    const user = $("reg-user").value.trim(), email = $("reg-email").value.trim(), pass = $("reg-pass").value;
    if (user.replace(/\s+/g, " ").length < 2) return showError("register-error", "El nombre de usuario necesita al menos 2 caracteres", "reg-user");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showError("register-error", "Email inválido", "reg-email");
    if (pass.length < 8 || !/[A-Za-z]/.test(pass) || !/\d/.test(pass)) return showError("register-error", "La contraseña necesita 8+ caracteres, una letra y un número", "reg-pass");
    showTerms("register").catch((err) => showError("register-error", err.message));
  };

  function showSetup(data) {
    state.setupToken = data.setup_token;
    $("setup-qr").src = data.qr_svg;
    $("setup-secret").textContent = data.totp_secret.match(/.{1,4}/g).join(" ");
    $("setup-code").value = "";
    openModal("m-setup", "setup-code");
  }
  $("setup-code").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });
  $("form-setup").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const data = await api("/auth/2fa/confirm", { method: "POST", auth: false, body: { setup_token: state.setupToken, code: $("setup-code").value } });
      $("recovery-codes").replaceChildren(...data.recovery_codes.map((c) => el("span", "", c)));
      openModal("m-recovery");
    } catch (err) { showError("setup-error", err.message, "setup-code"); }
  };
  $("recovery-copy").onclick = async () => {
    const text = [...$("recovery-codes").children].map((c) => c.textContent).join("\n");
    try { await navigator.clipboard.writeText(text); toast("Códigos copiados", "ok"); } catch { toast("No se pudo copiar; anótalos a mano", "err"); }
  };
  $("recovery-done").onclick = () => { openModal("m-login", "login-user"); toast("Google Authenticator vinculado. Ya puedes iniciar sesión.", "ok"); };

  // ------------------------------------------------------------ QR con sesión
  $("nav-qr").onclick = () => {
    $("qr-ask").classList.remove("hidden");
    $("qr-show").classList.add("hidden");
    $("qr-pass").value = "";
    openModal("m-qr", "qr-pass");
  };
  $("form-qr").onsubmit = async (e) => {
    e.preventDefault();
    if ($("qr-ask").classList.contains("hidden")) return;
    try {
      const data = await api("/auth/2fa/qr", { method: "POST", body: { password: $("qr-pass").value } });
      $("qr-pass").value = "";
      $("qr-img").src = data.qr_svg;
      $("qr-secret").textContent = data.totp_secret.match(/.{1,4}/g).join(" ");
      $("qr-ask").classList.add("hidden");
      $("qr-show").classList.remove("hidden");
    } catch (err) { showError("qr-error", err.message, "qr-pass"); }
  };

  // ------------------------------------------------------------ sesión
  function enterApp(data) {
    saveToken(data.access_token);
    startApp(data.user);
    toast(`Sesión válida hasta las ${new Date(data.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "ok");
  }

  function startApp(user) {
    state.user = user;
    $("user-name").textContent = user.username;
    closeModals();
    $("app").classList.remove("hidden");
    $("search").disabled = false;
    showQueueView();
    refreshQueue();
    refreshPlaylists();
    updateEmailBanner(user);
  }

  function sessionExpired() {
    resetApp();
    openModal("m-login", "login-user");
    toast("Tu sesión terminó. Inicia sesión de nuevo.", "err");
  }

  function resetApp() {
    saveToken(null);
    state.user = null;
    $("audio").pause();
    $("audio").removeAttribute("src");
    state.loadedTrackId = null;
    state.blobUrls.forEach((url) => URL.revokeObjectURL(url));
    state.blobUrls.clear();
    state.coverUrls.forEach((url) => URL.revokeObjectURL(url));
    state.coverUrls.clear();
    state.playlists = [];
    state.openPlaylist = null;
    $("email-banner").classList.add("hidden");
    $("app").classList.add("hidden");
  }

  $("logout").onclick = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    resetApp();
    openModal("m-login", "login-user");
  };

  // ------------------------------------------------------------ subida (drag & drop)
  $("nav-upload").onclick = () => $("file-input").click();
  $("nav-queue").onclick = () => showQueueView();
  $("dropzone").onclick = () => $("file-input").click();
  $("dropzone").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); } };
  $("file-input").onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ""; };

  // Arrastrar desde el Explorador de Windows: se escucha en toda la ventana
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || !state.user) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = state.user ? "copy" : "none"; } });
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    if (e.target.closest?.(".cover-picker, .pl-cover-btn, .modal")) return;  // lo maneja la portada
    if (state.user) uploadFiles([...e.dataTransfer.files]);
  });

  function uploadFiles(files) {
    const mp3 = files.filter((f) => /\.mp3$/i.test(f.name));
    const skipped = files.length - mp3.length;
    if (skipped) toast(`${skipped} archivo(s) ignorado(s): solo se aceptan .mp3`, "err");
    if (!mp3.length) return;
    const tooBig = mp3.filter((f) => f.size > 25 * 1024 * 1024);
    tooBig.forEach((f) => toast(`${f.name}: supera 25 MB`, "err"));
    const ok = mp3.filter((f) => f.size <= 25 * 1024 * 1024);
    if (!ok.length) return;

    const form = new FormData();
    ok.forEach((f) => form.append("files", f, f.name));
    // XHR para mostrar el progreso de subida
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/library/upload");
    xhr.setRequestHeader("Authorization", "Bearer " + state.token);
    $("uploading").classList.remove("hidden");
    $("upload-label").textContent = `Subiendo ${ok.length} canción(es)…`;
    $("upload-meter").style.width = "0%";
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) $("upload-meter").style.width = `${(e.loaded / e.total) * 100}%`; };
    xhr.onload = () => {
      $("uploading").classList.add("hidden");
      if (xhr.status === 401) return sessionExpired();
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 400) return toast(data.detail || `Error ${xhr.status}`, "err");
      if (data.added?.length) toast(`${data.added.length} canción(es) añadidas a la cola`, "ok");
      (data.errors || []).forEach((er) => toast(er.error, "err"));
      applyQueue(data.queue);
    };
    xhr.onerror = () => { $("uploading").classList.add("hidden"); toast("Error de red al subir", "err"); };
    xhr.send(form);
  }

  // ------------------------------------------------------------ cola
  async function refreshQueue() {
    try { applyQueue(await api("/api/queue")); } catch {}
  }
  async function queueAction(path, body) {
    try { applyQueue(await api(path, { method: path === "/api/queue" ? "DELETE" : "POST", body })); } catch (err) { toast(err.message, "err"); }
  }

  function applyQueue(q) {
    if (!q) return;
    state.queue = q;
    const { items, pointers, buffer } = q;
    const cur = pointers.current;
    const empty = items.length === 0;

    // Cola vacía: solo "Sube tus canciones aquí"; con pistas, la zona se compacta
    $("dropzone").classList.toggle("compact", !empty);
    $("dropzone").querySelector("h3").textContent = empty ? "Sube tus canciones aquí" : "Arrastra más canciones aquí";
    $("dropzone").querySelector("p").classList.toggle("hidden", !empty);
    $("queue-actions").classList.toggle("hidden", empty);
    $("queue-count").textContent = empty ? "" : `${items.length} pista(s)`;

    const list = $("queue");
    list.replaceChildren(...items.map((t, i) => {
      const li = el("li", "track" + (i === cur ? " current" : i < cur ? " played" : ""));
      li.draggable = true;
      li.dataset.pos = i;
      li.style.animationDelay = `${Math.min(i, 10) * 25}ms`;
      const info = el("div");
      info.append(el("div", "title", t.title), el("div", "artist", t.artist));
      const add = el("button", "icon-btn", "+");
      add.type = "button";
      add.title = "Añadir a una playlist";
      add.setAttribute("aria-label", `Añadir ${t.title} a una playlist`);
      add.onclick = (e) => { e.stopPropagation(); openPlaylistPopover(add, [t.id]); };
      li.append(el("span", "pos", i === cur ? "▶" : String(i + 1)), info, el("span", "dur", fmtTime(t.duration_seconds)), add);
      li.onclick = () => { queueAction("/api/queue/jump", { position: i }).then(() => playCurrent()); };
      li.ondragstart = (e) => { state.dragFrom = i; li.classList.add("drag-src"); e.dataTransfer.setData("text/x-zorryfy", String(i)); e.dataTransfer.effectAllowed = "move"; };
      li.ondragend = () => { state.dragFrom = null; li.classList.remove("drag-src"); };
      li.ondragover = (e) => { if (state.dragFrom !== null) { e.preventDefault(); li.classList.add("drag-over"); } };
      li.ondragleave = () => li.classList.remove("drag-over");
      li.ondrop = (e) => {
        if (state.dragFrom === null) return;
        e.preventDefault();
        e.stopPropagation();
        li.classList.remove("drag-over");
        if (state.dragFrom !== i) queueAction("/api/queue/move", { from_position: state.dragFrom, to_position: i });
      };
      return li;
    }));

    // Panel derecho
    const title = (i) => (i === null || i === undefined || !items[i]) ? "—" : `${items[i].title} · ${items[i].artist}`;
    $("ptr-prev").textContent = title(pointers.previous);
    $("ptr-cur").textContent = title(cur);
    $("ptr-next").textContent = title(pointers.next);
    $("buf-head").textContent = buffer.head;
    $("buf-tail").textContent = buffer.tail;
    $("buf-size").textContent = buffer.size;
    $("buf-cap").textContent = buffer.capacity;
    const curPhysical = cur === null || cur === undefined ? -1 : (buffer.head + cur) % buffer.capacity;
    $("slots").replaceChildren(...(buffer.slots || []).map((slot, i) => {
      const s = el("div", "slot" + (slot ? " filled" : "") + (i === curPhysical ? " cur" : "") + (i === buffer.head ? " head" : "") + (i === buffer.tail ? " tail" : ""));
      s.title = `Posición física ${i}`;
      return s;
    }));

    const usedMb = items.filter((t) => t.source === "upload").reduce((sum, t) => sum + t.size_bytes, 0) / 1048576;
    $("storage-used").textContent = `${usedMb.toFixed(1)} MB`;
    $("storage-meter").style.width = `${Math.min(100, (usedMb / STORAGE_LIMIT_MB) * 100)}%`;

    // Reproductor deshabilitado sin pistas
    $("player").classList.toggle("disabled", empty);
    $("play").disabled = empty;
    $("prev").disabled = empty || pointers.previous === null;
    $("next").disabled = empty || pointers.next === null;
    const current = items[cur];
    $("now-title").textContent = current ? current.title : "Sin pistas";
    $("now-artist").textContent = current ? current.artist : "Sube canciones para empezar";
    if (!current) { $("audio").pause(); state.loadedTrackId = null; }
  }

  $("clear-queue").onclick = () => queueAction("/api/queue");

  // ------------------------------------------------------------ reproductor
  const audio = $("audio");
  audio.volume = Number($("volume").value);
  $("volume").oninput = (e) => { audio.volume = Number(e.target.value); };

  async function loadCurrent() {
    const q = state.queue;
    const track = q.items[q.pointers.current];
    if (!track) return false;
    if (state.loadedTrackId === track.id) return true;
    // <audio> no puede enviar el header Authorization: se descarga con fetch y se usa un blob local
    let url = state.blobUrls.get(track.id);
    if (!url) {
      const res = await fetch(track.stream_url, { headers: { Authorization: "Bearer " + state.token } });
      if (res.status === 401) { sessionExpired(); return false; }
      if (!res.ok) { toast("No se pudo cargar la pista", "err"); return false; }
      url = URL.createObjectURL(await res.blob());
      state.blobUrls.set(track.id, url);
    }
    audio.src = url;
    state.loadedTrackId = track.id;
    return true;
  }

  async function playCurrent() {
    if (await loadCurrent()) audio.play().catch(() => {});
  }

  $("play").onclick = async () => {
    if (!audio.paused) return audio.pause();
    playCurrent();
  };
  $("next").onclick = () => queueAction("/api/queue/next").then(playCurrent);
  $("prev").onclick = () => queueAction("/api/queue/previous").then(playCurrent);
  audio.onended = () => {
    if (state.queue.pointers.next !== null) $("next").onclick();
  };
  audio.onplay = () => { $("player").classList.add("playing"); $("play-icon").innerHTML = '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'; $("play").setAttribute("aria-label", "Pausar"); };
  audio.onpause = () => { $("player").classList.remove("playing"); $("play-icon").innerHTML = '<path d="M7 4v16l13-8z"/>'; $("play").setAttribute("aria-label", "Reproducir"); };
  audio.ontimeupdate = () => {
    $("time-cur").textContent = fmtTime(audio.currentTime);
    $("time-total").textContent = fmtTime(audio.duration);
    $("progress-fill").style.width = audio.duration ? `${(audio.currentTime / audio.duration) * 100}%` : "0%";
  };
  $("progress").onclick = (e) => {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
  };
  $("progress").onkeydown = (e) => {
    if (!audio.duration) return;
    if (e.key === "ArrowRight") audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
  };

  // ------------------------------------------------------------ búsqueda interactiva
  let searchTimer = null;
  let searchCtrl = null;
  $("search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 200);
  });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("search").value = ""; $("results").classList.add("hidden"); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) $("results").classList.add("hidden"); });

  function highlight(text, words) {
    const frag = document.createDocumentFragment();
    const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const n = norm(text);
    const marks = new Array(text.length).fill(false);
    words.forEach((w) => { let i = n.indexOf(w); while (i >= 0 && w) { for (let k = i; k < i + w.length; k++) marks[k] = true; i = n.indexOf(w, i + 1); } });
    let buf = "", on = false;
    const flush = () => { if (!buf) return; frag.append(on ? el("mark", "", buf) : document.createTextNode(buf)); buf = ""; };
    [...text].forEach((ch, i) => { if (marks[i] !== on) { flush(); on = marks[i]; } buf += ch; });
    flush();
    return frag;
  }

  async function runSearch() {
    const q = $("search").value.trim();
    const box = $("results");
    if (!q) return box.classList.add("hidden");
    if (searchCtrl) searchCtrl.abort();
    searchCtrl = new AbortController();
    try {
      const res = await fetch(`/api/library/search?q=${encodeURIComponent(q)}&limit=20`, {
        headers: { Authorization: "Bearer " + state.token }, signal: searchCtrl.signal,
      });
      if (res.status === 401) return sessionExpired();
      const tracks = await res.json();
      const words = q.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/\s+/);
      if (!tracks.length) {
        box.replaceChildren(el("div", "empty", "Sin resultados por artista o canción"));
      } else {
        box.replaceChildren(...tracks.map((t) => {
          const r = el("div", "result");
          r.setAttribute("role", "option");
          const title = el("div"); title.style.fontWeight = "600"; title.append(highlight(t.title, words));
          const artist = el("div", "hint"); artist.append(highlight(t.artist, words));
          r.append(title, artist);
          r.onclick = () => {
            box.classList.add("hidden");
            const pos = state.queue.items.findIndex((it) => it.id === t.id);
            if (pos >= 0) queueAction("/api/queue/jump", { position: pos }).then(playCurrent);
          };
          return r;
        }));
      }
      box.classList.remove("hidden");
    } catch (err) { if (err.name !== "AbortError") toast("Error al buscar", "err"); }
  }


  // ------------------------------------------------------------ componente: portada en miniatura
  // coverThumb({ name, cover_url }, "sm" | "md" | "lg") -> <span class="thumb">
  // Sin portada muestra la inicial sobre un degradado; con portada la descarga con el token.
  function coverThumb(playlist, size = "sm") {
    const box = el("span", `thumb ${size}`, (playlist.name || "?").trim().charAt(0).toUpperCase());
    box.setAttribute("aria-hidden", "true");
    const src = playlist.cover_url;
    if (!src) return box;
    const img = document.createElement("img");
    img.alt = "";
    img.onload = () => img.classList.add("loaded");
    box.appendChild(img);
    const cached = state.coverUrls.get(src);
    if (cached) { img.src = cached; return box; }
    fetch(src, { headers: { Authorization: "Bearer " + state.token } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        state.coverUrls.set(src, url);
        img.src = url;
      })
      .catch(() => {});
    return box;
  }

  function localThumb(file, name) {
    const box = el("span", "thumb md", (name || "?").trim().charAt(0).toUpperCase() || "♪");
    if (file) {
      const img = document.createElement("img");
      img.alt = "";
      img.onload = () => { img.classList.add("loaded"); URL.revokeObjectURL(img.src); };
      img.src = URL.createObjectURL(file);
      box.appendChild(img);
    }
    return box;
  }

  // ------------------------------------------------------------ playlists
  async function refreshPlaylists() {
    try { state.playlists = await api("/api/playlists"); } catch { return; }
    renderPlaylistNav();
  }

  function renderPlaylistNav() {
    const nav = $("playlist-nav");
    $("playlist-empty").classList.toggle("hidden", state.playlists.length > 0);
    nav.replaceChildren(...state.playlists.map((pl) => {
      const li = el("li");
      const b = el("button");
      b.type = "button";
      if (state.openPlaylist?.id === pl.id) b.classList.add("active");
      const label = el("span", "pl-label");
      label.append(el("div", "pl-title", pl.name), el("div", "pl-count", `${pl.track_count} pista(s)`));
      b.append(coverThumb(pl, "sm"), label);
      b.onclick = () => showPlaylistView(pl.id);
      li.appendChild(b);
      return li;
    }));
  }

  function setActiveNav(id) {
    document.querySelectorAll(".side-item").forEach((b) => b.classList.toggle("active", b.id === id));
  }

  function showQueueView() {
    state.openPlaylist = null;
    $("queue-panel").classList.remove("hidden");
    $("playlist-panel").classList.add("hidden");
    setActiveNav("nav-queue");
    renderPlaylistNav();
  }

  async function showPlaylistView(id) {
    try { state.openPlaylist = await api(`/api/playlists/${id}`); }
    catch (err) { toast(err.message, "err"); return refreshPlaylists(); }
    $("queue-panel").classList.add("hidden");
    $("playlist-panel").classList.remove("hidden");
    setActiveNav(null);
    renderPlaylistView();
    renderPlaylistNav();
  }

  function renderPlaylistView() {
    const pl = state.openPlaylist;
    if (!pl) return;
    $("pl-cover").replaceChildren(coverThumb(pl, "lg"));
    $("pl-name").textContent = pl.name;
    const total = pl.tracks.reduce((sum, t) => sum + (t.duration_seconds || 0), 0);
    $("pl-meta").textContent = `${pl.tracks.length} pista(s) · ${fmtTime(total)}`;
    $("pl-cover-remove").classList.toggle("hidden", !pl.cover_url);
    $("pl-play").disabled = $("pl-append").disabled = pl.tracks.length === 0;
    $("pl-empty").classList.toggle("hidden", pl.tracks.length > 0);
    $("pl-tracks").replaceChildren(...pl.tracks.map((t, i) => {
      const li = el("li", "track");
      li.draggable = true;
      li.style.animationDelay = `${Math.min(i, 10) * 25}ms`;
      const info = el("div");
      info.append(el("div", "title", t.title), el("div", "artist", t.artist));
      const rm = el("button", "icon-btn remove", "×");
      rm.type = "button";
      rm.title = "Quitar de la playlist";
      rm.setAttribute("aria-label", `Quitar ${t.title} de la playlist`);
      rm.onclick = (e) => { e.stopPropagation(); playlistAction(`/api/playlists/${pl.id}/tracks/${i}`, "DELETE"); };
      li.append(el("span", "pos", String(i + 1)), info, el("span", "dur", fmtTime(t.duration_seconds)), rm);
      li.ondragstart = (e) => { state.dragFrom = i; li.classList.add("drag-src"); e.dataTransfer.setData("text/x-zorryfy", String(i)); };
      li.ondragend = () => { state.dragFrom = null; li.classList.remove("drag-src"); };
      li.ondragover = (e) => { if (state.dragFrom !== null) { e.preventDefault(); li.classList.add("drag-over"); } };
      li.ondragleave = () => li.classList.remove("drag-over");
      li.ondrop = (e) => {
        if (state.dragFrom === null) return;
        e.preventDefault();
        e.stopPropagation();
        li.classList.remove("drag-over");
        if (state.dragFrom !== i) playlistAction(`/api/playlists/${pl.id}/move`, "POST", { from_position: state.dragFrom, to_position: i });
      };
      return li;
    }));
  }

  async function playlistAction(path, method, body) {
    try {
      state.openPlaylist = await api(path, { method, body });
      renderPlaylistView();
      refreshPlaylists();
    } catch (err) { toast(err.message, "err"); }
  }

  async function loadPlaylist(mode) {
    const pl = state.openPlaylist;
    try {
      applyQueue(await api(`/api/playlists/${pl.id}/load`, { method: "POST", body: { mode } }));
      toast(mode === "replace" ? `Reproduciendo «${pl.name}»` : `«${pl.name}» añadida a la cola`, "ok");
      if (mode === "replace") { showQueueView(); state.loadedTrackId = null; playCurrent(); }
    } catch (err) { toast(err.message, "err"); }
  }
  $("pl-play").onclick = () => loadPlaylist("replace");
  $("pl-append").onclick = () => loadPlaylist("append");
  $("pl-delete").onclick = async () => {
    const pl = state.openPlaylist;
    // Confirmación en dos clics (sin diálogos del navegador)
    if ($("pl-delete").dataset.armed !== "1") {
      $("pl-delete").dataset.armed = "1";
      $("pl-delete").textContent = "¿Eliminar? Clic otra vez";
      setTimeout(() => { $("pl-delete").dataset.armed = ""; $("pl-delete").textContent = "Eliminar"; }, 3000);
      return;
    }
    $("pl-delete").dataset.armed = "";
    $("pl-delete").textContent = "Eliminar";
    try {
      await api(`/api/playlists/${pl.id}`, { method: "DELETE" });
      toast(`Playlist «${pl.name}» eliminada`, "ok");
      showQueueView();
      refreshPlaylists();
    } catch (err) { toast(err.message, "err"); }
  };
  $("pl-rename").onclick = () => {
    const h = $("pl-name");
    h.contentEditable = "true";
    h.focus();
    document.getSelection().selectAllChildren(h);
    const finish = async (save) => {
      h.contentEditable = "false";
      h.onblur = h.onkeydown = null;
      const name = h.textContent.trim();
      if (save && name && name !== state.openPlaylist.name) await playlistAction(`/api/playlists/${state.openPlaylist.id}`, "PATCH", { name });
      else h.textContent = state.openPlaylist.name;
    };
    h.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") finish(false);
    };
    h.onblur = () => finish(true);
  };

  // Portada de la playlist abierta: clic o arrastrar una imagen
  async function uploadCover(playlistId, file) {
    if (!file) return null;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast("La portada debe ser JPG, PNG o WebP", "err"); return null; }
    if (file.size > 2 * 1024 * 1024) { toast("La imagen supera 2 MB", "err"); return null; }
    const form = new FormData();
    form.append("file", file, file.name);
    try { return await api(`/api/playlists/${playlistId}/cover`, { method: "PUT", form }); }
    catch (err) { toast(err.message, "err"); return null; }
  }
  $("pl-cover-btn").onclick = () => $("cover-input").click();
  $("cover-input").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (await uploadCover(state.openPlaylist.id, file)) { toast("Portada actualizada", "ok"); showPlaylistView(state.openPlaylist.id); refreshPlaylists(); }
  };
  $("pl-cover-btn").addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  $("pl-cover-btn").addEventListener("drop", async (e) => {
    e.preventDefault();
    if (await uploadCover(state.openPlaylist.id, e.dataTransfer.files[0])) { showPlaylistView(state.openPlaylist.id); refreshPlaylists(); }
  });
  $("pl-cover-remove").onclick = async () => {
    const id = state.openPlaylist.id;
    try { await api(`/api/playlists/${id}/cover`, { method: "DELETE" }); } catch (err) { return toast(err.message, "err"); }
    showPlaylistView(id);
    refreshPlaylists();
  };

  // Crear playlist
  function renderNewCover() {
    $("new-cover-thumb").replaceChildren(localThumb(state.newCover, $("pl-new-name").value));
  }
  $("nav-new-playlist").onclick = () => {
    state.newCover = null;
    $("pl-new-name").value = "";
    $("pl-from-queue").checked = false;
    $("pl-from-queue").disabled = state.queue.items.length === 0;
    renderNewCover();
    openModal("m-playlist", "pl-new-name");
  };
  $("pl-new-name").addEventListener("input", () => { if (!state.newCover) renderNewCover(); });
  const picker = $("cover-picker");
  picker.onclick = () => $("new-cover-input").click();
  picker.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("new-cover-input").click(); } };
  function pickCover(file) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return showError("playlist-error", "La portada debe ser JPG, PNG o WebP");
    if (file.size > 2 * 1024 * 1024) return showError("playlist-error", "La imagen supera 2 MB");
    $("playlist-error").textContent = "";
    state.newCover = file;
    renderNewCover();
  }
  $("new-cover-input").onchange = (e) => { pickCover(e.target.files[0]); e.target.value = ""; };
  picker.addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); picker.classList.add("over"); } });
  picker.addEventListener("dragleave", () => picker.classList.remove("over"));
  picker.addEventListener("drop", (e) => { e.preventDefault(); picker.classList.remove("over"); pickCover(e.dataTransfer.files[0]); });

  $("form-playlist").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("pl-new-name").value.trim();
    if (!name) return showError("playlist-error", "Ponle un nombre a la playlist", "pl-new-name");
    const track_ids = $("pl-from-queue").checked ? state.queue.items.map((t) => t.id) : [];
    try {
      const pl = await api("/api/playlists", { method: "POST", body: { name, track_ids } });
      if (state.newCover) await uploadCover(pl.id, state.newCover);
      closeModals();
      toast(`Playlist «${pl.name}» creada`, "ok");
      await refreshPlaylists();
      showPlaylistView(pl.id);
    } catch (err) { showError("playlist-error", err.message); }
  };

  // Popover «Añadir a playlist»
  function openPlaylistPopover(anchor, trackIds) {
    const pop = $("pl-popover");
    const items = state.playlists.map((pl) => {
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.append(coverThumb(pl, "sm"), el("span", "", pl.name));
      b.onclick = async () => {
        pop.classList.add("hidden");
        try {
          await api(`/api/playlists/${pl.id}/tracks`, { method: "POST", body: { track_ids: trackIds } });
          toast(`Añadida a «${pl.name}»`, "ok");
          refreshPlaylists();
        } catch (err) { toast(err.message, "err"); }
      };
      return b;
    });
    const create = el("button", "", "＋ Nueva playlist…");
    create.type = "button";
    create.onclick = () => { pop.classList.add("hidden"); $("nav-new-playlist").click(); };
    pop.replaceChildren(el("div", "pop-title", "Añadir a playlist"), ...items, create);
    pop.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - pop.offsetHeight - 10)}px`;
    pop.style.left = `${Math.max(10, r.right - pop.offsetWidth)}px`;
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#pl-popover") && !e.target.closest(".icon-btn")) $("pl-popover").classList.add("hidden");
  });

  // ------------------------------------------------------------ confirmación del email por push
  function updateEmailBanner(user) {
    const banner = $("email-banner");
    let dismissed = false;
    try { dismissed = sessionStorage.getItem("zorryfy_email_banner") === "off"; } catch {}
    if (!user || user.email_status === "confirmed" || dismissed) return banner.classList.add("hidden");
    $("email-banner-text").textContent = user.email_status === "rejected"
      ? `Marcaste ${user.email} como incorrecto. Corrígelo para poder confirmarlo.`
      : `Confirma que ${user.email} es tu email: te enviaremos una notificación.`;
    $("email-push").classList.toggle("hidden", user.email_status === "rejected");
    banner.classList.remove("hidden", "confirmed");
  }
  $("email-dismiss").onclick = () => {
    try { sessionStorage.setItem("zorryfy_email_banner", "off"); } catch {}
    $("email-banner").classList.add("hidden");
  };

  function urlB64ToUint8Array(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function enablePushConfirmation() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      toast("Este navegador no admite notificaciones push", "err");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Activa las notificaciones de este sitio para confirmar tu email", "err");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { public_key } = await api("/api/push/public-key", { auth: false });
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(public_key) });
      const result = await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
      toast(result.sent ? "Te enviamos una notificación: respóndela para confirmar tu email" : "No pudimos entregar la notificación; inténtalo de nuevo", result.sent ? "ok" : "err");
    } catch (err) {
      toast(err.message || "No se pudo activar la notificación", "err");
    }
  }
  $("email-push").onclick = enablePushConfirmation;

  async function refreshUser() {
    try { state.user = await api("/auth/me"); updateEmailBanner(state.user); } catch {}
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const msg = e.data || {};
      if (msg.type === "email-status") {
        toast(msg.status === "confirmed" ? "Email confirmado ✓" : "Anotado: ese email no es tuyo. Corrígelo.", msg.status === "confirmed" ? "ok" : "err");
        refreshUser();
      }
      if (msg.type === "email-confirm-prompt" && state.user) {
        state.emailPrompt = { token: msg.token, email: msg.email };
        $("email-ask-value").textContent = msg.email;
        $("email-ask").classList.remove("hidden");
        $("email-edit").classList.add("hidden");
        openModal("m-email");
      }
    });
  }
  async function answerPrompt(accept) {
    try {
      await api("/auth/email/confirm", { method: "POST", body: { token: state.emailPrompt.token, accept }, auth: false });
      closeModals();
      await refreshUser();
      toast(accept ? "Email confirmado ✓" : "Corrige tu email para confirmarlo", accept ? "ok" : "err");
    } catch (err) { toast(err.message, "err"); }
  }
  $("email-yes").onclick = () => answerPrompt(true);
  $("email-no").onclick = () => answerPrompt(false);

  $("email-change").onclick = () => {
    $("email-ask").classList.add("hidden");
    $("email-edit").classList.remove("hidden");
    $("email-new").value = state.user?.email || "";
    openModal("m-email", "email-new");
  };
  $("form-email").onsubmit = async (e) => {
    e.preventDefault();
    if ($("email-edit").classList.contains("hidden")) return;
    try {
      state.user = await api("/api/account/email", { method: "PUT", body: { email: $("email-new").value.trim() } });
      closeModals();
      updateEmailBanner(state.user);
      toast("Email actualizado", "ok");
    } catch (err) { showError("email-error", err.message, "email-new"); }
  };

  // ------------------------------------------------------------ inicio
  (async () => {
    try { state.config = await api("/auth/config", { auth: false }); } catch {}
    document.querySelectorAll("[data-demo]").forEach((d) => d.classList.toggle("hidden", !state.config.demo_mode));
    const saved = storage()?.getItem(TOKEN_KEY);
    if (saved) {
      state.token = saved;
      try { return startApp(await api("/auth/me")); } catch { saveToken(null); }
    }
    openModal("m-login", "login-user");
  })();
})();
