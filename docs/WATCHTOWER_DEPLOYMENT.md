# Watchtower Deployment

This project uses Watchtower to keep the production Docker deployment aligned with the latest HuaweiDashboard image published to GitHub Container Registry (GHCR).

## What Watchtower Does

Watchtower monitors running Docker containers. At a configured interval it checks whether the image referenced by a running container has a newer digest in its registry. When a newer image is found, Watchtower pulls it, stops the old container, starts a replacement with the existing configuration, and can remove the old image.

Watchtower does not monitor Git branches, commits, or `package.json` versions. A Git push only triggers an update after GitHub Actions successfully builds and publishes a new image.

The production update chain is:

```text
git push to main or master
    -> GitHub Actions validates, builds, and publishes the image to GHCR
    -> GHCR:latest receives a new image digest
    -> Watchtower detects the digest change
    -> Docker containers are recreated with the new image
```

## Project Configuration

Watchtower is defined in `docker-compose.yml` as the `watchtower` service:

- Image: `ghcr.io/nicholas-fedor/watchtower:latest`
- Container: `huawei-watchtower`
- Polling interval: `600` seconds (10 minutes)
- Cleanup: enabled with `--cleanup`
- Docker access: `/var/run/docker.sock` is mounted so Watchtower can inspect and recreate containers
- Enabled profiles: `modular` and `monolith`

HuaweiDashboard services use the image `ghcr.io/colinburgess/huaweidashboard:latest`. In the modular production setup, Watchtower updates the running `ui-dashboard` and `inverter-collector` containers, and also updates `charger-service` when that service is enabled.

The current Compose configuration does not set a Watchtower label filter, so Watchtower scans the containers visible through the Docker socket. It scans four containers in the production setup: the dashboard, collector, InfluxDB, and Watchtower itself. InfluxDB is also defined with the `influxdb:2.7-alpine` image, so it can be considered for updates by the same scan.

## GitHub Actions and GHCR

The workflow in `.github/workflows/build-and-push.yml` runs on pushes to `main` and `master`. For a successful push workflow it:

1. Installs dependencies and runs the validation job.
2. Builds the Docker image for `linux/amd64` and `linux/arm64`.
3. Authenticates to GHCR with the GitHub-provided `GITHUB_TOKEN`.
4. Publishes branch, SHA, and `latest` tags. `latest` is enabled for the repository's default branch.

The workflow must finish successfully before Watchtower can deploy anything. A new commit in GitHub without a newly published image does not trigger a Watchtower update.

## Deployment Commands

For a server using the modular profile:

```bash
docker compose --profile modular up -d
```

For a local build instead of the published GHCR image:

```bash
docker compose --profile modular up -d --build
```

Avoid running both deployment modes at the same time because they use overlapping ports and container responsibilities.

## Verification

Run these commands from the server directory containing `docker-compose.yml`.

### Check containers

```bash
docker compose ps
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
```

### Read Watchtower logs

```bash
docker logs --tail 200 huawei-watchtower
docker logs --since 30m huawei-watchtower
```

Expected messages include:

```text
Update session completed failed=0 scanned=4 updated=0
```

`updated=0` means that no newer image digest was found during that scan. When an update is detected, the logs include `Found new image`, container stop/start messages, and a final line such as:

```text
Update session completed failed=0 scanned=4 updated=2
```

### Compare image digests

Check the digest used by running application containers:

```bash
docker inspect --format '{{.Name}} image={{.Config.Image}} id={{.Image}} created={{.Created}}' \
  huawei-dashboard-service huawei-collector-service
```

The running digest must differ from the old image before Watchtower can perform an update. The registry digest can be checked with Docker or the GHCR registry API when the package is public:

```bash
docker pull ghcr.io/colinburgess/huaweidashboard:latest
docker image inspect ghcr.io/colinburgess/huaweidashboard:latest --format '{{.Id}}'
```

Do not print `.env` contents while diagnosing deployment. It contains credentials and service configuration.

### Check the deployed application version

```bash
docker exec huawei-dashboard-service node -p "require('/app/package.json').version"
```

The result should match the version published by the commit that triggered the workflow.

## Troubleshooting

### GitHub Actions did not run

Check that the commit was pushed to `main` or `master`, then inspect the workflow run for the exact commit SHA. A local commit is invisible to both GitHub Actions and Watchtower until it is pushed.

### GitHub Actions succeeded but Watchtower reports `updated=0`

Compare the GHCR digest with the digest reported by the running containers. Common causes are:

- The workflow published a different tag and did not update `latest`.
- The workflow ran for a different commit than the one expected.
- GHCR was temporarily unavailable when Watchtower polled it.
- The registry returned the same digest because the image content did not change.

Watchtower retries on its next scheduled scan. A transient registry warning should be correlated with later `Update session completed` messages.

### Watchtower reports authentication or token errors

Check network access from the server to `ghcr.io`. For a private GHCR package, Watchtower also needs registry credentials configured through Docker registry authentication. Never put a token in Git, `docker-compose.yml`, or this document.

### The new image is deployed but the application is unhealthy

Inspect service logs and verify the dashboard endpoint:

```bash
docker logs --tail 200 huawei-dashboard-service
docker logs --tail 200 huawei-collector-service
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/
```

If a rollback is required, stop the automatic updater first, identify the previous image digest, and redeploy deliberately. Do not use an unreviewed `docker compose down` on a production system because it can stop unrelated stateful services.

## Operational Notes

- Watchtower performs rolling replacement per container, not a zero-downtime deployment for the complete application.
- The dashboard and collector share persistent `./storage` data on the host.
- Watchtower itself runs with `restart: unless-stopped`, but it cannot update containers if the Docker daemon or the host is unavailable.
- The production server should be checked after an update for container status, application version, service heartbeats, and recent errors.