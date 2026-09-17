/**
 * The session's own controls: model, reasoning level, and how much of the
 * context window is in use.
 *
 * They sit under the composer rather than in the header. The chat panel lives in
 * a narrow side bar, so a header that also had to hold them either wrapped the
 * title away or clipped them; below the input there is a full-width row to spare.
 *
 * `configOptions` is what the kernel actually offers - it has no ACP modes, and
 * its model picker arrives as a config option whose values are opaque strings
 * (a model value is JSON text), echoed back untouched.
 */
import type { FromWebview, SessionConfigOption } from '@dsh-vscode/core';
import { configChoiceGroups } from '@dsh-vscode/core';
import { useT, type T } from '../strings.js';

export interface SessionControlsProps {
  configOptions: SessionConfigOption[];
  usage?: { used: number; size: number };
  /** ACP modes, for a kernel that has them. dsh does not. */
  modes?: Array<{ id: string; name: string }>;
  modeId?: string;
  send: (message: FromWebview) => void;
}

/** Compact token count: 15346 -> "15.3k", 1000000 -> "1M". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

/** Title for a config option, preferring a localised name for the known ones. */
export function configOptionLabel(option: SessionConfigOption, t: T): string {
  if (option.id === 'model' || option.category === 'model') {
    return t('model');
  }
  if (option.category === 'thought_level' || option.id.includes('reasoning')) {
    return t('reasoningEffort');
  }
  return option.name;
}

/** Icon for a config option, so the control is identifiable at a glance. */
function configOptionIcon(option: SessionConfigOption): string {
  if (option.id === 'model' || option.category === 'model') {
    return 'codicon-hubot';
  }
  if (option.category === 'thought_level' || option.id.includes('reasoning')) {
    return 'codicon-lightbulb';
  }
  return 'codicon-settings-gear';
}

export function SessionControls({ configOptions, usage, modes = [], modeId, send }: SessionControlsProps) {
  const t = useT();
  const hasUsage = usage !== undefined && usage.size > 0;
  if (configOptions.length === 0 && modes.length === 0 && !hasUsage) {
    return null;
  }
  const usedShare = hasUsage ? Math.min(1, usage.used / usage.size) : 0;

  return (
    <div className="composer-meta">
      {modes.length > 0 && (
        <label className="toolbar-field" title={t('agentMode')}>
          <i className="codicon codicon-settings-gear" aria-hidden />
          <select
            className="header-select"
            value={modeId ?? modes[0]?.id ?? ''}
            aria-label={t('agentMode')}
            onChange={(event) => send({ type: 'setMode', modeId: event.target.value })}
          >
            {modes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {configOptions.map((option) => (
        <label key={option.id} className="toolbar-field" title={configOptionLabel(option, t)}>
          <i className={`codicon ${configOptionIcon(option)}`} aria-hidden />
          <select
            className="header-select"
            value={option.currentValue}
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
        </label>
      ))}
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
    </div>
  );
}
