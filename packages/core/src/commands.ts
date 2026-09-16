/**
 * Slash commands understood by the DeepSeek Harness kernel. They are forwarded
 * verbatim as prompt text; the kernel interprets them. This list is always
 * offered in the composer menu and is merged with commands announced by the
 * agent via `available_commands_update`.
 */
import type { SlashCommandInfo } from './chat.ts';

export const BUILT_IN_COMMANDS: readonly SlashCommandInfo[] = [
  { name: '/init', description: 'Scan the project and generate AGENTS.md context' },
  { name: '/compact', description: 'Compact the conversation context to free tokens' },
  { name: '/login', description: 'Sign in or configure provider credentials' },
  { name: '/help', description: 'Show harness help' },
] as const;

/** Merges built-in commands with kernel-announced ones, deduplicated by name. */
export function mergeCommands(kernelCommands: readonly SlashCommandInfo[]): SlashCommandInfo[] {
  const byName = new Map<string, SlashCommandInfo>();
  for (const command of BUILT_IN_COMMANDS) {
    byName.set(command.name, { ...command });
  }
  for (const command of kernelCommands) {
    if (command?.name) {
      byName.set(command.name, { ...command });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
