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
