// lib/memory-embedding-backfill.ts
// 给已有的长期记忆补全 / 重建向量（embedding）。
// 背景：向量只在「生成新长期记忆」和「手动编辑记忆内容」时才会生成，
// 在配置向量 API 之前产生的、从别处迁移来的、或换过向量模型的旧记忆，
// 要么没有向量，要么维度对不上；超出预算走向量召回时，这些记忆会被直接跳过。

import type { MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";

export type EmbeddingCoverage = {
    /** 长期记忆总数 */
    total: number;
    /** 带有向量的条数（不含维度不一致的） */
    ready: number;
    /** 完全没有向量的条数 */
    missing: number;
    /** 有向量但维度与多数不一致的条数（多半是换过向量模型） */
    mismatched: number;
};

/**
 * 统计向量覆盖情况。维度以「出现最多的维度」为准，
 * 不需要调用 API，所以可以在打开页面时随手算。
 */
export function computeEmbeddingCoverage(entries: MemoryEntry[]): EmbeddingCoverage {
    const dimCounts = new Map<number, number>();
    for (const entry of entries) {
        const len = entry.embedding?.length ?? 0;
        if (len > 0) dimCounts.set(len, (dimCounts.get(len) ?? 0) + 1);
    }
    let majorityDim = 0;
    let majorityCount = 0;
    for (const [dim, count] of dimCounts) {
        if (count > majorityCount) { majorityDim = dim; majorityCount = count; }
    }

    let ready = 0;
    let missing = 0;
    let mismatched = 0;
    for (const entry of entries) {
        const len = entry.embedding?.length ?? 0;
        if (len === 0) missing++;
        else if (len === majorityDim) ready++;
        else mismatched++;
    }
    return { total: entries.length, ready, missing, mismatched };
}

export type BackfillMode =
    /** 只处理没有向量、或维度与当前向量模型不一致的记忆 */
    | "missing"
    /** 全部重新生成（换了向量模型后使用） */
    | "all";

export type BackfillProgress = {
    done: number;
    total: number;
    failed: number;
};

export type BackfillResult = {
    ok: boolean;
    error?: string;
    /** 本次需要处理的条数 */
    total: number;
    /** 成功写入向量的条数 */
    updated: number;
    /** 生成失败的条数 */
    failed: number;
    /** 因为被中途停止而没处理的条数 */
    remaining: number;
};

const FLUSH_EVERY = 10;
const REQUEST_GAP_MS = 120;
const MAX_CONSECUTIVE_FAILURES = 5;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function backfillLongTermEmbeddings(
    characterId: string,
    options: {
        mode: BackfillMode;
        onProgress?: (progress: BackfillProgress) => void;
        /** 返回 true 时尽快停止；已算好的向量会先保存 */
        shouldStop?: () => boolean;
    },
): Promise<BackfillResult> {
    const apiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (!apiConfig) {
        return { ok: false, error: "未配置向量 API（请在绑定配置 → 辅助API绑定中设置向量模型）", total: 0, updated: 0, failed: 0, remaining: 0 };
    }
    const modelName = resolveEmbeddingModel(apiConfig);
    if (!modelName) {
        return { ok: false, error: "向量 API 的默认模型看起来不是向量模型，请换成 embedding 模型", total: 0, updated: 0, failed: 0, remaining: 0 };
    }

    const entries = await loadMemoryEntriesByType(characterId, "long_term");
    if (entries.length === 0) {
        return { ok: true, total: 0, updated: 0, failed: 0, remaining: 0 };
    }

    // 先用一条记忆探测当前向量模型：既验证 API 可用，也拿到「当前维度」
    let probe: number[] | null = null;
    try {
        probe = await generateEmbedding(entries[0].content, apiConfig, { throwOnError: true });
    } catch (err) {
        return { ok: false, error: "向量 API 调用失败：" + String(err instanceof Error ? err.message : err), total: 0, updated: 0, failed: 0, remaining: 0 };
    }
    if (!probe) {
        return { ok: false, error: "向量 API 没有返回向量数据", total: 0, updated: 0, failed: 0, remaining: 0 };
    }
    const currentDim = probe.length;

    const targets = options.mode === "all"
        ? entries
        : entries.filter(entry => (entry.embedding?.length ?? 0) !== currentDim);

    if (targets.length === 0) {
        return { ok: true, total: 0, updated: 0, failed: 0, remaining: 0 };
    }

    // 已算好、等待写入的向量：id → { 原文, 向量 }
    const pending = new Map<string, { content: string; embedding: number[] }>();
    let updated = 0;
    let failed = 0;
    let done = 0;
    let consecutiveFailures = 0;
    let stoppedEarly = false;

    // 写入前重新读取最新记忆：如果这条记忆在计算期间被编辑过（内容变了），
    // 就丢弃这次算好的向量，避免用旧内容覆盖用户刚改的文字。
    const flush = async () => {
        if (pending.size === 0) return;
        const fresh = await loadMemoryEntriesByType(characterId, "long_term");
        const freshById = new Map(fresh.map(entry => [entry.id, entry]));
        const embeddedAt = new Date().toISOString();
        for (const [id, item] of pending) {
            const current = freshById.get(id);
            if (!current || current.content.trim() !== item.content.trim()) {
                updated = Math.max(0, updated - 1);
                continue;
            }
            await saveMemoryEntry({
                ...current,
                embedding: item.embedding,
                metadata: { ...(current.metadata ?? {}), embeddingModel: modelName, embeddedAt },
            });
        }
        pending.clear();
    };

    for (let i = 0; i < targets.length; i++) {
        if (options.shouldStop?.()) { stoppedEarly = true; break; }

        const entry = targets[i];
        let embedding: number[] | null = null;
        if (entry.id === entries[0].id) {
            embedding = probe; // 探测时已经算过第一条，省一次调用
        } else {
            try {
                embedding = await generateEmbedding(entry.content, apiConfig);
            } catch {
                embedding = null;
            }
            await sleep(REQUEST_GAP_MS);
        }

        done++;
        if (embedding && embedding.length > 0) {
            pending.set(entry.id, { content: entry.content, embedding });
            updated++;
            consecutiveFailures = 0;
        } else {
            failed++;
            consecutiveFailures++;
        }
        options.onProgress?.({ done, total: targets.length, failed });

        if (pending.size >= FLUSH_EVERY) await flush();

        // 连续失败多半是额度、网络或密钥问题，继续下去只会白白刷错误
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            await flush();
            return {
                ok: false,
                error: `连续 ${MAX_CONSECUTIVE_FAILURES} 次生成向量失败，已停止（已完成的部分已保存）`,
                total: targets.length,
                updated,
                failed,
                remaining: targets.length - done,
            };
        }
    }

    await flush();
    return {
        ok: true,
        total: targets.length,
        updated,
        failed,
        remaining: stoppedEarly ? targets.length - done : 0,
    };
}
