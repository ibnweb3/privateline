import { $, api, h, onSubmit, price, quantity, timeAgo, usd } from "/static/app.js";

async function load() {
  const me = await api("/api/me");
  $("#account-id").textContent = `Account ${me.accountId}`;
  $("#total").textContent = usd(me.total);
  $("#subline").textContent = `${usd(me.cash)} cash. Signed in as ${me.email}.`;
  $("#locked-note").hidden = !me.locked;
  $("#lock").checked = me.locked;
  $("#phone").textContent = me.phone;

  const rows = me.holdings.map((holding) => h("tr", {},
    h("td", {}, h("strong", {}, holding.name), h("br"), h("span", { class: "muted small" }, holding.symbol)),
    h("td", { class: "r" }, `${quantity(holding.units)} ${holding.unit}`),
    h("td", { class: "r" }, price(holding.price)),
    h("td", { class: "r" }, usd(holding.value)),
  ));
  rows.unshift(h("tr", {}, h("td", {}, h("strong", {}, "Cash"), h("br"), h("span", { class: "muted small" }, "demo dollars")), h("td", { class: "r" }, usd(me.cash)), h("td", { class: "r" }, ""), h("td", { class: "r" }, usd(me.cash))));
  if (me.holdings.length === 0) {
    rows.push(h("tr", {}, h("td", { colspan: 4, class: "muted" }, "No investments yet. Text BUY GOLD 10 or BUY SPY 10 to start.")));
  }
  $("#holdings").replaceChildren(...rows);

  const used = me.dailyLimit > 0 ? Math.min(1, me.spentToday / me.dailyLimit) : 0;
  $("#limit-text").textContent = `Traded today: ${usd(me.spentToday)} of your ${usd(me.dailyLimit)} daily limit. The limit is enforced by the account contract itself.`;
  $("#limit-bar").style.width = `${Math.round(used * 100)}%`;
  $("#pin-paused").hidden = !me.pinPausedUntil;
  if (me.pinPausedUntil) $("#pin-paused").textContent = `Trading is paused after 3 wrong PINs until ${new Date(me.pinPausedUntil).toLocaleTimeString()}.`;

  $("#phone-change").hidden = !me.phoneChange;
  if (me.phoneChange) {
    $("#phone-change").textContent = `Moving to ${me.phoneChange.phone} after ${new Date(me.phoneChange.readyAt).toLocaleString()}. Your current phone can stop it by replying NO.`;
  }

  $("#activity").replaceChildren(...(me.activity.length
    ? me.activity.map((entry) => h("li", {}, entry.text, h("br"), h("span", { class: "muted" }, timeAgo(entry.at))))
    : [h("li", { class: "muted" }, "Nothing yet.")]));
  $("#alerts").textContent = me.alerts.length
    ? me.alerts.map((alert) => `${alert.name}: ${alert.pct}%`).join(", ")
    : "None. Text ALERT GOLD 2 to be told when gold moves 2%.";
}

$("#lock").addEventListener("change", async (event) => {
  const locked = event.target.checked;
  $("#locked-note").hidden = !locked;
  try {
    await api(locked ? "/api/me/lock" : "/api/me/unlock", {});
  } catch (error) {
    event.target.checked = !locked;
    $("#locked-note").hidden = false;
    $("#locked-note").textContent = `Couldn't change the lock: ${error.message}`;
  }
});

onSubmit($("#phone-form"), async (data) => {
  await api("/api/me/phone", { phone: String(data.get("phone")) });
  $("#phone-form").hidden = true;
  $("#phone-code-form").hidden = false;
  $("#phone-code").focus();
});

onSubmit($("#phone-code-form"), async (data) => {
  await api("/api/me/phone/confirm", { code: String(data.get("code")) });
  $("#phone-code-form").hidden = true;
  $("#phone-form").hidden = false;
  $("#phone-form").reset();
  await load();
});

$("#signout").addEventListener("click", async () => {
  await api("/api/signout", {});
  location.href = "/";
});

load().catch((error) => {
  $("#total").textContent = "";
  $("#subline").textContent = error.message;
});
setInterval(() => load().catch(() => {}), 15000);
