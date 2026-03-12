import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ConfigKeyData } from '../lib/api';
import { useConfigState } from '../hooks/useConfigState';
import { PillBar } from '../components/PillBar';
import { AgentSettingsPanel } from '../components/AgentSettingsPanel';
import { TelegramSettingsPanel } from '../components/TelegramSettingsPanel';
import { Select } from '../components/Select';
import { ArrayInput } from '../components/ArrayInput';
import { EditableField } from '../components/EditableField';
import { ConfigSection } from '../components/ConfigSection';
import { InfoTip } from '../components/InfoTip';

const TABS = [
  { id: 'llm', label: 'LLM' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'ton-proxy', label: 'TON Proxy' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'tool-rag', label: 'Tool RAG' },
];

const API_KEY_KEYS = ['agent.api_key', 'telegram.bot_token', 'tavily_api_key', 'tonapi_key', 'toncenter_api_key'];
const ADVANCED_KEYS = [
  'embedding.provider', 'embedding.model', 'webui.port', 'webui.log_requests',
  'deals.enabled', 'deals.expiry_seconds', 'deals.buy_max_floor_percent', 'deals.sell_min_floor_percent',
  'agent.base_url', 'dev.hot_reload',
];
const SESSION_KEYS = [
  'agent.session_reset_policy.daily_reset_enabled',
  'agent.session_reset_policy.daily_reset_hour',
  'agent.session_reset_policy.idle_expiry_enabled',
  'agent.session_reset_policy.idle_expiry_minutes',
];

export function Config() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'llm';

  const config = useConfigState();

  // Raw config keys state for ConfigSection tabs
  const [configKeys, setConfigKeys] = useState<ConfigKeyData[]>([]);

  // TON Proxy state
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<{ running: boolean; installed: boolean; port: number; enabled: boolean; pid?: number } | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);

  const handleTabChange = (id: string) => {
    setSearchParams({ tab: id }, { replace: true });
  };

  // Load config keys on mount (needed by ConfigSection in multiple tabs)
  useEffect(() => {
    api.getConfigKeys()
      .then((res) => setConfigKeys(res.data))
      .catch(() => {});
  }, []);

  // Load proxy status when TON Proxy tab is active
  useEffect(() => {
    if (activeTab !== 'ton-proxy') return;
    api.getTonProxyStatus()
      .then((res) => setProxyStatus(res.data))
      .catch(() => {});
  }, [activeTab]);

  const loadKeys = () => {
    api.getConfigKeys()
      .then((res) => setConfigKeys(res.data))
      .catch(() => {});
  };

  const handleArraySave = async (key: string, values: string[]) => {
    config.setError(null);
    try {
      await api.setConfigKey(key, values);
      config.showSuccess(`${key} updated successfully`);
      loadKeys();
    } catch (err) {
      config.setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (config.loading) return <div className="loading">Loading...</div>;

  return (
    <div>
      <div className="header">
        <h1>Configuration</h1>
        <p>Manage settings and API keys</p>
      </div>

      {config.error && (
        <div className="alert error" style={{ marginBottom: '14px' }}>
          {config.error}
          <button onClick={() => config.setError(null)} style={{ marginLeft: '10px', padding: '2px 8px', fontSize: '12px' }}>
            Dismiss
          </button>
        </div>
      )}

      {config.saveSuccess && (
        <div className="alert success" style={{ marginBottom: '16px' }}>
          {config.saveSuccess}
        </div>
      )}

      <PillBar tabs={TABS} activeTab={activeTab} onTabChange={handleTabChange} />

      {/* LLM Tab */}
      {activeTab === 'llm' && (
        <>
          <div className="card-header">
            <div className="section-title">Agent</div>
          </div>
          <div className="card">
            <AgentSettingsPanel
              getLocal={config.getLocal}
              getServer={config.getServer}
              setLocal={config.setLocal}
              saveConfig={config.saveConfig}
              cancelLocal={config.cancelLocal}
              modelOptions={config.modelOptions}
              pendingProvider={config.pendingProvider}
              pendingMeta={config.pendingMeta}
              pendingApiKey={config.pendingApiKey}
              setPendingApiKey={config.setPendingApiKey}
              pendingValidating={config.pendingValidating}
              pendingError={config.pendingError}
              setPendingError={config.setPendingError}
              handleProviderChange={config.handleProviderChange}
              handleProviderConfirm={config.handleProviderConfirm}
              handleProviderCancel={config.handleProviderCancel}
            />
          </div>

          {config.getLocal('agent.provider') === 'cocoon' && (
            <>
              <div className="card-header">
                <div className="section-title">Cocoon</div>
              </div>
              <div className="card">
                <EditableField
                  label="Proxy Port"
                  description="Cocoon Network proxy port"
                  configKey="cocoon.port"
                  type="number"
                  value={config.getLocal('cocoon.port')}
                  serverValue={config.getServer('cocoon.port')}
                  onChange={(v) => config.setLocal('cocoon.port', v)}
                  onSave={(v) => config.saveConfig('cocoon.port', v)}
                  onCancel={() => config.cancelLocal('cocoon.port')}
                  min={1}
                  max={65535}
                  placeholder="11434"
                  hotReload="restart"
                />
              </div>
            </>
          )}

        </>
      )}

      {/* Telegram Tab */}
      {activeTab === 'telegram' && (
        <TelegramSettingsPanel
          getLocal={config.getLocal}
          getServer={config.getServer}
          setLocal={config.setLocal}
          saveConfig={config.saveConfig}
          cancelLocal={config.cancelLocal}
          configKeys={configKeys}
          onArraySave={handleArraySave}
          extended={true}
        />
      )}

      {/* API Keys Tab */}
      {activeTab === 'api-keys' && (
        <>
          <div className="card-header">
            <div className="section-title">API Keys</div>
          </div>
          <div className="card">
            <ConfigSection
              keys={API_KEY_KEYS}
              configKeys={configKeys}
              getLocal={config.getLocal}
              getServer={config.getServer}
              setLocal={config.setLocal}
              saveConfig={config.saveConfig}
              cancelLocal={config.cancelLocal}
            />
          </div>
        </>
      )}

      {/* TON Proxy Tab */}
      {activeTab === 'ton-proxy' && (
        <>
          <div className="card-header">
            <div className="section-title">TON Proxy</div>
            <p className="card-description">
              Tonutils-Proxy gateway for accessing .ton websites. The binary is auto-downloaded from GitHub on first enable.
            </p>
          </div>
          <div className="card">
            {proxyError && (
              <div className="alert error" style={{ marginBottom: '14px' }}>
                {proxyError}
                <button onClick={() => setProxyError(null)} style={{ marginLeft: '10px', padding: '2px 8px', fontSize: '12px' }}>
                  Dismiss
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Top row: toggle left, uninstall right */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label className="toggle" style={{ margin: 0 }}>
                    <input
                      type="checkbox"
                      disabled={proxyLoading}
                      checked={proxyStatus?.enabled ?? config.getLocal('ton_proxy.enabled') === 'true'}
                      onChange={async (e) => {
                        const enable = e.target.checked;
                        setProxyLoading(true);
                        setProxyError(null);
                        try {
                          const res = enable
                            ? await api.startTonProxy()
                            : await api.stopTonProxy();
                          setProxyStatus(res.data);
                          config.showSuccess(enable ? 'TON Proxy started' : 'TON Proxy stopped');
                          loadKeys();
                        } catch (err) {
                          setProxyError(err instanceof Error ? err.message : String(err));
                        } finally {
                          setProxyLoading(false);
                        }
                      }}
                    />
                    <span className="toggle-track" />
                    <span className="toggle-thumb" />
                  </label>
                  <span>Enabled</span>
                  {proxyLoading && (
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <span className="spinner" style={{
                        display: 'inline-block',
                        width: 14,
                        height: 14,
                        border: '2px solid var(--separator)',
                        borderTopColor: 'var(--accent)',
                        borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite',
                      }} />
                      {proxyStatus?.installed === false ? 'Downloading binary...' : 'Starting...'}
                    </span>
                  )}
                  {!proxyLoading && proxyStatus?.running && (
                    <span style={{ fontSize: '12px', color: 'var(--green, #22c55e)' }}>
                      Running (PID {proxyStatus.pid})
                    </span>
                  )}
                  <InfoTip text="Enable TON Proxy — auto-downloads the binary if not found" />
                </div>
                {!(proxyStatus?.enabled) && (
                  <button
                    disabled={proxyLoading || !proxyStatus?.installed}
                    onClick={async () => {
                      if (!confirm('Remove the TON Proxy binary from disk?')) return;
                      setProxyLoading(true);
                      setProxyError(null);
                      try {
                        const res = await api.uninstallTonProxy();
                        setProxyStatus(res.data);
                        config.showSuccess('TON Proxy uninstalled');
                        loadKeys();
                      } catch (err) {
                        setProxyError(err instanceof Error ? err.message : String(err));
                      } finally {
                        setProxyLoading(false);
                      }
                    }}
                    style={{
                      padding: '5px 12px',
                      fontSize: 12,
                      fontWeight: 500,
                      background: proxyStatus?.installed ? 'var(--red, #ef4444)' : 'var(--text-secondary)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      cursor: proxyStatus?.installed ? 'pointer' : 'default',
                      opacity: proxyStatus?.installed ? 1 : 0.5,
                    }}
                  >
                    Uninstall
                  </button>
                )}
              </div>

              {/* Port */}
              <EditableField
                label="Proxy Port"
                description="HTTP proxy listen address port"
                configKey="ton_proxy.port"
                type="number"
                value={config.getLocal('ton_proxy.port') || '8080'}
                serverValue={config.getServer('ton_proxy.port') || '8080'}
                onChange={(v) => config.setLocal('ton_proxy.port', v)}
                onSave={(v) => config.saveConfig('ton_proxy.port', v)}
                onCancel={() => config.cancelLocal('ton_proxy.port')}
                min={1}
                max={65535}
                placeholder="8080"
                hotReload="restart"
              />

              {/* Binary Path */}
              <EditableField
                label="Binary Path"
                description="Custom path to tonutils-proxy-cli binary"
                configKey="ton_proxy.binary_path"
                type="text"
                value={config.getLocal('ton_proxy.binary_path')}
                serverValue={config.getServer('ton_proxy.binary_path')}
                onChange={(v) => config.setLocal('ton_proxy.binary_path', v)}
                onSave={(v) => config.saveConfig('ton_proxy.binary_path', v)}
                onCancel={() => config.cancelLocal('ton_proxy.binary_path')}
                placeholder="~/.teleclaw/bin/tonutils-proxy-cli (auto-download)"
                hotReload="restart"
              />

            </div>
          </div>
        </>
      )}

      {/* Advanced Tab */}
      {activeTab === 'advanced' && (
        <>
          <div className="card-header">
            <div className="section-title">Advanced</div>
          </div>
          <div className="card">
            <ConfigSection
              keys={ADVANCED_KEYS}
              configKeys={configKeys}
              getLocal={config.getLocal}
              getServer={config.getServer}
              setLocal={config.setLocal}
              saveConfig={config.saveConfig}
              cancelLocal={config.cancelLocal}
            />
          </div>
        </>
      )}

      {/* Sessions Tab */}
      {activeTab === 'sessions' && (
        <>
          <div className="card-header">
            <div className="section-title">Sessions</div>
            <p className="card-description">Session reset and expiry policies</p>
          </div>
          <div className="card">
            <ConfigSection
              keys={SESSION_KEYS}
              configKeys={configKeys}
              getLocal={config.getLocal}
              getServer={config.getServer}
              setLocal={config.setLocal}
              saveConfig={config.saveConfig}
              cancelLocal={config.cancelLocal}
            />
          </div>
        </>
      )}

      {/* Tool RAG Tab */}
      {activeTab === 'tool-rag' && config.toolRag && (
        <>
          <div className="card-header">
            <div className="section-title">Tool RAG</div>
            <p className="card-description">
              Semantic tool selection — sends only the most relevant tools to the LLM per message.
            </p>
          </div>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <span style={{ fontSize: '13px', fontWeight: 500 }}>Enabled</span>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={config.toolRag.enabled}
                  onChange={() => config.saveToolRag({ enabled: !config.toolRag!.enabled })}
                />
                <span className="toggle-track" />
                <span className="toggle-thumb" />
              </label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ fontSize: '13px', color: 'var(--text)' }}>
                  Top-K <InfoTip text="Number of most relevant tools to send per message" />
                </label>
                <Select
                  value={String(config.toolRag.topK)}
                  options={['10', '15', '20', '25', '30', '40', '50']}
                  onChange={(v) => config.saveToolRag({ topK: Number(v) })}
                  style={{ minWidth: '80px' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <label style={{ fontSize: '13px', color: 'var(--text)', cursor: 'pointer' }} htmlFor="skip-unlimited">
                  Skip Unlimited <InfoTip text="Skip RAG filtering for providers with no tool limit" />
                </label>
                <label className="toggle">
                  <input
                    id="skip-unlimited"
                    type="checkbox"
                    checked={config.toolRag.skipUnlimitedProviders ?? false}
                    onChange={() => config.saveToolRag({ skipUnlimitedProviders: !config.toolRag!.skipUnlimitedProviders })}
                  />
                  <span className="toggle-track" />
                  <span className="toggle-thumb" />
                </label>
              </div>
            </div>
            <div style={{ marginTop: '12px' }}>
              <label style={{ fontSize: '13px', color: 'var(--text)', display: 'block', marginBottom: '6px' }}>
                Always Include (glob patterns) <InfoTip text="Tool name patterns that are always included regardless of RAG scoring" />
              </label>
              <ArrayInput
                value={config.toolRag.alwaysInclude ?? []}
                onChange={(values) => config.saveToolRag({ alwaysInclude: values })}
                placeholder="e.g. telegram_send_*"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
