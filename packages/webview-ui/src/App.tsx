import { useCallback } from 'react';
import { useChat } from './hooks/useChat.js';
import { langFromLocale, StringsProvider } from './strings.js';
import { ToastProvider } from './components/Toast.js';
import { Header } from './components/Header.js';
import { MessageList } from './components/MessageList.js';
import { WorkingSetBar } from './components/WorkingSetBar.js';
import { Composer } from './components/Composer.js';

export function App() {
  const { state, send, submitPrompt, removeChip, busy, draft, setDraft } = useChat();
  const lang = langFromLocale(state.init?.language);
  // Stable so the memoised list is not invalidated by a fresh closure each
  // render of App.
  const handleEdit = useCallback((text: string) => setDraft(text), [setDraft]);
  const handleCancel = useCallback(() => send({ type: 'cancel' }), [send]);
  const handlePickFile = useCallback(() => send({ type: 'openFilePicker' }), [send]);

  return (
    <StringsProvider lang={lang}>
      <ToastProvider>
        <div className="app" role="main" aria-label={lang === 'zh' ? 'DeepSeek Harness 对话面板' : 'DeepSeek Harness chat panel'}>
          <Header state={state} send={send} />
          <main className="app-body">
            <MessageList
              entries={state.entries}
              status={state.status}
              send={send}
              onEdit={handleEdit}
            />
          </main>
          <footer className="app-footer">
            <WorkingSetBar workingSet={state.workingSet} send={send} />
            <Composer
              status={state.status}
              statusDetail={state.statusDetail}
              chips={state.chips}
              commands={state.availableCommands}
              busy={busy}
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submitPrompt}
              onCancel={handleCancel}
              onRemoveChip={removeChip}
              onPickFile={handlePickFile}
              configOptions={state.configOptions}
              usage={state.usage}
              modes={state.modes}
              modeId={state.modeId}
            />
          </footer>
        </div>
      </ToastProvider>
    </StringsProvider>
  );
}
