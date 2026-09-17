import type { ChatState } from '../hooks/useChat.js';
import type { FromWebview } from '@dsh-vscode/core';
import { useT, type T } from '../strings.js';

function relativeTime(updatedAt: number, t: T): string {
  const delta = Date.now() - updatedAt;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) {
    return t('relNow');
  }
  if (minutes < 60) {
    return t('relMin', { n: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('relHour', { n: hours });
  }
  return t('relDay', { n: Math.floor(hours / 24) });
}

/** Currency symbol for the balance chip; the API reports a currency code. */
function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY':
      return '¥';
    case 'USD':
      return '$';
    default:
      return '';
  }
}


interface HeaderProps {
  state: ChatState;
  send: (message: FromWebview) => void;
}

export function Header({ state, send }: HeaderProps) {
  const t = useT();
  const { init, history, canLoadSession, authMethods, status } = state;

  return (
    <header className="header">
      <div className="header-title" title={`DeepSeek Harness${init ? ` v${init.extensionVersion}` : ''}`}>
        <span className={`header-dot status-${status}`} aria-hidden />
        <span>DeepSeek Harness</span>
      </div>
      <div className="header-actions">
        {state.balance && (
          <span
            className="balance-chip"
            title={t('balanceDetail', {
              total: `${currencySymbol(state.balance.currency)}${state.balance.totalBalance}`,
              granted: state.balance.grantedBalance,
              toppedUp: state.balance.toppedUpBalance,
            })}
          >
            <i className="codicon codicon-credit-card" aria-hidden />
            <span className="usage-text">
              {currencySymbol(state.balance.currency)}
              {state.balance.totalBalance}
            </span>
          </span>
        )}
        {canLoadSession && history.length > 0 && (
          <select
            className="header-select"
            value=""
            title={t('history')}
            aria-label={t('history')}
            onChange={(event) => {
              const sessionId = event.target.value;
              if (sessionId) {
                send({ type: 'loadSession', sessionId });
              }
            }}
          >
            <option value="">{t('history')}</option>
            {history.map((meta) => (
              <option key={meta.sessionId} value={meta.sessionId}>
                {`${meta.title} · ${relativeTime(meta.updatedAt, t)}`}
              </option>
            ))}
          </select>
        )}
        <button className="icon-button" title={t('newChat')} onClick={() => send({ type: 'newChat' })}>
          <i className="codicon codicon-add" />
        </button>
        <div className="header-menu">
          <button className="icon-button" title={t('moreActions')}>
            <i className="codicon codicon-kebab-vertical" />
          </button>
          <div className="header-menu-list">
            <button onClick={() => send({ type: 'hostCommand', command: 'exportChat' })}>
              <i className="codicon codicon-export" /> {t('exportChat')}
            </button>
            <button onClick={() => send({ type: 'hostCommand', command: 'renameSession' })}>
              <i className="codicon codicon-edit" /> {t('renameSession')}
            </button>
            <button onClick={() => send({ type: 'hostCommand', command: 'deleteSession' })}>
              <i className="codicon codicon-trash" /> {t('deleteSession')}
            </button>
            <button onClick={() => send({ type: 'hostCommand', command: 'gitCommitMessage' })}>
              <i className="codicon codicon-git-commit" /> {t('gitCommit')}
            </button>
          </div>
        </div>
        <button className="icon-button" title={t('settings')} onClick={() => send({ type: 'openSettings' })}>
          <i className="codicon codicon-settings-gear" />
        </button>
      </div>
      {state.init?.hasApiKey === false && (
        <div className="retry-banner info">
          <i className="codicon codicon-key" />
          <span>{t('needApiKey')}</span>
          <button className="link-button" onClick={() => send({ type: 'openSettings' })}>
            {t('setApiKey')}
          </button>
        </div>
      )}
      {(state.status === 'error' || state.status === 'disconnected') && state.entries.length > 0 && (
        <div className="retry-banner">
          <i className="codicon codicon-plug" />
          <span>{t('connectionLost')}</span>
          <button className="link-button" onClick={() => send({ type: 'reconnect' })}>
            {t('retryConnection')}
          </button>
        </div>
      )}
      {authMethods.length > 0 && state.status === 'disconnected' && (
        <div className="auth-banner">
          <span>{t('signInRequired')}</span>
          {authMethods.map((method) => (
            <button
              key={method.id}
              className="link-button"
              onClick={() => send({ type: 'authenticate', methodId: method.id })}
            >
              {method.name ?? t('signIn')}
            </button>
          ))}
        </div>
      )}
    </header>
  );
}
