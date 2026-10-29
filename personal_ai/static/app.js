"use strict";

const $ = (id) => document.getElementById(id);
let currentId = null, currentMessages = [], attachment = null, controller = null;
let busy = false, defaultPrompt = "", settings = {};
try { settings = JSON.parse(localStorage.getItem("hearth.preferences") || "{}"); } catch { /* defaults */ }
if (!settings || typeof settings !== "object") settings = {};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function notice(message = "") { $("notice").textContent = message; $("notice").hidden = !message; }
function scrollDown() { $("scroll-area").scrollTop = $("scroll-area").scrollHeight; }
function renderContent(target, text) {
  // Model output is untrusted. Use text nodes only, including fenced code blocks.
  target.replaceChildren();
  const blocks = text.split(/```[^\n]*\n([\s\S]*?)```/g);
  blocks.forEach((block, index) => {
    if (index % 2) {
      const pre = document.createElement("pre"), code = document.createElement("code");
      code.textContent = block; pre.append(code); target.append(pre);
    } else target.append(document.createTextNode(block));
  });
}
function addMessage(role, content, waiting = false) {
  const article = document.createElement("article"); article.className = `message ${role}`;
  const label = document.createElement("div"); label.className = "message-label";
  const name = document.createElement("span"); name.textContent = role === "user" ? "YOU" : "✳ HEARTH";
  const copy = document.createElement("button"); copy.className = "message-copy"; copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(article.dataset.content || ""); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1500); }
    catch { notice("Clipboard unavailable. You can select and copy the message text."); }
  });
  label.append(name, copy);
  const body = document.createElement("div"); body.className = waiting ? "message-body thinking" : "message-body";
  article.dataset.content = content;
  renderContent(body, waiting ? "Thinking about that…" : content);
  article.append(label, body); $("messages").append(article); $("welcome").hidden = true;
  return { article, body };
}
async function refreshHistory() {
  const chats = await api("/api/conversations"); $("history").replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("p"); empty.className = "empty-history";
    empty.textContent = "Good conversations start here."; $("history").append(empty);
  }
  for (const chat of chats) {
    const row = document.createElement("div"); row.className = `history-item${chat.id === currentId ? " active" : ""}`;
    const open = document.createElement("button"); open.className = "history-open"; open.textContent = chat.title;
    open.title = chat.title; open.disabled = busy;
    open.addEventListener("click", async () => {
      try {
        const conversation = await api(`/api/conversations/${chat.id}`);
        currentId = chat.id; currentMessages = conversation.messages; $("messages").replaceChildren();
        currentMessages.forEach((m) => addMessage(m.role, m.content));
        $("welcome").hidden = currentMessages.length > 0; $("sidebar").classList.remove("open");
        notice(); await refreshHistory(); scrollDown();
      } catch (error) { notice(error.message); }
    });
    const remove = document.createElement("button"); remove.className = "history-delete";
    remove.textContent = "×"; remove.title = "Delete conversation"; remove.setAttribute("aria-label", `Delete ${chat.title}`); remove.disabled = busy;
    remove.addEventListener("click", async () => {
      if (!confirm("Delete this conversation permanently from this computer?")) return;
      try {
        await api(`/api/conversations/${chat.id}`, { method: "DELETE" });
        if (currentId === chat.id) newChat();
        await refreshHistory();
      } catch (error) { notice(error.message); }
    });
    row.append(open, remove); $("history").append(row);
  }
}
async function checkStatus() {
  $("refresh").disabled = true;
  try {
    const status = await api("/api/status"); defaultPrompt = status.default_prompt;
    const previous = $("model").value || settings.model;
    $("model").replaceChildren();
    for (const model of status.models) {
      const option = document.createElement("option"); option.value = model; option.textContent = model; $("model").append(option);
    }
    if (status.models.includes(previous)) $("model").value = previous;
    else if (status.models.includes("qwen3:8b")) $("model").value = "qwen3:8b";
    if (!status.models.length) {
      const option = document.createElement("option"); option.value = ""; option.textContent = "No model available"; $("model").append(option);
    }
    const ready = status.online && status.models.length > 0;
    $("connection").textContent = ready ? "● Local" : "Setup needed";
    $("connection").classList.toggle("offline", !ready); $("setup").hidden = ready;
    $("setup-title").textContent = status.online ? "Choose your first model" : "Connect your local model";
    $("setup-description").textContent = status.online ? "Ollama is running. Download a model in your terminal, then check again." : "Start Ollama with ‘ollama serve’, then download a model. See README for installation.";
    $("send").disabled = !ready;
  } catch (error) { notice(`Could not check the local model: ${error.message}`); }
  finally { $("refresh").disabled = false; }
}
function newChat() {
  if (busy) return;
  currentId = null; currentMessages = []; $("messages").replaceChildren(); $("welcome").hidden = false;
  $("prompt").value = ""; $("prompt").style.height = "auto"; clearAttachment(); notice();
  $("sidebar").classList.remove("open"); refreshHistory().catch((error) => notice(error.message)); $("prompt").focus();
}
function setBusy(value) {
  busy = value; $("send").hidden = value; $("stop").hidden = !value;
  for (const id of ["new-chat", "model", "attach", "prompt", "remove-file"]) $(id).disabled = value;
  document.querySelectorAll(".history-open,.history-delete,.suggestions button").forEach((el) => { el.disabled = value; });
}
async function send(event) {
  event.preventDefault();
  if (busy) return;
  let message = $("prompt").value.trim();
  const model = $("model").value;
  if (!message || !model) { notice("Enter a message and connect an installed model first."); return; }
  if (attachment) message += `\n\n--- Attached file: ${attachment.name} ---\n${attachment.content}\n--- End of attached file ---`;
  if (message.length > 12000) { notice("The message and file together must fit within 12,000 characters. Try a smaller excerpt."); return; }
  const draft = $("prompt").value, draftAttachment = attachment;
  notice(); setBusy(true); controller = new AbortController();
  addMessage("user", message); currentMessages.push({ role: "user", content: message });
  const reply = addMessage("assistant", "", true); let answer = "", accepted = false;
  $("prompt").value = ""; $("prompt").style.height = "auto"; clearAttachment(); scrollDown();
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ conversation_id: currentId, message, model,
        system_prompt: settings.system_prompt ?? defaultPrompt, temperature: settings.temperature ?? 0.7 }),
    });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error || "Request failed."); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "", done = false;
    function process(line) {
      if (!line.trim()) return;
      const part = JSON.parse(line);
      if (part.type === "start") { accepted = true; currentId = part.conversation_id; }
      if (part.type === "token") {
        answer += part.content; reply.body.classList.remove("thinking"); renderContent(reply.body, answer);
        reply.article.dataset.content = answer; scrollDown();
      }
      if (part.type === "done") done = true;
      if (part.type === "error") throw new Error(part.error);
    }
    while (true) {
      const { value, done: end } = await reader.read();
      buffer += decoder.decode(value, { stream: !end });
      const lines = buffer.split("\n"); buffer = lines.pop(); lines.forEach(process);
      if (end) { process(buffer); break; }
    }
    if (!done) throw new Error("The connection ended early. Your partial reply has been kept.");
  } catch (error) {
    notice(error.name === "AbortError" ? "Reply stopped. Any generated text is kept." : error.message);
    if (!accepted) {
      $("prompt").value = draft; attachment = draftAttachment; updateAttachment();
      currentMessages.pop(); reply.article.previousElementSibling?.remove();
    }
  } finally {
    if (answer) currentMessages.push({ role: "assistant", content: answer });
    else reply.article.remove();
    $("welcome").hidden = currentMessages.length > 0;
    setBusy(false); controller = null;
    refreshHistory().catch((error) => notice(error.message)); $("prompt").focus();
  }
}
function clearAttachment() { attachment = null; $("file").value = ""; updateAttachment(); }
function updateAttachment() { $("attachment").hidden = !attachment; $("attachment").querySelector("span").textContent = attachment ? `↳ ${attachment.name}` : ""; }
$("file").addEventListener("change", async () => {
  const file = $("file").files[0]; if (!file) return;
  if (file.size > 40000) { notice("Choose a small text file (up to 40 KB), or paste a short excerpt."); return; }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    if (content.includes("\0") || /\.(pdf|docx?|png|jpe?g|gif|zip)$/i.test(file.name)) throw new Error();
    attachment = { name: file.name, content }; updateAttachment(); notice();
  } catch { notice("This version accepts UTF-8 text and code files. Convert documents to text first."); }
});
$("composer").addEventListener("submit", send);
$("prompt").addEventListener("input", () => { $("prompt").style.height = "auto"; $("prompt").style.height = `${Math.min($("prompt").scrollHeight, 160)}px`; });
$("prompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("composer").requestSubmit(); }
});
$("new-chat").addEventListener("click", newChat);
$("stop").addEventListener("click", () => controller?.abort());
$("refresh").addEventListener("click", checkStatus);
$("attach").addEventListener("click", () => $("file").click());
$("remove-file").addEventListener("click", clearAttachment);
$("menu").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("scroll-area").addEventListener("click", () => $("sidebar").classList.remove("open"));
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { $("prompt").value = button.dataset.prompt; $("prompt").focus(); }));
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "n") { event.preventDefault(); newChat(); }
});
function saveSettings() {
  try { localStorage.setItem("hearth.preferences", JSON.stringify(settings)); }
  catch { notice("Browser storage is unavailable. Preferences will last for this tab only."); }
}
$("model").addEventListener("change", () => { settings.model = $("model").value; saveSettings(); });
$("settings").addEventListener("click", () => {
  $("system-prompt").value = settings.system_prompt ?? defaultPrompt;
  $("temperature").value = settings.temperature ?? 0.7; $("temperature-value").textContent = $("temperature").value;
  $("preferences").showModal();
});
$("temperature").addEventListener("input", () => { $("temperature-value").textContent = $("temperature").value; });
$("reset-settings").addEventListener("click", () => {
  $("system-prompt").value = defaultPrompt; $("temperature").value = 0.7; $("temperature-value").textContent = "0.7";
});
$("preferences-form").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "save") return;
  settings.system_prompt = $("system-prompt").value; settings.temperature = Number($("temperature").value); saveSettings();
});
$("export").addEventListener("click", () => {
  if (!currentMessages.length) { notice("Start a conversation before exporting."); return; }
  const text = "# Hearth conversation\n\n" + currentMessages.map((m) => `## ${m.role === "user" ? "You" : "Hearth"}\n\n${m.content}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `hearth-${new Date().toISOString().slice(0, 10)}.md`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
Promise.all([checkStatus(), refreshHistory()]).catch((error) => notice(error.message));
