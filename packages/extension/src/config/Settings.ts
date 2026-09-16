/**
 * Typed access to the `dsh.*` configuration section and SecretStorage helpers.
 * API keys are never written to settings.json - only to SecretStorage.
 */
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'dsh';
export const API_KEY_SECRET = 'dsh.apiKey';

export interface DshSettings {
  readonly executablePath?: string;
  /** Pin a kernel version, e.g. `0.1.2-rc.1` - developer preview moves fast. */
  readonly preferredVersion: string;
  /** Arguments that start the ACP server, e.g. ["--profile", "acp"]. */
  readonly acpArgs: readonly string[];
  /** Profile used for ACP sessions; created on demand when missing. */
  readonly acpProfile: string;
  /** Kernel plugin that provides the ACP server; version-paired on install. */
  readonly acpPluginPackage: string;
  readonly model?: string;
  /** Overrides the dsh home directory (config.toml, sessions, credentials). */
  readonly homeDir?: string;
  /** Auto-approve read-only tool calls (read/search/think/fetch). */
  readonly autoApproveReadOnly: boolean;
  /** Attach the active editor selection automatically when sending. */
  readonly attachActiveSelection: boolean;
  /** Open the first pending diff automatically when a turn ends. */
  readonly autoOpenReview: boolean;
}

export function readSettings(): DshSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const executablePath = config.get<string>('executablePath');
  const model = config.get<string>('model');
  const homeDir = config.get<string>('homeDir');
  return {
    executablePath: executablePath?.trim() ? executablePath.trim() : undefined,
    preferredVersion: config.get<string>('preferredVersion') ?? '',
    acpArgs: config.get<string[]>('acpArgs') ?? ['--profile', 'acp'],
    acpProfile: config.get<string>('acpProfile')?.trim() || 'acp',
    acpPluginPackage: config.get<string>('acpPluginPackage')?.trim() || '@deepseek-ai/dsh-acp-app',
    model: model?.trim() ? model.trim() : undefined,
    homeDir: homeDir?.trim() ? homeDir.trim() : undefined,
    autoApproveReadOnly: config.get<boolean>('autoApproveReadOnly') ?? false,
    attachActiveSelection: config.get<boolean>('attachActiveSelection') ?? true,
    autoOpenReview: config.get<boolean>('autoOpenReview') ?? true,
  };
}

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const value = await secrets.get(API_KEY_SECRET);
  return value?.trim() ? value.trim() : undefined;
}

export async function setApiKey(secrets: vscode.SecretStorage, value: string): Promise<void> {
  await secrets.store(API_KEY_SECRET, value);
}
