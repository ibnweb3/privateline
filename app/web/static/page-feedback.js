import { $, api, h, onSubmit } from "/static/app.js";

// Where the visitor came from, so we can tell demo users from people who found the page directly.
if (new URLSearchParams(location.search).get("from") === "try") $("#source").value = "try";

// Answer labels come from the form itself, so the thank-you summary can't drift from the questions.
const labels = new Map(
  [...document.querySelectorAll("input[type=radio]")].map((input) => [`${input.name}:${input.value}`, input.closest("label").textContent.trim()]),
);

const count = (value) => h("strong", { class: "num" }, value);

function split(question, counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return parts.length === 0
    ? "no answers yet"
    : parts.flatMap(([value, n], index) => [index > 0 ? ", " : "", `${labels.get(`${question}:${value}`) ?? value} `, count(n)]);
}

function showThanks(summary) {
  $("#feedback-form").hidden = true;
  $("#thanks").hidden = false;
  $("#thanks-total").textContent = summary.total === 1
    ? "You're the first to answer. Come back later to see what others said."
    : `${summary.total} people have answered so far. Here is what they said.`;
  const rows = [h("li", {}, h("strong", {}, "Would you use it? "), split("would_use", summary.would_use))];
  if (summary.traders.total > 0) {
    rows.push(h("li", {}, h("strong", {}, `Traders and shop owners (${summary.traders.total}): `), split("would_use", summary.traders.would_use)));
  }
  $("#thanks-list").replaceChildren(...rows);
  $("#thanks").scrollIntoView({ block: "start" });
}

onSubmit($("#feedback-form"), async (data) => {
  const { summary } = await api("/api/feedback", Object.fromEntries(data.entries()));
  showThanks(summary);
});
