// Helpers shared by every page.

export async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

export const usd = (value) =>
  `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const price = (value) => {
  const digits = value >= 10000 ? 0 : 2;
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

export const pct = (value) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;

export function quantity(value) {
  const n = Number(value);
  if (n === 0) return "0";
  const digits = n >= 100 ? 2 : n >= 1 ? 3 : Math.min(8, 2 - Math.floor(Math.log10(n)));
  return String(Number(n.toFixed(digits)));
}

/** Create an element: h("td", { class: "r" }, "text", childNode). */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value === undefined || value === null) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * Run a form submission: disable its submit button while the request runs (no double submits),
 * and show any error next to the form.
 */
export function onSubmit(form, handler) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const error = form.querySelector(".error");
    if (error) error.textContent = "";
    if (button) button.disabled = true;
    try {
      await handler(new FormData(form));
    } catch (failure) {
      if (error) error.textContent = failure.message;
    } finally {
      if (button) button.disabled = false;
    }
  });
}

/**
 * Call fn every ms while the tab is visible, and right away when it becomes visible again. Hidden
 * tabs don't poll, which keeps the free front door's daily request allowance for real visitors.
 * Returns a function that stops it.
 */
export function everyWhileVisible(ms, fn) {
  const tick = () => { if (!document.hidden) fn(); };
  const timer = setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", tick);
  };
}

export const shortId =(id, head = 10, tail = 6) => (id.length > head + tail + 1 ? `${id.slice(0, head)}...${id.slice(-tail)}` : id);

export function timeAgo(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}
