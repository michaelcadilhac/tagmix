# Server setup

These files run the existing Docker Compose app under systemd, with nginx on the
host terminating HTTPS and proxying to `127.0.0.1:3000`. Docker contains the Node.js
runtime and media tools. The separate named volumes retain media and account data.

The examples assume a checkout at `/opt/tagmix`, Docker Engine with the Compose
plugin supporting `up --wait`, nginx, and Certbot. Install those using your Linux
distribution's instructions. Commands below use Debian/Ubuntu nginx site paths;
on distributions using `conf.d`, install the chosen nginx file as
`/etc/nginx/conf.d/tagmix.conf` instead of creating a sites-enabled symlink.

## Configure and start TagMix

1. Put the repository at `/opt/tagmix`. If you use another path, change
   `WorkingDirectory` in `tagmix.service` and the commands below. Adjust
   `/usr/bin/docker` in the unit if Docker is installed elsewhere.
2. Choose your hostname and point its DNS records at the server. Replace every
   `tagmix.example.com` in both nginx files, `tagmix.env.example`, and the commands
   below with it.
   Allow inbound TCP ports 80 and 443; the app's port 3000 stays on localhost.
3. Install the environment file, build the image, and enable the service:

```bash
cd /opt/tagmix
sudo install -d -m 0755 /etc/tagmix
sudo install -m 0600 setup/tagmix.env.example /etc/tagmix/tagmix.env
sudo systemctl enable --now docker
sudo docker compose --project-name tagmix --file docker-compose.yml build
sudo install -m 0644 setup/tagmix.service /etc/systemd/system/tagmix.service
sudo systemctl daemon-reload
sudo systemctl enable --now tagmix
curl --fail http://127.0.0.1:3000/api/health
```

Set `TAGMIX_APP_ORIGIN` to the exact public HTTPS origin. It is required for
account mutation checks and Secure cookies behind the proxy. The unit reads
`/etc/tagmix/tagmix.env`; `.env.local` is not used by Compose for this setting.

`systemctl status tagmix` reports `active (exited)` after Compose has started the
container and its health check passes. Docker's existing `unless-stopped` policy
handles container restarts. `systemctl stop tagmix` stops the container while
keeping both volumes; `systemctl restart tagmix` reapplies environment changes.

## Obtain a certificate and enable nginx

If you already have a certificate, skip the bootstrap steps and use its paths in
`nginx.conf`. Otherwise, install the temporary HTTP-only site first. This serves
ACME challenges without requiring certificate files that do not exist yet:

```bash
cd /opt/tagmix
sudo install -d -m 0755 /var/www/letsencrypt
sudo install -m 0644 setup/nginx-bootstrap.conf /etc/nginx/sites-available/tagmix
sudo ln -sfn /etc/nginx/sites-available/tagmix /etc/nginx/sites-enabled/tagmix
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
sudo certbot certonly --webroot --webroot-path /var/www/letsencrypt \
  --cert-name tagmix.example.com --domain tagmix.example.com \
  --deploy-hook "systemctl reload nginx"
```

Replace the bootstrap site with the HTTPS configuration:

```bash
sudo install -m 0644 /opt/tagmix/setup/nginx.conf /etc/nginx/sites-available/tagmix
sudo ln -sfn /etc/nginx/sites-available/tagmix /etc/nginx/sites-enabled/tagmix
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
curl --fail https://tagmix.example.com/api/health
sudo certbot renew --dry-run
```

Ensure the renewal timer or cron job supplied by your Certbot installation is
enabled. The saved deploy hook reloads nginx after successful renewal. Keep the
HTTP ACME location in the final configuration so renewals can validate the domain.

The proxy redirects HTTP to HTTPS, forwards the public host and scheme, allows
up to five minutes between reads for initial media conversion, and streams
responses without proxy caching. Audio range requests and the app's private
account response headers pass through unchanged. After deployment, check account
signup/sign-in and playback in the browser.

## Updates and logs

Build updates before restarting so the running app stays available during builds:

```bash
cd /opt/tagmix
git pull --ff-only
sudo docker compose --project-name tagmix --file docker-compose.yml build
sudo systemctl restart tagmix
sudo journalctl -u tagmix -n 50 --no-pager
sudo docker compose --project-name tagmix --file docker-compose.yml logs --tail 100 tagmix
```

Keep the Compose project name `tagmix` consistent: its volumes are
`tagmix_tagmix-data` and `tagmix_tagmix-accounts`. For an existing deployment with
a different project name, use that name in the service and build/log commands to
keep using its existing volumes. Do not use `docker compose down -v` unless you
intend to delete accounts as well as the cache. See the main README for backups.

References: [nginx proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[Compose startup options](https://docs.docker.com/reference/cli/docker/compose/up/),
and [Certbot webroot and renewal](https://eff-certbot.readthedocs.io/en/stable/using.html).
