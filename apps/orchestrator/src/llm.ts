import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { Provider } from '@hivemind/shared';
import { providerRepo } from './repos.js';

// 单次回复内最多允许的 step 数（每个工具调用回合算一步），防 DeepSeek 死循环
const DEFAULT_MAX_STEPS = 12;

export async function createLlmModel(provider: Provider, modelName: string): Promise<LanguageModel> {
  const apiKey = await providerRepo.getApiKey(provider.id);
  if (!apiKey) throw new Error(`Provider ${provider.id} 缺少 API key（未在 keytar 中找到）`);

  if (provider.kind === 'openai-compatible') {
    const client = createOpenAICompatible({
      name: provider.name,
      baseURL: provider.baseUrl ?? 'https://api.openai.com/v1',
      apiKey,
    });
    return client(modelName);
  }

  // 'anthropic-direct' 暂未实现，Phase 0' 用不到
  throw new Error(`Provider kind ${provider.kind} 暂未实现`);
}

export async function generateReply(
  model: LanguageModel,
  systemPrompt: string,
  history: ModelMessage[],
  userText: string,
  options?: { temperature?: number }
): Promise<{ text: string; usage: unknown }> {
  const messages: ModelMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userText },
  ];
  const { text, usage } = await generateText({
    model,
    messages,
    temperature: options?.temperature,
  });
  return { text, usage };
}

/** 本地工具一次调用的观测（供可观测性埋点）。input/output 为模型/工具原始值，由调用方负责脱敏截断。 */
export interface ToolResultObservation {
  toolName: string;
  input: unknown;
  output: unknown;
}

/**
 * 带工具的多步回复：DeepSeek 在一次 generateText 内自行决定调用哪些工具、调几轮，
 * 直到产出最终文本或达到 maxSteps。中间的 tool 调用不写入会话历史（保持历史干净、
 * 避免 tool 消息配对约束），调用者只需把 user 文本和最终 assistant 文本入历史。
 *
 * 可观测性：传入 onToolResult 时，用 onStepFinish 在每步结束后把该步所有工具调用（含入参/出参）
 * 逐一回调出去（AI SDK v5 的 toolResults 每项已含 toolName/input/output）。本函数保持通用——
 * 不引入 recorder/脱敏/工具策略知识，由调用方在回调里落库。回调异常被隔离，绝不影响回复生成。
 */
export async function generateAgentReply(params: {
  model: LanguageModel;
  systemPrompt: string;
  history: ModelMessage[];
  userText: string;
  tools: ToolSet;
  temperature?: number;
  maxSteps?: number;
  // 透传给每个工具 execute 的上下文（如 delegate_to_claude 需要的 Discord 频道/requester/abort）
  experimentalContext?: unknown;
  // 每个工具调用结束后的观测回调（用于埋点；同步、best-effort）
  onToolResult?: (r: ToolResultObservation) => void;
  // 上层中止信号：bot 停机时中断整个工具循环（否则 generateText 会跑完才返回）
  abortSignal?: AbortSignal;
}): Promise<{ text: string; usage: unknown; toolCallCount: number; finishReason: string }> {
  const messages: ModelMessage[] = [
    { role: 'system', content: params.systemPrompt },
    ...params.history,
    { role: 'user', content: params.userText },
  ];

  const onToolResult = params.onToolResult;
  const hasTools = Object.keys(params.tools).length > 0;
  const result = await generateText({
    model: params.model,
    messages,
    temperature: params.temperature,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(params.experimentalContext !== undefined
      ? { experimental_context: params.experimentalContext }
      : {}),
    ...(hasTools
      ? { tools: params.tools, stopWhen: stepCountIs(params.maxSteps ?? DEFAULT_MAX_STEPS) }
      : {}),
    ...(onToolResult
      ? {
          onStepFinish: (step) => {
            for (const tr of step.toolResults) {
              try {
                onToolResult({ toolName: tr.toolName, input: tr.input, output: tr.output });
              } catch (e) {
                console.error('[llm] onToolResult 回调异常（已隔离，不影响回复）:', e);
              }
            }
            // tool-error（入参 schema 校验失败 / execute 抛异常）只进 step.content、不进 toolResults，
            // 必须单独补记，否则这类工具调用会被静默漏记（与「全量追踪」冲突）。output 以「错误：」开头
            // 便于调用方按约定标为 error 状态。
            for (const part of step.content) {
              if (part.type !== 'tool-error') continue;
              try {
                onToolResult({
                  toolName: part.toolName,
                  input: part.input,
                  output: `错误：[tool-error] ${String(part.error ?? 'unknown')}`,
                });
              } catch (e) {
                console.error('[llm] onToolResult(tool-error) 回调异常（已隔离）:', e);
              }
            }
          },
        }
      : {}),
  });

  const toolCallCount = result.steps.reduce((n, s) => n + s.toolCalls.length, 0);
  return {
    text: result.text,
    usage: result.totalUsage,
    toolCallCount,
    finishReason: result.finishReason,
  };
}
