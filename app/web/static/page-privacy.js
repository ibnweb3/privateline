import { $, api, h, quantity, shortId, usd } from "/static/app.js";

const party = (id) => h("span", { class: "party", title: id }, shortId(id, 18, 8));

function view(title, subtitle, ...body) {
  return h("section", { class: "card" }, h("h2", { style: "font-size:1.15rem" }, title), h("p", { class: "muted small" }, subtitle), ...body);
}

function counts(entries) {
  return h("dl", { class: "kv" }, ...entries.flatMap(([label, value]) => [h("dt", {}, label), h("dd", {}, String(value))]));
}

async function load() {
  const data = await api("/api/privacy");
  $("#loaded").textContent = `Queried at ${new Date().toLocaleTimeString()}.`;
  const account = data.you.account;
  const balances = account.fields.balances.map(([symbol, amount]) => `${symbol} ${symbol === "USD" ? usd(amount) : quantity(amount)}`).join(", ") || "empty";
  const otherTotal = data.otherUser.accounts + data.otherUser.trades + data.otherUser.fills + data.otherUser.approvals + data.otherUser.refusals;

  $("#views").replaceChildren(
    view("You", "Your own Canton party, as your phone's account sees it.",
      h("dl", { class: "kv" },
        h("dt", {}, "Party"), h("dd", {}, party(data.you.party)),
        h("dt", {}, "Account"), h("dd", {}, account.fields.accountId),
        h("dt", {}, "Balances"), h("dd", {}, balances),
        h("dt", {}, "Phone"), h("dd", {}, account.fields.phoneTag),
        h("dt", {}, "Signed by"), h("dd", {}, ...account.signatories.map(party)),
        h("dt", {}, "Shared with"), h("dd", {}, ...account.observers.map(party)),
      ),
      h("p", { class: "muted small", style: "margin:12px 0 0" }, "Signed by the vault, shared with you, and no one else. The phone field is a keyed tag: it changes if your number changes, but can't be turned back into the number."),
    ),
    view("Any other PrivateLine user", "The same queries, asked as a user who isn't you.",
      h("p", { class: "zero num" }, `${otherTotal} contracts`),
      counts([["Accounts", data.otherUser.accounts], ["Trades", data.otherUser.trades], ["Fills", data.otherUser.fills], ["Approvals", data.otherUser.approvals], ["Refusals", data.otherUser.refusals]]),
      h("p", { class: "muted small", style: "margin:12px 0 0" }, "Not your account, not your trades, not that you exist. Queried as ", party(data.otherUser.party), "."),
    ),
    view("The desk", "The market maker that fills trades, asked as itself.",
      counts([["Accounts", data.desk.accounts], ["Trade proposals", data.desk.trades], ["Open fills", data.desk.fills.length]]),
      data.desk.fills.length
        ? h("ul", { class: "list small" }, ...data.desk.fills.slice(0, 5).map((fill) => h("li", {}, `${fill.side} ${quantity(fill.units)} ${fill.symbol} for ${usd(fill.dollars)}, ref ${fill.tradeRef}`)))
        : h("p", { class: "muted small" }, "No unsettled fills right now."),
      h("p", { class: "muted small", style: "margin:12px 0 0" }, "Fills carry a size and a reference, never a user or an account. The desk also sees the vault's pooled token totals: ",
        data.desk.vaultHoldings.map((holding) => `${holding.symbol} ${holding.symbol === "USD" ? usd(holding.amount) : quantity(holding.amount)}`).join(", ") || "none", "."),
    ),
    view("The vault's 3 operators", "Asked as the vault, the 2-of-3 party the operators run.",
      counts([["Accounts", data.operators.accounts.length], ["Approved actions", data.operators.approvals], ["Checker refusals", data.operators.refusals], ["Trades awaiting approval", data.operators.pendingTrades]]),
      h("ul", { class: "list small" }, ...data.operators.accounts.slice(0, 6).map((row) => h("li", {}, h("strong", {}, row.accountId), " ", h("span", { class: "party" }, row.phoneTag)))),
      h("p", { class: "muted small", style: "margin:12px 0 0" }, "Account IDs and phone tags only. No names, emails or phone numbers are on the ledger."),
    ),
    view("Off the ledger", "What PrivateLine's own database keeps about you.",
      h("dl", { class: "kv" },
        h("dt", {}, "Email"), h("dd", {}, data.offLedger.email),
        h("dt", {}, "Phone"), h("dd", {}, `${data.offLedger.phoneEncrypted} (AES-256-GCM)`),
        h("dt", {}, "Phone lookup"), h("dd", {}, `${data.offLedger.phoneLookup} (keyed HMAC)`),
        h("dt", {}, "PIN"), h("dd", {}, `${data.offLedger.pinHash} (salted scrypt)`),
      ),
    ),
    view("The public", "Anyone else on the network, or on the internet.",
      h("p", { class: "zero num" }, "Nothing"),
      h("p", { class: "muted small" }, "Other validators never receive these contracts, and there is no public explorer for them."),
    ),
  );
}

load().catch((error) => {
  $("#views").replaceChildren(h("div", { class: "card" }, h("p", { class: "error" }, error.message)));
});
