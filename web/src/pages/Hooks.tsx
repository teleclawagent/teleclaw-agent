import { useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../lib/api';

interface TriggerEntry {
  id: string;
  keyword: string;
  context: string;
  enabled: boolean;
}

export function Hooks() {
  // Blocklist state
  const [blockEnabled, setBlockEnabled] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [blockMessage, setBlockMessage] = useState('');
  const [keywordInput, setKeywordInput] = useState('');

  // Triggers state
  const [triggers, setTriggers] = useState<TriggerEntry[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newContext, setNewContext] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKeyword, setEditKeyword] = useState('');
  const [editContext, setEditContext] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Debounced save for blocklist
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blocklistRef = useRef({ enabled: false, keywords: [] as string[], message: '' });

  const loadData = async () => {
    setLoading(true);
    try {
      const [blockRes, trigRes] = await Promise.all([api.getBlocklist(), api.getTriggers()]);
      const bl = blockRes.data;
      setBlockEnabled(bl.enabled);
      setKeywords(bl.keywords);
      setBlockMessage(bl.message);
      blocklistRef.current = { enabled: bl.enabled, keywords: bl.keywords, message: bl.message };
      setTriggers(trigRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);

  const saveBlocklist = useCallback((config: { enabled: boolean; keywords: string[]; message: string }) => {
    blocklistRef.current = config;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api.updateBlocklist(config);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 400);
  }, []);

  const handleToggleBlocklist = () => {
    const next = !blockEnabled;
    setBlockEnabled(next);
    saveBlocklist({ ...blocklistRef.current, enabled: next });
  };

  const handleAddKeyword = () => {
    const kw = keywordInput.trim();
    if (kw.length < 2) return;
    if (keywords.includes(kw)) { setKeywordInput(''); return; }
    const next = [...keywords, kw];
    setKeywords(next);
    setKeywordInput('');
    saveBlocklist({ ...blocklistRef.current, keywords: next });
  };

  const handleRemoveKeyword = (kw: string) => {
    const next = keywords.filter((k) => k !== kw);
    setKeywords(next);
    saveBlocklist({ ...blocklistRef.current, keywords: next });
  };

  const handleBlockMessageChange = (msg: string) => {
    setBlockMessage(msg);
    saveBlocklist({ ...blocklistRef.current, message: msg });
  };

  // ── Trigger actions ────────────────────────────────────────────────

  const handleAddTrigger = async () => {
    const kw = newKeyword.trim();
    const ctx = newContext.trim();
    if (kw.length < 2 || ctx.length < 1) return;
    setSaving(true);
    try {
      const res = await api.createTrigger({ keyword: kw, context: ctx });
      setTriggers((prev) => [...prev, res.data]);
      setNewKeyword('');
      setNewContext('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTrigger = async (id: string) => {
    try {
      await api.deleteTrigger(id);
      setTriggers((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleToggleTrigger = async (id: string, enabled: boolean) => {
    try {
      await api.toggleTrigger(id, !enabled);
      setTriggers((prev) =>
        prev.map((t) => (t.id === id ? { ...t, enabled: !enabled } : t))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const startEdit = (t: TriggerEntry) => {
    setEditingId(t.id);
    setEditKeyword(t.keyword);
    setEditContext(t.context);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    const kw = editKeyword.trim();
    const ctx = editContext.trim();
    if (kw.length < 2 || ctx.length < 1) return;
    setSaving(true);
    try {
      const res = await api.updateTrigger(editingId, { keyword: kw, context: ctx });
      setTriggers((prev) =>
        prev.map((t) => (t.id === editingId ? res.data : t))
      );
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Loading...</div>;

  return (
    <div>
      <div className="header">
        <h1>Hooks</h1>
        <p>Keyword blocklist and context injection triggers</p>
      </div>

      {error && (
        <div className="alert error" style={{ marginBottom: '14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{error}</span>
          <button className="btn-ghost btn-sm" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* ── Keyword Blocklist ── */}
      <div className="card" style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <h2 style={{ margin: 0, fontSize: '16px' }}>Keyword Blocklist</h2>
          <label className="toggle">
            <input type="checkbox" checked={blockEnabled} onChange={handleToggleBlocklist} />
            <span className="toggle-track" />
            <span className="toggle-thumb" />
          </label>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
          Messages containing these keywords will be blocked. Word-boundary matching (no substring matches).
        </p>

        <div style={{ marginBottom: '10px' }}>
          <label style={{ fontSize: '13px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>Keywords</label>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '8px',
            border: '1px solid var(--separator)',
            borderRadius: '8px',
            minHeight: '36px',
            alignItems: 'center',
          }}>
            {keywords.map((kw) => (
              <span
                key={kw}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 8px',
                  borderRadius: '12px',
                  background: 'rgba(110,168,254,0.12)',
                  color: 'var(--text)',
                  fontSize: '13px',
                }}
              >
                {kw}
                <button
                  onClick={() => handleRemoveKeyword(kw)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0 2px',
                    color: 'var(--text-secondary)',
                    fontSize: '14px',
                    lineHeight: 1,
                  }}
                >
                  &#x2715;
                </button>
              </span>
            ))}
            <input
              type="text"
              placeholder="Add keyword..."
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleAddKeyword(); }
                if (e.key === 'Backspace' && !keywordInput && keywords.length > 0) {
                  handleRemoveKeyword(keywords[keywords.length - 1]);
                }
              }}
              style={{
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: 'var(--text)',
                fontSize: '13px',
                flex: 1,
                minWidth: '100px',
                padding: '2px 0',
              }}
            />
          </div>
        </div>

        <div>
          <label style={{ fontSize: '13px', fontWeight: 600, display: 'block', marginBottom: '4px' }}>
            Block reply (optional)
          </label>
          <input
            type="text"
            placeholder="Message sent when a message is blocked..."
            value={blockMessage}
            onChange={(e) => handleBlockMessageChange(e.target.value)}
            maxLength={500}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {/* ── Context Triggers ── */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <h2 style={{ margin: 0, fontSize: '16px' }}>Context Triggers</h2>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{triggers.length}/50</span>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
          When a keyword is detected, the associated context is injected into the LLM prompt.
        </p>

        {/* Existing triggers */}
        {triggers.length > 0 && (
          <div style={{ display: 'grid', gap: '8px', marginBottom: '14px' }}>
            {triggers.map((t) => (
              <div
                key={t.id}
                className="tool-row"
                style={{
                  padding: '10px 12px',
                  opacity: t.enabled ? 1 : 0.5,
                  transition: 'opacity 0.15s',
                }}
              >
                {editingId === t.id ? (
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                      <input
                        type="text"
                        value={editKeyword}
                        onChange={(e) => setEditKeyword(e.target.value)}
                        placeholder="Keyword"
                        style={{ flex: '0 0 200px' }}
                      />
                      <button className="btn-sm" onClick={handleSaveEdit} disabled={saving}>
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button className="btn-ghost btn-sm" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                    <textarea
                      value={editContext}
                      onChange={(e) => setEditContext(e.target.value)}
                      placeholder="Context to inject..."
                      maxLength={2000}
                      rows={3}
                      style={{ width: '100%', resize: 'vertical' }}
                    />
                  </div>
                ) : (
                  <>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 600, fontSize: '13px' }}>"{t.keyword}"</span>
                      </div>
                      <div style={{
                        fontSize: '12px',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: '80px',
                        overflow: 'hidden',
                      }}>
                        {t.context}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={() => startEdit(t)}
                        style={{ fontSize: '12px' }}
                      >
                        Edit
                      </button>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={t.enabled}
                          onChange={() => handleToggleTrigger(t.id, t.enabled)}
                        />
                        <span className="toggle-track" />
                        <span className="toggle-thumb" />
                      </label>
                      <button
                        onClick={() => handleDeleteTrigger(t.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '4px',
                          color: 'var(--red)',
                          opacity: 0.5,
                          transition: 'opacity 0.15s',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
                      >
                        &#x2715;
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {/* New trigger form */}
        <div style={{
          padding: '12px',
          border: '1px solid var(--separator)',
          borderRadius: '8px',
          background: 'rgba(255,255,255,0.02)',
        }}>
          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>
            New Trigger
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <input
              type="text"
              placeholder="Keyword (min 2 chars)"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              maxLength={100}
              style={{ flex: '0 0 200px' }}
            />
          </div>
          <textarea
            placeholder="Context to inject when keyword is detected..."
            value={newContext}
            onChange={(e) => setNewContext(e.target.value)}
            maxLength={2000}
            rows={3}
            style={{ width: '100%', resize: 'vertical', marginBottom: '8px' }}
          />
          <button
            className="btn-sm"
            onClick={handleAddTrigger}
            disabled={saving || newKeyword.trim().length < 2 || newContext.trim().length < 1}
          >
            {saving ? 'Adding...' : 'Add Trigger'}
          </button>
        </div>
      </div>
    </div>
  );
}
