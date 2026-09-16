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
              onEdit={(text) => setDraft(text)}
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
              onCancel={() => send({ type: 'cancel' })}
              onRemoveChip={removeChip}
              onPickFile={() => send({ type: 'openFilePicker' })}
            />
          </footer>
        </div>
      </ToastProvider>
    </StringsProvider>
  );
}
