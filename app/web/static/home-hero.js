// The home page's moving parts: a phone that replays real conversations while the three operators
// light up as they approve, count-up numbers, and sections that fade in. With prefers-reduced-motion
// nothing plays by itself: the page shows a finished conversation and the buttons switch between them.

import { $, h } from "/static/app.js";
import { OPERATORS, SCENES } from "/static/home-scenes.js";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const hasObserver = "IntersectionObserver" in window;

if ($("#pl-thread")) startHero();
startStats();
startReveal();

function startHero() {
  const thread = $("#pl-thread");
  const stage = $("#pl-stage");
  const typed = $("#pl-typed");
  const send = $("#pl-send");
  const note = $("#pl-note");
  const tallyBox = $("#pl-tally");
  const tallyBig = $("#pl-tally-big");
  const tallySmall = $("#pl-tally-small");
  const toggle = $("#pl-toggle");
  const status = $("#pl-status");
  const chips = SCENES.map((scene, i) => {
    const chip = h("button", { class: "chip", type: "button", "aria-pressed": String(i === 0) }, scene.label);
    toggle.before(chip);
    return chip;
  });
  const nodes = Object.fromEntries(OPERATORS.map((operator) => [operator.id, $(`[data-op="${operator.id}"]`)]));

  const STATE_LABEL = { idle: "ready", proposed: "proposed", confirmed: "confirmed", refused: "refused", offline: "offline" };
  const STATE_MARK = { proposed: "•", confirmed: "✓", refused: "✕", offline: "–" };
  const CANCELLED = Symbol("cancelled");

  let token = 0; // each run of a scene gets a new one; an older run notices and stops
  let paused = false;
  let visible = !hasObserver;
  let started = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Wait `ms`, then keep waiting while paused, off screen or in a hidden tab. Stops if a newer run began. */
  async function pace(ms, mine) {
    await sleep(ms);
    while (mine === token && (paused || !visible || document.hidden)) await sleep(250);
    if (mine !== token) throw CANCELLED;
  }

  function follow() {
    thread.scrollTo({ top: thread.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }

  function setOp(id, state) {
    const node = nodes[id];
    if (!node || node.dataset.state === state) return;
    node.dataset.state = state;
    $(".pl-op-dot", node).textContent = STATE_MARK[state] ?? String(OPERATORS.findIndex((operator) => operator.id === id) + 1);
    $(".pl-op-state", node).textContent = STATE_LABEL[state];
    if (!reduceMotion) {
      node.classList.remove("pop");
      void node.offsetWidth; // restart the animation
      node.classList.add("pop");
    }
  }

  function setTally([big, small], tone) {
    tallyBig.textContent = big;
    tallySmall.textContent = small;
    tallyBox.dataset.tone = tone;
  }

  function resetOps(start = {}) {
    for (const operator of OPERATORS) setOp(operator.id, start[operator.id] ?? "idle");
    setTally(["Ready", "watching an example"], "idle");
  }

  function addBubble(who, text) {
    thread.append(h("div", { class: `bubble ${who === "you" ? "out" : "in"} sms pl-rise` }, text));
    follow();
  }

  /** The parts of a step that need no waiting: a divider line, operator states, the tally. */
  function applyStep(step) {
    if (step.sys) {
      thread.append(h("div", { class: "pl-sys pl-rise" }, step.sys));
      follow();
    }
    for (const [id, state] of Object.entries(step.ops ?? {})) setOp(id, state);
    if (step.tally) setTally(step.tally, step.tone);
  }

  function select(index) {
    const scene = SCENES[index];
    chips.forEach((chip, i) => chip.setAttribute("aria-pressed", String(i === index)));
    note.textContent = scene.note;
    thread.replaceChildren();
    thread.classList.remove("fading");
    typed.textContent = "";
    resetOps(scene.start);
  }

  async function typeAndSend(text, mine) {
    typed.textContent = "";
    for (const character of text) {
      typed.textContent += character;
      await pace(character === " " ? 70 : 42, mine);
    }
    await pace(260, mine);
    send.classList.add("press");
    await pace(140, mine);
    send.classList.remove("press");
    typed.textContent = "";
    addBubble("you", text);
  }

  async function play(index, firstRun = false) {
    const mine = ++token;
    // The first time, the page's starter conversation stays up until the show really begins.
    if (!firstRun) select(index);
    try {
      await pace(firstRun ? 700 : 500, mine);
      if (firstRun) select(index);
      for (const step of SCENES[index].steps) {
        if (step.you) await typeAndSend(step.you, mine);
        if (step.pl) {
          const dots = h("div", { class: "pl-typing pl-rise", "aria-hidden": "true" }, h("i"), h("i"), h("i"));
          thread.append(dots);
          follow();
          await pace(step.think ?? 1000, mine);
          dots.remove();
          addBubble("pl", step.pl);
        }
        applyStep(step);
        await pace(step.hold ?? (step.you ? 350 : 500), mine);
      }
      await pace(4200, mine);
      thread.classList.add("fading");
      await pace(260, mine);
      void play((index + 1) % SCENES.length);
    } catch (error) {
      if (error !== CANCELLED) throw error;
    }
  }

  /** The finished conversation, all at once. For people who ask their device for less motion. */
  function showFinished(index) {
    token++;
    select(index);
    for (const step of SCENES[index].steps) {
      if (step.you) addBubble("you", step.you);
      if (step.pl) addBubble("pl", step.pl);
      applyStep(step);
    }
  }

  function transcript(scene) {
    return scene.steps
      .map((step) => (step.you ? `You: ${step.you}.` : step.pl ? `PrivateLine: ${step.pl}` : step.sys ? `${step.sys}.` : ""))
      .filter(Boolean)
      .join(" ");
  }

  function choose(index) {
    status.textContent = `Showing the example “${SCENES[index].label}”. ${transcript(SCENES[index])}`;
    if (reduceMotion) return showFinished(index);
    paused = false;
    syncToggle();
    void play(index);
  }

  function syncToggle() {
    toggle.textContent = paused ? "Play" : "Pause";
  }

  chips.forEach((chip, i) => chip.addEventListener("click", () => choose(i)));

  if (reduceMotion) {
    showFinished(0);
    return;
  }

  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    paused = !paused;
    syncToggle();
  });

  if (hasObserver) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !started) {
        started = true;
        void play(0, true);
      }
    }, { threshold: 0.25 }).observe(stage);
  } else {
    started = true;
    void play(0, true);
  }
}

/** Numbers that count up once, the first time they scroll into view. */
function startStats() {
  const numbers = [...document.querySelectorAll("[data-to]")];
  if (numbers.length === 0 || reduceMotion || !hasObserver) return;
  const decimals = (el) => Number(el.dataset.decimals ?? 0);
  numbers.forEach((el) => { el.textContent = (0).toFixed(decimals(el)); });
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      seen.unobserve(entry.target);
      countUp(entry.target, Number(entry.target.dataset.to), decimals(entry.target));
    }
  }, { threshold: 0.6 });
  numbers.forEach((el) => seen.observe(el));
}

function countUp(el, to, decimals) {
  const began = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - began) / 900);
    el.textContent = (to * (1 - (1 - t) ** 3)).toFixed(decimals);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Sections fade in as they arrive. Only hidden once this script is running, so nothing is lost if it fails. */
function startReveal() {
  const items = [...document.querySelectorAll(".reveal")];
  if (items.length === 0 || reduceMotion || !hasObserver) return;
  document.documentElement.classList.add("reveal-ready");
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("in");
      seen.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  items.forEach((item) => seen.observe(item));
}
