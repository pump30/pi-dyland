const log = document.getElementById("log");
const form = document.getElementById("form");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");
const skillsMeta = document.getElementById("skills-meta");

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

// Load skill list into the header metadata.
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

resetBtn.addEventListener("click", async () => {
  await fetch("/reset", { method: "POST" });
  log.innerHTML = "";
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

async function send() {
  const prompt = promptEl.value.trim();
  if (!prompt || sendBtn.disabled) return;
  promptEl.value = "";
  sendBtn.disabled = true;
  addMessage("user", prompt);
  let assistantBody = null;
  let assistantText = "";
  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
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
      // Parse SSE frames: blocks separated by "\n\n", data lines start with "data: ".
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
        // Skip streaming thinking to the UI to keep the transcript readable.
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
