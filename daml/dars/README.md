# Prebuilt DARs

PrivateLine's packages build against these DARs. They are copied unchanged by
`scripts/dev/vendor-dars.sh` from BitSafe's Decentralization Manager
([DLC-link/decentralization-manager](https://github.com/DLC-link/decentralization-manager), branch `hackathon`).

| File | From | What we use it for |
|---|---|---|
| `governance-action-v1-0.1.0.dar` | `releases/v1/` | The `GovernableAction` interface our proposals implement |
| `governance-core-v1-0.1.0.dar` | `releases/v1/` | `GovernanceRules`, used by the tests to confirm and execute |
| `splice-api-token-holding-v1-1.0.0.dar` | `daml/dars/` | The CIP-56 `Holding` interface our demo tokens implement |
| `splice-api-token-metadata-v1-1.0.0.dar` | `daml/dars/` | CIP-56 metadata types |

The two governance DARs are the files `hackathon/seed.sh` distributes to LocalNet, so the
package ids match. All four are Apache-2.0 (DLC-Link and Digital Asset).

`privateline-v0-0.1.0.dar` is our own first release, the version first deployed to LocalNet. The
current package lists it under `upgrades:`, so every build checks that the new version is a valid
smart-contract upgrade and existing accounts keep working.
