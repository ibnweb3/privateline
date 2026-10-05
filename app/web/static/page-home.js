import { $, api, everyWhileVisible, h, pct, price } from "/static/app.js";

let loaded = false;
const lastSeen = new Map(); // symbol -> { ask, bid, market }, to flash what changed on a refresh

async function loadPrices() {
  const body = $("#prices");
  try {
    const data = await api("/api/prices");
    $("#price-mode").textContent = data.mode === "live" ? "Live: Cantex and market" : `Replay: ${data.mode.replace("replay ", "")}`;
    body.replaceChildren(...data.assets.map((asset) => {
      if (asset.unavailable) {
        return h("tr", {}, h("td", {}, asset.name), h("td", { class: "sms" }, asset.alias), h("td", { colspan: 4, class: "muted" }, "Price unavailable right now"));
      }
      const gap = asset.market ? asset.mid / asset.market - 1 : null;
      const tone = gap === null ? "" : Math.abs(gap) > 0.015 ? "warn" : "good";
      const before = lastSeen.get(asset.symbol);
      const changed = (key) => (before && before[key] !== asset[key] ? " flash" : "");
      lastSeen.set(asset.symbol, { ask: asset.ask, bid: asset.bid, market: asset.market });
      return h("tr", {},
        h("td", {}, h("strong", {}, asset.name), h("br"), h("span", { class: "muted small" }, `${asset.symbol}, per ${asset.unit}`)),
        h("td", { class: "sms" }, asset.alias),
        h("td", { class: `r${changed("ask")}` }, price(asset.ask)),
        h("td", { class: `r${changed("bid")}` }, price(asset.bid)),
        h("td", { class: `r${changed("market")}` }, asset.market ? price(asset.market) : "n/a"),
        h("td", { class: "r" }, gap === null ? "n/a" : h("span", { class: `pill ${tone}` }, pct(gap))),
      );
    }));
    loaded = true;
  } catch (error) {
    // A failed refresh keeps the prices already on screen.
    if (!loaded) body.replaceChildren(h("tr", {}, h("td", { colspan: 6, class: "muted" }, `Prices are unavailable: ${error.message}`)));
  }
}

async function loadStatus() {
  try {
    const status = await api("/api/status");
    for (const checker of status.checkers) {
      const pill = document.querySelector(`[data-checker="${checker.name}"]`);
      if (!pill) continue;
      const fresh = checker.lastTickAt && Date.now() - checker.lastTickAt < 15000 && !checker.lastError;
      pill.className = `pill ${fresh ? "good" : "warn"}`;
      pill.replaceChildren(h("span", { class: "dot", "aria-hidden": "true" }), fresh ? "online" : "not responding");
    }
  } catch {
    // Status is a nicety on this page.
  }
}

loadPrices();
loadStatus();
everyWhileVisible(10000, loadStatus);
everyWhileVisible(30000, loadPrices);
