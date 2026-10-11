"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import {
    classifyLogError,
    clearApiErrorLogs,
    getApiLogs,
    type DebugInfo,
    type LogErrorInfo,
} from "@/lib/api-log-store";

type ErrorRow = { log: DebugInfo; error: LogErrorInfo };

const DETAIL_CHAR_LIMIT = 3000;

function formatTime(ts: string): string {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function loadErrorRows(): ErrorRow[] {
    const rows: ErrorRow[] = [];
    for (const log of [...getApiLogs()].reverse()) {
        const error = classifyLogError(log);
        if (error) rows.push({ log, error });
    }
    return rows;
}

/** 请求体量概况：消息条数与字符数。日志里的文本最多保留 9.6 万字符，所以这是下限估计。 */
function describeRequestSize(log: DebugInfo): string {
    const chars = log.messages.reduce((sum, message) => sum + message.content.length, 0);
    const size = chars >= 10000 ? `${(chars / 10000).toFixed(1)} 万字符` : `${chars} 字符`;
    return `${log.messages.length} 条消息 · 约 ${size}`;
}

/**
 * 报错日志：只列出失败的调用，先看状态码（400、503 等）和一行原因，
 * 完整请求折叠在下面，需要时再点开。长请求的错误信息在「底层调用大模型日志」里
 * 要翻过整段提示词才看得到，这里把它放到最前面。
 */
export function ErrorLogViewer({ onBack }: { onBack: () => void }) {
    const [rows, setRows] = useState<ErrorRow[]>(loadErrorRows);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [fullOpenIds, setFullOpenIds] = useState<Set<string>>(new Set());

    const codeCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const row of rows) counts.set(row.error.code, (counts.get(row.error.code) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    }, [rows]);

    const toggleFull = (id: string) => {
        setFullOpenIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleClear = () => {
        clearApiErrorLogs();
        setRows([]);
        setExpandedId(null);
        setFullOpenIds(new Set());
    };

    return (
        <PageShell title="报错日志" onBack={onBack} className="absolute inset-0 z-[100]">
            <div className="page-menu">
                {rows.length === 0 ? (
                    <div className="ui-empty">
                        <span className="menu-desc">还没有报错记录（更新之前发生的聊天报错没有被记录下来）</span>
                    </div>
                ) : (
                    <>
                        <div className="menu-desc mx-2 mb-2 flex gap-2 flex-wrap">
                            {codeCounts.map(([code, count]) => (
                                <span key={code} className="ts-12 font-semibold">{code} ×{count}</span>
                            ))}
                        </div>

                        <div className="flex flex-col gap-3">
                            {rows.map(({ log, error }) => {
                                const isOpen = expandedId === log.id;
                                const fullOpen = fullOpenIds.has(log.id);
                                const detail = (error.detail || log.rawResponse || "").slice(0, DETAIL_CHAR_LIMIT);
                                return (
                                    <div key={log.id} className="menu-group">
                                        <button
                                            type="button"
                                            onClick={() => setExpandedId(isOpen ? null : log.id)}
                                            className="menu-item"
                                        >
                                            <div className="menu-label-group">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span
                                                        className="ts-12 font-bold rounded-[4px] px-[7px] py-[1px] shrink-0"
                                                        style={{ background: "var(--c-danger)", color: "#fff" }}
                                                    >
                                                        {error.code}
                                                    </span>
                                                    {log.characterName && (
                                                        <span className="ts-11 font-semibold text-white bg-[var(--c-icon-active)] rounded-[4px] px-[6px] py-[1px] shrink-0">
                                                            {log.characterName}
                                                        </span>
                                                    )}
                                                    <span className="menu-label font-semibold">{formatTime(log.timestamp)}</span>
                                                </div>
                                                <div className="menu-desc mt-1 break-all">{error.summary}</div>
                                            </div>
                                            <div className="menu-right">
                                                <ChevronRight
                                                    size={16}
                                                    className="ui-chevron-flip"
                                                    {...(isOpen ? { "data-open": "" } : {})}
                                                />
                                            </div>
                                        </button>

                                        {isOpen && (
                                            <div className="api-log-panel">
                                                <div className="font-bold px-1 pt-3 pb-2 text-[var(--c-danger)]">错误详情</div>
                                                <div className="api-log-response whitespace-pre-wrap break-all leading-[1.4]">
                                                    {detail}
                                                </div>

                                                <div className="menu-desc px-1 pt-3 flex gap-3 flex-wrap">
                                                    {log.model && <span>模型：{log.model}</span>}
                                                    <span>{describeRequestSize(log)}</span>
                                                </div>

                                                <button
                                                    type="button"
                                                    className="ui-btn ui-btn-outline py-1 px-3 ts-12 mt-3"
                                                    onClick={() => toggleFull(log.id)}
                                                >
                                                    {fullOpen ? "收起完整请求日志" : `查看完整请求日志（${log.messages.length} 条消息）`}
                                                </button>

                                                {fullOpen && (
                                                    <>
                                                        <div className="font-bold px-1 pt-3 pb-2 text-[var(--c-warning)]">
                                                            Prompt ({log.messages.length} 条消息)
                                                        </div>
                                                        {log.messages.map((m, i) => (
                                                            <div key={i} className="api-log-entry" data-role={m.role}>
                                                                <div className="flex items-center gap-[6px] mb-1 flex-wrap">
                                                                    <span className="font-bold text-[var(--log-role-color)]">
                                                                        [{i}] {m.role}
                                                                    </span>
                                                                    {m.marker && <span className="api-log-marker">{m.marker}</span>}
                                                                </div>
                                                                <div className="whitespace-pre-wrap break-all leading-[1.4]">
                                                                    {m.content}
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>

                        <div className="menu-group mt-4">
                            <button type="button" className="menu-item" onClick={handleClear}>
                                <div className="menu-icon"><Trash2 size={18} color="var(--c-icon)" /></div>
                                <div className="menu-label-group"><span className="menu-label menu-label-danger">清空报错记录</span></div>
                            </button>
                        </div>
                    </>
                )}
            </div>
        </PageShell>
    );
}
