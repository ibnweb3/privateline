import { $, api, h, onSubmit } from "/static/app.js";

let email = "";
let token = "";
let phone = "";
let inboxTimer = null;
let lastMessageId = 0;

const params = new URLSearchParams(location.search);
const presetPhone = params.get("phone");
if (presetPhone) $("#phone").value = presetPhone;

function step(n) {
  $("#step-email").hidden = n !== 1;
  $("#step-phone").hidden = n !== 2;
  $("#step-pin").hidden = n !== 3;
  $("#step-done").hidden = n !== 4;
  for (let i = 1; i <= 3; i++) $(`#bar-${i}`).className = i <= n ? "done" : "";
}

onSubmit($("#email-form"), async (data) => {
  email = String(data.get("email"));
  const { devCode } = await api("/api/signup/start", { email });
  $("#email-form").hidden = true;
  $("#email-code-form").hidden = false;
  if (devCode) {
    const note = $("#dev-code");
    note.hidden = false;
    note.replaceChildren("Demo: email delivery is simulated on LocalNet. Your code is ", h("strong", { class: "sms" }, devCode), ".");
  }
  $("#email-code").focus();
});

onSubmit($("#email-code-form"), async (data) => {
  const result = await api("/api/signup/email", { email, code: String(data.get("code")) });
  token = result.signupToken;
  step(2);
});

async function pollInbox() {
  try {
    const { messages } = await api(`/api/sim/messages?phone=${encodeURIComponent(phone)}&after=${lastMessageId}`);
    for (const message of messages) {
      lastMessageId = message.id;
      if (message.direction !== "out") continue;
      $("#inbox").append(h("div", { class: "bubble in" }, message.body));
      const code = /(\d{6})/.exec(message.body)?.[1];
      if (code && !$("#phone-code").value) $("#phone-code").value = code;
    }
  } catch {
    // Keep polling.
  }
}

onSubmit($("#phone-form"), async (data) => {
  const result = await api("/api/signup/phone", { token, phone: String(data.get("phone")) });
  phone = String(data.get("phone")).replace(/[^\d+]/g, "");
  $("#phone-form").hidden = true;
  $("#phone-code-form").hidden = false;
  if (result.simulator) {
    $("#inbox").hidden = false;
    clearInterval(inboxTimer);
    inboxTimer = setInterval(pollInbox, 1000);
    pollInbox();
  }
});

onSubmit($("#phone-code-form"), async (data) => {
  await api("/api/signup/verify-phone", { token, code: String(data.get("code")) });
  clearInterval(inboxTimer);
  step(3);
});

onSubmit($("#pin-form"), async (data) => {
  const pin = String(data.get("pin"));
  if (pin !== String(data.get("pinAgain"))) throw new Error("The two PINs don't match.");
  $("#opening").hidden = false;
  try {
    const { accountId } = await api("/api/signup/finish", { token, pin });
    $("#done-title").textContent = `Welcome to PrivateLine, account ${accountId}`;
    step(4);
  } finally {
    $("#opening").hidden = true;
  }
});
