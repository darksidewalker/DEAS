import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider, useI18n } from '../src/i18n/I18nProvider';
import { PromptForge } from '../src/features/forge/PromptForge';
import { Workbench, type WorkbenchProps } from '../src/features/studio/Workbench';
import type { ForgeCanvasContext, ForgeSendCanvas } from '../src/lib/forgeCanvas';
import '../src/styles.css';

/** Browser-only host: actual components, retained panes and App's typed Send boundary. */
function Fixture() {
  const { t } = useI18n();
  const [tab, setTab] = useState<'generate' | 'forge'>('forge');
  const [root, setRoot] = useState('/env');
  const [context, setContext] = useState<ForgeCanvasContext>();
  const [incoming, setIncoming] = useState<WorkbenchProps['incoming']>();
  const [sendError, setSendError] = useState('');
  const endpoint = 'http://127.0.0.1:7801';
  const roots = { models: `${root}/ComfyUI/models`, input: `${root}/ComfyUI/input`, output: `${root}/ComfyUI/output` };
  const send = (positive: string, negative: string, canvas?: ForgeSendCanvas) => {
    if (canvas && (!context || canvas.contextKey !== context.key || !context.acceptsCanvas?.(canvas.canvas))) {
      setSendError('forge.canvas.handoffBlocked'); return false;
    }
    setSendError('');
    setIncoming(previous => ({ positive, negative, n: (previous?.n ?? 0) + 1, ...(canvas ? { canvas } : {}) }));
    setTab('generate'); return true;
  };
  return <main style={{ padding: 12, minWidth: 0 }}>
    <nav aria-label="Fixture controls" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" data-fixture-tab="generate" aria-pressed={tab === 'generate'} onClick={() => setTab('generate')}>Studio</button>
      <button type="button" data-fixture-tab="forge" aria-pressed={tab === 'forge'} onClick={() => setTab('forge')}>Prompt Forge</button>
      <button type="button" data-fixture-context-change onClick={() => setRoot(value => value === '/env' ? '/env-next' : '/env')}>Change fixture context</button>
    </nav>
    {sendError && <p role="alert" data-fixture-send-error>{t(sendError)}</p>}
    <output hidden data-fixture-context>{JSON.stringify(context)}</output>
    <output hidden data-fixture-incoming>{JSON.stringify(incoming)}</output>
    <div data-fixture-studio hidden={tab !== 'generate'} style={{ display: tab === 'generate' ? 'block' : 'none' }}>
      <Workbench endpoint={endpoint} root={root} roots={roots} incoming={incoming} onCanvasContext={setContext}/>
    </div>
    <div data-fixture-forge hidden={tab !== 'forge'} style={{ display: tab === 'forge' ? 'block' : 'none' }}>
      <PromptForge endpoint={endpoint} root={root} inputDir={roots.input} outputDir={roots.output} canvasContext={context} onSend={send} active={tab === 'forge'}/>
    </div>
  </main>;
}

createRoot(document.getElementById('fixture-root')!).render(<I18nProvider><Fixture/></I18nProvider>);
