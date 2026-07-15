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

fetch("/skills")
  .then((r) => r.json())
  .then((skills) => {
    skillsMeta.textContent =
      skills.length === 0
        ? "no skills loaded"
        : `${skills.length} skill${skills.length === 1 ? "" : "s"}: ${skills.map((s) => s.name).join(", ")}`;
  })
  .catch(() => {
    skillsMeta.textContent = "skill list unavailable";
  });

// -----------------------------------------------------------------------------
// Controls
// -----------------------------------------------------------------------------

resetBtn.addEventListener("click", async () => {
  await fetch("/reset", { method: "POST" });
  log.innerHTML = "";
  pendingImages.length = 0;
  pendingFiles.length = 0;
  renderAttachments();
});

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
  try {
    const body = { prompt };
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
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case "assistant_start":
        assistantText = "";
        assistantBody = addMessage("assistant", "");
        break;
      case "text_delta":
        if (!assistantBody) {
          assistantText = "";
          assistantBody = addMessage("assistant", "");
        }
        assistantText += ev.delta;
        assistantBody.textContent = assistantText;
        log.scrollTop = log.scrollHeight;
        break;
      case "thinking_delta":
        break;
      case "tool_start": {
        const body = addMessage("tool", "");
        body.textContent = `→ ${ev.name}(${JSON.stringify(ev.args ?? {})})`;
        break;
      }
      case "tool_end": {
        const body = addMessage("tool", "");
        const text = (ev.result?.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        body.textContent = `← ${ev.name} → ${text || "(no output)"}`;
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
