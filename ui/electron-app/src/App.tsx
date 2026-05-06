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
  const [activeView, setActiveView] = useState<'dashboard' | 'pipeline' | 'registry' | 'settings'>('dashboard');
  const [selectedModule, setSelectedModule] = useState<string | null>(null);

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

  // Actions
  const submitContract = async () => {
    // In a real UI, this would open a form dialog
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
          {(['dashboard', 'pipeline', 'registry', 'settings'] as const).map(view => (
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

      {activeView === 'settings' && (
        <div className="card">
          <h2 style={{ marginBottom: '1rem' }}>Settings</h2>
          <p style={{ color: 'var(--color-text-muted)' }}>Configuration is managed at <code>C:/SkynetFactory/config/builder.config.json</code></p>
          <p style={{ color: 'var(--color-text-muted)', marginTop: '0.5rem' }}>
            Or update at runtime via <code>PUT /skynetfactory/api/config</code>
          </p>
        </div>
      )}
    </div>
  );
}

export default App;