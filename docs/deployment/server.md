# Server Deployment

Server mode is intended for a shared group server. It runs a control plane behind nginx and starts one isolated Docker worker per registered user. Local single-user mode is separate and does not require Docker.

## Architecture

| Service | Purpose |
| --- | --- |
| `proxy` | nginx entrypoint on port 80. Routes UI, API, and SSE traffic to the control plane. |
| `control-plane` | FastAPI app for auth, settings, session browsing, admin APIs, and worker lifecycle. |
| `matcreator-worker-<user_id>` | Per-user worker container with that user's mounted MatCreator home. |

Each worker sees:

```text
/root/.matcreator -> <host-data-root>/users/<user_id>/.matcreator
```

Workers are disposable. User data persists because it is mounted from the host.

## Prerequisites

1. Docker Engine and Docker Compose plugin.
2. A built MatCreator image.
3. Shared model and compute credentials available to the deployment.

## Quick Start

From the repository root:

```bash
docker compose build

export MATCREATOR_HOST_DATA_ROOT="$(pwd)/server-data"
docker compose -f docker-compose.server.yml up -d
```

Open:

```text
http://localhost
```

Register a user and log in. The first login or register request starts a dedicated worker for that user.

## Data Layout

With `MATCREATOR_HOST_DATA_ROOT="$(pwd)/server-data"`:

```text
server-data/
  control-plane/
    .matcreator/
      users.db
      config.yaml
      .env
  users/
    <user_id>/
      .matcreator/
        .adk/
          session.db
          agent_graphs/
          know_do_graph.db
        workspace/
        config.yaml
```

Use this tree for backups, admin inspection, and quota management.

## Resource Controls

Stop idle workers by setting:

```bash
export MATCREATOR_WORKER_IDLE_TIMEOUT_SECONDS=1800
```

Apply Docker limits before starting the control plane:

```bash
export MATCREATOR_WORKER_MEM_LIMIT=4g
export MATCREATOR_WORKER_CPUS=2
export MATCREATOR_WORKER_PIDS_LIMIT=512
docker compose -f docker-compose.server.yml up -d
```

## Admin Users

By default, the display name `admin` has admin privileges. To customize:

```bash
export MATCREATOR_ADMIN_USERS=admin,alice
docker compose -f docker-compose.server.yml up -d
```

## Useful Commands

List services and workers:

```bash
docker ps --filter "name=matcreator"
```

Read control-plane logs:

```bash
docker logs --tail=200 pfd-agent-control-plane-1
```

Read a worker's logs:

```bash
docker logs --tail=200 matcreator-worker-<user_id>
```

Enter a worker shell:

```bash
docker exec -it matcreator-worker-<user_id> bash
```

## Security Notes

- Mounting `/var/run/docker.sock` gives the control plane high host privileges.
- Use HTTPS for real deployments. The included nginx config is plain HTTP for local or internal-server setup.
- Back up `MATCREATOR_HOST_DATA_ROOT`; worker containers should be considered replaceable.

## Configurable Ports

Server-mode deployment supports configurable host-facing ports via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MATCREATOR_SERVER_PROXY_HOST_PORT` | 80 | Nginx proxy host port |
| `MATCREATOR_SERVER_PROXY_PORT` | 80 | Nginx proxy container port |
| `MATCREATOR_WEB_HOST_PORT` | 8001 | Control-plane host port |
| `MATCREATOR_WEB_PORT` | 8001 | Control-plane container port |
| `MATCREATOR_ADK_PORT` | 8000 | ADK API (internal) |
| `MATCREATOR_WORKER_BASE_PORT` | 9001 | Worker container base port |

Example: run server mode on custom ports:

```bash
MATCREATOR_SERVER_PROXY_HOST_PORT=8080 \
MATCREATOR_WEB_HOST_PORT=8101 \
docker compose -f docker-compose.server.yml up
```

For personal Docker deployment:

```bash
MATCREATOR_ADK_HOST_PORT=8100 \
MATCREATOR_WEB_HOST_PORT=8101 \
MATCREATOR_FRONTEND_HOST_PORT=5174 \
docker compose up
```