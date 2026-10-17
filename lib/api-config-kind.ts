// lib/api-config-kind.ts
// 区分「对话 API 配置」和「向量（embedding）API 配置」。
// 向量配置只会被记忆向量召回使用，没法聊天，所以不应该混进各处的对话配置选择器里。
// 判定：显式标记 purpose === "embedding"，或旧数据里没有标记、但默认模型名一看就是向量模型。

import type { ApiConfig } from "./settings-types";

const EMBEDDING_MODEL_NAME_RE = /embed|bge-|m3e|text2vec|\be5\b|\bgte\b/i;

export function isEmbeddingModelName(model: string | undefined): boolean {
    return Boolean(model && EMBEDDING_MODEL_NAME_RE.test(model));
}

export function isEmbeddingApiConfig(config: Pick<ApiConfig, "purpose" | "defaultModel">): boolean {
    if (config.purpose === "embedding") return true;
    if (config.purpose === "chat") return false;
    return isEmbeddingModelName(config.defaultModel);
}

export function filterChatApiConfigs<T extends Pick<ApiConfig, "purpose" | "defaultModel">>(configs: T[]): T[] {
    return configs.filter(config => !isEmbeddingApiConfig(config));
}

export function filterEmbeddingApiConfigs<T extends Pick<ApiConfig, "purpose" | "defaultModel">>(configs: T[]): T[] {
    return configs.filter(config => isEmbeddingApiConfig(config));
}
