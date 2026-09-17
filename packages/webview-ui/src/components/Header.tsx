import type { ChatState } from '../hooks/useChat.js';
import type { FromWebview, SessionConfigOption } from '@dsh-vscode/core';
import { configChoiceGroups } from '@dsh-vscode/core';
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

/** Compact token count: 15346 -> "15.3k", 1000000 -> "1M". */
function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
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

/** Title for a config option, preferring a localised name for the known ones. */
function configOptionLabel(option: SessionConfigOption, t: T): string {
  if (option.id === 'model') {
    return t('model');
  }
  if (option.category === 'thought_level' || option.id.includes('reasoning')) {
    return t('reasoningEffort');
  }
  return option.name;
}

interface HeaderProps {
  state: ChatState;
  send: (message: FromWebview) => void;
}

export function Header({ state, send }: HeaderProps) {
  const t = useT();
  const { init, history, canLoadSession, modes, modeId, configOptions, usage, authMethods, status } = state;
  const hasUsage = usage !== undefined && usage.size > 0;
  const usedShare = hasUsage ? Math.min(1, usage.used / usage.size) : 0;

  return (
    <header className="header">
      <div className="header-title" title={`DeepSeek Harness${init ? ` v${init.extensionVersion}` : ''}`}>
        <span className={`header-dot status-${status}`} aria-hidden />
        <span>DeepSeek Harness</span>
      </div>
      <div className="header-actions">
        {modes.length > 0 && (
          <select
            className="header-select"
            value={modeId ?? modes[0]?.id ?? ''}
            onChange={(event) => send({ type: 'setMode', modeId: event.target.value })}
            aria-label={t('agentMode')}
          >
            {modes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </select>
        )}
        {/*
          The kernel exposes its pickers as session configuration options rather
          than ACP modes, which is why the model and reasoning level live here.
          Values are opaque strings echoed back untouched.
        */}
        {configOptions.map((option) => (
          <select
            key={option.id}
            className="header-select"
            value={option.currentValue}
            title={configOptionLabel(option, t)}
            aria-label={configOptionLabel(option, t)}
            onChange={(event) =>
              send({ type: 'setConfigOption', optionId: option.id, value: event.target.value })
            }
          >
            {configChoiceGroups(option.options).map((group, index) => {
              const values = group.values.map((value) => (
                <option key={value.value} value={value.value} title={value.description}>
                  {value.name}
                </option>
              ));
              return group.label ? (
                <optgroup key={`${group.label}-${index}`} label={group.label}>
                  {values}
                </optgroup>
              ) : (
                values
              );
            })}
          </select>
        ))}
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
        {hasUsage && (
          <span
            className="usage-meter"
            title={t('contextUsageDetail', {
              used: usage.used.toLocaleString(),
              size: usage.size.toLocaleString(),
            })}
          >
            <i className="codicon codicon-pie-chart" aria-hidden />
            <span className="usage-text">
              {formatTokens(usage.used)} / {formatTokens(usage.size)}
            </span>
            <span className="usage-bar" aria-hidden>
              <span className="usage-bar-fill" style={{ width: `${Math.round(usedShare * 100)}%` }} />
            </span>
          </span>
        )}
        {canLoadSession && history.length > 0 && (
          <select
            className="header-select"
            value=""
            onChange={(event) => {
              const sessionId = event.target.value;
              if (sessionId) {
                send({ type: 'loadSession', sessionId });
              }
            }}
            aria-label={t('history')}
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
