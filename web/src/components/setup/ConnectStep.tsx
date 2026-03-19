import { useState, lazy, Suspense, useEffect } from 'react';
import type { StepProps } from '../../pages/Setup';
import { useSetup } from './SetupContext';

const Lottie = lazy(() => import('lottie-react'));
const runAnimation = () => import('../../assets/run.json').then((m) => m.default);

function LottiePlayer({ loader, size }: { loader: () => Promise<object>; size: number }) {
  const [data, setData] = useState<object | null>(null);
  useEffect(() => { loader().then(setData); }, []);
  if (!data) return <div style={{ width: size, height: size, margin: '0 auto 16px' }} />;
  return (
    <Suspense fallback={<div style={{ width: size, height: size, margin: '0 auto 16px' }} />}>
      <Lottie animationData={data} loop style={{ width: size, height: size, margin: '0 auto 16px' }} />
    </Suspense>
  );
}

export function ConnectStep({ data: _data, onChange: _onChange }: StepProps) {
  const { saved, loading, error, launching, launchError, handleSave, handleLaunch } = useSetup();

  return (
    <div className="step-content">
      <h2 className="step-title">Start Your Agent</h2>
      <p className="step-description">
        Everything is configured. Save your config and launch Teleclaw Agent.
      </p>

      <div className="text-center" style={{ padding: '20px 0' }}>
        <LottiePlayer loader={runAnimation} size={200} />

        {!saved ? (
          <>
            <button
              onClick={handleSave}
              disabled={loading}
              type="button"
              className="btn-lg"
            >
              {loading ? <><span className="spinner sm" /> Saving...</> : '💾 Save Configuration'}
            </button>
            {error && <div className="alert error" style={{ marginTop: '16px' }}>{error}</div>}
          </>
        ) : (
          <>
            <div className="alert success" style={{ marginBottom: '16px' }}>
              ✅ Configuration saved successfully
            </div>
            <button
              onClick={handleLaunch}
              disabled={launching}
              type="button"
              className="btn-lg"
            >
              {launching ? <><span className="spinner sm" /> Starting...</> : '🚀 Start Agent'}
            </button>
            {launchError && <div className="alert error" style={{ marginTop: '16px' }}>{launchError}</div>}
          </>
        )}
      </div>
    </div>
  );
}
