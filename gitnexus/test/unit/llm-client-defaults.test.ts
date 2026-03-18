import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repo-manager to avoid file system access
vi.mock('../../src/storage/repo-manager.js', () => ({
  loadCLIConfig: vi.fn().mockResolvedValue({}),
}));

describe('LLM client defaults', () => {
  beforeEach(() => {
    // Clear relevant env vars so defaults are used
    delete process.env.GITNEXUS_MODEL;
    delete process.env.GITNEXUS_API_KEY;
    delete process.env.GITNEXUS_LLM_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  it('uses MiniMax-M2.7 as default model', async () => {
    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    const config = await resolveLLMConfig();
    expect(config.model).toBe('minimax/minimax-m2.7');
  });

  it('uses OpenRouter as default base URL', async () => {
    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    const config = await resolveLLMConfig();
    expect(config.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('allows model override via parameter', async () => {
    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    const config = await resolveLLMConfig({ model: 'minimax/minimax-m2.7-highspeed' });
    expect(config.model).toBe('minimax/minimax-m2.7-highspeed');
  });

  it('allows model override via env var', async () => {
    process.env.GITNEXUS_MODEL = 'minimax/minimax-m2.5';
    const { resolveLLMConfig } = await import('../../src/core/wiki/llm-client.js');
    const config = await resolveLLMConfig();
    expect(config.model).toBe('minimax/minimax-m2.5');
    delete process.env.GITNEXUS_MODEL;
  });
});
