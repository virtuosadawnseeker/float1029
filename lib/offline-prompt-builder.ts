// lib/offline-prompt-builder.ts
// 线下聊天历史构造：把「线下轮次」（ChatOfflineTurn）转成与线上同构的 ChatMessage[]。
// assistant 消息内容用 <content> + 摘要 XML 包裹，与真实线下生成（generateOfflineChatCompletion
// / generateGroupOfflineChatCompletion）完全一致。
// chat-room（真实发送）与提示词查看器（预览）共用本模块，保证「预览 = 即将发出的提示词」。

import type { ChatSession, ChatMessage } from "./chat-storage";
import type { ChatOfflineTurn } from "./chat-offline-storage";

/** 围观群里用户写的「导演指令」在线下轮次里的存储前缀；构造历史时还原成系统指令消息。 */
export const OFFLINE_DIRECTOR_PREFIX = "[系统指令] ";

function isDirectorNote(session: ChatSession, content: string): boolean {
    return session.isGroup === true && session.isSpectator === true && content.startsWith(OFFLINE_DIRECTOR_PREFIX);
}

function directorNoteMessage(id: string, session: ChatSession, content: string, createdAt: string): ChatMessage {
    return {
        id,
        sessionId: session.id,
        role: "system",
        mediaType: "system_instruction",
        content,
        status: "sent",
        createdAt,
    };
}

export function formatOfflineTurnXml(turn: ChatOfflineTurn): string {
    if (turn.rawText?.trim()) return turn.rawText.trim();
    const summaryTag = turn.summaryTag?.trim() || "summary";
    // rawText 缺失（旧数据）时重建完整 XML：思维链（thinkingText）存在则按原标签拼回，
    // 保证历史上下文里保留这一轮的思考内容
    const thinkingTag = turn.thinkingTag?.trim() || "thinking";
    const thinkingBlock = turn.thinkingText?.trim()
        ? `<${thinkingTag}>\n${turn.thinkingText.trim()}\n</${thinkingTag}>`
        : "";
    return [
        thinkingBlock,
        "<content>",
        turn.assistantContent,
        "</content>",
        `<${summaryTag}>`,
        turn.summary,
        `</${summaryTag}>`,
    ].filter(Boolean).join("\n");
}

export function buildOfflinePromptHistory(
    session: ChatSession,
    turns: ChatOfflineTurn[],
    pendingUserContent: string,
): ChatMessage[] {
    const history: ChatMessage[] = [];
    for (const turn of turns) {
        const assistantAt = turn.createdAt;
        const userAtMs = new Date(turn.createdAt).getTime() - 1;
        const userAt = Number.isFinite(userAtMs) ? new Date(userAtMs).toISOString() : turn.createdAt;
        if (turn.userContent.trim() && isDirectorNote(session, turn.userContent)) {
            history.push(directorNoteMessage(`${turn.id}_user`, session, turn.userContent, userAt));
        } else if (turn.userContent.trim()) {
            history.push({
                id: `${turn.id}_user`,
                sessionId: session.id,
                role: "user",
                content: turn.userContent,
                status: "sent",
                createdAt: userAt,
            });
        }
        history.push({
            id: `${turn.id}_assistant`,
            sessionId: session.id,
            role: "assistant",
            content: formatOfflineTurnXml(turn),
            status: "sent",
            createdAt: assistantAt,
            ...(session.isGroup ? { senderName: session.groupName || "群聊线下" } : {}),
        });
    }
    if (pendingUserContent.trim() && isDirectorNote(session, pendingUserContent.trim())) {
        history.push(directorNoteMessage(`offline_pending_${Date.now()}`, session, pendingUserContent.trim(), new Date().toISOString()));
    } else if (pendingUserContent.trim()) {
        history.push({
            id: `offline_pending_${Date.now()}`,
            sessionId: session.id,
            role: "user",
            content: pendingUserContent.trim(),
            status: "sent",
            createdAt: new Date().toISOString(),
        });
    }
    return history;
}

/** 线下模式默认篇幅（中文字数）。按次计费的用户希望每轮写足，而预设里只有「可以较长」这种弱提示。 */
export const OFFLINE_DEFAULT_MIN_CHARS = 400;
export const OFFLINE_DEFAULT_TARGET_CHARS = "600～1000";

/**
 * 线下模式篇幅提示：追加在提示词末尾（离生成最近，约束力最强）。
 * 放在代码里而不是内置预设里：改预设需要升版本号，会覆盖用户自己改过的预设副本。
 * 用户明确要求写短时，以用户要求为准。
 */
export function buildOfflineLengthHint(): string {
    return [
        `【线下篇幅】本轮 <content> 正文请写足：通常 ${OFFLINE_DEFAULT_TARGET_CHARS} 字，不少于 ${OFFLINE_DEFAULT_MIN_CHARS} 字（以中文字数计）。`,
        "不要只写一两句话就收束；把动作、环境、对话与心理自然铺开，让场景有推进、有细节。",
        "若用户本轮明确要求简短，则以用户要求为准。篇幅要求只针对 <content> 正文，摘要字段仍保持简洁。",
    ].join("\n");
}

/** 当前提示词属于线下模式时，在末尾追加篇幅提示。 */
export function appendOfflineLengthHint(
    llmMessages: Array<{ role: string; content: unknown }>,
    appTags: readonly string[] | undefined,
): void {
    if (!appTags?.includes("offline")) return;
    llmMessages.push({ role: "system", content: buildOfflineLengthHint() });
}
