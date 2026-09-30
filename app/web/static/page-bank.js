import { $, api, everyWhileVisible, h, onSubmit, timeAgo, usd } from "/static/app.js";

const KEY = "privateline-demo-bank";
const ngn = (value) => `₦${Math.round(value).toLocaleString("en-US")}`;
let rates = null;

function loadMe() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && /^\d{10}$/.test(saved.senderAccount)) return saved;
  } catch {
    // Storage may be unavailable; a fresh demo account per visit is fine.
  }
  const account = `0${Array.from(crypto.getRandomValues(new Uint8Array(9)), (byte) => byte % 10).join("")}`;
  return { senderName: "ADA OKAFOR", senderBank: "GTBank", senderAccount: account };
}

function saveMe() {
  const me = { senderName: $("#name").value, senderBank: $("#bankname").value, senderAccount: $("#acct").value };
  try { localStorage.setItem(KEY, JSON.stringify(me)); } catch { /* ignore */ }
  return me;
}

function showRate() {
  if (!rates) return;
  const amount = Number($("#amount").value) || 0;
  const dollars = Math.floor((amount / rates.deposit) * 100) / 100;
  $("#rate-hint").textContent = `At ${ngn(rates.deposit)} per $1 (market ${ngn(rates.mid)} + 1.5% exchange spread), ${ngn(amount)} credits about ${usd(dollars)}.`;
}

async function loadStatement() {
  const account = $("#acct").value;
  if (!/^\d{10}$/.test(account)) return;
  try {
    const { entries } = await api(`/api/demo-bank/statement?account=${account}`);
    $("#statement").replaceChildren(...(entries.length
      ? entries.map((entry) => h("li", {},
          h("strong", {}, entry.direction === "in" ? `+${ngn(entry.naira)}` : `-${ngn(entry.naira)}`), " ",
          entry.direction === "in" ? `from ${entry.counterparty}` : `to ${entry.counterparty}`,
          h("br"), h("span", { class: "muted" }, `${timeAgo(entry.at)} · ${entry.reference}`)))
      : [h("li", { class: "muted" }, "No transfers yet.")]));
  } catch {
    // Keep the last statement on screen.
  }
}

const me = loadMe();
$("#name").value = me.senderName;
$("#bankname").value = me.senderBank;
$("#acct").value = me.senderAccount;
const to = new URLSearchParams(location.search).get("to");
if (to) $("#to").value = to;
$("#me").addEventListener("change", () => { saveMe(); loadStatement(); });
$("#amount").addEventListener("input", showRate);

onSubmit($("#transfer"), async (data) => {
  const sender = saveMe();
  if (!$("#me").reportValidity()) throw new Error("Fill in your bank account first.");
  const naira = Number(data.get("naira"));
  const { reference } = await api("/api/demo-bank/transfer", { toAccount: String(data.get("toAccount")), naira, ...sender });
  const note = $("#sent");
  note.hidden = false;
  note.textContent = `Sent ${ngn(naira)}. Reference ${reference}. PrivateLine will text the phone on that account once 2 of 3 operators approve the deposit.`;
  loadStatement();
});

api("/api/fx").then((result) => { rates = result; showRate(); }).catch(() => { $("#rate-hint").textContent = "Rate unavailable right now."; });
loadStatement();
everyWhileVisible(4000, loadStatement);
