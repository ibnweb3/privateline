# Build journal

## Day 1 — 2026-09-27 — idea locked, dev environment on a Windows laptop in Nigeria

**Decision.** After ruling out a Cantex price-drift monitor (operators would hard-code it themselves)
and checking what already exists on Canton (a Telegram red-envelope app, a pump.fun-style launchpad
coming from OneSwap, no SMS or USSD wallet anywhere), we locked the idea: a wallet you run entirely
by SMS for tokenized stocks, gold, silver and crypto, whose vault is a 2-of-3 decentralized party.
Launch market for the pitch: Nigeria. We reuse the SMS gateway code from an earlier project
(sms-gate.app on an Android phone).

**Setting up BitSafe's Decentralization Manager LocalNet on Windows took three fixes worth writing down:**

1. **WSL memory.** Without a `.wslconfig`, WSL gets half the RAM (about 7.8 GB on this 15.7 GB
   laptop). BitSafe's bundle needs 12 GB for Docker, so we set `memory=12GB` (Docker now reports
   about 11.7 GiB and 8 CPUs).
2. **Docker Desktop crashed on every start** with `initializing Inference manager ... remove
   ...\Docker\run\dockerInference: The file cannot be accessed by the system`, then the same for
   `docker-secrets-engine\engine.sock`. The unix-socket files left by an earlier unclean shutdown
   (and by every later stop) cannot be removed by Docker on this machine. The crash dialog offers
   "Reset to factory defaults"; that was clicked once and it wiped Docker's settings, including the
   WSL integration for Ubuntu (restored in `settings-store.json`). Fix: move the two socket folders
   aside before each start. `scripts/dev/start-docker.ps1` does it; Docker then starts in ~20 s.
3. **GitHub's CDN is throttled per connection from here.** General bandwidth measured ~700 KB/s
   (Cloudflare), but GitHub release downloads and ghcr.io image blobs ran at 20-40 KB/s per
   connection. The 725 MB LocalNet bundle would have taken ~10 hours, and Docker pulls one
   connection per layer (the `canton` image has a 316 MB layer). Every DNS resolver returned the
   same four GitHub edge IPs, so it's routing, not DNS. Fix: parallel range requests.
   `scripts/dev/fetch-localnet-bundle.sh` (24 connections) and `scripts/dev/fetch-ghcr-images.mjs`
   (24 connections, sha256-verified, loaded into Docker as an OCI layout) brought combined
   throughput to several MB/s.

**Result: BitSafe's LocalNet runs on the laptop.** `up.sh` brought up Canton, Splice and Postgres
plus three DecMan nodes (UIs on ports 8081-8083), all connected. `seed.sh` created `demo-party`
with threshold 2, distributed the governance DARs, allocated one member party per node and
deployed `GovernanceRules`. `demo.sh` then ran propose (node 1) → confirm (node 2) → execute
(node 3) in about 6 seconds; the audit trail shows 1 propose, 4 confirm, 2 execute and 1
execute_result event, with the acting party on each. Two more notes:

- Right after Docker started, one pull failed with `lookup auth.docker.io: no such host`; the same
  pull worked a minute later (Windows DNS resolved it fine throughout).
- **Memory is the real limit.** Running, the stack uses ~6 GB (canton 2.3, splice 2.0, postgres
  1.2, DecMan nodes 0.5) and Windows was down to 0.7 GB free; party onboarding took ~27 minutes
  under that pressure. Close other apps while working, and stop the stack (`hackathon/down.sh`)
  when not.
- The official Daml installer downloads a single 1.1 GB file and stalled at 97%; its EXIT trap
  deletes the partial file. `scripts/dev/install-daml-toolchain.sh` saves and resumes instead.

**Read for Days 2-3.** BitSafe's `docs/CUSTOM_DAML_TEMPLATES.md`: custom actions implement
`GovernableAction` (signatory = proposer, observer = governance party), build with Daml SDK
3.4.11 (`dpm build`, LF target 2.2), get distributed with `POST /dars/distribute`, proposed by a
member through the Ledger API, and confirmed/executed with `POST /governance/confirm` and
`/governance/execute` (`governance_type: "core_domain"`). The proposer's own confirmation counts
toward the threshold, so in our 2-of-3 design the SMS operator proposes and either independent
checker completes the approval. Contract ids in a proposal are resolved at execute time, so one
pending trade per user at a time and short confirmation timeouts.

## Day 2 — 2026-09-29 — name, contracts and tests

**Name: PrivateLine.** Tagline: "Stocks and gold by text message, private on Canton." No other
Season 3 entry uses it. The only products with that name are a Las Vegas company's VPN, 2FA and
messenger apps, none in finance.

**Contracts** (`daml/privateline`, package `privateline-v0`, Daml SDK 3.4.11). They build against
the same governance DARs that BitSafe's `seed.sh` distributes to LocalNet, copied into `daml/dars/`,
so the package ids match.

- `Account`: one per user, signed by the vault and visible to that user. It holds balances per
  symbol, a daily trading limit (per UTC day) and an opaque phone tag instead of a phone number.
- `DemoHolding`: the vault's actual tokens, demo mirrors of SPYe, QQQe, eXAU, eXAG, cBTC and cETH
  plus a demo dollar. Both the issuer and the owner sign, so neither can create or destroy the
  vault's tokens alone. They implement the CIP-56 `Holding` interface, so token-standard tools
  can read them.
- `Quote`, `Fill` and `DeskAgreement`: the desk signs quotes, and only the vault can fill one, from
  inside an approved trade. Fills name no user. `DeskAgreement_Settle` nets fills per symbol and
  burns and mints tokens in one transaction.
- `DemoFaucet`: LocalNet only. It mints demo dollars, capped per mint.
- Four governed actions implement BitSafe's `GovernableAction` interface: open account, deposit,
  trade and settle. Each needs 2 of 3 operators. Every check in a trade (quote still valid, price
  no worse than the user confirmed by SMS, balance, daily limit) runs again at execution time,
  after the approvals.

**Why pooled tokens plus private accounts, not tokens per user.** A token's issuer is a
signatory on every holding. If each user had their own token contracts, the issuer would see
every user's position. With the vault holding pooled tokens and each user's share recorded in a
private account, the desk sees only the vault's totals and the size of each trade, never who
traded. Settling in net batches has a second benefit: a user's trade touches only that user's
account, so two users trading at the same moment never conflict.

**Tests** (`daml/privateline-test`, 15, all passing; `scripts/dev/daml-test.sh`):

- One operator alone cannot act. Execution fails with 1 confirmation and works once the risk
  checker adds the second.
- A buy by dollars and a sell by units produce the right balances, and the fill is recorded.
- The daily limit blocks a trade that would go over it and resets the next UTC day.
- A trade fails if its quote has expired, if the price is worse than the user confirmed (even
  with a fresh quote), or if the balance is too low.
- The desk cannot fill its own quote.
- A second trade proposed against the same account version fails with "Could not find contract"
  after the first one runs. That's why the SMS service keeps one pending action per account.
- **Privacy:**
  - Bob sees his own account and nothing of Alice's: no account, trade, fill or approval record.
  - The desk sees fills (sizes only), and no accounts, trade proposals or approval records.
  - The approval records stay inside the vault.
- **Settlement:**
  - After two users' buys and a sell are netted, the vault's tokens equal the sum of the
    accounts, to the unit.
  - A settlement that leaves out the vault's dollars fails, and the fills stay open.
  - The vault's tokens list correctly through the CIP-56 `Holding` interface.

Every failure test checks the error text, so each one fails for the stated reason and not some
other error. Build and test take about 2.5 minutes on `/mnt/c` from WSL.

**Known limits, stated plainly:**

- The vault's 3 operators can see every account, by account id, because they check limits.
- On LocalNet the faucet lets the vault mint demo dollars. Real deposits would be stablecoin
  transfers.
- SMS itself is not encrypted: the phone network can read texts, just as it can read bank SMS
  alerts. What stays private is the ledger.

**Next (Day 3):**

- Upload the DAR to LocalNet through `/dars/distribute`.
- Allocate the desk and user parties.
- Run one trade end to end through DecMan's confirm and execute, from two different nodes, and
  see it on the BitSafe dashboard.

## Day 3 — 2026-09-29 — on BitSafe's LocalNet, through their dashboard

**Result.** A real trade now runs end to end on BitSafe's Decentralization Manager LocalNet, in
about 11 seconds:

1. The SMS operator opens a funded account for a user. The operator (node 1) and the price
   checker (node 2) confirm through DecMan, and node 2 executes.
2. The desk quotes SPYe.
3. The operator proposes "buy $30 of SPYe". This time the operator (node 1) and the risk checker
   (node 3) confirm, and node 3 executes. Either checker can complete an approval.
4. The user's account shows 0.05 SPYe and $70. The desk sees the fill with no user named, and
   zero accounts.
5. A settlement batch, again 2 of 3, moves the actual tokens. Afterwards the vault holds exactly
   0.05 SPYe and 70 USD, matching the account.

BitSafe's dashboard shows all of it
([screenshot](docs/screenshots/day3-bitsafe-dashboard.jpg)):

- the `privateline-vault` party, with 3 owners and a threshold of 2 of 3;
- its **holdings (SPYe 0.05, USD 70), picked up through the CIP-56 `Holding` interface with no
  extra work on our side**;
- an audit trail with each `OpenAccountProposal`, `TradeProposal` and `SettleProposal` and their
  confirm and execute events.

**What was built** (`app/`, TypeScript run directly by Node 24, no runtime dependencies):

- `src/ledger.ts`: a client for the Canton JSON Ledger API v2, written against the OpenAPI spec
  the participant serves at `/docs/openapi`.
- `src/decman.ts`: a client for DecMan's REST API (confirm, execute, pending actions, DAR
  distribution, invitations, audit).
- `src/governance.ts`: runs the confirm-then-execute sequence across nodes.
- `src/localnet.ts`: finds the vault and each node's member party. A party allocated on a
  participant carries that participant's fingerprint, so each member is matched to its node from
  the governance rules on the ledger.
- `scripts/localnet-setup.ts` (`npm run localnet:setup`): distributes the DAR through DecMan's
  multi-party workflow (node 1 proposes, nodes 2 and 3 accept), then allocates the desk and
  creates its faucet and agreement. It can be re-run safely.
- `scripts/trade-demo.ts` (`npm run demo:trade`) and `scripts/settle.ts` (`npm run demo:settle`).
  The settle script also checks that the vault's tokens equal the sum of all accounts.
- `scripts/dev/localnet-vault.sh`: creates the `privateline-vault` party with BitSafe's
  `seed.sh` (`PARTY_PREFIX=privateline-vault`), reusing the member parties and governance DARs.

**Gotchas:**

- **Restarting WSL kills the stack, and Splice doesn't recover on its own.** Docker restarts
  Splice before Postgres is ready. Splice gives up on the database ("exhausted retries") and
  then sits unhealthy forever. The fix is `docker restart splice` followed by
  `hackathon/up.sh` again. Startup then took 77 s.
- **BitSafe's `seed.sh` allocates member parties with `party_id_hint` in snake case.** The JSON
  Ledger API expects `partyIdHint`, so the hint is ignored and the members get random names
  (`party-a0515a2e-…`). Our client sends `partyIdHint`, so our parties are named
  `privateline-desk` and `demo-user-1`. This is a one-line upstream fix we could offer.
- **The price is a fixed demo price for now.** Live Cantex quotes come next.

## Days 4-7 (built 2026-09-29) — prices, checkers, SMS, website, safety

The plan spread these over four days. They all went in today, and each was tested on the real
LocalNet stack.

**Prices.**

- The desk quotes from Cantex's public API: pool reserves converted to dollars through the
  CC-USDCx pool, plus a 0.4% spread.
- The checkers compare against the real-world price.
- **CoinGecko started returning 403 from this machine, and Coinbase, Kraken and Binance don't
  connect at all** (most likely Nigeria's ISP-level blocks on crypto exchanges). Yahoo Finance's
  chart endpoint works without a key: SPY, QQQ, gold and silver futures, BTC-USD and ETH-USD.
  SPY at $765.61 matched Cantex SPYe at $764.75, which confirms one SPYe tracks one SPY share.
- Connections from here drop now and then (Cantex and Yahoo each timed out once), so fetches
  retry.
- **Replay mode** serves the Sep 26 06:38 UTC snapshot from the old gap logger: cETH +2.34%,
  gold +2.34%, cBTC +2.06%, QQQe +1.90%.

**Checkers.** Two bots, one per checker node, each with its own DecMan node, ledger node and price
fetch.

- **The rule:** refuse if the price is more than 1.5% against the user (buying above the market,
  or selling below it), or the quote expired, or a limit or balance fails.
- **What a refusal leaves behind:** a `CheckRefusal` contract with the reason, a new template in
  package version 0.2.0. The build now checks that each version is a valid upgrade of the one on
  LocalNet (`upgrades:` in daml.yaml), and the deployed 0.1.0 account kept trading after the
  upgrade.
- **Results:**
  - Replayed drift: both checkers refused a cETH buy in 3 s, with the reason on the ledger.
  - Live: a SPY buy at +0.64% was confirmed by both and executed in 4.7 s.
  - **Live, unplanned:** Cantex's gold bid was 1.69% under the market, and `SELL GOLD ALL` was
    refused. The protection worked on real data.

**Resilience (BitSafe's criteria):**

- `docker stop decman-2` (the price checker's node): a trade still went through in 5.8 s with the
  SMS operator and the risk checker.
- `docker stop decman-3` as well: only 1 of 3 is left. After 30 s: "not enough operators approved
  it in time", and no money moved.
- That test found a bug. The reply said "you don't have enough for it", because the reason text
  contains "not enough". Fixed, with a test.

**SMS service** (`app/src/sms`, `app/src/app.ts`):

- BinaText's sms-gate webhook parsing (signature over timestamp + body) and its send call, ported
  to Node. It reads either the `sender` or the `phoneNumber` field, and can ignore the second SIM
  of a dual-SIM phone.
- Commands: `BAL`, `PRICE`, `BUY`, `SELL` (by dollars or `ALL`), `YES <PIN>`, `NO`,
  `ALERT <asset> <pct>`, `ALERTS [OFF]`, `LOCK`, `HELP`. Word order, case and "$" don't matter.
- Every trade is restated and needs `YES` plus the PIN within 2 minutes. Three wrong PINs pause
  trading for 15 minutes.
- Texts from each user are processed one at a time. Retried webhooks are de-duplicated.
- **The simulator:** `+999` numbers (an unassigned country code) go to a phone on the website, so
  no demo can ever text a real person.

**Personal data, all off-ledger** (SQLite, built into Node):

- phone numbers are AES-256-GCM encrypted;
- a keyed HMAC finds the user when a text arrives;
- a different keyed HMAC is the `phoneTag` on the ledger, which can't be brute-forced like a plain
  hash of a phone number;
- PINs are scrypt-hashed with a salt.

**Caught before it shipped:** the file holding the encryption key (`app/data/app-secret`) was not
gitignored. It is now, along with SQLite's `-wal` and `-shm` files.

**SIM-swap protection:**

- A `ChangePhoneProposal` whose contract refuses to run before `requestedAt + cooldown`.
- The checkers only confirm after the cooldown, and only if it's long enough (24 h in production).
- The old phone is warned and can reply `NO`.
- Tested end to end with a 2-minute cooldown. The account moved 10 s after the cooldown ended, and
  the old number stopped working.

**Website** (`app/web`, no framework, light and dark, checked for overflow at 375 px):

- **Home:** live prices, with "Canton vs market" for each asset.
- **Try it:** the phone simulator.
- **Sign-up:** email code (simulated delivery), SMS code (arrives in the page for `+999`
  numbers), and a PIN. Weak PINs are refused.
- **Sign-in and account:** holdings, daily limit, a lock switch, phone change, activity.
- **Privacy:** the ledger queried live as you, as another user, as the desk and as the operators,
  next to what's stored off-ledger.

**Operator fix:** the operator now passes one confirmation per member when executing, because
GovernanceRules rejects a repeated confirmer.

**Tests:**

- Daml: 18.
- App: 19 unit tests.
- End to end: sign-up, then the full conversation, the node-offline runs, the phone change, and
  price alerts.

**Still open:**

- Real SMS through the gateway phone. It needs the SIM decision; the code and settings are ready.
- Email delivery is simulated.
- Writing, video and submission.

## Deployment — 2026-09-30 — live without the laptop

**PrivateLine now runs on a server: https://20.91.214.194.sslip.io.** It's an Azure VM in Sweden
Central (Standard_D4as_v5: 4 vCPU, 16 GB, Ubuntu 24.04), paid by the free account's $200 credit.
That's about $141 for 30 days, and the credit ends around Oct 29, after the Oct 21 final.

**Getting a server for $0 took some searching:**

- Google Cloud asked for a $30 prepayment, which is refundable only on some account types.
- DigitalOcean gave only $5 of credit; the $200 offer comes through referral links. It also needed
  a card that verifies, or a PayPal top-up.
- Contabo's $4.95/month was over budget.
- On Azure's free trial, most VM sizes are blocked region by region (`NotAvailableForSubscription`),
  and the portal just says "unavailable". The Azure CLI shows exactly where each size is open: one
  `az vm list-skus --all` (8 MB of JSON, 70,000 entries) filtered locally.
  - D4as_v5 is open in Sweden Central, North Central US and South Africa North, among others, but
    not in East US.
  - Quota was never the problem: 4 vCPUs per family per region.
- The Microsoft.Compute and Microsoft.Network resource providers had to be registered on the new
  subscription first.

**The deployment kit** (`deploy/`):

- `upload.sh` sends the working tree over scp, with no commit needed and nothing gitignored.
- `server-setup.sh` sets up the server in one run: firewall, swap, Docker, Node 24, BitSafe's
  LocalNet, the vault, the app, systemd services and Caddy for HTTPS on sslip.io. On Azure it took
  about 12 minutes, because downloads that crawl on the home connection are fast there.
- `firewall.sh` (ufw plus a DOCKER-USER rule) and Azure's network security group both keep
  everything but 22, 80 and 443 closed.

**Checked after deploying:**

- A port scan from outside: 8081-8083 (DecMan, no login on LocalNet), 2975/3975/4975 (ledger),
  5432 and 8790 are all closed.
- The full SMS conversation works: trades take 2.7 to 3.6 s including the 2-of-3 approval, faster
  than on the laptop.
- **After a reboot, everything came back on its own in about 2 minutes.** The accounts and the
  database state survived, and the books still balance.
- Memory runs at about 5.3 of 15 GB.

BitSafe's dashboard is reachable only through an SSH tunnel (`deploy/README.md`).

## Funding — 2026-09-30 — naira in, naira out

**The question:** how does someone in Nigeria put money into an SMS wallet? Can bank deposits
become CC or cBTC?

**The answer:** they become **dollars (USDCx on MainNet)**, not CC or cBTC:

- CC and cBTC move with the market before the user has picked an investment.
- CC transfers are public, which undoes the point of a private wallet.
- USDCx is a CIP-56 token, so the vault holds it the same way it holds everything else.

The real path is bank transfer or USSD → a per-user virtual account at a licensed payment provider
→ a licensed exchange converts naira to USDC → Circle xReserve mints USDCx on Canton → the vault.
The hackathon is too short to sign a payment provider and an exchange, so we built the whole loop
against a demo bank, keeping the parts that don't change:

- **Daml 0.3.0**, an upgrade of 0.2.0: `WithdrawProposal` (a `GovernableAction`),
  `Account_Debit`, and `DemoFaucet_Burn`, which only burns holdings the desk and vault share.
  `FundingTest` adds three tests: deposit then withdraw keeps the books balanced; you can't
  withdraw more than you have; the desk can't burn the vault's dollars. 21 Daml tests pass.
- **Payments webhook** in the format of Paystack's dedicated-virtual-account `charge.success`,
  checked with HMAC-SHA512. The demo bank signs its notifications with the same secret and sends
  them through the same code a real provider would reach. Each payment reference is credited
  once, and failed deposits are retried every minute.
- **Rates:** open.er-api.com, with a second source and a fixed fallback, plus a 1.5% spread each
  way. Replies write naira as "N15,000", because ₦ isn't in the GSM-7 SMS alphabet.
- **Withdrawals** go only to the bank account the user last deposited from, so a stolen phone
  can't send money somewhere new. Both checkers refuse amounts over $500 or over the balance.
- **Website:** a `/bank` page (the demo bank, with a statement), a funding card on the account
  page, and `DEPOSIT` / `WITHDRAW 10` chips on the phone simulator.

**Deployed and checked on the server.** DecMan distributed the 0.3.0 DAR to all three
participants. Then `scripts/funding-e2e.ts` ran against the live site:

- It signed up a phone, texted `DEPOSIT`, and sent N15,000 from the demo bank.
- The credit text arrived 3.4 s later, after the 2-of-3 approval.
- `WITHDRAW 5` and `YES <PIN>` paid N6,536 back to the same GTBank account in 3.0 s.

After that, `settle.ts` still reports that the books balance: the vault's $205.97 equals the sum
of all accounts.

## A name — 2026-09-30 — https://privateline.pages.dev

An IP address in the link looked unfinished. PrivateLine can't move onto Cloudflare the way our
earlier Workers projects did, because it needs the Canton stack next to it. So Cloudflare Pages
now hosts a front door of about 20 lines, `deploy/front-door/public/_worker.js`, that forwards
every request to the server. It still costs $0.

Details that mattered:

- **Rate limits.** Through a proxy, every visitor would share Cloudflare's address and one
  rate-limit bucket: 5 sign-ups an hour for the whole world. The front door passes on the
  visitor's address, and the app believes it only when the request also carries a shared key
  (`FRONT_DOOR_KEY`). The key lives only in the server's `.env` and as a Pages secret.
- **The IP address still works, but pages opened there redirect to the name.** API calls and
  webhooks are served at both addresses.
- **Cloudflare's free plan allows 100,000 requests a day.** The phone simulator polls every
  1.2 s, so every page now polls only while its tab is visible.
- Wrangler 4.144 sends new Pages projects to Workers. `--force` created the project on classic
  Pages, which is what gets the short `privateline.pages.dev` name.

Checked: `funding-e2e.ts` passed through the new address (deposit credited in 2.7 s, withdrawal
in 2.9 s). A packet capture on the server showed the proxied request carrying the right key and
the visitor's real address.

## Feedback form — 2026-10-01 — evidence from real people

The hackathon's Metrics step asks for conversations and tests with real users. When we filled it in,
the live server held 3 accounts, all from our own test runs. So we added the way to collect real
evidence: an anonymous feedback form at `/feedback`, linked from the nav and from the Try page.

- **Six short questions.** Who are you (trader or shop owner, salaried, student, builder, other),
  which phone, would you use it (yes, maybe, no), what first amount, what worries you most, and an
  optional note. Only the first and third are required.
- **Nothing identifies the person.** No name, email or phone number, and no account id. A row holds
  the answers, a timestamp and whether they came from the Try page. The privacy page says so.
- **Counts are public, notes are private.** `/api/feedback/summary` returns counts only, including
  the "would you use it" split among traders and shop owners (our first customer). The notes are
  read on the server with `node scripts/feedback-report.ts`. A comment is stored as plain text and
  never sent back to a browser.
- **Rate limited** to 10 submissions an hour per visitor, through the same front-door address
  handling as the rest of the site.
- **A test keeps the form and the server in step.** It reads the radio values out of
  `feedback.html` and checks they are exactly the choices the server accepts, so a renamed option
  can't quietly start failing.
- Checked on a 375 px phone width: no sideways scroll, 44-48 px tap targets, 16 px text so iOS
  doesn't zoom. Then through the public address: bad answers get a 400 with a plain message, a good
  one is stored, and I deleted my own test row so the table started empty.

## The ledger went down for 14 hours — 2026-10-03/04 — and an animated home page

**The outage.** Deploying the new home page failed with `scp: write remote: Failure`. That is a
full disk, not a network problem. `df` said 61 GB used of 61 GB, and 47.7 GB of it was one file: the
`canton` container's Docker log. Canton logs at debug level, about 800 MB an hour, and Docker's
default is to keep every line. The disk filled around 20:00 UTC on Oct 3. Postgres died first, in
the middle of replaying its write-ahead log ("No space left on device"). Then Canton crashed and
could not restart. The website kept loading and the app process stayed up, so nothing looked wrong
from outside, but every trade, sign-up and deposit would have failed.

What I got wrong at first: Docker still showed Postgres as "Up (unhealthy)", but it was a stale
flag. Its health check could not even run without disk space, and the container had actually exited.

**The fix, in order.** Emptied the two oversized log files (no data touched). Started Postgres,
which recovered by itself, and checked the ledger databases were intact (the sequencer is 469 MB,
the participants 67 to 158 MB). Ran the LocalNet start-up service. Splice got stuck retrying its
database, as it has after earlier restarts, and a `docker restart splice` cleared it. Then the
app. A full test on the live site after the outage: sign-up, a deposit credited in 4.3 s, and a
2-of-3 approved withdrawal in 4.3 s.

**Prevention.** `deploy/docker-logs.sh`, now part of `server-setup.sh`: log rotation for new
containers, and a cron job that empties any container log over 300 MB every 10 minutes. At
Canton's rate that caps a log at a few hundred MB. A health check that only looks at the website
would have missed this; the next improvement is an alert on disk usage and on the ledger itself.

**The home page.** The home page now replays real conversations on a phone, in the style of the
BinaText landing page, with a twist BinaText did not have: the three operators light up as they
approve. Five examples can be picked or left to play: buy gold, add naira, a bad price refused, one
node down, two nodes down. Each reply is word for word what the app sends, and a test enforces
it. If a reply format changes, the test names the animated line that is now wrong. Numbers count up,
sections fade in, and the price table refreshes with a flash when a price moves.

It respects people who ask for less motion (they see a finished conversation and can still switch
examples), pauses when the tab is hidden or off screen, has a Pause button, and every tap target is
at least 44 px. Checked in a real browser at desktop and phone width, in light and dark, with
reduced motion on, and against the live site.
