# Self-hosted Docker deployment

This deployment runs the static visualizer, API, and Java runner on one Linux
VM. Only Caddy publishes host ports. The API and runner share a private
internal Docker network, while Caddy and the runner remain isolated from each
other. The runner has no internet egress.

## Requirements

- A Linux VM with Docker Engine and Docker Compose v2.
- For Oracle Cloud Always Free, choose an eligible Ampere A1 **ARM64** VM with
  enough available memory for the Java runner.
- A domain name with an `A` record pointing to the VM for automatic HTTPS.
- Ports 80 and 443 open to the VM. Restrict SSH (22) to your own IP.

The workspace excludes optional ARM64 native packages for unrelated platforms
but allows the Linux ARM64 binaries needed by the frontend build. If you change
dependencies or package-manager configuration, regenerate and commit
`package-lock.json` before deploying.

## Provision an Oracle Cloud VM

1. Create an eligible Always Free Ampere A1 VM in Oracle Cloud with an Ubuntu
   ARM64 image and an SSH public key. Check the console's free-tier quota and
   capacity in your selected home region before creating it.
2. Assign a public IP and configure the VM's network security list or network
   security group to allow inbound TCP 80 and 443 from the internet and TCP 22
   only from your IP. Do not allow inbound ports 5000 or 7000.
3. Point your domain's `A` record at the VM's public IP.
4. Connect over SSH and install Docker Engine and Compose:

   ```sh
   sudo apt update
   sudo apt install -y docker.io docker-compose-v2
   sudo systemctl enable --now docker
   sudo usermod -aG docker "$USER"
   ```

   Log out and reconnect so Docker commands can run without `sudo`.

## Deploy

1. Clone the repository on the VM and enter its root directory:

   ```sh
   git clone <YOUR_REPOSITORY_URL> drv
   cd drv
   ```

2. Copy `.env.example` to `.env` and set `SITE_ADDRESS` to your real domain,
   `ACME_EMAIL` to an address you monitor, and `RUNNER_API_KEY` to a long,
   random secret. The Compose stack passes the shared key only to the API and
   runner, which use it to authenticate trace requests. Caddy will obtain and
   renew its HTTPS certificate automatically.

   ```sh
   cp .env.example .env
   nano .env
   ```

   Generate a random key, for example with `openssl rand -hex 32`, and use it
   for `RUNNER_API_KEY`.

3. Build and start the containers:

   ```sh
   docker compose build java-runner
   docker compose build api
   docker compose build web
   docker compose up -d
   ```

   Building separately reduces peak memory use on small VMs.

4. Check container health and the application endpoints:

   ```sh
   docker compose ps
   curl -fsS https://visualizer.example.com/api/healthz
   curl -fsS https://visualizer.example.com/api/health
   curl -fsS https://visualizer.example.com/api/languages
   ```

   The language response should include Java. Then open the domain and test a
   small program, including a program that reads from standard input.

5. To update after pushing changes:

   ```sh
   git pull
   docker compose build
   docker compose up -d
   docker image prune -f
   ```

## VM firewall

If UFW is enabled on Ubuntu, allow SSH before enabling it:

```sh
sudo ufw allow from <YOUR_PUBLIC_IP>/32 to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

## Operations

```sh
docker compose logs -f --tail=100
docker compose restart
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to delete
Caddy's persisted certificate data. The runner has a 1 GiB memory limit, one
CPU limit, a process limit, no internet egress, a read-only root filesystem,
and no Linux capabilities. Submitted programs still consume server resources,
so monitor the VM and avoid advertising an unauthenticated instance as a
high-traffic public service.
