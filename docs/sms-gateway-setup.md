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
5. In the app's webhook settings, set a **signing key**: any long random string.

## 2. PrivateLine's settings

Put these in `app/.env`. Don't paste them into chat or commit them; `.env` is gitignored.

```
SMSGATE_USERNAME=<from the app>
SMSGATE_PASSWORD=<from the app>
SMSGATE_WEBHOOK_SECRET=<the signing key from step 1.5>
PUBLIC_URL=<https address from step 3>
```

On a dual-SIM phone, also set `SMSGATE_SIM=1` or `2`. PrivateLine then ignores texts that
arrive on the other SIM, and sends from its own.

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

- Text `HELP` to the gateway SIM's number. You should get the command list back.
- Sign up at `<PUBLIC_URL>/signup` with that phone's real number. The code arrives by SMS.

Simulator numbers (`+999...`) keep working next to the real phone.

## When something doesn't arrive

- `npm run smsgate -- send <+your number> "test"` checks that sending works.
- The server log shows a `403 bad signature` if the signing key in `.env` doesn't match the app's.
- In the app, check the message log and the webhook delivery log. Most failures are the phone
  sleeping, or an old tunnel address.
