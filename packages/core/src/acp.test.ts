/**
 * The ACP surface the panel depends on. Everything here was read off the real
 * kernel: it advertises session *config options* (model, reasoning effort)
 * rather than ACP modes, and reports context occupancy as `usage_update`.
 */
import { describe, expect, it } from 'vitest';
import { normalizeConfigOptions, normalizeSessionUpdate } from './acp.ts';
import { configChoiceGroups } from './chat.ts';

describe('normalizeConfigOptions', () => {
  it('carries a model value verbatim, groups and all', () => {
    const options = normalizeConfigOptions([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: '["deepseek-official","deepseek-v4-flash"]',
        options: [
          {
            group: 'deepseek-official',
            name: 'DeepSeek',
            options: [{ value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' }],
          },
        ],
      },
    ]);

    expect(options).toHaveLength(1);
    // The value is opaque JSON text - parsing or rebuilding it would break the
    // kernel's own id space.
    expect(options[0]!.currentValue).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(configChoiceGroups(options[0]!.options)).toEqual([
      {
        label: 'DeepSeek',
        values: [
          {
            value: '["deepseek-official","deepseek-v4-pro"]',
            name: 'DeepSeek-V4-Pro',
            description: undefined,
          },
        ],
      },
    ]);
  });

  it('keeps a flat option list flat', () => {
    const options = normalizeConfigOptions([
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'max', name: 'Max', description: 'Most thorough.' },
        ],
      },
    ]);
    expect(configChoiceGroups(options[0]!.options)).toEqual([
      {
        values: [
          { value: 'off', name: 'Off', description: undefined },
          { value: 'max', name: 'Max', description: 'Most thorough.' },
        ],
      },
    ]);
  });

  it('puts ungrouped values before grouped ones', () => {
    const groups = configChoiceGroups([
      { group: 'g', name: 'Group', options: [{ value: 'b', name: 'B' }] },
      { value: 'a', name: 'A' },
    ]);
    expect(groups.map((group) => group.label)).toEqual([undefined, 'Group']);
  });

  it('ignores malformed options instead of throwing', () => {
    expect(normalizeConfigOptions(undefined)).toEqual([]);
    expect(normalizeConfigOptions([null, 'x', { name: 'no id' }])).toEqual([]);
    expect(normalizeConfigOptions([{ id: 'a', options: [null, { name: 'no value' }] }])).toEqual([
      {
        id: 'a',
        name: 'a',
        category: undefined,
        type: 'select',
        currentValue: '',
        options: [],
      },
    ]);
  });
});

describe('normalizeSessionUpdate', () => {
  it('reads context occupancy', () => {
    expect(normalizeSessionUpdate({ sessionUpdate: 'usage_update', used: 15346, size: 1000000 })).toEqual({
      sessionUpdate: 'usage',
      usage: { used: 15346, size: 1000000 },
    });
  });

  it('treats a config option update as the whole list', () => {
    const update = normalizeSessionUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'reasoning_effort',
          name: 'Reasoning effort',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'max', name: 'Max' }],
        },
      ],
    });
    expect(update.sessionUpdate).toBe('config_options');
    if (update.sessionUpdate === 'config_options') {
      expect(update.options[0]!.currentValue).toBe('high');
    }
  });
});
