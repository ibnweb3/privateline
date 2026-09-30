# Deploying PrivateLine to a server

PrivateLine runs as one Ubuntu 24.04 x86 server with 16 GB of memory. On it:

- BitSafe's Decentralization Manager LocalNet: Canton, Splice, Postgres and 3 DecMan nodes;
- the `privateline-vault` party;
- the PrivateLine app: website, SMS service, desk and both checkers;
- Caddy, which serves the app over HTTPS.

Any provider's Ubuntu 24.04 x86 server with 16 GB works. The free-credit options:

- DigitalOcean: $200 for 60 days.
- Azure: $200 for 30 days.
- Google Cloud: $300 for 90 days, but some countries have to prepay $30.

On DigitalOcean the login user is `root`, so run the upload as `DEPLOY_USER=root deploy/upload.sh <ip>`
and ssh as `root@<ip>`. The setup script installs its own firewall (`deploy/firewall.sh`), so a
provider without a default firewall is still safe.

### Azure (free account: $200 for 30 days)

In the portal, go to **Virtual machines**, then **Create**, then **Azure virtual machine**. The
free account allows 4 vCPUs per region.

- **Basics:**
  - resource group `privateline`, VM name `privateline`, region East US (cheapest);
  - image **Ubuntu Server 24.04 LTS, x64 Gen2**;
  - size **Standard_D4as_v5** (4 vCPU, 16 GiB, $0.172/h), or **Standard_B4ms** ($0.166/h) if D-series quota is 0;
  - authentication **SSH public key**, username `privateline`, existing public key = the deploy key's line;
  - public inbound ports **22, 80, 443**.
- **Disks:** OS disk **64 GiB**, Standard SSD. The default 30 GiB is too small.
- **Management:** **auto-shutdown off**.
- **Also:** don't tick Azure Spot.

About $133 of the credit covers 30 days. Don't upgrade to pay-as-you-go: the free account then
stops, instead of charging, when the credit or the 30 days run out.

### DigitalOcean

Create a **Basic** droplet with these settings:

- **Image:** Ubuntu 24.04 (LTS) x64.
- **Size:** 8 vCPU / 16 GB.
- **SSH key:** add the deploy key's public line.

Leave IPv6 off.

## 1. Create the VM (Google Cloud console)

- **Machine:** Compute Engine, E2, **e2-standard-4** (4 vCPU, 16 GB).
- **Boot disk:** **Ubuntu 24.04 LTS x86/64**, balanced persistent disk, **60 GB**.
- **Firewall:** tick *Allow HTTP traffic* and *Allow HTTPS traffic*. Open nothing else.
- **SSH key:** under *Advanced → Security → Manage access*, add the deploy key's public line
  (`ssh-ed25519 ... privateline`). The last word becomes the login user.

## 2. Upload and set up

From the laptop, in Git Bash:

```bash
deploy/upload.sh <external-ip>
ssh -i ~/.ssh/privateline_gcp privateline@<external-ip> "bash ~/privateline/deploy/server-setup.sh <external-ip>.sslip.io"
```

`<external-ip>.sslip.io` is a free hostname that resolves to the IP, so Caddy can get a real
certificate. The first run downloads BitSafe's LocalNet (about 760 MB plus images) and creates
the vault. It takes 15 to 30 minutes.

The setup script writes `app/.env` on the server:

- a fresh `APP_SECRET`;
- `PUBLIC_URL`;
- `HOST=127.0.0.1`, so the app is only reachable through Caddy;
- a two-minute phone-change cooldown for the demo.

It then installs two services, `privateline-localnet` and `privateline`, which start on boot and
restart the app if it stops.

## 3. A name instead of an IP address (optional, free)

The public address is https://privateline.pages.dev, a Cloudflare Pages front door
(`front-door/public/_worker.js`) that forwards every request to the server. The app still runs
only on the server, next to the Canton stack.

```bash
npx wrangler pages project create privateline --production-branch main --force   # once
deploy/front-door.sh <external-ip>
```

The script:

- gives `app/.env` a `FRONT_DOOR_KEY` and points `PUBLIC_URL` (the address in texts) at the name;
- stores the key and the server's address as Pages secrets, and deploys the front door;
- has Caddy send anyone who opens a page by IP address to the name.

API calls and webhooks still work at the IP address.

The front door passes on each visitor's address, so the rate limits stay per visitor. The app
believes that address only when the request also carries `FRONT_DOOR_KEY`, so nobody can fake it
by calling the server directly.

Cloudflare's free plan allows 100,000 requests a day. Pages poll only while their tab is visible.

## Security

- `deploy/firewall.sh` (run at boot) allows only 22, 80 and 443 into the host (ufw). It also drops new
  connections from the public interface to Docker's published ports (a DOCKER-USER rule), because
  Docker's NAT bypasses ufw. On Google Cloud the VPC firewall does the same job a second time.
- The VPC firewall allows only 22, 80 and 443 in. Docker's published ports (8081-8083, the
  ledger's 2975/3975/4975) stay unreachable from the internet. Docker bypasses the server's own
  firewall, so the cloud firewall is the one that counts. **Don't add rules for them:** on LocalNet
  they have no authentication.
- To see BitSafe's dashboard, open an SSH tunnel and browse http://localhost:8081:

  ```bash
  ssh -i ~/.ssh/privateline_gcp -L 8081:localhost:8081 privateline@<external-ip>
  ```

## Updating

Run `deploy/upload.sh <ip>` again, then on the server:
`cd ~/privateline/app && npm ci && sudo systemctl restart privateline`. The front door only needs
redeploying when `front-door/` changes: `cd deploy/front-door && npx wrangler pages deploy`.

If the Daml package changed, also run `node scripts/localnet-setup.ts` before restarting. It
distributes the new DAR through DecMan.

## Logs

```bash
sudo journalctl -u privateline -f        # app, checkers, SMS
sudo journalctl -u caddy --since -1h     # HTTPS
docker ps                                # LocalNet containers
```
