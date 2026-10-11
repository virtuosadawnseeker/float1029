// lib/api-helpers.ts
// Unified API helpers — single source of truth for provider URL resolution,
// request headers, and response parsing. All LLM-calling modules should use these.

import type { ApiConfig } from "./settings-types";
import { pushApiLog } from "./api-log-store";

const SIMPLE_ANTHROPIC_AUTO_MAX_TOKENS = 8192;

/**
 * Resolve the base URL for an API config.
 * Priority: user-configured baseUrl > provider default.
 * Supports all 11 UI providers + Custom (relies on baseUrl field).
 */
export function determineBaseUrl(config: { provider: string; baseUrl?: string }): string {
    if (config.baseUrl) return config.baseUrl;
    switch (config.provider) {
        case "OpenAI":      return "https://api.openai.com/v1";
        case "Anthropic":   return "https://api.anthropic.com/v1";
        case "Google":      return "https://generativelanguage.googleapis.com/v1beta";
        case "DeepSeek":    return "https://api.deepseek.com/v1";
        case "Groq":        return "https://api.groq.com/openai/v1";
        case "OpenRouter":  return "https://openrouter.ai/api/v1";
        case "Moonshot":    return "https://api.moonshot.cn/v1";
        case "Zhipu":       return "https://open.bigmodel.cn/api/paas/v4";
        case "SiliconFlow": return "https://api.siliconflow.cn/v1";
        case "TogetherAI":  return "https://api.together.xyz/v1";
        case "Custom":      return ""; // must be set via baseUrl
        default:            return "";
    }
}

/**
 * Build the chat completions fetch URL for a given base URL.
 * Most providers use the OpenAI-compatible `/chat/completions` endpoint.
 * Google Gemini uses a different path, handled separately by callers.
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
    if (baseUrl.endsWith("/chat/completions")) return baseUrl;
    return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

/**
 * Build request headers for an API config.
 * Handles provider-specific headers (OpenRouter, Anthropic, etc.)
 * and custom proxy/relay sites that use standard Bearer auth.
 */
export function buildRequestHeaders(config: ApiConfig, baseUrl: string): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };

    if (config.provider === "Anthropic" && !config.baseUrl) {
        // Native Anthropic API uses x-api-key
        headers["x-api-key"] = config.apiKey;
        headers["anthropic-version"] = "2023-06-01";
    } else {
        // All others (including Anthropic via proxy/relay) use Bearer token
        headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    // OpenRouter requires referer headers
    if (baseUrl.includes("openrouter.ai")) {
        headers["HTTP-Referer"] = "https://aivirtualphone.local";
        headers["X-Title"] = "AI Virtual Phone";
    }

    return headers;
}

/**
 * Check if this provider uses the native Anthropic Messages API format
 * (not OpenAI-compatible chat/completions).
 * Only true for direct Anthropic API — proxies/relays that wrap Anthropic
 * behind OpenAI-compatible endpoints should use Custom provider + baseUrl.
 */
export function isNativeAnthropicApi(config: ApiConfig): boolean {
    return config.provider === "Anthropic" && !config.baseUrl;
}

/**
 * Check if this provider uses the native Google Gemini API format.
 * Only true for direct Google API — proxies that wrap Gemini behind
 * OpenAI-compatible endpoints should use Custom provider + baseUrl.
 */
export function isNativeGoogleApi(config: ApiConfig): boolean {
    // 之前要求 baseUrl 必须为空才认为是原生 Gemini，这导致中转站（如 dzzi.ai 暴露的 /v1beta 端点）
    // 没法被识别成原生 Gemini，只能走 OpenAI 兼容路径，进而 thoughtSignature 丢失、多轮工具调用失败。
    // 现在只要 provider=Google 就走原生 Gemini 协议；用户填的 baseUrl 由 determineBaseUrl 处理。
    return config.provider === "Google";
}

/**
 * Send a simple LLM request (single user message) and return the text response.
 * Used by summarizer, moments-engine, and other non-chat LLM calls.
 * Handles all provider formats automatically.
 */
export async function simpleLLMCall(
    config: ApiConfig,
    messages: { role: string; content: string }[],
    options?: { temperature?: number; max_tokens?: number; signal?: AbortSignal; label?: string; stream?: boolean },
): Promise<{ content: string | null; error?: string; finishReason?: string; wasTruncated?: boolean }> {
    const baseUrl = determineBaseUrl(config);
    if (!baseUrl || !config.apiKey) {
        return { content: null, error: "API 地址或密钥无效" };
    }

    const headers = buildRequestHeaders(config, baseUrl);
    const temperature = options?.temperature ?? 0.7;
    const max_tokens = options?.max_tokens;

    // 流式优先（调用方 opt-in）：带思考的模型非流式要等很久才返回第一个字节，
    // 中转站/Safari 常在这段静默期把连接掐断（表现为 "Load failed"）。
    // 流式失败时退回下面的非流式老路径，并把流式的失败原因带进错误信息。
    let streamError = "";
    if (options?.stream) {
        try {
            const streamed = await streamingLLMCall(config, messages, temperature, max_tokens, options.signal);
            const wasTruncated = isTruncationFinishReason(streamed.finishReason);
            // 模型被安全过滤中途掐断时，已吐出的正文只是半截；当成失败，不能当成完整结果入库。
            const stoppedBySafety = isSafetyFinishReason(streamed.finishReason);
            const finishNote = streamed.finishReason && !/^(stop|end_turn)$/i.test(streamed.finishReason)
                ? `\n[finishReason: ${streamed.finishReason}]`
                : "";
            pushApiLog({
                characterName: options.label,
                source: "background",
                model: config.defaultModel,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
                rawResponse: stoppedBySafety
                    ? `[被模型安全过滤中断，回复不完整]${finishNote}\n${streamed.content}`
                    : `${streamed.content}${finishNote}`,
                usage: streamed.usage,
            });
            if (stoppedBySafety) {
                return {
                    content: null,
                    error: `模型因安全过滤中途停止输出（${streamed.finishReason}），回复不完整，已取消入库。可换一个对内容更宽松的模型来做记忆总结`,
                    finishReason: streamed.finishReason,
                };
            }
            return { content: streamed.content, finishReason: streamed.finishReason, wasTruncated };
        } catch (err) {
            if (options.signal?.aborted) {
                return { content: null, error: "请求已取消" };
            }
            streamError = err instanceof Error ? err.message : String(err);
            console.warn("[simpleLLMCall] stream failed, falling back to non-stream:", err);
        }
    }
    const streamNote = streamError ? `（流式请求先失败：${streamError}；已退回非流式重试）` : "";

    try {
        let fetchUrl: string;
        let body: string;

        if (isNativeAnthropicApi(config)) {
            // Anthropic Messages API
            fetchUrl = `${baseUrl.replace(/\/$/, "")}/messages`;
            const anthropicMessages = messages
                .filter(m => m.role !== "system")
                .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
            const systemMsg = messages.find(m => m.role === "system");
            body = JSON.stringify({
                model: config.defaultModel,
                messages: anthropicMessages,
                ...(systemMsg ? { system: systemMsg.content } : {}),
                temperature,
                // Anthropic requires max_tokens. Keep this helper aligned with
                // the main chat engine instead of silently capping output low.
                max_tokens: max_tokens ?? SIMPLE_ANTHROPIC_AUTO_MAX_TOKENS,
            });
        } else if (isNativeGoogleApi(config)) {
            // Google Gemini API
            fetchUrl = `${baseUrl.replace(/\/$/, "")}/models/${config.defaultModel}:generateContent?key=${config.apiKey}`;
            // Remove Authorization header for Gemini (uses URL key)
            delete headers["Authorization"];
            const parts = messages.map(m => ({
                role: m.role === "assistant" ? "model" : "user",
                parts: [{ text: m.content }],
            }));
            body = JSON.stringify({
                contents: parts,
                generationConfig: {
                    temperature,
                    ...(max_tokens ? { maxOutputTokens: max_tokens } : {}),
                },
            });
        } else {
            // OpenAI-compatible (all others including proxies/relays/custom)
            fetchUrl = buildChatCompletionsUrl(baseUrl);
            body = JSON.stringify({
                model: config.defaultModel,
                messages,
                temperature,
                ...(max_tokens ? { max_tokens } : {}),
            });
        }

        const bodySize = body.length;
        const bodyTokenEstimate = Math.ceil(bodySize / 3);
        console.log("[simpleLLMCall] Request:", { url: fetchUrl.slice(0, 80), bodySize, bodyTokenEstimate, model: config.defaultModel });

        const res = await fetch(fetchUrl, { method: "POST", headers, body, signal: options?.signal });

        if (!res.ok) {
            const errText = await res.text().catch(() => "");
            console.warn("[simpleLLMCall] API error:", res.status, errText.slice(0, 300));
            pushApiLog({
                characterName: options?.label,
                source: "background",
                model: config.defaultModel,
                messages: messages.map(m => ({ role: m.role, content: m.content })),
                rawResponse: `[API 错误 ${res.status}] ${errText.slice(0, 2000)}${streamNote}`,
                status: res.status,
                isError: true,
            });
            return { content: null, error: `API 错误 ${res.status}: ${errText.slice(0, 200)}${streamNote}` };
        }

        const data = await res.json();

        // Extract content — try multiple response formats for maximum compatibility
        const content = extractLLMContent(data, config.provider);
        const finishReason = extractFinishReason(data);
        const wasTruncated = isTruncationFinishReason(finishReason);
        pushApiLog({
            characterName: options?.label,
            source: "background",
            model: config.defaultModel,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            rawResponse: content ?? describeEmptyLLMResponse(data, finishReason, wasTruncated, config),
            usage: extractUsage(data),
            ...(content ? {} : { isError: true }),
        });
        if (!content) {
            console.warn("[simpleLLMCall] Empty response. Keys:", JSON.stringify(Object.keys(data || {})),
                "Full:", JSON.stringify(data).slice(0, 500));
            return { content: null, error: describeEmptyLLMResponse(data, finishReason, wasTruncated, config), finishReason, wasTruncated };
        }

        return { content, finishReason, wasTruncated };
    } catch (err) {
        console.warn("[simpleLLMCall] fetch error:", err);
        pushApiLog({
            characterName: options?.label,
            source: "background",
            model: config.defaultModel,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            rawResponse: `[请求失败] ${err instanceof Error ? err.message : String(err)}${streamNote}`,
            isError: true,
        });
        return { content: null, error: `请求失败: ${err instanceof Error ? err.message : String(err)}${streamNote}` };
    }
}

/**
 * 流式版本的单轮 LLM 调用：复用聊天用的 buildProviderRequest / 流式解析，
 * 只把增量文本拼成完整回复返回。失败一律 throw，由 simpleLLMCall 决定是否退回非流式。
 */
async function streamingLLMCall(
    config: ApiConfig,
    messages: { role: string; content: string }[],
    temperature: number,
    maxTokens: number | undefined,
    signal?: AbortSignal,
): Promise<{ content: string; finishReason?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }> {
    // 动态引入：llm-provider-adapter 反过来依赖本文件，静态引入会形成循环依赖。
    const { buildProviderRequest, parseProviderStreamDelta } = await import("./llm-provider-adapter");
    const { fetchLlmPayload } = await import("./llm-http");

    const request = buildProviderRequest(
        config,
        null,
        messages.map(m => ({
            role: m.role === "system" || m.role === "assistant" ? m.role : "user",
            content: m.content,
        })) as Parameters<typeof buildProviderRequest>[2],
        { stream: true, ...(maxTokens ? { maxTokens } : {}) },
    );
    // 总结类调用要低温度，覆盖预设默认值
    if (request.providerKind === "gemini") {
        const gen = (request.body.generationConfig && typeof request.body.generationConfig === "object"
            ? request.body.generationConfig
            : {}) as Record<string, unknown>;
        request.body.generationConfig = { ...gen, temperature };
    } else {
        request.body.temperature = temperature;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 500_000);
    const onAbort = () => abort.abort();
    if (signal) {
        if (signal.aborted) abort.abort();
        else signal.addEventListener("abort", onAbort);
    }

    try {
        const response = await fetchLlmPayload(request, { signal: abort.signal });
        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`API 错误 ${response.status}: ${errText.slice(0, 200)}`);
        }
        if (!response.body) throw new Error("流式响应没有 body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let finishReason: string | undefined;
        let usage: ReturnType<typeof extractUsage>;

        const handleEvent = (eventText: string) => {
            for (const line of eventText.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;
                const dataLine = trimmed.slice(5).trim();
                if (!dataLine || dataLine === "[DONE]") continue;
                try {
                    const parsed = JSON.parse(dataLine) as Record<string, unknown>;
                    const delta = parseProviderStreamDelta(request.providerKind, parsed);
                    if (delta.content) content += delta.content;
                    finishReason = extractFinishReason(parsed) ?? finishReason;
                    const u = extractUsage(parsed)
                        ?? extractUsage({ usage: undefined, ...(parsed.usageMetadata ? { candidates: [{ usageMetadata: parsed.usageMetadata }] } : {}) });
                    if (u) usage = u;
                } catch {
                    // 中转站心跳 / 非 JSON 片段，忽略
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const normalized = buffer.replace(/\r\n/g, "\n");
            const parts = normalized.split("\n\n");
            buffer = parts[parts.length - 1] || "";
            for (const eventText of parts.slice(0, -1)) handleEvent(eventText);
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleEvent(buffer.replace(/\r\n/g, "\n"));

        content = content.trim();
        if (!content) throw new Error("流式响应没有返回正文");
        return { content, finishReason, usage };
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
    }
}

export function extractUsage(data: Record<string, unknown>): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
    if (!data) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;
    const usage = d?.usage ?? d?.output?.usage ?? d?.candidates?.[0]?.usageMetadata;
    if (!usage) return undefined;
    return {
        prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount,
        completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount,
        total_tokens: usage.total_tokens ?? usage.totalTokenCount,
    };
}

export function extractFinishReason(data: Record<string, unknown>): string | undefined {
    if (!data) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;

    return d?.choices?.[0]?.finish_reason
        ?? d?.stop_reason
        ?? d?.candidates?.[0]?.finishReason
        ?? d?.output?.finish_reason
        ?? d?.finish_reason
        ?? undefined;
}

function isTruncationFinishReason(reason?: string): boolean {
    if (!reason) return false;
    const normalized = String(reason).trim().toLowerCase();
    return normalized === "length"
        || normalized === "max_tokens"
        || normalized === "max_output_tokens"
        || normalized === "max_completion_tokens";
}

function isSafetyFinishReason(reason?: string): boolean {
    if (!reason) return false;
    const normalized = String(reason).trim().toLowerCase();
    return normalized.includes("content_filter")
        || normalized.includes("safety")
        || normalized.includes("blocked")
        || normalized.includes("block")
        || normalized.includes("prohibited")
        || normalized.includes("policy");
}

function shortDebugText(value: unknown, limit = 120): string {
    let text = "";
    if (typeof value === "string") text = value;
    else if (value !== undefined && value !== null) {
        try { text = JSON.stringify(value); } catch { text = String(value); }
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function describeEmptyLLMResponse(
    data: Record<string, unknown>,
    finishReason?: string,
    wasTruncated = false,
    config?: Pick<ApiConfig, "provider" | "defaultModel">
): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;
    const parts = [
        "LLM 返回了空内容",
        config?.provider ? `provider=${config.provider}` : "",
        config?.defaultModel ? `model=${config.defaultModel}` : "",
        finishReason ? `finishReason=${finishReason}` : "finishReason=未返回",
    ].filter(Boolean);

    if (wasTruncated) parts.push("原因判断=输出被长度上限截断，模型可能把输出额度耗尽后没有留下正文");
    if (isSafetyFinishReason(finishReason)) parts.push("原因判断=供应商安全过滤或策略拦截导致正文为空");

    const choice = d?.choices?.[0];
    if (choice) {
        const message = choice.message ?? {};
        const messageKeys = message && typeof message === "object" ? Object.keys(message) : [];
        if (messageKeys.length) parts.push(`message字段=${messageKeys.join(",")}`);
        if (typeof message?.content === "string") parts.push(`content长度=${message.content.length}`);
        if (typeof message?.reasoning_content === "string") parts.push(`reasoning长度=${message.reasoning_content.length}`);
        if (typeof message?.reasoning === "string") parts.push(`reasoning长度=${message.reasoning.length}`);
        if (message?.refusal) parts.push(`refusal=${shortDebugText(message.refusal)}`);
        if (choice.finish_reason && !finishReason) parts.push(`choice.finish_reason=${choice.finish_reason}`);
    }

    const candidate = d?.candidates?.[0];
    if (candidate) {
        if (candidate.finishReason && !finishReason) parts.push(`candidate.finishReason=${candidate.finishReason}`);
        const partsValue = candidate.content?.parts;
        if (Array.isArray(partsValue)) {
            const visibleCount = partsValue.filter((part: unknown) => {
                const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
                return item.thought !== true && item.type !== "thinking" && item.type !== "thought" && typeof item.text === "string" && item.text.trim();
            }).length;
            const thoughtCount = partsValue.length - visibleCount;
            parts.push(`geminiParts=visible:${visibleCount},thought:${thoughtCount}`);
        }
    }

    const promptFeedback = d?.promptFeedback ?? d?.prompt_feedback;
    if (promptFeedback) parts.push(`promptFeedback=${shortDebugText(promptFeedback)}`);
    if (d?.error) parts.push(`providerError=${shortDebugText(d.error)}`);
    parts.push(`返回顶层字段=${JSON.stringify(Object.keys(data || {}))}`);
    return parts.join("；");
}

/**
 * Extract text content from various API response formats.
 * Supports: OpenAI, Anthropic, Google Gemini, DashScope, simple proxies.
 */
/**
 * Strip AI-hallucinated timestamps. Single source of truth — llm-provider-adapter
 * re-exports this one, and the WeChat assistant runtime keeps a byte-identical copy
 * (tools/weixin-local-assistant/assistant-core.mjs · cleanReplyText).
 *
 * 括号内以完整日期时间开头的一律剥掉：兼容带秒、时区（Europe/Madrid、UTC+2）、
 * 星期等尾巴与全角括号——prompt 给历史消息标注的时间带时区时，AI 会照格式模仿。
 */
export function stripHallucinatedTimestamps(text: string): string {
    return text
        .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
        .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "");
}

function stripReasoningMarkup(text: string): string {
    return text
        .replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, "")
        .trim();
}

// Gemini may return thought parts before the visible answer. Only expose non-thought text here.
function extractGeminiVisibleText(parts: unknown): string | null {
    if (!Array.isArray(parts)) return null;
    const visible = parts
        .filter((part) => {
            const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
            return item.thought !== true && item.type !== "thinking" && item.type !== "thought";
        })
        .map((part) => {
            const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
            return typeof item.text === "string" ? item.text.trim() : "";
        })
        .filter(Boolean)
        .join("\n");
    return visible || null;
}

export function extractLLMContent(data: Record<string, unknown>, provider?: string): string | null {
    if (!data) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;

    let raw: string | null = null;

    // OpenAI-compatible (most providers, proxies, relays)
    const openai = d?.choices?.[0]?.message?.content;
    if (openai) raw = String(openai).trim();

    // Anthropic Messages API
    if (!raw) { const anthropic = d?.content?.[0]?.text; if (anthropic) raw = String(anthropic).trim(); }

    // Google Gemini
    if (!raw) raw = extractGeminiVisibleText(d?.candidates?.[0]?.content?.parts);

    // Alibaba DashScope
    if (!raw) { const dashscope = d?.output?.text; if (dashscope) raw = String(dashscope).trim(); }

    // Simple proxy format
    if (!raw) { const simple = d?.response; if (typeof simple === "string" && simple.trim()) raw = simple.trim(); }

    // Fallback: try choices[0].text (older completions API)
    if (!raw) { const legacy = d?.choices?.[0]?.text; if (legacy) raw = String(legacy).trim(); }

    // Last resort: reasoning models (DeepSeek-R1 / v4-pro) put their output in
    // reasoning_content and may leave content empty when max_tokens is exhausted
    // mid-thought. Surface the reasoning rather than reporting an empty response.
    if (!raw) { const reasoning = d?.choices?.[0]?.message?.reasoning_content; if (reasoning) raw = String(reasoning).trim(); }

    if (!raw) return null;

    // Strip non-user-facing model metadata before any downstream processing
    return stripHallucinatedTimestamps(stripReasoningMarkup(raw));
}

/**
 * Extract reasoning/thinking content from API response (DeepSeek-R1, Anthropic Claude extended thinking).
 * Returns the reasoning text or empty string if none found.
 * Only used by story mode to prepend as <think> block.
 */
export function extractReasoningContent(data: Record<string, unknown>): string {
    if (!data) return "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any;

    // DeepSeek-R1: reasoning_content field
    const reasoning = d?.choices?.[0]?.message?.reasoning_content;
    if (reasoning) return String(reasoning).trim();

    // Anthropic: thinking blocks in content array
    if (Array.isArray(d?.content)) {
        const thinkingBlocks = d.content
            .filter((b: any) => b.type === "thinking" && b.thinking)
            .map((b: any) => String(b.thinking).trim());
        if (thinkingBlocks.length > 0) return thinkingBlocks.join("\n\n");
    }

    return "";
}
