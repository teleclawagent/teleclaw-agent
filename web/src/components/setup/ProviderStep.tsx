import { useState, useEffect, useRef } from 'react';
import { setup, SetupProvider, SetupModelOption } from '../../lib/api';
import { Select } from '../Select';
import type { StepProps } from '../../pages/Setup';

type AuthMethod = 'subscription' | 'api-key';

export function ProviderStep({ data, onChange }: StepProps) {
  const [providers, setProviders] = useState<SetupProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [keyValid, setKeyValid] = useState<boolean | null>(null);
  const [keyError, setKeyError] = useState('');
  const [validating, setValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [models, setModels] = useState<SetupModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>('subscription');

  useEffect(() => {
    setup.getProviders()
      .then((p) => setProviders(p))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const selected = providers.find((p) => p.id === data.provider);

  // Load models when provider changes
  useEffect(() => {
    if (!data.provider || data.provider === 'cocoon' || data.provider === 'local') {
      setModels([]);
      return;
    }
    setLoadingModels(true);
    setup.getModels(data.provider)
      .then((m) => {
        setModels(m);
        if (!data.model && m.length > 0) {
          onChange({ ...data, model: m[0].value });
        }
      })
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false));
  }, [data.provider]);

  const handleSelect = (id: string) => {
    onChange({ ...data, provider: id, apiKey: '', model: '', customModel: '' });
    setKeyValid(null);
    setKeyError('');
    // Reset auth method based on provider
    const prov = providers.find((p) => p.id === id);
    setAuthMethod(prov?.supportsSetupToken ? 'subscription' : 'api-key');
  };

  const validateKey = async (provider: string, key: string) => {
    setValidating(true);
    try {
      const result = await setup.validateApiKey(provider, key);
      setKeyValid(result.valid);
      setKeyError(result.error || '');
    } catch {
      setKeyValid(null);
    } finally {
      setValidating(false);
    }
  };

  const handleKeyChange = (value: string) => {
    onChange({ ...data, apiKey: value });
    setKeyValid(null);
    setKeyError('');

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.length > 0 && data.provider) {
      debounceRef.current = setTimeout(() => validateKey(data.provider, value), 500);
    }
  };

  if (loading) return <div className="loading">Loading providers...</div>;
  if (error) return <div className="alert error">{error}</div>;

  return (
    <div className="step-content">
      <h2 className="step-title">Choose Your LLM Provider</h2>
      <p className="step-description">
        This is the AI model that powers your agent's intelligence.
      </p>

      <div className="provider-grid">
        {providers.map((p) => (
          <div
            key={p.id}
            className={`provider-card${data.provider === p.id ? ' selected' : ''}`}
            onClick={() => handleSelect(p.id)}
          >
            <h3>{p.displayName}</h3>
            <div className="provider-meta">{p.defaultModel}</div>
            {p.supportsSetupToken && (
              <span className="badge always" style={{ marginTop: '6px' }}>
                ⭐ Recommended
              </span>
            )}
            {!p.supportsSetupToken && p.toolLimit === null && (
              <span className="badge always" style={{ marginTop: '6px' }}>
                Recommended
              </span>
            )}
          </div>
        ))}
      </div>

      {selected && selected.toolLimit !== null && (
        <div className="info-box" style={{ marginTop: '16px' }}>
          Teleclaw has ~116 tools. With a {selected.toolLimit}-tool limit, some tools may be truncated or unavailable.
        </div>
      )}

      {/* Auth method selection for providers that support setup-token */}
      {selected && selected.supportsSetupToken && (
        <div style={{ marginTop: '16px' }}>
          <label style={{ marginBottom: '8px', display: 'block', fontWeight: 600 }}>Authentication Method</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={`btn ${authMethod === 'subscription' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setAuthMethod('subscription')}
              style={{ flex: 1 }}
            >
              ⭐ Claude Subscription
              <div style={{ fontSize: '0.75em', opacity: 0.8, marginTop: '2px' }}>Free with Pro/Max plan</div>
            </button>
            <button
              className={`btn ${authMethod === 'api-key' ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setAuthMethod('api-key')}
              style={{ flex: 1 }}
            >
              API Key
              <div style={{ fontSize: '0.75em', opacity: 0.8, marginTop: '2px' }}>Pay-as-you-go</div>
            </button>
          </div>
        </div>
      )}

      {/* Setup-token instructions for Claude subscription */}
      {selected && selected.supportsSetupToken && authMethod === 'subscription' && (
        <div style={{ marginTop: '16px' }}>
          <div className="info-panel" style={{ borderColor: 'var(--color-primary, #6366f1)' }}>
            <div style={{ marginBottom: '12px' }}>
              <strong>🔑 Use your Claude Pro/Max subscription — no extra charges</strong>
            </div>
            <div style={{ marginBottom: '8px', padding: '8px', background: 'rgba(255,200,0,0.1)', borderRadius: '4px', fontSize: '0.9em' }}>
              ⚠️ Open a <strong>separate terminal/command prompt</strong> and run this command:
            </div>
            <div style={{ marginBottom: '12px' }}>
              <code style={{ display: 'block', margin: '6px 0', padding: '12px', background: 'rgba(0,0,0,0.15)', borderRadius: '4px', fontSize: '1.05em' }}>
                npx @anthropic-ai/claude-code auth login
              </code>
              <div style={{ fontSize: '0.85em', opacity: 0.8, marginTop: '6px' }}>
                Browser opens → sign in with your Claude account → see "Successfully logged in" → come back here
              </div>
            </div>
            <div style={{ fontSize: '0.85em', opacity: 0.7 }}>
              Your credentials are saved locally and auto-refresh. No token to copy/paste.
            </div>
          </div>

          <div className="form-group" style={{ marginTop: '12px' }}>
            <label>Setup Token</label>
            <input
              type="password"
              value={data.apiKey}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder="Paste your setup-token here..."
              className="w-full"
            />
            {validating && (
              <div className="helper-text"><span className="spinner sm" /> Validating...</div>
            )}
            {!validating && keyValid === true && (
              <div className="helper-text success">✅ Token looks valid.</div>
            )}
            {!validating && keyValid === false && keyError && (
              <div className="helper-text error">{keyError}</div>
            )}
            <div className="helper-text" style={{ marginTop: '4px' }}>
              This token uses your Claude subscription — no extra charges. Token may expire, regenerate with <code>claude setup-token</code> if needed.
            </div>
          </div>
        </div>
      )}

      {/* Standard API key input */}
      {selected && selected.requiresApiKey && (
        (!selected.supportsSetupToken || authMethod === 'api-key') && (
          <div className="form-group" style={{ marginTop: '16px' }}>
            <label>API Key</label>
            <input
              type="password"
              value={data.apiKey}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder={selected.keyPrefix ? `${selected.keyPrefix}...` : 'Enter API key'}
              className="w-full"
            />
            {validating && (
              <div className="helper-text"><span className="spinner sm" /> Validating...</div>
            )}
            {!validating && keyValid === true && (
              <div className="helper-text success">Key format looks valid.</div>
            )}
            {!validating && keyValid === false && keyError && (
              <div className="helper-text error">{keyError}</div>
            )}
            {selected.consoleUrl && (
              <div className="helper-text">
                Get your key at:{' '}
                <a href={selected.consoleUrl} target="_blank" rel="noopener noreferrer">
                  {selected.consoleUrl}
                </a>
              </div>
            )}
          </div>
        )
      )}

      {selected && !selected.requiresApiKey && selected.id === 'cocoon' && (
        <div style={{ marginTop: '16px' }}>
          <div className="info-panel">
            Cocoon Network uses a local proxy. No API key required.
          </div>
          <div className="form-group">
            <label>Cocoon Proxy Port</label>
            <input
              type="number"
              value={data.cocoonPort}
              onChange={(e) => onChange({ ...data, cocoonPort: parseInt(e.target.value) || 0 })}
              min={1}
              max={65535}
              className="w-full"
            />
            <div className="helper-text">
              Port where the Cocoon client proxy is running (1-65535).
            </div>
          </div>
        </div>
      )}

      {selected && selected.id === 'local' && (
        <div style={{ marginTop: '16px' }}>
          <div className="info-panel">
            Connect to any OpenAI-compatible server (Ollama, vLLM, LM Studio, llama.cpp). No API key required.
          </div>
          <div className="form-group">
            <label>Server URL</label>
            <input
              type="url"
              value={data.localUrl}
              onChange={(e) => onChange({ ...data, localUrl: e.target.value })}
              placeholder="http://localhost:11434/v1"
              className="w-full"
            />
            <div className="helper-text">
              Ollama :11434 · vLLM :8000 · LM Studio :1234 · llama.cpp :8080
            </div>
          </div>
        </div>
      )}

      {selected && selected.id !== 'cocoon' && selected.id !== 'local' && (
        <div className="form-group" style={{ marginTop: '16px' }}>
          <label>Model</label>
          {loadingModels ? (
            <div className="text-muted"><span className="spinner sm" /> Loading models...</div>
          ) : (
            <Select
              value={data.model}
              options={models.map((m) => m.value)}
              labels={models.map((m) => m.isCustom ? 'Custom...' : `${m.name} - ${m.description}`)}
              onChange={(v) => onChange({ ...data, model: v })}
              style={{ width: '100%' }}
            />
          )}
          {data.model === '__custom__' && (
            <input
              type="text"
              value={data.customModel}
              onChange={(e) => onChange({ ...data, customModel: e.target.value })}
              placeholder="Enter custom model ID"
              className="w-full"
              style={{ marginTop: '8px' }}
            />
          )}
        </div>
      )}
    </div>
  );
}
