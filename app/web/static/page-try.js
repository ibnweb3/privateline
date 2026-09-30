import { $, api, h } from "/static/app.js";

const KEY = "privateline-demo-phone";

function newNumber() {
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(7)), (byte) => byte % 10).join("");
  return `+999${digits}`;
}

function loadNumber() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^\+999\d{7}$/.test(saved)) return saved;
  } catch {
    // Storage can be unavailable (private windows); a fresh number per visit is fine.
  }
  const number = newNumber();
  try { localStorage.setItem(KEY, number); } catch { /* see above */ }
  return number;
}

let phone = loadNumber();
let lastId = 0;
let waiting = null;
const thread = $("#thread");

function pretty(number) {
  return `${number.slice(0, 4)} ${number.slice(4, 7)} ${number.slice(7)}`;
}

function showNumber() {
  $("#my-number").textContent = pretty(phone);
  $("#head-number").textContent = pretty(phone);
  $("#signup-link").href = `/signup?phone=${encodeURIComponent(phone)}`;
}

function scrollDown() {
  thread.scrollTop = thread.scrollHeight;
}

function setWaiting(text) {
  waiting?.remove();
  waiting = text ? h("div", { class: "typing" }, text) : null;
  if (waiting) thread.append(waiting);
  scrollDown();
}

function addBubble(message, pending = false) {
  $("#empty")?.remove();
  const bubble = h("div", { class: `bubble ${message.direction === "in" ? "out" : "in"}`, "data-pending": pending ? "1" : false }, message.body);
  if (waiting) thread.insertBefore(bubble, waiting);
  else thread.append(bubble);
  scrollDown();
}

async function poll() {
  try {
    const { messages } = await api(`/api/sim/messages?phone=${encodeURIComponent(phone)}&after=${lastId}`);
    if (messages.length > 0) {
      thread.querySelectorAll("[data-pending]").forEach((bubble) => bubble.remove());
      for (const message of messages) {
        addBubble(message);
        lastId = message.id;
        if (message.direction === "out") setWaiting(null);
        if (message.direction === "out" && /Welcome|Cash|Done|Not done/.test(message.body)) {
          $("#number-status").className = "pill good";
          $("#number-status").textContent = "signed up";
          $("#signup-hint").textContent = "This number has an account. Text it below.";
        }
      }
    }
  } catch {
    // Keep polling; the server may be restarting.
  }
}

async function send(text) {
  const body = text.trim();
  if (!body) return;
  addBubble({ direction: "in", body }, true);
  setWaiting(/^(YES|Y|OK)\s/i.test(body) ? "Waiting for 2 of 3 operators to approve..." : "...");
  try {
    await api("/api/sim/send", { phone, body });
  } catch (error) {
    setWaiting(null);
    addBubble({ direction: "out", body: `(not sent: ${error.message})` });
  }
}

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#message");
  const text = input.value;
  input.value = "";
  send(text);
});

$("#chips").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (chip) send(chip.textContent);
});

$("#new-number").addEventListener("click", () => {
  phone = newNumber();
  try { localStorage.setItem(KEY, phone); } catch { /* ignore */ }
  lastId = 0;
  thread.replaceChildren(h("p", { class: "thread-empty", id: "empty" }, "No messages yet. Sign up with this number, then text HELP."));
  $("#number-status").className = "pill";
  $("#number-status").textContent = "new";
  showNumber();
});

showNumber();
poll();
setInterval(poll, 1200);
