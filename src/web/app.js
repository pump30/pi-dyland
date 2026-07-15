const log = document.getElementById("log");
const form = document.getElementById("form");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");
const skillsMeta = document.getElementById("skills-meta");
const attachBtn = document.getElementById("attach");
const fileInput = document.getElementById("file-input");
const attachmentsEl = document.getElementById("attachments");
const dropOverlay = document.getElementById("drop-overlay");
const threadListEl = document.getElementById("thread-list");
const threadNewBtn = document.getElementById("thread-new");
const threadTitleEl = document.getElementById("thread-title");
const sidebarEl = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");

// -----------------------------------------------------------------------------
// Thread state
// -----------------------------------------------------------------------------

const THREAD_KEY = "pi-dyland.active-thread";
let activeThreadId = localStorage.getItem(THREAD_KEY) || "default";
/** @type {{id:string,title:string,createdAt:number,lastActiveAt:number,messageCount:number}[]} */
let threadCache = [];

function setActiveThread(id) {
  activeThreadId = id;
  localStorage.setItem(THREAD_KEY, id);
  renderThreadList();
  refreshTitleFromCache();
}

function refreshTitleFromCache() {
  const t = threadCache.find((x) => x.id === activeThreadId);
  threadTitleEl.textContent = t?.title || "pi-dyland";
}

async function fetchThreads() {
  try {
    const r = await fetch("/threads");
    if (!r.ok) return;
    threadCache = await r.json();
    renderThreadList();
    refreshTitleFromCache();
  } catch (err) {
    // silent; sidebar just won't populate
  }
}

function renderThreadList() {
  threadListEl.innerHTML = "";
  for (const t of threadCache) {
    const li = document.createElement("li");
    if (t.id === activeThreadId) li.classList.add("active");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = t.title || "(untitled)";
    title.title = `${t.title} — ${t.messageCount} messages`;
    title.addEventListener("click", () => switchThread(t.id));
    li.appendChild(title);
    if (t.id !== "default") {
      const del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.textContent = "×";
      del.title = "Delete thread";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${t.title}"?`)) return;
        await fetch(`/threads/${t.id}`, { method: "DELETE" });
        if (activeThreadId === t.id) setActiveThread("default");
        await fetchThreads();
        await loadMessages();
      });
      li.appendChild(del);
    }
    threadListEl.appendChild(li);
  }
}

async function newThread() {
  const r = await fetch("/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) return;
  const t = await r.json();
  await fetchThreads();
  setActiveThread(t.id);
  log.innerHTML = "";
  promptEl.focus();
  if (window.matchMedia("(max-width: 640px)").matches) sidebarEl.classList.remove("open");
}

async function switchThread(id) {
  if (id === activeThreadId) return;
  setActiveThread(id);
  await loadMessages();
  if (window.matchMedia("(max-width: 640px)").matches) sidebarEl.classList.remove("open");
}

/** Map<tool_use_id, cardHandle> — bridges paired history messages. */
const historicalToolCards = new Map();

async function loadMessages() {
  log.innerHTML = "";
  historicalToolCards.clear();
  try {
    const r = await fetch(`/messages?thread=${encodeURIComponent(activeThreadId)}`);
    if (!r.ok) return;
    const messages = await r.json();
    for (const m of messages) renderStoredMessage(m);
  } catch (err) {
    // silent
  }
}

function renderStoredMessage(m) {
  // pi Agent message shape: { role, content:[{type,text|...}, ...] }
  if (!m || !Array.isArray(m.content)) return;
  const role = m.role;
  if (role === "user") {
    let text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    // Strip server-side system hints (see server.ts applySlashHint).
    let skillTag = null;
    const hintMatch = text.match(/<system_hint>[\s\S]*?The user invoked \/([a-z0-9_]+)[\s\S]*?<\/system_hint>/);
    if (hintMatch) skillTag = hintMatch[1];
    text = text.replace(/<system_hint>[\s\S]*?<\/system_hint>\s*/g, "").trim();
    if (text) {
      addUserMessage(text, [], []);
      if (skillTag) {
        const lastUser = log.querySelector(".msg.user:last-of-type");
        if (lastUser && !lastUser.querySelector(".skill-chip")) {
          const chip = document.createElement("span");
          chip.className = "skill-chip";
          chip.textContent = `via /${skillTag}`;
          lastUser.querySelector(".role")?.appendChild(chip);
        }
      }
    }
  } else if (role === "assistant") {
    const text = m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    const toolCalls = m.content.filter((c) => c.type === "tool_use");
    if (text) {
      const body = addMessage("assistant md-msg", "");
      body.innerHTML = renderMarkdown(text);
    }
    for (const tc of toolCalls) {
      const card = toolCard(tc.name, tc.input);
      // Historical tool calls don't stream results; result comes from the
      // paired role="tool" message. Store card keyed by toolCallId so
      // renderStoredMessage("tool") can attach the result later.
      historicalToolCards.set(tc.id, card);
    }
  } else if (role === "tool") {
    // Attach result to the card created above, if we can find it.
    const results = m.content.filter((c) => c.type === "tool_result");
    for (const r of results) {
      const card = historicalToolCards.get(r.toolUseId ?? r.tool_use_id);
      const text = (Array.isArray(r.content) ? r.content : [])
        .filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
      if (card) {
        card.setResult(text, r.isError);
        historicalToolCards.delete(r.toolUseId ?? r.tool_use_id);
      } else if (text) {
        // Orphan tool result — render standalone.
        const c = toolCard("(unknown tool)", null);
        c.setResult(text, r.isError);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Attachment state
// -----------------------------------------------------------------------------

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 200 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** @type {{kind:'image', mimeType:string, data:string, name:string, size:number}[]} */
const pendingImages = [];
/** @type {{kind:'file', name:string, content:string, size:number}[]} */
const pendingFiles = [];

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function renderAttachments() {
  attachmentsEl.innerHTML = "";
  for (const [i, img] of pendingImages.entries()) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const thumb = document.createElement("img");
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    thumb.alt = img.name;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = img.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = humanSize(img.size);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    chip.append(thumb, name, size, rm);
    attachmentsEl.appendChild(chip);
  }
  for (const [i, f] of pendingFiles.entries()) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = `📄 ${f.name}`;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = humanSize(f.size);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      pendingFiles.splice(i, 1);
      renderAttachments();
    });
    chip.append(name, size, rm);
    attachmentsEl.appendChild(chip);
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file, "utf-8");
  });
}

async function ingestFile(file) {
  const isImage = file.type.startsWith("image/") && IMAGE_MIMES.has(file.type);
  if (isImage) {
    if (pendingImages.length >= MAX_IMAGES) {
      addMessage("error", `Too many images attached (max ${MAX_IMAGES}).`);
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      addMessage("error", `Image "${file.name}" too large (${humanSize(file.size)}, max ${humanSize(MAX_IMAGE_BYTES)}).`);
      return;
    }
    const dataUrl = await readAsDataUrl(file);
    // strip "data:<mime>;base64," prefix
    const b64 = String(dataUrl).split(",", 2)[1] ?? "";
    pendingImages.push({ kind: "image", mimeType: file.type, data: b64, name: file.name, size: file.size });
    renderAttachments();
    return;
  }
  // Everything else -> text file
  if (pendingFiles.length >= MAX_FILES) {
    addMessage("error", `Too many files attached (max ${MAX_FILES}).`);
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    addMessage("error", `File "${file.name}" too large (${humanSize(file.size)}, max ${humanSize(MAX_FILE_BYTES)} for text).`);
    return;
  }
  let content;
  try {
    content = await readAsText(file);
  } catch (err) {
    addMessage("error", `Could not read "${file.name}" as text: ${err?.message ?? err}`);
    return;
  }
  pendingFiles.push({ kind: "file", name: file.name, content, size: file.size });
  renderAttachments();
}

async function ingestFiles(files) {
  for (const f of files) await ingestFile(f);
}

// -----------------------------------------------------------------------------
// Message rendering
// -----------------------------------------------------------------------------

function el(cls, text) {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  if (text) d.textContent = text;
  return d;
}

// -----------------------------------------------------------------------------
// Minimal Markdown renderer. Enough for tool outputs and assistant replies
// (paragraphs, bold, inline code, fenced code, links, unordered lists).
// Not a full CommonMark parser — anything unsupported stays literal.
// -----------------------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderMarkdown(src) {
  if (!src) return "";
  const blocks = [];
  let s = src.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000CODE${i}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = s.split("\n");
  const out = [];
  let listOpen = false;
  let paraBuf = [];
  const flushPara = () => {
    if (paraBuf.length > 0) {
      out.push(`<p>${paraBuf.join("<br>")}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  for (const raw of lines) {
    if (raw.startsWith("\u0000CODE")) {
      flushPara();
      closeList();
      const i = Number(raw.slice(5).replace(/\u0000$/, ""));
      out.push(blocks[i]);
      continue;
    }
    const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    if (raw.trim() === "") {
      flushPara();
      closeList();
      continue;
    }
    closeList();
    paraBuf.push(raw);
  }
  flushPara();
  closeList();
  return out.join("");
}

// Tool card: collapsed by default, click header to expand args + result.
function toolCard(name, args) {
  const wrap = document.createElement("div");
  wrap.className = "msg tool card";
  const hd = document.createElement("div");
  hd.className = "hd";
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▶";
  const nm = document.createElement("span");
  nm.className = "toolname";
  nm.textContent = `⚙ ${name}`;
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = "running…";
  hd.append(caret, nm, status);
  hd.addEventListener("click", () => wrap.classList.toggle("open"));
  wrap.appendChild(hd);

  const body = document.createElement("div");
  body.className = "body";
  const argsKv = document.createElement("div");
  argsKv.className = "kv";
  argsKv.innerHTML = `<div class="k">arguments</div><pre></pre>`;
  argsKv.querySelector("pre").textContent = JSON.stringify(args ?? {}, null, 2);
  const resultKv = document.createElement("div");
  resultKv.className = "kv";
  resultKv.innerHTML = `<div class="k">result</div><pre></pre>`;
  body.append(argsKv, resultKv);
  wrap.appendChild(body);

  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;

  return {
    element: wrap,
    status,
    setResult(text, isError) {
      resultKv.querySelector("pre").textContent = text || "(no output)";
      status.textContent = isError ? "error" : "done";
      status.classList.toggle("err", !!isError);
      if (isError) wrap.classList.add("open");
    },
  };
}

function addMessage(cls, text) {
  const wrap = el(cls);
  const role = document.createElement("div");
  role.className = "role";
  role.textContent = cls;
  const body = document.createElement("div");
  body.textContent = text ?? "";
  wrap.appendChild(role);
  wrap.appendChild(body);
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return body;
}

function addUserMessage(text, images, files) {
  const wrap = el("user");
  const role = document.createElement("div");
  role.className = "role";
  role.textContent = "user";
  const body = document.createElement("div");
  body.textContent = text ?? "";
  wrap.appendChild(role);
  wrap.appendChild(body);
  if ((images && images.length) || (files && files.length)) {
    const attach = document.createElement("div");
    attach.className = "attachments-in-msg";
    for (const img of images ?? []) {
      const t = document.createElement("img");
      t.src = `data:${img.mimeType};base64,${img.data}`;
      t.alt = img.name;
      attach.appendChild(t);
    }
    for (const f of files ?? []) {
      const tag = document.createElement("span");
      tag.className = "file-tag";
      tag.textContent = `📄 ${f.name} (${humanSize(f.size)})`;
      attach.appendChild(tag);
    }
    wrap.appendChild(attach);
  }
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

// -----------------------------------------------------------------------------
// Skill list
// -----------------------------------------------------------------------------

/** @type {{name:string,label:string,description:string}[]} */
let skillCache = [];

fetch("/skills")
  .then((r) => r.json())
  .then((skills) => {
    skillCache = skills;
    skillsMeta.textContent =
      skills.length === 0
        ? "no skills loaded"
        : `${skills.length} skill${skills.length === 1 ? "" : "s"}: ${skills.map((s) => s.name).join(", ")}`;
  })
  .catch(() => {
    skillsMeta.textContent = "skill list unavailable";
  });

// -----------------------------------------------------------------------------
// Slash autocomplete
// -----------------------------------------------------------------------------

const slashMenu = document.getElementById("slash-menu");
let slashHl = 0;

function slashQueryFromPrompt() {
  const v = promptEl.value;
  // Only fire when the prompt starts with a bare "/" (no space yet, still on the token).
  const m = v.match(/^\/([a-z0-9_-]*)$/i);
  return m ? m[1].toLowerCase().replace(/-/g, "_") : null;
}

function positionSlashMenu() {
  const rect = promptEl.getBoundingClientRect();
  slashMenu.style.left = `${rect.left}px`;
  slashMenu.style.bottom = `${window.innerHeight - rect.top + 6}px`;
  slashMenu.style.top = "auto";
}

function renderSlashMenu(matches) {
  slashMenu.innerHTML = "";
  matches.forEach((s, i) => {
    const item = document.createElement("div");
    item.className = `slash-item${i === slashHl ? " hl" : ""}`;
    const n = document.createElement("div");
    n.className = "n";
    n.textContent = `/${s.name}`;
    const d = document.createElement("div");
    d.className = "d";
    d.textContent = s.label || s.description?.slice(0, 80) || "";
    item.appendChild(n);
    item.appendChild(d);
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptSlash(s.name);
    });
    slashMenu.appendChild(item);
  });
}

function acceptSlash(name) {
  promptEl.value = `/${name} `;
  closeSlashMenu();
  promptEl.focus();
}

function closeSlashMenu() {
  slashMenu.classList.remove("open");
  slashHl = 0;
}

function refreshSlashMenu() {
  const q = slashQueryFromPrompt();
  if (q === null || skillCache.length === 0) {
    closeSlashMenu();
    return;
  }
  const matches = skillCache.filter((s) => s.name.startsWith(q));
  if (matches.length === 0) {
    closeSlashMenu();
    return;
  }
  if (slashHl >= matches.length) slashHl = 0;
  positionSlashMenu();
  renderSlashMenu(matches);
  slashMenu.classList.add("open");
}

promptEl.addEventListener("input", refreshSlashMenu);
promptEl.addEventListener("blur", () => setTimeout(closeSlashMenu, 120));
window.addEventListener("resize", () => {
  if (slashMenu.classList.contains("open")) positionSlashMenu();
});

// -----------------------------------------------------------------------------
// Controls
// -----------------------------------------------------------------------------

resetBtn.addEventListener("click", async () => {
  await fetch(`/reset?thread=${encodeURIComponent(activeThreadId)}`, { method: "POST" });
  log.innerHTML = "";
  pendingImages.length = 0;
  pendingFiles.length = 0;
  renderAttachments();
});

threadNewBtn.addEventListener("click", newThread);
sidebarToggle?.addEventListener("click", () => sidebarEl.classList.toggle("open"));

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  await ingestFiles(fileInput.files);
  fileInput.value = "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await send();
});

promptEl.addEventListener("keydown", (event) => {
  // Slash menu navigation takes precedence when open.
  if (slashMenu.classList.contains("open")) {
    const items = slashMenu.querySelectorAll(".slash-item");
    if (event.key === "ArrowDown") {
      event.preventDefault();
      slashHl = Math.min(items.length - 1, slashHl + 1);
      refreshSlashMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      slashHl = Math.max(0, slashHl - 1);
      refreshSlashMenu();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const q = slashQueryFromPrompt();
      if (q !== null) {
        const matches = skillCache.filter((s) => s.name.startsWith(q));
        const picked = matches[slashHl];
        if (picked) {
          event.preventDefault();
          acceptSlash(picked.name);
          return;
        }
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    form.requestSubmit();
  }
});

// Paste images from clipboard into attachments.
promptEl.addEventListener("paste", async (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const it of items) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length > 0) {
    event.preventDefault();
    await ingestFiles(files);
  }
});

// Drag & drop across the whole window.
let dragCounter = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  dragCounter++;
  dropOverlay.classList.add("active");
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.classList.remove("active");
});
window.addEventListener("drop", async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove("active");
  await ingestFiles(e.dataTransfer.files);
});

// -----------------------------------------------------------------------------
// Send
// -----------------------------------------------------------------------------

async function send() {
  const prompt = promptEl.value.trim();
  const hasAttachments = pendingImages.length > 0 || pendingFiles.length > 0;
  if (!prompt && !hasAttachments) return;
  if (sendBtn.disabled) return;
  const sentImages = pendingImages.slice();
  const sentFiles = pendingFiles.slice();
  promptEl.value = "";
  pendingImages.length = 0;
  pendingFiles.length = 0;
  renderAttachments();
  sendBtn.disabled = true;
  addUserMessage(prompt, sentImages, sentFiles);
  let assistantBody = null;
  let assistantText = "";
  const toolCards = new Map(); // toolCallId -> card handle
  try {
    const body = { prompt, threadId: activeThreadId };
    if (sentImages.length > 0) {
      body.images = sentImages.map((i) => ({ data: i.data, mimeType: i.mimeType }));
    }
    if (sentFiles.length > 0) {
      body.files = sentFiles.map((f) => ({ name: f.name, content: f.content }));
    }
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const err = await res.text().catch(() => "");
      addMessage("error", `HTTP ${res.status}: ${err}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        let payload;
        try {
          payload = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }
        handleEvent(payload);
      }
    }
  } catch (err) {
    addMessage("error", err && err.message ? err.message : String(err));
  } finally {
    sendBtn.disabled = false;
    promptEl.focus();
    // Server may have auto-derived a title from the first prompt; refresh list.
    fetchThreads();
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case "assistant_start":
        assistantText = "";
        assistantBody = addMessage("assistant md-msg", "");
        break;
      case "text_delta":
        if (!assistantBody) {
          assistantText = "";
          assistantBody = addMessage("assistant md-msg", "");
        }
        assistantText += ev.delta;
        // Render as Markdown on every delta. For tiny messages this is fine;
        // for very large outputs consider debouncing. Current turns average
        // <2KB, so unnecessary.
        assistantBody.innerHTML = renderMarkdown(assistantText);
        log.scrollTop = log.scrollHeight;
        break;
      case "thinking_delta":
        break;
      case "tool_start": {
        const card = toolCard(ev.name, ev.args);
        if (ev.toolCallId) toolCards.set(ev.toolCallId, card);
        break;
      }
      case "tool_end": {
        const text = (ev.result?.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        const isErr = Boolean(ev.result?.isError);
        const card = ev.toolCallId ? toolCards.get(ev.toolCallId) : null;
        if (card) {
          card.setResult(text, isErr);
          toolCards.delete(ev.toolCallId);
        } else {
          // No matching start — render a standalone card.
          const c = toolCard(ev.name, null);
          c.setResult(text, isErr);
        }
        break;
      }
      case "skill_hint": {
        // Server acknowledged a /skill-name trigger. Tag the most recent user
        // message so the user sees which skill was hinted.
        const lastUser = log.querySelector(".msg.user:last-of-type");
        if (lastUser && !lastUser.querySelector(".skill-chip")) {
          const chip = document.createElement("span");
          chip.className = "skill-chip";
          chip.textContent = `via /${ev.name}`;
          lastUser.querySelector(".role")?.appendChild(chip);
        }
        break;
      }
      case "error":
        addMessage("error", ev.message ?? "unknown error");
        break;
      case "done":
        assistantBody = null;
        break;
    }
  }
}

promptEl.focus();

// Initial load: populate sidebar + restore active thread history.
fetchThreads().then(() => loadMessages());
