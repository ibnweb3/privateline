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
