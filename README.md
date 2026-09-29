# PrivateLine

Stocks and gold by text message, private on Canton.

Buy the S&P 500, gold or bitcoin by text message. No app, no mobile data, no gas.
Every trade needs your PIN and the approval of 2 of 3 independent operators, so no single
company can move your assets alone.

Built for HackCanton Season 3 (Financial Applications track + BitSafe "Decentralizing Apps on
Canton" challenge). Launch market for the pitch: Nigeria.

## Status

- Day 1 (2026-09-27): development environment.
- Day 2 (2026-09-29): Daml contracts and 15 passing tests, including privacy tests.

See [JOURNAL.md](JOURNAL.md).

## How it works (target design)

- **SMS service** receives texts from an Android phone gateway (sms-gate.app), checks the sender's
  phone number and PIN, parses commands (`BAL`, `PRICE GOLD`, `BUY GOLD 20`, `SELL GOLD 10`,
  `ALERT GOLD 1`) and replies.
- **Vault**: a decentralized party run by 3 operators with threshold 2, built with BitSafe's
  Decentralization Manager. Operator 1 (SMS) proposes every action; Operators 2 and 3 are
  independent price/limit checkers, and either one completes the approval.
- **Contracts (Daml)**, in [`daml/privateline`](daml/privateline):
  - The vault holds pooled tokens, CIP-56 holdings that mirror Cantex assets on LocalNet.
  - Each user's share is recorded in a private account.
  - The desk signs quotes and settles fills with the vault in net batches.
  - Opening an account, depositing, trading and settling are governed actions that need 2 of 3
    operators.
- **Prices**: live from Cantex's public API, compared against CoinGecko.
- **Privacy**:
  - Each user's account is visible only to that user and the vault.
  - The desk sees trade sizes, never who traded.
  - Operators see account IDs, never phone numbers.
  - Personal data (phone, email, PIN hash) stays off-ledger.
  - SMS itself is not encrypted, so the phone network can read texts, as with bank SMS alerts.
    What stays private is the ledger.

## Run the contract tests

Inside WSL, with the toolchain from `scripts/dev/install-daml-toolchain.sh`:

```bash
scripts/dev/daml-test.sh
```

It builds `daml/privateline` and `daml/privateline-test` and runs the 15 Daml Script tests.
`scripts/dev/vendor-dars.sh` refreshes the prebuilt DARs in `daml/dars/` from a
Decentralization Manager clone.

## License

[Apache-2.0](LICENSE). The prebuilt DARs in `daml/dars/` come from DLC-Link and Digital Asset under
the same license.

## Development environment (Windows 11 + WSL2 + Docker Desktop)

- `C:\Users\<you>\.wslconfig` gives WSL 12 GB (BitSafe's LocalNet needs 12 GB for Docker).
- `scripts/dev/start-docker.ps1` starts Docker Desktop when it crashes on leftover socket files.
- `scripts/dev/fetch-localnet-bundle.sh` and `scripts/dev/fetch-ghcr-images.mjs` download the
  LocalNet bundle and the `canton` / `splice-app` images over parallel connections, for networks
  where GitHub's CDN is throttled per connection.
- BitSafe's Decentralization Manager LocalNet: `DLC-link/decentralization-manager`, branch
  `hackathon` (PR #440), `./hackathon/up.sh`, `seed.sh`, `demo.sh`.
