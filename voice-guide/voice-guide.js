// Voice Guide: the chat page.
//
// The whole conversation lives in this browser. On every turn the page sends
// it to a small Cloudflare Worker, which adds the instructions and the API key,
// calls Claude, and streams the reply back. See voice-guide-skill/web/worker.

// Where the Worker lives. Local testing uses `wrangler dev` on port 8787.
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const WORKER_URL = LOCAL
  ? "http://localhost:8787/chat"
  : "https://voice-guide.catreading.workers.dev/chat";

const STORAGE_KEY = "voice-guide-conversation-v1";
const MAX_MESSAGES = 120; // matches the Worker's limit

const chatEl = document.getElementById("chat");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const restartButton = document.getElementById("restart");

// Messages in the shape the Claude API expects:
//   { role: "user", content: "text" }
//   { role: "assistant", content: [ ...blocks exactly as Claude sent them ] }
let messages = loadConversation();
let busy = false;

// ---------- Saving in this browser, so a refresh doesn't lose the conversation ----------

function loadConversation() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveConversation() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // Private browsing or storage full: the chat still works, it just won't survive a refresh.
  }
}

// ---------- Turning Claude's reply into page content ----------

function textOf(content) {
  if (typeof content === "string") return content;
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function renderMarkdown(markdown) {
  const html = DOMPurify.sanitize(marked.parse(markdown, { gfm: true }));
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  // Wide tables scroll sideways instead of stretching the page on phones.
  for (const table of wrapper.querySelectorAll("table")) {
    const scroller = document.createElement("div");
    scroller.className = "table-wrap";
    table.replaceWith(scroller);
    scroller.appendChild(table);
  }
  return wrapper.childNodes;
}

// The finished guide arrives between two marker lines (see the Worker's
// web-instructions.md). Split the reply into: text before, the guide, text after.
const GUIDE_START = /<<<VOICE_GUIDE(?:\s+filename="([^"]*)")?>>>\s*\n?/;
const GUIDE_END = "<<<END_VOICE_GUIDE>>>";

function splitGuide(text) {
  const start = text.match(GUIDE_START);
  if (!start) return { before: text, guide: null };
  const before = text.slice(0, start.index);
  const rest = text.slice(start.index + start[0].length);
  const endAt = rest.indexOf(GUIDE_END);
  const complete = endAt !== -1;
  const guide = complete ? rest.slice(0, endAt).trim() : rest;
  const after = complete ? rest.slice(endAt + GUIDE_END.length) : "";
  const safeName = /^[a-z0-9-]+\.md$/.test(start[1] ?? "") ? start[1] : "voice-guide.md";
  return { before, guide, complete, filename: safeName, after };
}

function guideCard(guide, filename, complete) {
  const card = document.createElement("div");
  card.className = "guide-card";
  if (!complete) {
    card.innerHTML = '<strong>Writing your guide…</strong><p class="status">This takes a minute or two.</p>';
    return card;
  }
  card.innerHTML =
    '<strong>Your voice guide is ready</strong>' +
    '<div class="composer-buttons"><button type="button" class="button download">Download ' +
    '</button><button type="button" class="button-quiet copy">Copy text</button></div>' +
    "<details><summary>Preview the guide</summary><div class=\"body\"></div></details>";
  card.querySelector(".download").append(filename);
  card.querySelector(".download").addEventListener("click", () => {
    const blob = new Blob([guide], { type: "text/markdown" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  card.querySelector(".copy").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(guide);
      event.target.textContent = "Copied";
    } catch {
      event.target.textContent = "Copy failed. Use Download instead.";
    }
  });
  card.querySelector(".body").append(...renderMarkdown(guide));
  return card;
}

// ---------- Drawing messages ----------

function addMessage(role) {
  const el = document.createElement("div");
  el.className = `message ${role}`;
  el.innerHTML = '<div class="who"></div><div class="body"></div>';
  el.querySelector(".who").textContent = role === "user" ? "You" : "Voice Guide";
  chatEl.appendChild(el);
  return el.querySelector(".body");
}

function showUser(text) {
  const body = addMessage("user");
  body.textContent = text; // plain text, never HTML
  return body.parentElement;
}

function fillAssistant(body, text, finished) {
  body.replaceChildren();
  const parts = splitGuide(text);
  if (parts.before.trim()) body.append(...renderMarkdown(parts.before));
  if (parts.guide !== null) {
    body.append(guideCard(parts.guide, parts.filename, parts.complete && finished));
    if (parts.after.trim()) body.append(...renderMarkdown(parts.after));
  }
}

function note(body, text, isError = false) {
  const p = document.createElement("p");
  p.className = isError ? "error-note" : "status";
  p.textContent = text;
  body.append(p);
}

function renderAll() {
  chatEl.replaceChildren();
  for (const message of messages) {
    if (message.role === "user") showUser(message.content);
    else fillAssistant(addMessage("assistant"), textOf(message.content), true);
  }
}

// ---------- Sending a message ----------

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  input.disabled = value || messages.length >= MAX_MESSAGES;
  if (messages.length >= MAX_MESSAGES) {
    input.placeholder = "This conversation has reached its length limit. Download your guide or start over.";
  }
}

async function send(text) {
  messages.push({ role: "user", content: text });
  saveConversation();
  const userEl = showUser(text);
  setBusy(true);

  const body = addMessage("assistant");
  note(body, "Thinking…");
  body.scrollIntoView({ block: "nearest" });

  // If anything fails, take the message back out and return it to the box,
  // so the founder can just press Send again.
  const fail = (message) => {
    messages.pop();
    saveConversation();
    userEl.remove();
    body.replaceChildren();
    note(body, message, true);
    input.value = text;
  };

  let reply = "";
  let finished = false;
  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      fail(problem.error ?? "Your message didn't go through. It's back in the box, so you can send it again.");
      return;
    }

    // The reply streams in as one JSON object per line.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let drawScheduled = false;
    const draw = () => {
      drawScheduled = false;
      fillAssistant(body, reply, false);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "text") {
          reply += event.text;
          if (!drawScheduled) {
            drawScheduled = true;
            requestAnimationFrame(draw); // redraw at most once per frame
          }
        } else if (event.type === "done") {
          finished = true;
          messages.push({ role: "assistant", content: event.content });
          saveConversation();
          fillAssistant(body, textOf(event.content), true);
          if (event.stop_reason === "max_tokens") {
            note(body, "That reply got cut off. Say \"please continue\" to get the rest.");
          } else if (event.stop_reason === "refusal") {
            note(body, "Claude couldn't help with that message. Try rephrasing it.");
          }
        } else if (event.type === "error") {
          fail(event.message);
          return;
        }
      }
    }
    if (!finished) fail("The connection dropped before the reply finished. Your message is back in the box, so you can send it again.");
  } catch {
    if (!finished) fail("Couldn't reach Voice Guide. Check your connection, then send your message again. It's back in the box.");
  } finally {
    setBusy(false);
    input.focus();
  }
}

// ---------- Buttons and keys ----------

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  send(text);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

restartButton.addEventListener("click", () => {
  if (busy) return;
  if (messages.length && !confirm("Start over? This clears the conversation in this browser.")) return;
  messages = [];
  saveConversation();
  renderAll();
  setBusy(false);
  input.focus();
});

renderAll();
setBusy(false);
