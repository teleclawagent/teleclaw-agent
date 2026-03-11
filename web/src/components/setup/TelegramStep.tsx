import type { StepProps } from '../../pages/Setup';
import { PasswordInput } from './PasswordInput';

export function TelegramStep({ data, onChange }: StepProps) {
  return (
    <div className="step-content">
      <h2 className="step-title">Telegram Credentials</h2>
      <p className="step-description">
        These credentials allow your agent to use your Telegram account to send and receive messages.
      </p>

      <details className="guide-dropdown">
        <summary>How to get these credentials</summary>
        <div className="guide-content">
          <div className="guide-section">
            <strong>API ID &amp; API Hash</strong>
            <ol>
              <li>Open <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer">my.telegram.org</a> in your browser</li>
              <li>Log in with your phone number (the one linked to your Telegram account)</li>
              <li>Click <strong>API development tools</strong></li>
              <li>If prompted, create a new app — the name and platform don't matter (e.g. "MyApp", Desktop)</li>
              <li>Copy <strong>App api_id</strong> (a number) and <strong>App api_hash</strong> (a hex string)</li>
            </ol>
          </div>
          {data.authMode === 'phone' && (
            <div className="guide-section">
              <strong>Phone Number</strong>
              <p>The phone number linked to your Telegram account, with country code (e.g. +33612345678).</p>
            </div>
          )}
        </div>
      </details>

      <div className="form-group">
        <label>API ID</label>
        <input
          type="number"
          value={data.apiId || ''}
          onChange={(e) => onChange({ ...data, apiId: parseInt(e.target.value) || 0 })}
          placeholder="12345678"
          className="w-full"
        />
      </div>

      <div className="form-group">
        <label>API Hash</label>
        <PasswordInput
          value={data.apiHash}
          onChange={(e) => onChange({ ...data, apiHash: e.target.value })}
          placeholder="abcdef0123456789abcdef0123456789"
          className="w-full"
        />
        {data.apiHash.length > 0 && data.apiHash.length < 10 && (
          <div className="helper-text">API Hash should be at least 10 characters.</div>
        )}
      </div>

      {/* Auth mode toggle */}
      <div className="form-group">
        <label>Login method</label>
        <div style={{
          display: 'flex',
          gap: '4px',
          background: 'var(--surface)',
          borderRadius: '8px',
          padding: '4px',
        }}>
          <button
            type="button"
            onClick={() => onChange({ ...data, authMode: 'qr', phone: '' })}
            style={{
              flex: 1,
              padding: '8px 16px',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              background: data.authMode === 'qr' ? 'var(--accent, #6c5ce7)' : 'transparent',
              color: data.authMode === 'qr' ? '#fff' : 'var(--text-muted, #999)',
              fontWeight: data.authMode === 'qr' ? 600 : 400,
              transition: 'all 0.2s',
            }}
          >
            QR Code
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...data, authMode: 'phone' })}
            style={{
              flex: 1,
              padding: '8px 16px',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              background: data.authMode === 'phone' ? 'var(--accent, #6c5ce7)' : 'transparent',
              color: data.authMode === 'phone' ? '#fff' : 'var(--text-muted, #999)',
              fontWeight: data.authMode === 'phone' ? 600 : 400,
              transition: 'all 0.2s',
            }}
          >
            Phone Number
          </button>
        </div>
        <div className="text-muted" style={{ fontSize: '0.85em', marginTop: '6px' }}>
          {data.authMode === 'qr'
            ? 'Scan a QR code with your Telegram app to connect instantly.'
            : 'Receive a verification code via SMS or Telegram app.'}
        </div>
      </div>

      {data.authMode === 'phone' && (
        <div className="form-group">
          <label>Phone Number</label>
          <input
            type="text"
            value={data.phone}
            onChange={(e) => onChange({ ...data, phone: e.target.value })}
            placeholder="+33612345678"
            className="w-full"
          />
          {data.phone.length > 0 && !data.phone.startsWith('+') && (
            <div className="helper-text">Phone number must start with &quot;+&quot;</div>
          )}
        </div>
      )}

    </div>
  );
}
