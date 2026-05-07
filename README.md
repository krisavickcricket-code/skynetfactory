# SkyNetFactory

Automated module-generation pipeline: from contract specification to verified, production-ready code.

## Architecture

| Component | Path | Role |
|---|---|---|
| **Supervisor** | `supervisor/` | Orchestrator — contract lifecycle, gate runner, circuit breaker, lock manager, registry, REST + WebSocket API |
| **Worker Runtime** | `worker-runtime/` | Standalone Ollama worker — receives task packets, calls LLMs, enforces write scope, produces `worker_result.json` |
| **UI** | `ui/electron-app/` | Electron + React dashboard — live pipeline visibility |
| **Agent Swarm** | `orchestration/agent-swarm/` | Optional external orchestration backend (reused when available) |

## Prerequisites

1. **Node.js** ≥ 18
2. **Ollama** installed and running (default: `http://localhost:11434`)
3. *(Optional)* **AgentSwarm** running on port 4000
4. *(Optional)* **Git** (used for worktree rollback/snapshotting; auto-initialized if missing)

## Quick Start

```bash
# 1. Clone / enter the repo
cd C:/SkynetFactory        # or wherever you checked it out

# 2. Install dependencies and build
node scripts/setup.js

# 3. Start the supervisor
node scripts/start.js
```

The supervisor API will be available at:
- **REST API:** `http://127.0.0.1:3013/skynetfactory/api`
- **WebSocket:** `ws://127.0.0.1:3013/skynetfactory/events`

### Start the UI (separate terminal)

```bash
cd ui/electron-app
npm run electron:dev
```

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

Key settings (also overridable in `config/builder.config.json`):

| Variable | Default | Description |
|---|---|---|
| `SKYNET_FACTORY_ROOT` | `C:/SkynetFactory` | Root working directory |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama API endpoint |
| `AGENT_SWARM_API_URL` | `http://localhost:4000` | AgentSwarm API endpoint |
| `DEFAULT_TEMPERATURE` | `0.1` | LLM temperature |
| `SEED_CONTROL` | `true` | Deterministic seed rotation |

## Submitting a Module Contract

Contracts are JSON files dropped into `module-contracts/pending/` or submitted via the API:

```bash
curl -X POST http://localhost:3013/skynetfactory/api/contracts \
  -H "Content-Type: application/json" \
  -d @examples/sample-contract.json
```

A sample contract is provided in `examples/sample-contract.json`.

### Contract Lifecycle

```
pending → claimed → building → testing → completed
                              ↓            ↑
                         remediation ──────┘
                              ↓
                         rejected → pending (manual retry)
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/skynetfactory/api/contracts` | List all contracts |
| `GET` | `/skynetfactory/api/contracts/:id` | Contract detail |
| `POST` | `/skynetfactory/api/contracts` | Submit new contract |
| `PUT` | `/skynetfactory/api/contracts/:id/retry` | Retry failed/rejected contract |
| `DELETE` | `/skynetfactory/api/contracts/:id` | Cancel contract |
| `GET` | `/skynetfactory/api/registry` | Registry index |
| `GET` | `/skynetfactory/api/registry/:id` | Registry entry |
| `POST` | `/skynetfactory/api/registry/:id/deprecate` | Deprecate module |
| `GET` | `/skynetfactory/api/health` | System health + circuit breaker |
| `PUT` | `/skynetfactory/api/config` | Update runtime config |

## Building Components Manually

```bash
# Supervisor
cd supervisor && npm install && npm run build

# Worker Runtime
cd worker-runtime && npm install && npm run build

# UI
cd ui/electron-app && npm install && npm run build
```

## Directory Layout

```
SkyNetFactory/
├── config/builder.config.json      # Runtime configuration
├── module-contracts/
│   ├── pending/                     # Incoming contracts
│   ├── claimed/                     # Locked for processing
│   ├── building/                    # LLM generation in progress
│   ├── testing/                     # Acceptance gates running
│   ├── completed/                   # Verified modules
│   ├── remediation/                 # Failed, retrying
│   └── rejected/                    # Max retries exceeded
├── worktrees/                       # Git worktrees per module
├── production-modules/              # Verified, deployed modules
├── registry/                        # Module registry (file-per-module)
├── logs/
│   ├── evidence/                    # Gate-run evidence bundles
│   └── failed_attempts/             # Preserved failed attempts
├── supervisor/                      # TypeScript orchestrator
├── worker-runtime/                  # Standalone Ollama worker
├── ui/electron-app/                 # Dashboard
└── orchestration/agent-swarm/       # Optional external backend
```

## Troubleshooting

### Supervisor exits immediately
- Ensure Ollama is running: `ollama serve`
- Check that the default model is pulled: `ollama pull qwen3-coder`
- Check `config/builder.config.json` has the correct `ollama_host_url`

### Contracts stuck in pending
- The supervisor scans every 10 seconds; verify `canDispatch()` isn't blocked by the circuit breaker
- Check health endpoint: `GET /skynetfactory/api/health`

### AgentSwarm warnings
- AgentSwarm is **optional**. The supervisor runs gates and Ollama workers natively.
- If you want to use AgentSwarm, ensure it is running on port 4000 and set `AGENT_SWARM_API_URL`.

## License

Proprietary — internal use only.
