/**
 * Unit tests for MiniMax LLM provider integration.
 *
 * Covers:
 * - Type definitions and config shapes
 * - Chat model factory (createChatModel)
 * - Settings service (load/save/update/getActive/displayName/models)
 * - Temperature clamping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Type tests ----

import type {
  LLMProvider,
  MiniMaxConfig,
  ProviderConfig,
  LLMSettings,
} from '../types';
import { DEFAULT_LLM_SETTINGS } from '../types';

describe('MiniMax types', () => {
  it('LLMProvider union includes minimax', () => {
    const provider: LLMProvider = 'minimax';
    expect(provider).toBe('minimax');
  });

  it('MiniMaxConfig satisfies ProviderConfig', () => {
    const config: ProviderConfig = {
      provider: 'minimax',
      apiKey: 'test-key',
      model: 'MiniMax-M2.7',
      temperature: 0.1,
    };
    expect(config.provider).toBe('minimax');
  });

  it('DEFAULT_LLM_SETTINGS includes minimax defaults', () => {
    expect(DEFAULT_LLM_SETTINGS.minimax).toBeDefined();
    expect(DEFAULT_LLM_SETTINGS.minimax!.model).toBe('MiniMax-M2.7');
    expect(DEFAULT_LLM_SETTINGS.minimax!.temperature).toBe(0.1);
    expect(DEFAULT_LLM_SETTINGS.minimax!.apiKey).toBe('');
  });

  it('LLMSettings accepts minimax field', () => {
    const settings: LLMSettings = {
      ...DEFAULT_LLM_SETTINGS,
      activeProvider: 'minimax',
      minimax: { apiKey: 'k', model: 'MiniMax-M2.5' },
    };
    expect(settings.minimax?.model).toBe('MiniMax-M2.5');
  });
});

// ---- createChatModel tests ----

// vi.hoisted lets us define variables that are available inside hoisted vi.mock factories
const { ChatOpenAIMock } = vi.hoisted(() => {
  const ChatOpenAIMock = vi.fn(function (this: any, opts: any) {
    Object.assign(this, { _type: 'ChatOpenAI', ...opts });
  });
  return { ChatOpenAIMock };
});

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: ChatOpenAIMock,
  AzureChatOpenAI: vi.fn(function (this: any, opts: any) {
    Object.assign(this, { _type: 'AzureChatOpenAI', ...opts });
  }),
}));

vi.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: vi.fn(function (this: any, opts: any) {
    Object.assign(this, { _type: 'ChatGoogleGenerativeAI', ...opts });
  }),
}));

vi.mock('@langchain/anthropic', () => ({
  ChatAnthropic: vi.fn(function (this: any, opts: any) {
    Object.assign(this, { _type: 'ChatAnthropic', ...opts });
  }),
}));

vi.mock('@langchain/ollama', () => ({
  ChatOllama: vi.fn(function (this: any, opts: any) {
    Object.assign(this, { _type: 'ChatOllama', ...opts });
  }),
}));

vi.mock('@langchain/langgraph/prebuilt', () => ({
  createReactAgent: vi.fn(),
}));

vi.mock('@langchain/core/messages', () => ({
  SystemMessage: vi.fn(),
}));

vi.mock('../tools', () => ({
  createGraphRAGTools: vi.fn().mockReturnValue([]),
}));

vi.mock('../context-builder', () => ({
  buildDynamicSystemPrompt: vi.fn().mockReturnValue('test prompt'),
}));

import { createChatModel } from '../agent';

describe('createChatModel — minimax', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a ChatOpenAI instance with MiniMax base URL', () => {
    const config: MiniMaxConfig = {
      provider: 'minimax',
      apiKey: 'test-minimax-key',
      model: 'MiniMax-M2.7',
      temperature: 0.5,
    };

    createChatModel(config);

    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-minimax-key',
        modelName: 'MiniMax-M2.7',
        temperature: 0.5,
        streaming: true,
        configuration: expect.objectContaining({
          apiKey: 'test-minimax-key',
          baseURL: 'https://api.minimax.io/v1',
        }),
      })
    );
  });

  it('clamps temperature to minimum 0.01', () => {
    const config: MiniMaxConfig = {
      provider: 'minimax',
      apiKey: 'key',
      model: 'MiniMax-M2.7',
      temperature: 0,
    };

    createChatModel(config);

    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.01,
      })
    );
  });

  it('clamps temperature to maximum 1.0', () => {
    const config: MiniMaxConfig = {
      provider: 'minimax',
      apiKey: 'key',
      model: 'MiniMax-M2.7',
      temperature: 2.0,
    };

    createChatModel(config);

    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 1.0,
      })
    );
  });

  it('uses default temperature 0.1 when not specified', () => {
    const config: MiniMaxConfig = {
      provider: 'minimax',
      apiKey: 'key',
      model: 'MiniMax-M2.7',
    };

    createChatModel(config);

    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0.1,
      })
    );
  });

  it('throws when API key is missing', () => {
    const config: MiniMaxConfig = {
      provider: 'minimax',
      apiKey: '',
      model: 'MiniMax-M2.7',
    };

    expect(() => createChatModel(config)).toThrow(
      'MiniMax API key is required but was not provided'
    );
  });

  it('throws when API key is whitespace', () => {
    const config: MiniMaxConfig = {
      provider: 'minimax',
      apiKey: '   ',
      model: 'MiniMax-M2.7',
    };

    expect(() => createChatModel(config)).toThrow(
      'MiniMax API key is required but was not provided'
    );
  });

  it('passes maxTokens when provided', () => {
    const config: MiniMaxConfig = {
      provider: 'minimax',
      apiKey: 'key',
      model: 'MiniMax-M2.5',
      maxTokens: 4096,
    };

    createChatModel(config);

    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 4096,
        modelName: 'MiniMax-M2.5',
      })
    );
  });
});

// ---- Settings service tests ----

// Mock localStorage for settings tests
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

import {
  loadSettings,
  saveSettings,
  getActiveProviderConfig,
  getProviderDisplayName,
  getAvailableModels,
} from '../settings-service';

describe('settings-service — minimax', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('loadSettings returns minimax defaults when no stored settings', () => {
    const settings = loadSettings();
    expect(settings.minimax).toBeDefined();
    expect(settings.minimax!.model).toBe('MiniMax-M2.7');
  });

  it('loadSettings merges stored minimax settings with defaults', () => {
    localStorageMock.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'minimax',
        minimax: { apiKey: 'stored-key' },
      })
    );

    const settings = loadSettings();
    expect(settings.minimax!.apiKey).toBe('stored-key');
    expect(settings.minimax!.model).toBe('MiniMax-M2.7'); // from defaults
  });

  it('getActiveProviderConfig returns MiniMaxConfig when configured', () => {
    const settings: LLMSettings = {
      ...DEFAULT_LLM_SETTINGS,
      activeProvider: 'minimax',
      minimax: { apiKey: 'my-key', model: 'MiniMax-M2.5' },
    };
    saveSettings(settings);

    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('minimax');
    expect((config as MiniMaxConfig).apiKey).toBe('my-key');
    expect((config as MiniMaxConfig).model).toBe('MiniMax-M2.5');
  });

  it('getActiveProviderConfig returns null when minimax API key is missing', () => {
    const settings: LLMSettings = {
      ...DEFAULT_LLM_SETTINGS,
      activeProvider: 'minimax',
      minimax: { apiKey: '', model: 'MiniMax-M2.7' },
    };
    saveSettings(settings);

    const config = getActiveProviderConfig();
    expect(config).toBeNull();
  });

  it('getActiveProviderConfig returns null when minimax API key is whitespace', () => {
    const settings: LLMSettings = {
      ...DEFAULT_LLM_SETTINGS,
      activeProvider: 'minimax',
      minimax: { apiKey: '  ', model: 'MiniMax-M2.7' },
    };
    saveSettings(settings);

    const config = getActiveProviderConfig();
    expect(config).toBeNull();
  });

  it('getActiveProviderConfig defaults model to MiniMax-M2.7', () => {
    const settings: LLMSettings = {
      ...DEFAULT_LLM_SETTINGS,
      activeProvider: 'minimax',
      minimax: { apiKey: 'key' },
    };
    saveSettings(settings);

    const config = getActiveProviderConfig() as MiniMaxConfig;
    expect(config.model).toBe('MiniMax-M2.7');
  });

  it('getProviderDisplayName returns MiniMax', () => {
    expect(getProviderDisplayName('minimax')).toBe('MiniMax');
  });

  it('getAvailableModels returns MiniMax models', () => {
    const models = getAvailableModels('minimax');
    expect(models).toContain('MiniMax-M2.7');
    expect(models).toContain('MiniMax-M2.5');
    expect(models).toContain('MiniMax-M2.5-highspeed');
    expect(models.length).toBe(3);
  });
});

// ---- Integration-style tests ----

describe('MiniMax integration', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('round-trips minimax settings through save/load', () => {
    const settings: LLMSettings = {
      ...DEFAULT_LLM_SETTINGS,
      activeProvider: 'minimax',
      minimax: {
        apiKey: 'integration-key',
        model: 'MiniMax-M2.5-highspeed',
        temperature: 0.7,
      },
    };

    saveSettings(settings);
    const loaded = loadSettings();

    expect(loaded.activeProvider).toBe('minimax');
    expect(loaded.minimax!.apiKey).toBe('integration-key');
    expect(loaded.minimax!.model).toBe('MiniMax-M2.5-highspeed');
    expect(loaded.minimax!.temperature).toBe(0.7);
  });

  it('createChatModel works with config from getActiveProviderConfig', () => {
    const settings: LLMSettings = {
      ...DEFAULT_LLM_SETTINGS,
      activeProvider: 'minimax',
      minimax: {
        apiKey: 'e2e-key',
        model: 'MiniMax-M2.7',
        temperature: 0.3,
      },
    };
    saveSettings(settings);

    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();

    // Should not throw
    const model = createChatModel(config!);
    expect(model).toBeDefined();
    expect(ChatOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'e2e-key',
        modelName: 'MiniMax-M2.7',
        temperature: 0.3,
        configuration: expect.objectContaining({
          baseURL: 'https://api.minimax.io/v1',
        }),
      })
    );
  });

  it('all MiniMax models can be used with createChatModel', () => {
    const models = getAvailableModels('minimax');
    for (const model of models) {
      vi.clearAllMocks();
      const config: MiniMaxConfig = {
        provider: 'minimax',
        apiKey: 'key',
        model,
      };
      createChatModel(config);
      expect(ChatOpenAIMock).toHaveBeenCalledWith(
        expect.objectContaining({ modelName: model })
      );
    }
  });
});
