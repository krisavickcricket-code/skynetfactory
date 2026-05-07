import React, { useState, useEffect, useCallback } from 'react';

const API_BASE = 'http://localhost:3013/skynetfactory/api';
const WS_URL = 'ws://localhost:3013/skynetfactory/events';

interface ContractSummary {
  module_id: string;
  state: string;
  state_details?: any;
}

interface HealthStatus {
  component: string;
  status: string;
  details: string;
}

interface CircuitBreakerState {
  state: string;
  failure_count: number;
}

function App() {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [registry, setRegistry] = useState<any[]>([]);
  const [health, setHealth] = useState<Record<string, HealthStatus>>({});
  const [circuitBreaker, setCircuitBreaker] = useState<CircuitBreakerState>({ state: 'closed', failure_count: 0 });
  const [activeView, setActiveView] = useState<'dashboard' | 'pipeline' | 'registry' | 'authoring' | 'settings'>('dashboard');
  const [selectedModule, setSelectedModule] = useState<string | null>(null);

  // Supervisor + config state
  const [configData, setConfigData] = useState<any>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [supervisorRunning, setSupervisorRunning] = useState<boolean>(false);
  const [supervisorLogs, setSupervisorLogs] = useState<string[]>([]);
  const [isSavingConfig, setIsSavingConfig] = useState<boolean>(false);

  // Draft contract form state
  const [draftContractStr, setDraftContractStr] = useState('');
  const [draftValidationResult, setDraftValidationResult] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch data
  const fetchContracts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/contracts`);
      const data = await res.json();
      if (data.status === 'success') setContracts(data.data);
    } catch {}
  }, []);

  const fetchRegistry = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/registry`);
      const data = await res.json();
      if (data.status === 'success') setRegistry(data.data);
    } catch {}
  }, []);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/health`);
      const data = await res.json();
      if (data.status === 'success') {
        setHealth(data.data.health || {});
        setCircuitBreaker(data.data.circuit_breaker || {});
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchContracts();
    fetchRegistry();
    fetchHealth();

    const interval = setInterval(() => {
      fetchContracts();
      fetchRegistry();
      fetchHealth();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // WebSocket
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: any;

    function connect() {
      try {
        ws = new WebSocket(WS_URL);
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'contract_state_changed') fetchContracts();
            if (msg.type === 'gate_result') fetchContracts();
            if (msg.type === 'health_status_changed') fetchHealth();
            if (msg.type === 'circuit_breaker_state_changed') {
              setCircuitBreaker(prev => ({ ...prev, state: msg.new_state }));
            }
          } catch {}
        };
        ws.onclose = () => {
          reconnectTimer = setTimeout(connect, 5000);
        };
      } catch {
        reconnectTimer = setTimeout(connect, 5000);
      }
    }

    connect();
    return () => {
      ws?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);

  // Supervisor IPC listeners + status polling
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    checkSupervisorStatus();
    const statusInterval = setInterval(checkSupervisorStatus, 3000);

    const onOutput = (_event: any, data: string) => {
      setSupervisorLogs(prev => [...prev.slice(-199), data]);
    };
    const onError = (_event: any, data: string) => {
      setSupervisorLogs(prev => [...prev.slice(-199), `[STDERR] ${data}`]);
    };
    const onExit = (_event: any, code: number | null) => {
      setSupervisorRunning(false);
      setSupervisorLogs(prev => [...prev.slice(-199), `[UI] Supervisor exited with code ${code}`]);
    };

    api.onSupervisorOutput(onOutput);
    api.onSupervisorError(onError);
    api.onSupervisorExit(onExit);

    return () => {
      clearInterval(statusInterval);
    };
  }, []);

  // Config + model fetching
  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/config`);
      const data = await res.json();
      if (data.status === 'success') setConfigData(data.data);
    } catch {}
  }, []);

  const fetchOllamaModels = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/ollama/models`);
      const data = await res.json();
      if (data.status === 'success') {
        const models = data.data.models?.map((m: any) => m.name) || [];
        setOllamaModels(models);
      }
    } catch {}
  }, []);

  // Load config + models when settings tab opens
  useEffect(() => {
    if (activeView === 'settings') {
      fetchConfig();
      fetchOllamaModels();
    }
  }, [activeView, fetchConfig, fetchOllamaModels]);

  // Actions
  const submitContract = async () => {
    alert('Contract submission via UI: use POST /skynetfactory/api/contracts');
  };

  const retryContract = async (moduleId: string) => {
    await fetch(`${API_BASE}/contracts/${moduleId}/retry`, { method: 'PUT' });
    fetchContracts();
  };

  const cancelContract = async (moduleId: string) => {
    await fetch(`${API_BASE}/contracts/${moduleId}`, { method: 'DELETE' });
    fetchContracts();
  };

  const deprecateModule = async (moduleId: string) => {
    await fetch(`${API_BASE}/registry/${moduleId}/deprecate`, { method: 'POST' });
    fetchRegistry();
  };

  // Supervisor IPC helpers
  const checkSupervisorStatus = async () => {
    try {
      const api = (window as any).electronAPI;
      if (api?.supervisorStatus) {
        const status = await api.supervisorStatus();
        setSupervisorRunning(status.running);
      }
    } catch {}
  };

  const startSupervisor = async () => {
    try {
      const api = (window as any).electronAPI;
      if (api?.supervisorStart) {
        setSupervisorLogs(prev => [...prev, '[UI] Starting supervisor...']);
        const result = await api.supervisorStart();
        if (result.success) {
          setSupervisorRunning(true);
          setSupervisorLogs(prev => [...prev, `[UI] Supervisor started (PID ${result.pid})`]);
        } else {
          setSupervisorLogs(prev => [...prev, `[UI] Start failed: ${result.error}`]);
        }
      }
    } catch (err: any) {
      setSupervisorLogs(prev => [...prev, `[UI] Error: ${err.message}`]);
    }
  };

  const stopSupervisor = async () => {
    try {
      const api = (window as any).electronAPI;
      if (api?.supervisorStop) {
        setSupervisorLogs(prev => [...prev, '[UI] Stopping supervisor...']);
        const result = await api.supervisorStop();
        if (result.success) {
          setSupervisorRunning(false);
          setSupervisorLogs(prev => [...prev, '[UI] Supervisor stopped']);
        } else {
          setSupervisorLogs(prev => [...prev, `[UI] Stop failed: ${result.error}`]);
        }
      }
    } catch (err: any) {
      setSupervisorLogs(prev => [...prev, `[UI] Error: ${err.message}`]);
    }
  };

  // Counts
  const counts = {
    pending: contracts.filter(c => c.state === 'pending').length,
    claimed: contracts.filter(c => c.state === 'claimed').length,
    building: contracts.filter(c => c.state === 'building').length,
    testing: contracts.filter(c => c.state === 'testing').length,
    completed: contracts.filter(c => c.state === 'completed').length,
    remediation: contracts.filter(c => c.state === 'remediation').length,
    rejected: contracts.filter(c => c.state === 'rejected').length,
  };

  return (
    <div className="container">
      {/* Header */}
      <header className="flex items-center justify-between" style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
          🏭 SkyNetFactory
        </h1>
        <nav className="flex gap-2">
          {(['dashboard', 'pipeline', 'registry', 'authoring', 'settings'] as const).map(view => (
            <button
              key={view}
              className={`btn ${activeView === view ? 'btn-primary' : ''}`}
              onClick={() => setActiveView(view)}
              style={{ background: activeView === view ? 'var(--color-primary)' : 'var(--color-surface)' }}
            >
              {view.charAt(0).toUpperCase() + view.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {/* Health Bar */}
      <div className="card" style={{ padding: '0.75rem 1.5rem' }}>
        <div className="flex items-center gap-4">
          {Object.entries(health).map(([name, status]: [string, any]) => (
            <span key={name} className="flex items-center gap-2" style={{ fontSize: '0.875rem' }}>
              <span className={`health-dot health-${status.status}`} />
              {name}
            </span>
          ))}
          <span className="flex items-center gap-2" style={{ fontSize: '0.875rem', marginLeft: 'auto' }}>
            Circuit Breaker:
            <span className={`badge badge-${circuitBreaker.state === 'closed' ? 'completed' : circuitBreaker.state === 'open' ? 'rejected' : 'building'}`}>
              {circuitBreaker.state}
            </span>
          </span>
        </div>
      </div>

      {/* Views */}
      {activeView === 'dashboard' && (
        <div>
          {/* Stats Grid */}
          <div className="grid grid-cols-3 gap-4" style={{ marginBottom: '1.5rem' }}>
            {Object.entries(counts).map(([state, count]) => (
              <div key={state} className="card" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>{count}</div>
                <div className={`badge badge-${state}`}>{state}</div>
              </div>
            ))}
          </div>

          {/* Recent Contracts */}
          <div className="card">
            <h2 style={{ marginBottom: '1rem' }}>Recent Contracts</h2>
            {contracts.map(c => (
              <div key={c.module_id} className="flex items-center justify-between" style={{ padding: '0.75rem 0', borderBottom: '1px solid #334155' }}>
                <span style={{ fontWeight: 500 }}>{c.module_id}</span>
                <span className={`badge badge-${c.state}`}>{c.state}</span>
                {c.state_details?.attempt_count > 0 && (
                  <span style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
                    attempt {c.state_details.attempt_count}
                    {c.state_details.model_used && ` | ${c.state_details.model_used}`}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeView === 'pipeline' && (
        <div className="grid grid-cols-7 gap-4">
          {['pending', 'claimed', 'building', 'testing', 'completed', 'remediation', 'rejected'].map(state => (
            <div key={state} style={{ background: 'var(--color-surface)', borderRadius: '0.5rem', padding: '1rem', minHeight: '300px' }}>
              <h3 className={`badge badge-${state}`} style={{ display: 'block', textAlign: 'center', marginBottom: '1rem' }}>
                {state}
              </h3>
              {contracts.filter(c => c.state === state).map(c => (
                <div key={c.module_id} className="card" style={{ padding: '0.75rem', cursor: 'pointer' }} onClick={() => setSelectedModule(c.module_id)}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 500 }}>{c.module_id}</div>
                  {c.state_details?.attempt_count > 0 && (
                    <div style={{ fontSize: '0.625rem', color: 'var(--color-text-muted)' }}>
                      attempt {c.state_details.attempt_count}/{c.state_details.remediation_count || 0}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {activeView === 'registry' && (
        <div className="card">
          <h2 style={{ marginBottom: '1rem' }}>Registry — Verified Modules</h2>
          {registry.map((entry: any) => (
            <div key={entry.module_id} className="flex items-center justify-between" style={{ padding: '0.75rem 0', borderBottom: '1px solid #334155' }}>
              <div>
                <div style={{ fontWeight: 500 }}>{entry.module_id}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
                  v{entry.version} | {entry.category} | {entry.capability_type}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`badge badge-${entry.status === 'verified' ? 'completed' : entry.status === 'deprecated' ? 'rejected' : 'remediation'}`}>
                  {entry.status}
                </span>
                {entry.status === 'verified' && (
                  <button className="btn btn-danger" style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }} onClick={() => deprecateModule(entry.module_id)}>
                    Deprecate
                  </button>
                )}
              </div>
            </div>
          ))}
          {registry.length === 0 && <p style={{ color: 'var(--color-text-muted)' }}>No verified modules yet.</p>}
        </div>
      )}

      {activeView === 'authoring' && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h2>Draft New Contract</h2>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
            Paste a module contract JSON below. Use <code>Validate</code> to check against the schema before submitting.
            See <code>config/codex-contract-authoring-prompt.txt</code> for authoring guidance.
          </p>
          <textarea
            value={draftContractStr}
            onChange={(e) => setDraftContractStr(e.target.value)}
            placeholder={JSON.stringify({
              module_id: "domain.capability",
              version: "1.0.0",
              category: "example",
              capability_type: "validator",
              purpose: "Describe what this module does in 20+ characters.",
              language: "typescript",
              runtime: "node",
              api: { endpoints: [{ method: "GET", path: "/health", description: "Health check" }] },
              acceptance_gates: ["structure_validation", "contract_validation"]
            }, null, 2)}
            style={{
              width: '100%',
              minHeight: '300px',
              background: '#0f172a',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: '0.375rem',
              padding: '0.75rem',
              fontFamily: 'monospace',
              fontSize: '0.875rem',
              resize: 'vertical',
            }}
          />
          <div className="flex items-center gap-3" style={{ marginTop: '0.5rem' }}>
            <button
              className="btn"
              style={{ background: '#475569' }}
              onClick={async () => {
                setDraftValidationResult(null);
                try {
                  const payload = JSON.parse(draftContractStr);
                  const res = await fetch(`${API_BASE}/contracts/validate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  const data = await res.json();
                  setDraftValidationResult(data);
                } catch (err: any) {
                  setDraftValidationResult({ status: 'error', valid: false, errors: [`JSON parse error: ${err.message}`] });
                }
              }}
            >
              Validate Contract
            </button>
            <button
              className="btn btn-primary"
              style={{ background: 'var(--color-primary)' }}
              onClick={async () => {
                setIsSubmitting(true);
                setDraftValidationResult(null);
                try {
                  const payload = JSON.parse(draftContractStr);
                  const res = await fetch(`${API_BASE}/contracts`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  const data = await res.json();
                  if (data.status === 'success') {
                    setDraftValidationResult({ status: 'success', message: `Contract submitted: ${data.data.module_id}` });
                    setDraftContractStr('');
                    fetchContracts();
                  } else {
                    setDraftValidationResult({ status: 'error', errors: [JSON.stringify(data.error)] });
                  }
                } catch (err: any) {
                  setDraftValidationResult({ status: 'error', errors: [`Submit error: ${err.message}`] });
                } finally { setIsSubmitting(false); }
              }}
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Submitting...' : 'Submit Contract'}
            </button>
            <button
              className="btn"
              style={{ background: '#1e293b' }}
              onClick={() => {
                setDraftContractStr('');
                setDraftValidationResult(null);
              }}
            >
              Clear
            </button>
          </div>

          {draftValidationResult && (
            <div style={{
              marginTop: '0.75rem',
              padding: '0.75rem',
              borderRadius: '0.375rem',
              background: draftValidationResult.status === 'success' ? '#064e3b' : '#450a0a',
              border: `1px solid ${draftValidationResult.status === 'success' ? '#059669' : '#dc2626'}`,
            }}>
              {draftValidationResult.status === 'success' ? (
                <span>✅ {draftValidationResult.message || 'Contract is valid!'}</span>
              ) : (
                <div>
                  <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>❌ Validation Failed</div>
                  <ul style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.875rem' }}>
                    {(draftValidationResult.errors || []).map((err: string, i: number) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeView === 'settings' && (
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Supervisor Control */}
          <div>
            <h2 style={{ marginBottom: '0.75rem' }}>Supervisor Control</h2>
            <div className="flex items-center gap-3" style={{ marginBottom: '0.75rem' }}>
              <span className={`health-dot health-${supervisorRunning ? 'healthy' : 'unhealthy'}`} />
              <span style={{ fontWeight: 500 }}>
                {supervisorRunning ? 'Running' : 'Stopped'}
              </span>
              <button
                className="btn"
                style={{ background: 'var(--color-primary)', marginLeft: 'auto' }}
                onClick={supervisorRunning ? stopSupervisor : startSupervisor}
              >
                {supervisorRunning ? 'Stop Supervisor' : 'Start Supervisor'}
              </button>
            </div>
            {supervisorLogs.length > 0 && (
              <pre style={{
                background: '#0f172a',
                color: '#e2e8f0',
                padding: '0.75rem',
                borderRadius: '0.375rem',
                fontSize: '0.75rem',
                maxHeight: '200px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {supervisorLogs.join('')}
              </pre>
            )}
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #334155' }} />

          {/* LLM Configuration */}
          <div>
            <h2 style={{ marginBottom: '0.75rem' }}>LLM Configuration</h2>
            {configData ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>Default Ollama Model</label>
                  <select
                    className="btn"
                    style={{ width: '100%', background: 'var(--color-surface)', color: 'var(--color-text)' }}
                    value={configData.default_ollama_model || ''}
                    onChange={(e) => setConfigData({ ...configData, default_ollama_model: e.target.value })}
                  >
                    {ollamaModels.length === 0 && (
                      <option value={configData.default_ollama_model}>{configData.default_ollama_model}</option>
                    )}
                    {ollamaModels.map((m: string) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <label style={{ fontSize: '0.875rem' }}>Fallback Models:</label>
                  <span style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
                    {(configData.fallback_models || []).join(', ')}
                  </span>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                    Temperature: {configData.default_temperature ?? 0.1}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={configData.default_temperature ?? 0.1}
                    onChange={(e) => setConfigData({ ...configData, default_temperature: parseFloat(e.target.value) })}
                    style={{ width: '100%' }}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="seedControl"
                    checked={configData.seed_control ?? true}
                    onChange={(e) => setConfigData({ ...configData, seed_control: e.target.checked })}
                  />
                  <label htmlFor="seedControl" style={{ fontSize: '0.875rem' }}>Seed Control (deterministic retry rotation)</label>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="ollamaHost"
                    disabled
                    checked
                  />
                  <label htmlFor="ollamaHost" style={{ fontSize: '0.875rem' }}>
                    Ollama Host: {configData.ollama_host_url || 'http://localhost:11434'}
                  </label>
                </div>

                <button
                  className="btn btn-primary"
                  style={{ marginTop: '0.5rem', background: 'var(--color-primary)' }}
                  onClick={async () => {
                    setIsSavingConfig(true);
                    try {
                      const res = await fetch(`${API_BASE}/config`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          default_ollama_model: configData.default_ollama_model,
                          default_temperature: configData.default_temperature,
                          seed_control: configData.seed_control,
                        }),
                      });
                      const data = await res.json();
                      if (data.status === 'success') {
                        setConfigData(data.data);
                        setSupervisorLogs(prev => [...prev, '[UI] Config saved successfully']);
                      } else {
                        setSupervisorLogs(prev => [...prev, `[UI] Save failed: ${JSON.stringify(data.error)}`]);
                      }
                    } catch (err: any) {
                      setSupervisorLogs(prev => [...prev, `[UI] Save error: ${err.message}`]);
                    } finally {
                      setIsSavingConfig(false);
                    }
                  }}
                  disabled={isSavingConfig}
                >
                  {isSavingConfig ? 'Saving...' : 'Save Configuration'}
                </button>
              </div>
            ) : (
              <p style={{ color: 'var(--color-text-muted)' }}>Loading configuration...</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;