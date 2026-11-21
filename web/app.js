"use strict";

// The secret token is in the page address after "#". It never leaves this
// computer: the address fragment isn't sent with requests.
const token = location.hash.slice(1);

// A new address from the app means a new token: start fresh.
window.addEventListener("hashchange", () => location.reload());

const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  apps: null,      // { remove, disable, protected }
  pending: new Map(), // id -> action
  busy: false,
  picture: null,   // File
  view: "debloat", // debloat | apps | files
  path: "/sdcard", // folder shown under Files
  userApps: null,
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch("/api/" + path, {
    ...options,
    headers: { "X-Token": token, ...(options.headers || {}) },
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong (" + res.status + ").");
    err.status = res.status;
    throw err;
  }
  return data;
}

const postJSON = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function show(id, visible) { $(id).hidden = !visible; }

function flash() {
  document.body.classList.remove("flash");
  void document.body.offsetWidth; // restart the animation
  document.body.classList.add("flash");
  setTimeout(() => document.body.classList.remove("flash"), 500);
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

const platformToolsURL = "https://developer.android.com/tools/releases/platform-tools";

const installCommand = {
  mac: "brew install --cask android-platform-tools",
  windows: "scoop install adb",
  linux: "sudo apt install adb",
};

// The steps to turn on USB debugging on the C69 M Star.
function usbDebugSteps() {
  return el("ol", { class: "steps" },
    el("li", {}, "On the tablet, open ", el("strong", {}, "Apps"), ", tap the menu at the top right, then ", el("strong", {}, "App management"), "."),
    el("li", {}, "Turn on ", el("strong", {}, "USB Debug Mode"), "."),
    el("li", {}, "Connect the tablet with a USB cable that carries data."),
    el("li", {}, "Tap ", el("strong", {}, "Allow"), " when the tablet asks to allow USB debugging, and tick ", el("strong", {}, "Always allow from this computer"), "."));
}

// Shown when adb is missing: download it from Google with one click, or
// install it by hand.
function adbInstallBlock(status) {
  const parts = [el("p", {}, "boox-debloat uses Android platform tools (adb) to talk to the tablet. It's a free tool from Google.")];
  if (status.canInstall) {
    const out = el("p", { class: "install-out", hidden: true });
    const btn = el("button", { type: "button", class: "button" }, "Download Android platform tools");
    btn.addEventListener("click", async () => {
      state.busy = true; // keep the page from redrawing while it downloads
      btn.disabled = true;
      btn.textContent = "Downloading…";
      out.hidden = false;
      out.classList.remove("bad");
      out.textContent = "Downloading from Google. This usually takes under a minute.";
      try {
        await postJSON("install-adb");
        out.textContent = "Installed. Looking for your tablet…";
        state.busy = false;
        await refreshStatus();
      } catch (err) {
        out.classList.add("bad");
        out.textContent = err.message;
        btn.disabled = false;
        btn.textContent = "Try again";
      } finally {
        state.busy = false;
      }
    });
    parts.push(el("div", { class: "install-row" }, btn, el("span", { class: "row-why" }, "About 10 MB. Kept in the app's own folder; no admin rights needed.")), out);
    parts.push(el("p", { class: "row-why" }, "Already have adb somewhere else? Install it with ", el("code", {}, installCommand[status.os] || installCommand.linux), " or ",
      el("a", { href: platformToolsURL, target: "_blank", rel: "noopener noreferrer" }, "download it from Google"), ", then press Refresh."));
  } else {
    parts.push(el("p", {}, "Install it with this command, then press Refresh:"), el("p", {}, el("code", {}, installCommand[status.os] || installCommand.linux)));
    parts.push(el("p", {}, "Or ", el("a", { href: platformToolsURL, target: "_blank", rel: "noopener noreferrer" }, "download Android platform tools from Google"), ", then press Refresh."));
  }
  return parts;
}

function renderMessage(status) {
  const box = $("message");
  let title, body = [];
  if (!token) {
    title = "This page needs to be opened from the app.";
    body = [el("p", {}, "Run boox-debloat again; it opens the right address for you.")];
  } else if (status.expired) {
    title = "This page has expired.";
    body = [el("p", {}, "Close it and run boox-debloat again. Each run opens a new address.")];
  } else if (status.stopped) {
    title = "boox-debloat isn't running.";
    body = [el("p", {}, "Run boox-debloat again to reopen the app.")];
  } else if (!status.adb) {
    title = "Install Android platform tools.";
    body = adbInstallBlock(status);
  } else if (status.state === "unauthorized") {
    title = "Allow USB debugging on the tablet.";
    body = [el("p", {}, "A prompt is waiting on the tablet's screen. Unlock it, tap Allow, and tick Always allow from this computer.")];
  } else if (status.state === "multiple") {
    title = "More than one Android device is connected.";
    body = [el("p", {}, "Unplug the others, or start the app with boox-debloat -serial <serial>.")];
  } else if (status.state === "nopermission") {
    title = "Linux needs permission to use the tablet.";
    body = [
      el("p", {}, "adb can see the tablet but isn't allowed to talk to it. Give your user USB access, then unplug and replug the tablet:"),
      el("p", {}, "Debian or Ubuntu: ", el("code", {}, "sudo apt install android-sdk-platform-tools-common"), " then ", el("code", {}, "sudo usermod -aG plugdev $USER")),
      el("p", {}, "Fedora: ", el("code", {}, "sudo dnf install android-tools")),
      el("p", {}, "Arch: ", el("code", {}, "sudo pacman -S android-udev")),
      el("p", {}, "Then log out and back in, run ", el("code", {}, "adb kill-server"), ", and press Refresh. The ", el("a", { href: "help.html#linux", target: "_blank", rel: "noopener" }, "help page"), " has more."),
    ];
  } else if (status.state === "offline") {
    title = "The tablet isn't responding.";
    body = [el("p", {}, "Unplug it, plug it back in, and unlock the screen.")];
  } else {
    title = "Plug in your tablet and turn on USB debugging.";
    body = [usbDebugSteps(), el("p", { class: "row-why" }, "This page finds the tablet by itself. Press Refresh to check now.")];
  }
  // Only redraw when the message changes, so buttons and links stay put.
  const key = title + (status.canInstall ? "1" : "");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(el("h2", {}, title), ...body,
    el("p", { class: "row-why" }, "Stuck? Read the ", el("a", { href: "help.html", target: "_blank", rel: "noopener" }, "help and FAQ"), "."));
}

// Show which build is running, so two copies can't be mixed up.
function renderVersion(status) {
  if (!status.version) return;
  const label = status.version === "dev" ? "Development build" : "Version " + status.version;
  $("appVersion").textContent = label;
  $("appVersion").hidden = false;
  document.title = status.version === "dev" ? "Boox Debloat (dev)" : `Boox Debloat ${status.version}`;
}

function renderDevice(status) {
  renderVersion(status);
  show("demo", status.demo);
  const connected = token && status.adb && status.state === "device";
  renderConnection(status, connected);
  if (!connected) {
    $("deviceName").textContent = "Boox Debloat";
    show("deviceMeta", false);
    show("sleepStatus", false);
    show("playStatus", false);
    show("pictureForm", false);
    show("restartBox", false);
    show("views", false);
    return;
  }
  show("restartBox", true);
  show("views", true);
  $("deviceName").textContent = ({ C69_M_STAR: "C69 M Star", C69_M_Bridge: "C69 M Bridge" })[status.model] || status.model || "Android device";
  const fw = (status.firmware.match(/(\d+\.\d+\.\d+)/) || [])[1] || status.firmware;
  const meta = $("deviceMeta");
  meta.textContent = `Firmware ${fw}, Android ${status.android}`;
  meta.title = status.firmware; // full build name on hover
  show("deviceMeta", true);
  show("pictureForm", status.supported);
}

// The line under the tablet's name: a dot, what's happening, and Refresh.
function renderConnection(status, connected) {
  let text;
  if (connected) text = "Connected";
  else if (status.expired || status.stopped) text = "Not connected to the app";
  else if (status.adb === false) text = "adb isn't installed";
  else if (status.state === "unauthorized") text = "Waiting for USB permission";
  else if (status.state === "multiple") text = "More than one device connected";
  else text = "No tablet connected";
  $("connText").textContent = text;
  $("conn").classList.toggle("on", !!connected);
  // Refresh works whenever the app is running: it re-checks the connection
  // and, once connected, reloads the app list.
  show("refreshBtn", !!token && !status.expired && !status.stopped);
}

// Re-reads the tablet: connection, firmware and every app's state.
async function refreshAll() {
  const n = state.pending.size;
  if (n > 0) {
    const body = [el("p", {}, `Refreshing reloads the app list from the tablet and drops your ${n} unapplied change${n === 1 ? "" : "s"}.`)];
    if (!(await confirmDialog("Discard unapplied changes?", body, "Discard and refresh"))) return;
  }
  const btn = $("refreshBtn");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  state.pending.clear();
  state.apps = null; // makes refreshStatus reload the list
  try {
    await refreshStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh";
  }
}

$("refreshBtn").addEventListener("click", refreshAll);

async function refreshStatus() {
  if (state.busy) return;
  let status;
  try {
    status = token ? await api("status") : { adb: true, state: "none" };
  } catch (err) {
    status = {
      adb: true,
      state: "none",
      error: err.message,
      expired: err.status === 401,
      stopped: err.status === undefined, // the request never reached the app
    };
  }
  const was = state.status;
  state.status = status;
  renderDevice(status);

  const connected = token && status.adb && status.state === "device";
  show("message", !connected);
  showView(connected);
  if (!connected) {
    renderMessage(status);
    state.apps = null;
    state.pending.clear();
    show("result", false);
    return;
  }
  show("unsupported", !status.supported);
  if (!status.supported) {
    $("unsupported").textContent =
      `This tool is made for the C69 M Star and C69 M Bridge. This device reports "${status.model}", so changes are turned off.`;
  }
  const fresh = !was || was.state !== "device" || was.serial !== status.serial;
  if (fresh || !state.apps) await loadApps();
  if (fresh) loadView();
}

// ---------------------------------------------------------------------------
// Sections: Debloat, Apps, Files
// ---------------------------------------------------------------------------

function showView(connected) {
  show("lists", connected && state.view === "debloat");
  show("bar", connected && state.view === "debloat");
  show("appsView", connected && state.view === "apps");
  show("filesView", connected && state.view === "files");
  for (const b of document.querySelectorAll(".view-link")) {
    if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
}

function loadView() {
  if (state.view === "apps") loadUserApps();
  if (state.view === "files") loadFiles(state.path);
}

for (const b of document.querySelectorAll(".view-link")) {
  b.addEventListener("click", () => {
    if (state.view === b.dataset.view) return;
    state.view = b.dataset.view;
    show("result", false);
    const s = state.status;
    showView(!!(token && s && s.adb && s.state === "device"));
    loadView();
    window.scrollTo({ top: 0 });
  });
}

const supportedNow = () => !!(state.status && state.status.supported);

function setStatus(id, text, kind) {
  const p = $(id);
  p.textContent = text || "";
  p.hidden = !text;
  p.classList.toggle("bad", kind === "bad");
  p.classList.toggle("good", kind === "good");
}

function formatSize(n) {
  if (n < 1000) return n + " B";
  if (n < 1e6) return (n / 1e3).toFixed(0) + " KB";
  if (n < 1e9) return (n / 1e6).toFixed(1) + " MB";
  return (n / 1e9).toFixed(2) + " GB";
}

// Uploads with progress. Resolves with the JSON answer or throws its error.
function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/" + path);
    xhr.setRequestHeader("X-Token", token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) { /* empty */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || "Something went wrong (" + xhr.status + ")."));
    };
    xhr.onerror = () => reject(new Error("The app isn't running."));
    xhr.send(form);
  });
}

// ---------------------------------------------------------------------------
// Apps: install, your apps, recommended
// ---------------------------------------------------------------------------

async function loadUserApps() {
  try {
    state.userApps = await api("user-apps");
  } catch (err) {
    setStatus("apkStatus", err.message, "bad");
    return;
  }
  renderUserApps();
}

function renderUserApps() {
  const data = state.userApps;
  if (!data) return;
  const list = data.apps || [];
  $("userAppsCount").textContent = list.length ? `${list.length} installed` : "";
  $("userAppsList").replaceChildren(...(list.length ? list.map(userAppRow) : [el("li", { class: "row" }, el("span", { class: "row-why" }, "No apps installed yet."))]));

  const abi = data.abi ? ` This tablet uses ${data.abi}: pick that APK or the universal one when a page offers several.` : "";
  $("recNote").textContent = "Lightweight apps that work well on this tablet. Download the APK from the official page, then drop it under Install an app." + abi;
  $("recList").replaceChildren(...(data.recommended || []).map((g) =>
    el("div", { class: "rec-group" },
      el("h3", {}, g.group),
      el("ul", { class: "rows" }, g.apps.map(recRow)))));
}

function userAppRow(app) {
  const text = el("div", { class: "row-text" },
    el("span", { class: "row-name" }, app.name || app.id),
    el("span", { class: "row-why" }, app.version ? "Version " + app.version : "Version unknown"),
    app.name ? el("span", { class: "row-id" }, app.id) : null);
  const btn = el("button", { type: "button", class: "text-button danger", disabled: !supportedNow(), onclick: () => uninstall(app) }, "Uninstall");
  return el("li", { class: "row" }, text, el("div", { class: "row-actions" }, btn));
}

function recRow(app) {
  const text = el("div", { class: "row-text" },
    el("span", { class: "row-name" }, app.name),
    el("span", { class: "row-why" }, app.why));
  const actions = el("div", { class: "rec-actions" },
    app.installed ? el("span", { class: "tag-installed" }, "Installed") : null,
    el("a", { href: app.url, target: "_blank", rel: "noopener noreferrer" }, app.source === "GitHub" ? "GitHub releases" : app.source === "F-Droid" ? "Get on F-Droid" : app.source));
  return el("li", { class: "row" }, text, actions);
}

async function uninstall(app) {
  const name = app.name || app.id;
  const body = [el("p", {}, `${name} and its data are removed from the tablet. You can install it again later from its APK.`)];
  if (!(await confirmDialog(`Uninstall ${name}?`, body, "Uninstall"))) return;
  state.busy = true;
  try {
    await postJSON("uninstall", { id: app.id });
    flash();
    setStatus("apkStatus", `Uninstalled ${name}.`, "good");
  } catch (err) {
    setStatus("apkStatus", err.message, "bad");
  } finally {
    state.busy = false;
    await loadUserApps();
  }
}

async function installAPK(file) {
  if (!file) return;
  if (!/\.apk$/i.test(file.name)) {
    setStatus("apkStatus", "Choose an .apk file. Split bundles (.apks, .xapk) aren't supported.", "bad");
    return;
  }
  if (!supportedNow()) return;
  const drop = $("apkDrop");
  drop.classList.add("busy");
  state.busy = true;
  setStatus("apkStatus", `Sending ${file.name}…`);
  const form = new FormData();
  form.append("apk", file);
  try {
    await upload("install", form, (f) => {
      setStatus("apkStatus", f < 1 ? `Sending ${file.name}… ${Math.round(f * 100)}%` : `Installing ${file.name}…`);
    });
    flash();
    setStatus("apkStatus", `Installed ${file.name}.`, "good");
  } catch (err) {
    setStatus("apkStatus", err.message, "bad");
  } finally {
    drop.classList.remove("busy");
    state.busy = false;
    $("apkInput").value = "";
    await loadUserApps();
  }
}

$("apkInput").addEventListener("change", (e) => installAPK(e.target.files[0]));
dropTarget($("apkDrop"), $("apkDrop"), (files) => installAPK(files[0]));

// Makes `zone` accept dropped files, highlighting `mark` while dragging.
function dropTarget(zone, mark, onFiles) {
  zone.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    mark.classList.add("dragging");
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) mark.classList.remove("dragging");
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    mark.classList.remove("dragging");
    // Entries must be taken before the first await, while the drop is live.
    const entries = [...e.dataTransfer.items]
      .map((it) => (it.kind === "file" && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
    if (entries.some((en) => en && en.isDirectory)) {
      const files = [];
      for (const en of entries) if (en) await collectEntry(en, "", files);
      if (files.length) onFiles(files);
      return;
    }
    if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  });
}

// Walks a dropped file or folder, adding each file with `rel` set to its
// path inside the drop ("Folder/sub/file.txt").
async function collectEntry(entry, prefix, out) {
  const rel = prefix + entry.name;
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    file.rel = rel;
    out.push(file);
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const child of batch) await collectEntry(child, rel + "/", out);
  }
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function loadFiles(path) {
  let data;
  try {
    data = await api("files?path=" + encodeURIComponent(path));
  } catch (err) {
    setStatus("filesStatus", err.message, "bad");
    if (path !== "/sdcard") return loadFiles("/sdcard");
    return;
  }
  state.path = data.path;
  renderCrumbs(data.path);
  const rows = data.entries.map(fileRow);
  $("filesList").replaceChildren(...(rows.length ? rows : [el("li", { class: "empty" }, "This folder is empty. Drop files here to copy them in.")]));
}

function renderCrumbs(path) {
  const parts = path.split("/").filter(Boolean); // ["sdcard", "Books", ...]
  const nodes = [];
  parts.forEach((part, i) => {
    const full = "/" + parts.slice(0, i + 1).join("/");
    const label = i === 0 ? "Storage" : part;
    if (i > 0) nodes.push(el("span", { class: "sep", "aria-hidden": "true" }, "/"));
    if (i === parts.length - 1) nodes.push(el("span", { "aria-current": "location" }, label));
    else nodes.push(el("button", { type: "button", onclick: () => openFolder(full) }, label));
  });
  $("crumbs").replaceChildren(...nodes);
}

function openFolder(path) {
  setStatus("filesStatus", "");
  loadFiles(path);
}

const deletable = (p) => p !== "/sdcard" && p !== "/sdcard/Android" && !p.startsWith("/sdcard/Android/");

function fileRow(entry) {
  const full = state.path + "/" + entry.name;
  const name = entry.dir
    ? el("button", { type: "button", class: "file-name", onclick: () => openFolder(full) }, entry.name)
    : el("span", { class: "file-name" }, entry.name);
  const meta = entry.dir ? "Folder" : `${formatSize(entry.size)}, ${entry.modified}`;
  const actions = el("div", { class: "row-actions" },
    entry.dir ? null : el("button", { type: "button", class: "text-button", onclick: () => download(full, entry.name) }, "Download"),
    deletable(full) ? el("button", { type: "button", class: "text-button danger", disabled: !supportedNow(), onclick: () => removeFile(full, entry) }, "Delete") : null);
  return el("li", { class: "row" }, el("div", { class: "row-text" }, name, el("span", { class: "row-why" }, meta)), actions);
}

async function download(path, name) {
  setStatus("filesStatus", `Copying ${name} from the tablet…`);
  state.busy = true;
  try {
    const res = await fetch("/api/download?path=" + encodeURIComponent(path), { headers: { "X-Token": token } });
    if (!res.ok) {
      let msg = "Couldn't download it.";
      try { msg = (await res.json()).error || msg; } catch (_) { /* not JSON */ }
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = el("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus("filesStatus", `Downloaded ${name}. It's in your browser's downloads.`, "good");
  } catch (err) {
    setStatus("filesStatus", err.message === "Failed to fetch" ? "The app isn't running." : err.message, "bad");
  } finally {
    state.busy = false;
  }
}

async function removeFile(path, entry) {
  const what = entry.dir ? "folder" : "file";
  const body = [el("p", {}, entry.dir
    ? `${entry.name} is deleted from the tablet. Only empty folders can be deleted.`
    : `${entry.name} is deleted from the tablet. This can't be undone.`)];
  if (!(await confirmDialog(`Delete this ${what}?`, body, "Delete"))) return;
  state.busy = true;
  try {
    await postJSON("delete", { path });
    setStatus("filesStatus", `Deleted ${entry.name}.`, "good");
  } catch (err) {
    setStatus("filesStatus", err.message, "bad");
  } finally {
    state.busy = false;
    await loadFiles(state.path);
  }
}

// Splits files into requests of at most 200 files or 256 MB, so a big
// folder stays under the server's per-request limits.
function uploadBatches(files) {
  const batches = [];
  let cur = [], bytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= 200 || bytes + f.size > 256 << 20)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(f);
    bytes += f.size;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function uploadFiles(files) {
  if (!files.length || !supportedNow()) return;
  const total = files.reduce((n, f) => n + f.size, 0);
  const rel = (f) => f.rel || f.webkitRelativePath || "";
  const top = new Set(files.map((f) => rel(f).split("/")[0]).filter(Boolean));
  const label = top.size === 1 && rel(files[0]).includes("/")
    ? `${[...top][0]} (${files.length} file${files.length === 1 ? "" : "s"})`
    : files.length === 1 ? files[0].name : `${files.length} files`;
  state.busy = true;
  setStatus("filesStatus", `Sending ${label} (${formatSize(total)})…`);
  try {
    let sent = 0;
    for (const batch of uploadBatches(files)) {
      const form = new FormData();
      form.append("path", state.path);
      for (const f of batch) {
        form.append("files", f);
        form.append("rel", rel(f));
      }
      const size = batch.reduce((n, f) => n + f.size, 0);
      await upload("upload", form, (f) => {
        const pct = total ? Math.round(((sent + f * size) / total) * 100) : 100;
        setStatus("filesStatus", pct < 100 ? `Sending ${label}… ${pct}%` : `Copying ${label} to the tablet…`);
      });
      sent += size;
    }
    flash();
    setStatus("filesStatus", `Copied ${label} to ${state.path.replace("/sdcard", "Storage").split("/").join(" / ")}.`, "good");
  } catch (err) {
    setStatus("filesStatus", err.message, "bad");
  } finally {
    state.busy = false;
    $("uploadInput").value = "";
    $("uploadFolderInput").value = "";
    await loadFiles(state.path);
  }
}

$("uploadInput").addEventListener("change", (e) => uploadFiles([...e.target.files]));
$("uploadFolderInput").addEventListener("change", (e) => uploadFiles([...e.target.files]));
dropTarget($("filesView"), $("filesList"), uploadFiles);

// ---------------------------------------------------------------------------
// App lists
// ---------------------------------------------------------------------------

async function loadApps() {
  try {
    state.apps = await api("apps");
  } catch (err) {
    showResult([el("p", { class: "bad" }, err.message)]);
    return;
  }
  render();
}

const installed = (s) => s === "enabled" || s === "disabled";

// What the switch shows: the app's state once pending changes are applied.
function desiredOn(app) {
  const a = state.pending.get(app.id);
  if (a === "remove" || a === "disable") return false;
  if (a === "restore" || a === "enable") return true;
  return app.state === "enabled" || (app.state === "disabled" && app._group === "remove");
}

function toggle(app) {
  const on = desiredOn(app);
  state.pending.delete(app.id);
  if (app._group === "remove") {
    if (on && installed(app.state)) state.pending.set(app.id, "remove");
    if (!on && app.state === "removed") state.pending.set(app.id, "restore");
  } else if (app._group === "disable") {
    if (on && app.state === "enabled") state.pending.set(app.id, "disable");
    if (!on && app.state === "disabled") state.pending.set(app.id, "enable");
    if (!on && app.state === "removed") state.pending.set(app.id, "restore");
  }
  render();
}

const pendingText = {
  remove: "Will be removed",
  restore: "Will come back",
  disable: "Will be turned off",
  enable: "Will be turned on",
};

function appRow(app) {
  const supported = state.status && state.status.supported;
  const pending = state.pending.get(app.id);
  const lines = [
    el("span", { class: "row-name" }, app.name),
    el("span", { class: "row-why" }, app.why),
    el("span", { class: "row-id" }, app.id),
  ];
  if (pending) lines.push(el("span", { class: "row-pending" }, pendingText[pending]));
  const text = el("div", { class: "row-text" }, ...lines);

  if (app.state === "missing") {
    return el("li", { class: "row missing" }, text, el("span", { class: "lock" }, "Not on this firmware"));
  }

  if (app._group === "protected") {
    const problem = app.state === "removed" || app.state === "disabled";
    if (!problem) return el("li", { class: "row locked" }, text, el("span", { class: "lock" }, "Kept"));
    const action = app.state === "removed" ? "restore" : "enable";
    const queued = state.pending.has(app.id);
    const btn = el("button", {
      type: "button",
      class: "text-button",
      disabled: !supported,
      onclick: () => {
        if (queued) state.pending.delete(app.id); else state.pending.set(app.id, action);
        render();
      },
    }, queued ? "Undo" : "Bring back");
    return el("li", { class: "row problem" }, text, btn);
  }

  const on = desiredOn(app);
  const sw = el("button", {
    type: "button",
    class: "switch",
    role: "switch",
    "aria-checked": String(on),
    "aria-label": `${app.name} ${app._group === "disable" ? "turned on" : "installed"}`,
    disabled: !supported,
    onclick: () => toggle(app),
  });
  return el("li", { class: "row" }, text, sw);
}

function render() {
  if (!state.apps) return;
  const tag = (list, group) => list.map((a) => ({ ...a, _group: group }));
  const remove = tag(state.apps.remove, "remove");
  const disable = tag(state.apps.disable, "disable");
  const keep = tag(state.apps.protected, "protected");

  $("removeList").replaceChildren(...remove.map(appRow));
  $("disableList").replaceChildren(...disable.map(appRow));
  $("protectedList").replaceChildren(...keep.map(appRow));

  // Sleep screen health: the apps it needs must be enabled.
  const needed = ["com.onyx", "com.onyx.android.ksync", "com.onyx.screenmanager", "com.android.providers.media"];
  const broken = keep.filter((a) => needed.includes(a.id) && (a.state === "removed" || a.state === "disabled"));
  const status = $("sleepStatus");
  status.hidden = false;
  status.classList.toggle("bad", broken.length > 0);
  status.textContent = broken.length
    ? `Sleep screen: needs ${broken.map((a) => a.name).join(" and ")}. Bring it back under Always kept.`
    : "Sleep screen: ready";

  renderPlay(keep);

  const supported = state.status && state.status.supported;
  const removable = remove.filter((a) => installed(a.state) && state.pending.get(a.id) !== "remove");
  $("removeAll").disabled = !supported || removable.length === 0;

  const n = state.pending.size;
  $("review").disabled = n === 0 || !supported;
  $("review").textContent = n === 0 ? "Review changes" : `Review ${n} change${n === 1 ? "" : "s"}`;
  show("discard", n > 0);
  $("restoreAll").disabled = !supported;
}

// Google Play: Boox ships it turned off. Offer to turn it on only when it isn't.
const playIds = ["com.google.android.gsf", "com.google.android.gms", "com.android.vending"];

function renderPlay(keep) {
  const apps = keep.filter((a) => playIds.includes(a.id));
  const box = $("playStatus");
  const btn = $("enablePlay");
  box.hidden = false;
  const byId = Object.fromEntries(apps.map((a) => [a.id, a.state]));
  const has = (id) => byId[id] && byId[id] !== "missing";
  let text, off = false, needStore = false;
  if (!has("com.google.android.gms") || !has("com.google.android.gsf")) {
    text = "Google Play: not on this firmware";
  } else if (!has("com.android.vending")) {
    text = "Google Play: Play Store missing";
    needStore = true;
  } else if (apps.every((a) => a.state === "enabled")) {
    text = "Google Play: on";
  } else {
    text = "Google Play: off";
    off = true;
  }
  $("playText").textContent = text;
  box.classList.toggle("off", off || needStore);
  btn.hidden = !off;
  btn.disabled = !(state.status && state.status.supported) || state.busy;
  $("playInstall").hidden = !needStore;
  $("playInput").disabled = !(state.status && state.status.supported) || state.busy;
}

$("playInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !supportedNow()) return;
  const form = new FormData();
  form.append("apk", file);
  state.busy = true;
  $("playInput").disabled = true;
  setStatus("playMsg", `Sending ${file.name}…`);
  try {
    await upload("install-play", form, (f) => {
      setStatus("playMsg", f < 1 ? `Sending ${file.name}… ${Math.round(f * 100)}%` : "Checking it's signed by Google, then installing…");
    });
    flash();
    setStatus("playMsg", "Play Store is installed. Open it on the tablet and sign in. To stop Play Protect blocking apps you install yourself, turn off Scan apps with Play Protect (Play Store, profile picture, Play Protect, settings).", "good");
  } catch (err) {
    setStatus("playMsg", err.message, "bad");
  } finally {
    state.busy = false;
    await loadApps();
  }
});

$("enablePlay").addEventListener("click", async () => {
  const body = [
    el("p", {}, "Turns on Google Play Store, Google Play services and Google Services Framework. Apps already on are left alone."),
    el("p", {}, "If Play Store then says the tablet isn't Play Protect certified, follow ",
      el("a", { href: "help.html#play", target: "_blank", rel: "noopener" }, "Google Play in Help"), "."),
  ];
  const note = "Your current app list is saved as a backup first.";
  if (!(await confirmDialog("Turn on Google Play?", body, "Turn on", { note }))) return;
  await apply(() => postJSON("enable-play"));
});

$("removeAll").addEventListener("click", () => {
  for (const a of state.apps.remove) {
    if (installed(a.state)) state.pending.set(a.id, "remove");
  }
  render();
});

$("discard").addEventListener("click", () => {
  state.pending.clear();
  render();
});

// ---------------------------------------------------------------------------
// Review and apply
// ---------------------------------------------------------------------------

function nameOf(id) {
  for (const list of Object.values(state.apps)) {
    const a = list.find((x) => x.id === id);
    if (a) return a.name;
  }
  return id;
}

const groupTitles = {
  remove: "Remove",
  restore: "Bring back",
  disable: "Turn off",
  enable: "Turn on",
};

function confirmDialog(title, body, okText, { cancelText = "Cancel", note = "" } = {}) {
  $("dialogTitle").textContent = title;
  $("dialogBody").replaceChildren(...body);
  $("dialogOk").textContent = okText;
  $("dialogCancel").textContent = cancelText;
  $("dialogNote").textContent = note;
  $("dialogNote").hidden = !note;
  const dialog = $("dialog");
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
  });
}

$("review").addEventListener("click", async () => {
  const byAction = {};
  for (const [id, action] of state.pending) (byAction[action] ||= []).push(id);
  const body = Object.entries(byAction).map(([action, ids]) =>
    el("div", {},
      el("h3", {}, `${groupTitles[action]} (${ids.length})`),
      el("ul", {}, ids.map((id) => el("li", {}, nameOf(id))))));
  const note = "Your current app list is saved as a backup first.";
  if (!(await confirmDialog("Review changes", body, "Apply to tablet", { note }))) return;
  const changes = [...state.pending].map(([id, action]) => ({ id, action }));
  await apply(() => postJSON("apply", { changes }));
});

$("restoreAll").addEventListener("click", async () => {
  const body = [el("p", {}, "Every app this tool can remove comes back, and NFC is turned on again. Anything you changed by hand stays as it is.")];
  const note = "Your current app list is saved as a backup first.";
  if (!(await confirmDialog("Restore all apps?", body, "Restore all apps", { note }))) return;
  await apply(() => postJSON("restore-all"));
});

async function apply(call) {
  state.busy = true;
  setBusy(true, "Applying…");
  let changed = false;
  try {
    const res = await call();
    state.pending.clear();
    flash();
    reportResults(res);
    changed = res.results.some((r) => r.ok);
  } catch (err) {
    showResult([el("p", { class: "bad" }, err.message)]);
  } finally {
    state.busy = false;
    setBusy(false);
    await loadApps();
  }
  if (changed) await askToRestart();
}

// After changes, offer a restart: removed apps only fully go away after one.
async function askToRestart() {
  const body = [el("p", {}, "Your changes are applied. They finish taking effect after a restart, which takes about a minute.")];
  if (await confirmDialog("Restart the tablet now?", body, "Restart now", { cancelText: "Later" })) {
    await reboot();
  }
}

function setBusy(on, text) {
  for (const id of ["review", "restoreAll", "removeAll", "discard", "enablePlay"]) $(id).disabled = on;
  if (on) $("review").textContent = text;
  document.body.style.cursor = on ? "progress" : "";
}

function reportResults(res) {
  const ok = res.results.filter((r) => r.ok);
  const failed = res.results.filter((r) => !r.ok);
  const parts = [];
  if (res.results.length === 0) {
    parts.push(el("p", {}, "Nothing to change. Every app is already back."));
  } else {
    parts.push(el("p", {}, el("strong", {}, `Applied ${ok.length} change${ok.length === 1 ? "" : "s"}.`), " Restart the tablet to finish."));
  }
  if (failed.length) {
    parts.push(el("p", { class: "bad" }, `${failed.length} didn't work:`));
    parts.push(el("ul", {}, failed.map((r) => el("li", { class: "bad" }, `${nameOf(r.id)}: ${r.message || "no answer from the tablet"}`))));
  }
  if (res.backup) parts.push(el("p", { class: "row-why" }, "Backup: ", res.backup));
  showResult(parts);
}

function showResult(parts) {
  const box = $("result");
  box.replaceChildren(...parts);
  box.hidden = false;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function reboot() {
  $("restartBtn").disabled = true;
  try {
    await postJSON("reboot");
    showResult([el("p", {}, "Restarting. The tablet reconnects here when it's back on.")]);
  } catch (err) {
    showResult([el("p", { class: "bad" }, err.message)]);
  } finally {
    // Leave the button off for a while; the tablet takes about a minute.
    setTimeout(() => { $("restartBtn").disabled = false; }, 30000);
  }
}

$("restartBtn").addEventListener("click", async () => {
  const body = [el("p", {}, "The tablet turns off and on again, which takes about a minute. This page reconnects by itself.")];
  if (await confirmDialog("Restart the tablet?", body, "Restart tablet")) await reboot();
});

// ---------------------------------------------------------------------------
// Sleep picture
// ---------------------------------------------------------------------------

function choosePicture(file) {
  if (!file || !file.type.startsWith("image/")) {
    setPictureInfo("That isn't a picture. Use PNG or JPG.", true);
    return;
  }
  state.picture = file;
  show("pictureDone", false);
  const url = URL.createObjectURL(file);
  const img = $("preview");
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight;
    const mb = (file.size / 1e6).toFixed(1);
    const exact = w === 758 && h === 1024;
    let text = `${file.name}, ${w} × ${h}, ${mb} MB.`;
    if (!exact && $("fit").checked) text += " It will be resized to 758 × 1024.";
    if (!exact && !$("fit").checked) text += " The best size is 758 × 1024.";
    setPictureInfo(text, !$("fit").checked && file.size > 10e6);
  };
  img.src = url;
  img.hidden = false;
  show("screenHint", false);
  $("sendPicture").disabled = false;
}

function setPictureInfo(text, bad) {
  $("pictureInfo").textContent = text;
  $("pictureInfo").classList.toggle("bad", !!bad);
}

$("pictureInput").addEventListener("change", (e) => choosePicture(e.target.files[0]));
$("fit").addEventListener("change", () => state.picture && choosePicture(state.picture));
$("screen").addEventListener("click", () => {
  if (!$("pictureForm").hidden) $("pictureInput").click();
});

const tablet = $("tablet");
tablet.addEventListener("dragover", (e) => {
  if ($("pictureForm").hidden) return;
  e.preventDefault();
  tablet.classList.add("dragging");
});
tablet.addEventListener("dragleave", () => tablet.classList.remove("dragging"));
tablet.addEventListener("drop", (e) => {
  e.preventDefault();
  tablet.classList.remove("dragging");
  if (!$("pictureForm").hidden) choosePicture(e.dataTransfer.files[0]);
});

$("pictureForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.picture) return;
  const form = new FormData();
  form.append("picture", state.picture);
  form.append("fit", $("fit").checked ? "1" : "0");
  const apply = $("applySleep").checked;
  form.append("apply", apply ? "1" : "0");
  const btn = $("sendPicture");
  btn.disabled = true;
  btn.textContent = apply ? "Setting… (about 30 s)" : "Sending…";
  state.busy = true;
  try {
    const res = await api("picture", { method: "POST", body: form });
    flash();
    const done = $("pictureDone");
    const manual = "On the tablet: open Storage, then Image (or Pictures), long-press the picture, tap Set Screensaver, then Set as screensaver.";
    if (apply && res.applied) {
      done.textContent = `Done. ${res.name} is now the sleep picture. Press the power button to see it.`;
    } else if (apply) {
      done.textContent = `Sent as ${res.name}, but setting it didn't finish: ${res.applyError || "unknown error"}. ${manual}`;
    } else {
      done.textContent = `Sent as ${res.name}. ${manual}`;
    }
    done.hidden = false;
  } catch (err) {
    setPictureInfo(err.message, true);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = "Set sleep picture";
  }
});

// ---------------------------------------------------------------------------
// Copy logs
// ---------------------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Older browsers: copy through a hidden text box.
    const box = el("textarea", { readonly: true, style: "position:fixed;opacity:0" });
    box.value = text;
    document.body.append(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Activity panel: the log, live
// ---------------------------------------------------------------------------

const activity = { open: false, next: 0, timer: null };

function atBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

async function pollActivity() {
  const box = $("activityLog");
  const live = $("activityLive");
  try {
    const data = await api("activity?since=" + activity.next);
    const stick = atBottom(box);
    if (data.reset) box.textContent = "";
    const lines = data.lines || [];
    if (lines.length) {
      box.append(document.createTextNode((box.textContent ? "\n" : "") + lines.join("\n")));
      if (stick) box.scrollTop = box.scrollHeight;
    }
    activity.next = data.next;
    live.textContent = "Live";
    live.classList.remove("off");
  } catch (err) {
    live.textContent = err.message === "Failed to fetch" ? "App not running" : err.status === 401 ? "Page expired" : "Paused";
    live.classList.add("off");
  }
}

function setActivity(open, moveFocus = true) {
  activity.open = open;
  $("activity").hidden = !open;
  document.body.classList.toggle("activity-open", open);
  $("showActivity").setAttribute("aria-expanded", String(open));
  $("showActivity").textContent = open ? "Hide activity" : "Show activity";
  clearInterval(activity.timer);
  activity.timer = null;
  if (open) {
    pollActivity().then(() => { const box = $("activityLog"); box.scrollTop = box.scrollHeight; });
    activity.timer = setInterval(pollActivity, 2000);
    if (moveFocus) $("activityClose").focus();
  } else if (moveFocus) {
    $("showActivity").focus();
  }
  try { localStorage.setItem("activityOpen", open ? "1" : ""); } catch (_) { /* storage blocked */ }
}

$("showActivity").addEventListener("click", () => setActivity(!activity.open));
$("activityClose").addEventListener("click", () => setActivity(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activity.open && !$("dialog").open) setActivity(false);
});

let activityCopyTimer;
$("activityCopy").addEventListener("click", async () => {
  const btn = $("activityCopy");
  btn.textContent = (await copyText($("activityLog").textContent)) ? "Copied" : "Couldn't copy";
  clearTimeout(activityCopyTimer);
  activityCopyTimer = setTimeout(() => { btn.textContent = "Copy"; }, 3000);
});

if (token) {
  try { if (localStorage.getItem("activityOpen")) setActivity(true, false); } catch (_) { /* storage blocked */ }
}

let copyTimer;
$("copyLogs").addEventListener("click", async () => {
  const note = $("copyNote");
  note.classList.remove("bad");
  try {
    const res = await fetch("/api/logs", { headers: { "X-Token": token } });
    if (!res.ok) throw new Error(res.status === 401 ? "Page expired. Run boox-debloat again." : "Couldn't read the logs.");
    if (!(await copyText(await res.text()))) throw new Error("Couldn't copy. Try again.");
    note.textContent = "Copied";
  } catch (err) {
    note.classList.add("bad");
    note.textContent = err.message === "Failed to fetch" ? "The app isn't running." : err.message;
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { note.textContent = ""; }, 4000);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

refreshStatus();
setInterval(refreshStatus, 5000);
if (token) {
  postJSON("ping").catch(() => {});
  setInterval(() => postJSON("ping").catch(() => {}), 30000);
}

// A file dropped outside a drop area shouldn't open in the browser and
// leave the app.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
