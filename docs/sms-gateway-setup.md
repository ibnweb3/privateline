# Real SMS: the gateway phone

PrivateLine sends and receives real texts through an Android phone running
[SMS Gateway for Android](https://sms-gate.app) with its own SIM. Users text that SIM's number.
The phone relays each text to PrivateLine and sends the replies. Every trade still needs the
user's PIN and 2 of 3 operators on the ledger; the phone only carries messages.

## 1. The phone

1. Put the new SIM in an Android phone. Any carrier works; the SIM needs an SMS plan, because
   every reply is a normal text sent from it.
2. Install **SMS Gateway for Android**, from Google Play or the project's releases.
3. Grant it SMS permission, and turn off battery optimization for it, so Android doesn't put it to
   sleep.
4. In the app, turn on **Cloud server** and note the **username** and **password** it shows.
5. In the app (Settings > Webhooks > Signing Key), set a **signing key**: 24 random **digits**.
   Use digits, not letters: phone keyboards autocapitalise the first letter and autocorrect, which
   silently changes a hex or word key. Paste it, don't type it, and check the field shows exactly
   what you meant. The app signs every webhook with it (HMAC-SHA256 over the body followed by the
   timestamp, in the `x-signature` and `x-timestamp` headers), and PrivateLine checks that.

## 2. PrivateLine's settings

Put these in `app/.env`. Don't paste them into chat or commit them; `.env` is gitignored.

```
SMSGATE_USERNAME=<from the app>
SMSGATE_PASSWORD=<from the app>
SMSGATE_WEBHOOK_SECRET=<the signing key from step 1.5, with no quotes around it>
REAL_SMS_ALLOW=<your own numbers, e.g. +2348031234567,+2348099999999>
PUBLIC_URL=<https address from step 3>
```

**`REAL_SMS_ALLOW` is a safety limit, and it is closed by default.** A public demo must never text a
stranger, and without this limit anyone could type another person's number into the sign-up form
and make your SIM text them. Real numbers can only sign up, be texted, or text us if they are
listed here. Texts from any other number are ignored, with no reply, so they cost nothing. Everyone
else uses the `+999` simulator. Set `REAL_SMS_ALLOW=open` only on your own private instance.

On a dual-SIM phone, also set `SMSGATE_SIM=1` or `2`. PrivateLine then ignores texts that
arrive on the other SIM, and sends from its own.

## On the live server: one command

Instead of editing `.env` by hand, run this in your own terminal, from the repo, after
`deploy/upload.sh <ip>`:

```
deploy/set-smsgate.sh <server-ip>
```

It asks for the gateway login, the numbers allowed to use real SMS, and the SIM slot. It writes them
to the server's `.env` over SSH (nothing goes on a command line or into a file on your laptop),
restarts the app, registers the webhook, and prints the signing key to enter in the phone's app.
The live site's address (`https://privateline.pages.dev`) is stable, so it needs no tunnel.

## 3. A public address for this machine

The phone delivers each text to `<PUBLIC_URL>/sms/webhook`, so it must be a public `https://`
address that reaches port 8790 here. A Cloudflare quick tunnel needs no account:

```
cloudflared tunnel --url http://localhost:8790
```

It prints an address like `https://<words>.trycloudflare.com`. Put that in `PUBLIC_URL`. A
quick tunnel's address changes each time it starts; when it does, update `PUBLIC_URL` and
register the webhook again.

## 4. Connect them

From `app/`:

```
npm start                      # restart so the new settings load
npm run smsgate -- register    # texts to the phone now reach PrivateLine
npm run smsgate -- list        # check
```

Then, from any phone:

- Text `HELP` to the gateway SIM's number from a number listed in `REAL_SMS_ALLOW`. If that number
  has signed up, you get the command list back. If it hasn't, you get a short "this number isn't on
  PrivateLine yet" reply (at most once an hour), which also proves the round trip works.
- Sign up at `<PUBLIC_URL>/signup` with that phone's real number. The code arrives by SMS.

The phone forwards **every** text the SIM receives, including operator messages from senders such as
"MTN". PrivateLine ignores anything that is not from a phone number.

Simulator numbers (`+999...`) keep working next to the real phone.

## When something doesn't arrive

- `npm run smsgate -- send <+your number> "test"` checks that sending works.
- The server log shows `sms webhook: refused, the signature does not match` if the signing key in
  `.env` doesn't match the app's. Check, in this order: the key in the app is exactly the `.env`
  value (no quotes, no spaces, same digits); you saved it in Settings > Webhooks > Signing Key and
  not another field; then look at what the phone really sends. The app listens on plain HTTP on the
  server's loopback, so `sudo tcpdump -i lo -A 'tcp port 8790'` shows the `x-signature` and
  `x-timestamp` headers and the body, and you can recompute the HMAC-SHA256 yourself over the body
  followed by the timestamp.
- In the app, check the message log and the webhook delivery log. Most failures are the phone
  sleeping, or an old tunnel address.
