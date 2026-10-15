import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { AllowanceCard, AllowanceCardKind, WalletAccountType, WalletCard, WalletPaymentInput, WalletPaymentResult, WalletState, WalletTransaction } from "./wallet-types";

const WALLET_STATE_KEY = "ai_phone_wallet_state_v1";
const LEGACY_DEFAULT_WALLET_CARD_ID = "wallet_default_balance_card";
const DEFAULT_WALLET_BANK_CARD_ID = "wallet_default_bank_card";
const DEFAULT_WALLET_BALANCE = 10000;

export const WALLET_BALANCE_ACCOUNT_ID = "wallet_balance_account";
/** 额度卡（亲属卡 / 亲密付）的账户 ID 前缀 */
export const ALLOWANCE_CARD_ID_PREFIX = "allowance_card_";
export const WALLET_UPDATED_EVENT = "wallet-state-updated";

registerKvMigration(WALLET_STATE_KEY);

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function normalizeMoney(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").replace(/[¥￥元,\s]/g, ""));
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.round(amount * 100) / 100);
}

function normalizeSignedMoney(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(String(value ?? "").replace(/[¥￥元,\s]/g, ""));
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function generateWalletId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isBalanceAccountId(accountId: string | undefined): boolean {
  return !accountId || accountId === WALLET_BALANCE_ACCOUNT_ID || accountId === LEGACY_DEFAULT_WALLET_CARD_ID;
}

function getAccountType(accountId: string): WalletAccountType {
  return isBalanceAccountId(accountId) ? "balance" : "card";
}

function createDefaultWalletCard(now = new Date().toISOString()): WalletCard {
  return {
    id: DEFAULT_WALLET_BANK_CARD_ID,
    title: "储蓄卡",
    bankLabel: "CHAT WALLET",
    maskedNumber: "**** **** **** 0214",
    cardStyle: "graphite",
    balance: 0,
    note: "系统自动创建的默认银行卡",
    accentLabel: "储蓄",
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeCard(value: unknown): WalletCard | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const title = cleanText(record.title, 80);
  if (!id || !title) return null;
  const normalizedTitle = title === "备用余额卡" ? "储蓄卡" : title;
  const rawStyle = cleanText(record.cardStyle, 40);
  const cardStyle = rawStyle === "graphite" || rawStyle === "silver" ? rawStyle : "obsidian";
  const now = new Date().toISOString();
  return {
    id,
    title: normalizedTitle,
    bankLabel: cleanText(record.bankLabel, 80) || "CHAT WALLET",
    maskedNumber: cleanText(record.maskedNumber, 40) || "**** **** **** 0000",
    cardStyle,
    balance: normalizeMoney(record.balance),
    note: cleanText(record.note, 240),
    accentLabel: cleanText(record.accentLabel, 24) || "储蓄",
    isDefault: record.isDefault === true,
    createdAt: cleanText(record.createdAt, 80) || now,
    updatedAt: cleanText(record.updatedAt, 80) || now,
  };
}

function normalizeTransaction(value: unknown): WalletTransaction | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const rawCardId = cleanText(record.cardId, 120);
  const cardId = rawCardId === LEGACY_DEFAULT_WALLET_CARD_ID ? WALLET_BALANCE_ACCOUNT_ID : rawCardId;
  const title = cleanText(record.title, 120);
  const rawKind = cleanText(record.kind, 40);
  const kind = rawKind === "payment" || rawKind === "adjustment" || rawKind === "transfer_out" || rawKind === "refund"
    ? rawKind
    : "transfer_in";
  if (!id || !cardId || !title) return null;
  const rawAccountType = cleanText(record.accountType, 40);
  return {
    id,
    cardId,
    accountType: rawAccountType === "card" || rawAccountType === "balance" || rawAccountType === "allowance" ? rawAccountType : getAccountType(cardId),
    title,
    amount: normalizeSignedMoney(record.amount),
    kind,
    category: cleanText(record.category, 80) || "余额",
    createdAt: cleanText(record.createdAt, 80) || new Date().toISOString(),
    detail: cleanText(record.detail, 400),
    balanceAfter: normalizeMoney(record.balanceAfter),
    relatedOrderId: cleanText(record.relatedOrderId, 120) || undefined,
  };
}

export function getAllowanceMonthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function normalizeAllowanceCard(value: unknown): AllowanceCard | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const issuerId = cleanText(record.issuerId, 120);
  if (!id || !issuerId) return null;
  const now = new Date().toISOString();
  return {
    id,
    kind: record.kind === "intimate" ? "intimate" : "family",
    issuerId,
    issuerName: cleanText(record.issuerName, 80) || "TA",
    monthlyLimit: normalizeMoney(record.monthlyLimit),
    usedAmount: normalizeMoney(record.usedAmount),
    usedMonth: cleanText(record.usedMonth, 12),
    status: record.status === "closed" ? "closed" : "active",
    note: cleanText(record.note, 240),
    sourceMessageId: cleanText(record.sourceMessageId, 120) || undefined,
    sessionId: cleanText(record.sessionId, 120) || undefined,
    createdAt: cleanText(record.createdAt, 80) || now,
    updatedAt: cleanText(record.updatedAt, 80) || now,
  };
}

function normalizeWalletState(state: WalletState): WalletState {
  const now = new Date().toISOString();
  const cards = state.cards.length > 0 ? state.cards : [createDefaultWalletCard(now)];
  const defaultCardId = cards.some(card => card.id === state.defaultCardId) ? state.defaultCardId : cards[0].id;
  return {
    balance: normalizeMoney(state.balance),
    cards: cards.map(card => ({
      ...card,
      isDefault: card.id === defaultCardId,
      balance: normalizeMoney(card.balance),
    })),
    allowanceCards: (state.allowanceCards ?? [])
      .map(normalizeAllowanceCard)
      .filter((card): card is AllowanceCard => Boolean(card))
      .slice(0, 50),
    transactions: state.transactions.slice(0, 300),
    defaultCardId,
    updatedAt: state.updatedAt || now,
  };
}

export function createDefaultWalletState(): WalletState {
  const now = new Date().toISOString();
  const card = createDefaultWalletCard(now);
  return {
    balance: DEFAULT_WALLET_BALANCE,
    cards: [card],
    allowanceCards: [],
    transactions: [{
      id: "wallet_initial_balance",
      cardId: WALLET_BALANCE_ACCOUNT_ID,
      accountType: "balance",
      title: "初始余额",
      amount: DEFAULT_WALLET_BALANCE,
      kind: "transfer_in",
      category: "初始化",
      createdAt: now,
      detail: "系统自动创建余额账户",
      balanceAfter: DEFAULT_WALLET_BALANCE,
    }],
    defaultCardId: card.id,
    updatedAt: now,
  };
}

function migrateLegacyParsedState(parsed: Record<string, unknown>): WalletState {
  const now = new Date().toISOString();
  const rawCards = Array.isArray(parsed.cards)
    ? parsed.cards.map(normalizeCard).filter((card): card is WalletCard => Boolean(card))
    : [];
  const legacyBalanceCard = rawCards.find(card => card.id === LEGACY_DEFAULT_WALLET_CARD_ID || card.title === "默认余额卡");
  const explicitBalance = normalizeMoney(parsed.balance);
  const balance = typeof parsed.balance === "number" || typeof parsed.balance === "string"
    ? explicitBalance
    : normalizeMoney(legacyBalanceCard?.balance ?? 0);
  const cards = rawCards.filter(card => card.id !== LEGACY_DEFAULT_WALLET_CARD_ID && card.title !== "默认余额卡");
  const normalizedCards = cards.length > 0 ? cards : [createDefaultWalletCard(now)];
  const transactions = Array.isArray(parsed.transactions)
    ? parsed.transactions.map(normalizeTransaction).filter((transaction): transaction is WalletTransaction => Boolean(transaction))
    : [];
  const defaultCardId = cleanText(parsed.defaultCardId, 120);
  const allowanceCards = Array.isArray(parsed.allowanceCards)
    ? parsed.allowanceCards.map(normalizeAllowanceCard).filter((card): card is AllowanceCard => Boolean(card))
    : [];
  return normalizeWalletState({
    balance,
    cards: normalizedCards,
    allowanceCards,
    transactions,
    defaultCardId: normalizedCards.some(card => card.id === defaultCardId) ? defaultCardId : normalizedCards[0].id,
    updatedAt: cleanText(parsed.updatedAt, 80) || now,
  });
}

export function loadWalletState(): WalletState {
  if (typeof window === "undefined") return createDefaultWalletState();
  try {
    const raw = kvGet(WALLET_STATE_KEY);
    if (!raw) {
      const next = createDefaultWalletState();
      saveWalletState(next);
      return next;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next = migrateLegacyParsedState(parsed);
    if (!("balance" in parsed) || next.cards.length === 0) saveWalletState(next);
    return next;
  } catch {
    const next = createDefaultWalletState();
    saveWalletState(next);
    return next;
  }
}

export function saveWalletState(state: WalletState): WalletState {
  const next = normalizeWalletState({ ...state, updatedAt: new Date().toISOString() });
  kvSet(WALLET_STATE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WALLET_UPDATED_EVENT, { detail: next }));
  }
  return next;
}

export function formatWalletAmount(amount: number): string {
  const safeAmount = normalizeMoney(amount);
  return `¥${safeAmount.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function getWalletBalance(state: WalletState): number {
  return normalizeMoney(state.balance);
}

export function getWalletTotalBalance(state: WalletState): number {
  return normalizeMoney(state.balance) + state.cards.reduce((sum, card) => sum + normalizeMoney(card.balance), 0);
}

export function createWalletCard(input?: Partial<Pick<WalletCard, "title" | "bankLabel" | "maskedNumber" | "cardStyle" | "balance" | "note" | "accentLabel">>): WalletState {
  const current = loadWalletState();
  const now = new Date().toISOString();
  const card: WalletCard = {
    id: generateWalletId("wallet_card"),
    title: cleanText(input?.title, 80) || "储蓄卡",
    bankLabel: cleanText(input?.bankLabel, 80) || "CHAT WALLET",
    maskedNumber: cleanText(input?.maskedNumber, 40) || `**** **** **** ${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`,
    cardStyle: input?.cardStyle === "graphite" || input?.cardStyle === "silver" ? input.cardStyle : "obsidian",
    balance: normalizeMoney(input?.balance),
    note: cleanText(input?.note, 240),
    accentLabel: cleanText(input?.accentLabel, 24) || "储蓄",
    isDefault: current.cards.length === 0,
    createdAt: now,
    updatedAt: now,
  };
  return saveWalletState({
    ...current,
    cards: [card, ...current.cards],
    defaultCardId: current.cards.length === 0 ? card.id : current.defaultCardId,
  });
}

export function deleteWalletCard(cardId: string): { ok: boolean; state: WalletState; error?: string } {
  const current = loadWalletState();
  if (current.cards.length <= 1) {
    return { ok: false, state: current, error: "至少需要保留一张银行卡。" };
  }
  const nextCards = current.cards.filter(card => card.id !== cardId);
  if (nextCards.length === current.cards.length) return { ok: false, state: current, error: "未找到这张卡。" };
  const defaultCardId = current.defaultCardId === cardId ? nextCards[0].id : current.defaultCardId;
  const next = saveWalletState({
    ...current,
    cards: nextCards,
    defaultCardId,
    transactions: current.transactions.filter(transaction => transaction.cardId !== cardId),
  });
  return { ok: true, state: next };
}

export function setDefaultWalletCard(cardId: string): WalletState {
  const current = loadWalletState();
  if (!current.cards.some(card => card.id === cardId)) return current;
  return saveWalletState({ ...current, defaultCardId: cardId });
}

function createTransaction(input: {
  accountId: string;
  accountType: WalletAccountType;
  title: string;
  amount: number;
  kind: WalletTransaction["kind"];
  category: string;
  detail: string;
  balanceAfter: number;
  relatedOrderId?: string;
}): WalletTransaction {
  return {
    id: generateWalletId("wallet_tx"),
    cardId: input.accountId,
    accountType: input.accountType,
    title: cleanText(input.title, 120),
    amount: normalizeSignedMoney(input.amount),
    kind: input.kind,
    category: cleanText(input.category, 80),
    createdAt: new Date().toISOString(),
    detail: cleanText(input.detail, 400),
    balanceAfter: normalizeMoney(input.balanceAfter),
    relatedOrderId: cleanText(input.relatedOrderId, 120) || undefined,
  };
}

export function transferCardToWalletBalance(cardId: string, amount: number): { ok: boolean; state: WalletState; transactions?: WalletTransaction[]; error?: string } {
  const current = loadWalletState();
  const transferAmount = normalizeMoney(amount);
  if (transferAmount <= 0) return { ok: false, state: current, error: "转入金额需要大于 0。" };
  const card = current.cards.find(item => item.id === cardId);
  if (!card) return { ok: false, state: current, error: "未找到这张银行卡。" };
  if (normalizeMoney(card.balance) < transferAmount) {
    return { ok: false, state: current, error: "该银行卡余额不足，无法转入余额。" };
  }
  const now = new Date().toISOString();
  const balanceAfter = normalizeMoney(current.balance + transferAmount);
  const cardBalanceAfter = normalizeMoney(card.balance - transferAmount);
  const balanceTransaction = createTransaction({
    accountId: WALLET_BALANCE_ACCOUNT_ID,
    accountType: "balance",
    title: "银行卡转入余额",
    amount: transferAmount,
    kind: "transfer_in",
    category: "转入",
    detail: `${card.title} 转入余额 ${formatWalletAmount(transferAmount)}`,
    balanceAfter,
  });
  const cardTransaction = createTransaction({
    accountId: card.id,
    accountType: "card",
    title: "转入余额",
    amount: -transferAmount,
    kind: "transfer_out",
    category: "转入余额",
    detail: `转入余额 ${formatWalletAmount(transferAmount)}`,
    balanceAfter: cardBalanceAfter,
  });
  const next = saveWalletState({
    ...current,
    balance: balanceAfter,
    cards: current.cards.map(item => item.id === card.id ? { ...item, balance: cardBalanceAfter, updatedAt: now } : item),
    transactions: [balanceTransaction, cardTransaction, ...current.transactions],
  });
  return { ok: true, state: next, transactions: [balanceTransaction, cardTransaction] };
}

export function transferWalletBalanceToCard(cardId: string, amount: number): { ok: boolean; state: WalletState; transactions?: WalletTransaction[]; error?: string } {
  const current = loadWalletState();
  const transferAmount = normalizeMoney(amount);
  if (transferAmount <= 0) return { ok: false, state: current, error: "提现金额需要大于 0。" };
  const card = current.cards.find(item => item.id === cardId);
  if (!card) return { ok: false, state: current, error: "未找到这张银行卡。" };
  if (normalizeMoney(current.balance) < transferAmount) {
    return { ok: false, state: current, error: "余额不足，无法提现。" };
  }
  const now = new Date().toISOString();
  const balanceAfter = normalizeMoney(current.balance - transferAmount);
  const cardBalanceAfter = normalizeMoney(card.balance + transferAmount);
  const balanceTransaction = createTransaction({
    accountId: WALLET_BALANCE_ACCOUNT_ID,
    accountType: "balance",
    title: "提现到银行卡",
    amount: -transferAmount,
    kind: "transfer_out",
    category: "提现",
    detail: `提现到 ${card.title} ${formatWalletAmount(transferAmount)}`,
    balanceAfter,
  });
  const cardTransaction = createTransaction({
    accountId: card.id,
    accountType: "card",
    title: "余额提现到账",
    amount: transferAmount,
    kind: "transfer_in",
    category: "提现",
    detail: `余额提现到账 ${formatWalletAmount(transferAmount)}`,
    balanceAfter: cardBalanceAfter,
  });
  const next = saveWalletState({
    ...current,
    balance: balanceAfter,
    cards: current.cards.map(item => item.id === card.id ? { ...item, balance: cardBalanceAfter, updatedAt: now } : item),
    transactions: [balanceTransaction, cardTransaction, ...current.transactions],
  });
  return { ok: true, state: next, transactions: [balanceTransaction, cardTransaction] };
}

export function adjustWalletCardAccount(
  cardId: string,
  amount: number,
  direction: "in" | "out",
): { ok: boolean; state: WalletState; transaction?: WalletTransaction; error?: string } {
  const current = loadWalletState();
  const transferAmount = normalizeMoney(amount);
  if (transferAmount <= 0) return { ok: false, state: current, error: "金额需要大于 0。" };
  const card = current.cards.find(item => item.id === cardId);
  if (!card) return { ok: false, state: current, error: "未找到这张银行卡。" };
  const signedAmount = direction === "in" ? transferAmount : -transferAmount;
  const balanceAfter = normalizeMoney(card.balance + signedAmount);
  if (direction === "out" && normalizeMoney(card.balance) < transferAmount) {
    return { ok: false, state: current, error: "该银行卡余额不足，无法转出账户。" };
  }
  const now = new Date().toISOString();
  const transaction = createTransaction({
    accountId: card.id,
    accountType: "card",
    title: direction === "in" ? "转入账户" : "转出账户",
    amount: signedAmount,
    kind: direction === "in" ? "transfer_in" : "transfer_out",
    category: "银行卡账户",
    detail: `${card.title} ${direction === "in" ? "转入账户" : "转出账户"} ${formatWalletAmount(transferAmount)}`,
    balanceAfter,
  });
  const next = saveWalletState({
    ...current,
    cards: current.cards.map(item => item.id === card.id ? { ...item, balance: balanceAfter, updatedAt: now } : item),
    transactions: [transaction, ...current.transactions],
  });
  return { ok: true, state: next, transaction };
}

const MAX_WALLET_AMOUNT = 1_000_000_000_000;

/** 校验"直接修改余额"的目标金额；不合法时返回错误文案。 */
function validateAdjustTarget(value: unknown): { ok: true; amount: number } | { ok: false; error: string } {
  const raw = typeof value === "number" ? value : Number(String(value ?? "").replace(/[¥￥元,\s]/g, ""));
  if (!Number.isFinite(raw)) return { ok: false, error: "请输入有效的金额。" };
  if (raw < 0) return { ok: false, error: "余额不能为负。" };
  if (raw > MAX_WALLET_AMOUNT) return { ok: false, error: "金额太大啦。" };
  return { ok: true, amount: normalizeMoney(raw) };
}

/**
 * 直接把【余额】改成指定金额。
 * 会记一条"余额调整"流水（金额为差值），方便回头看改过什么。
 */
export function setWalletBalance(
  nextBalance: number,
  note = "",
): { ok: boolean; state: WalletState; transaction?: WalletTransaction; error?: string } {
  const current = loadWalletState();
  const target = validateAdjustTarget(nextBalance);
  if (!target.ok) return { ok: false, state: current, error: target.error };
  const before = normalizeMoney(current.balance);
  const delta = normalizeSignedMoney(target.amount - before);
  if (delta === 0) return { ok: false, state: current, error: "余额没有变化。" };
  const transaction = createTransaction({
    accountId: WALLET_BALANCE_ACCOUNT_ID,
    accountType: "balance",
    title: "余额调整",
    amount: delta,
    kind: "adjustment",
    category: "手动调整",
    detail: cleanText(note, 200) || `余额由 ${formatWalletAmount(before)} 调整为 ${formatWalletAmount(target.amount)}`,
    balanceAfter: target.amount,
  });
  const next = saveWalletState({
    ...current,
    balance: target.amount,
    transactions: [transaction, ...current.transactions],
  });
  return { ok: true, state: next, transaction };
}

/** 直接把某张【银行卡】的余额改成指定金额，同样记一条"余额调整"流水。 */
export function setWalletCardBalance(
  cardId: string,
  nextBalance: number,
  note = "",
): { ok: boolean; state: WalletState; transaction?: WalletTransaction; error?: string } {
  const current = loadWalletState();
  const card = current.cards.find(item => item.id === cardId);
  if (!card) return { ok: false, state: current, error: "未找到这张银行卡。" };
  const target = validateAdjustTarget(nextBalance);
  if (!target.ok) return { ok: false, state: current, error: target.error };
  const before = normalizeMoney(card.balance);
  const delta = normalizeSignedMoney(target.amount - before);
  if (delta === 0) return { ok: false, state: current, error: "余额没有变化。" };
  const transaction = createTransaction({
    accountId: card.id,
    accountType: "card",
    title: "余额调整",
    amount: delta,
    kind: "adjustment",
    category: "手动调整",
    detail: cleanText(note, 200) || `${card.title} 余额由 ${formatWalletAmount(before)} 调整为 ${formatWalletAmount(target.amount)}`,
    balanceAfter: target.amount,
  });
  const now = new Date().toISOString();
  const next = saveWalletState({
    ...current,
    cards: current.cards.map(item => item.id === card.id ? { ...item, balance: target.amount, updatedAt: now } : item),
    transactions: [transaction, ...current.transactions],
  });
  return { ok: true, state: next, transaction };
}

// ── 额度卡：亲属卡 / 亲密付 ───────────────────────────

export function getAllowanceKindLabel(kind: AllowanceCardKind): string {
  return kind === "intimate" ? "亲密付" : "亲属卡";
}

/** 例如「顾辞的亲属卡」 */
export function getAllowanceCardLabel(card: Pick<AllowanceCard, "kind" | "issuerName">): string {
  return `${card.issuerName}的${getAllowanceKindLabel(card.kind)}`;
}

/** 这个月已经用掉的额度；月份变了自动按 0 计算（每月 1 号清零）。 */
export function getAllowanceUsed(card: AllowanceCard, now: Date = new Date()): number {
  return card.usedMonth === getAllowanceMonthKey(now) ? normalizeMoney(card.usedAmount) : 0;
}

/** 这个月还剩多少额度；已关闭的卡为 0。 */
export function getAllowanceRemaining(card: AllowanceCard, now: Date = new Date()): number {
  if (card.status !== "active") return 0;
  return normalizeMoney(card.monthlyLimit - getAllowanceUsed(card, now));
}

export function listActiveAllowanceCards(state: WalletState): AllowanceCard[] {
  return (state.allowanceCards ?? []).filter(card => card.status === "active");
}

export function isAllowanceCardId(accountId: string | undefined): boolean {
  return Boolean(accountId && accountId.startsWith(ALLOWANCE_CARD_ID_PREFIX));
}

export function findAllowanceCardBySourceMessage(state: WalletState, messageId: string): AllowanceCard | undefined {
  if (!messageId) return undefined;
  return (state.allowanceCards ?? []).find(card => card.sourceMessageId === messageId);
}

/**
 * 用户收下角色开的亲属卡 / 亲密付。
 * 同一个角色、同一种卡只保留一张生效的：再次收下会更新额度（已用金额保留），而不是多出一张。
 * 同一条聊天卡片重复点击不会重复开卡。
 */
export function activateAllowanceCard(input: {
  kind: AllowanceCardKind;
  issuerId: string;
  issuerName: string;
  monthlyLimit: number;
  note?: string;
  sourceMessageId?: string;
  sessionId?: string;
}): { ok: boolean; state: WalletState; card?: AllowanceCard; error?: string } {
  const current = loadWalletState();
  const limit = normalizeMoney(input.monthlyLimit);
  if (limit <= 0) return { ok: false, state: current, error: "额度需要大于 0。" };
  const issuerId = cleanText(input.issuerId, 120);
  if (!issuerId) return { ok: false, state: current, error: "找不到开卡人。" };
  const existingCards = current.allowanceCards ?? [];

  const sameSource = input.sourceMessageId
    ? existingCards.find(card => card.sourceMessageId === input.sourceMessageId)
    : undefined;
  if (sameSource) return { ok: true, state: current, card: sameSource };

  const now = new Date().toISOString();
  const sameIssuer = existingCards.find(card => card.status === "active" && card.issuerId === issuerId && card.kind === input.kind);
  if (sameIssuer) {
    const updated: AllowanceCard = {
      ...sameIssuer,
      issuerName: cleanText(input.issuerName, 80) || sameIssuer.issuerName,
      monthlyLimit: limit,
      note: cleanText(input.note, 240) || sameIssuer.note,
      sourceMessageId: input.sourceMessageId || sameIssuer.sourceMessageId,
      sessionId: input.sessionId || sameIssuer.sessionId,
      updatedAt: now,
    };
    const next = saveWalletState({
      ...current,
      allowanceCards: existingCards.map(card => card.id === updated.id ? updated : card),
    });
    return { ok: true, state: next, card: updated };
  }

  const card: AllowanceCard = {
    id: generateWalletId(ALLOWANCE_CARD_ID_PREFIX.replace(/_$/, "")),
    kind: input.kind,
    issuerId,
    issuerName: cleanText(input.issuerName, 80) || "TA",
    monthlyLimit: limit,
    usedAmount: 0,
    usedMonth: getAllowanceMonthKey(),
    status: "active",
    note: cleanText(input.note, 240),
    sourceMessageId: input.sourceMessageId || undefined,
    sessionId: input.sessionId || undefined,
    createdAt: now,
    updatedAt: now,
  };
  const next = saveWalletState({ ...current, allowanceCards: [card, ...existingCards] });
  return { ok: true, state: next, card };
}

/** 关闭一张额度卡（关闭后不能再付款，记录保留）。 */
export function closeAllowanceCard(cardId: string): { ok: boolean; state: WalletState; card?: AllowanceCard; error?: string } {
  const current = loadWalletState();
  const existingCards = current.allowanceCards ?? [];
  const target = existingCards.find(card => card.id === cardId);
  if (!target) return { ok: false, state: current, error: "未找到这张卡。" };
  if (target.status === "closed") return { ok: true, state: current, card: target };
  const closed: AllowanceCard = { ...target, status: "closed", updatedAt: new Date().toISOString() };
  const next = saveWalletState({
    ...current,
    allowanceCards: existingCards.map(card => card.id === cardId ? closed : card),
  });
  return { ok: true, state: next, card: closed };
}

export function creditWalletBalance(amount: number, title: string, detail: string, category = "余额"): WalletPaymentResult {
  const current = loadWalletState();
  const creditAmount = normalizeMoney(amount);
  if (creditAmount <= 0) return { ok: false, state: current, error: "入账金额无效。" };
  const balanceAfter = normalizeMoney(current.balance + creditAmount);
  const transaction = createTransaction({
    accountId: WALLET_BALANCE_ACCOUNT_ID,
    accountType: "balance",
    title: title || "余额入账",
    amount: creditAmount,
    kind: "transfer_in",
    category,
    detail,
    balanceAfter,
  });
  const next = saveWalletState({
    ...current,
    balance: balanceAfter,
    transactions: [transaction, ...current.transactions],
  });
  return { ok: true, state: next, transaction };
}

export function payWithWalletAccount(input: WalletPaymentInput): WalletPaymentResult {
  const current = loadWalletState();
  const paymentAmount = normalizeMoney(input.amount);
  if (paymentAmount <= 0) return { ok: false, state: current, error: "付款金额无效。" };
  const accountId = input.accountId || input.cardId || WALLET_BALANCE_ACCOUNT_ID;
  const now = new Date().toISOString();

  const allowanceCard = (current.allowanceCards ?? []).find(item => item.id === accountId);
  if (allowanceCard) {
    const cardLabel = getAllowanceCardLabel(allowanceCard);
    if (allowanceCard.status !== "active") {
      return { ok: false, state: current, error: `${cardLabel}已关闭，无法付款。` };
    }
    const remaining = getAllowanceRemaining(allowanceCard);
    if (remaining < paymentAmount) {
      return { ok: false, state: current, error: `${cardLabel}本月剩余额度 ${formatWalletAmount(remaining)}，不够付这一笔。` };
    }
    const usedAfter = normalizeMoney(getAllowanceUsed(allowanceCard) + paymentAmount);
    const remainingAfter = normalizeMoney(allowanceCard.monthlyLimit - usedAfter);
    const transaction = createTransaction({
      accountId: allowanceCard.id,
      accountType: "allowance",
      title: cleanText(input.title, 120) || `${cardLabel}付款`,
      amount: -paymentAmount,
      kind: "payment",
      category: cleanText(input.category, 80) || "付款",
      detail: `${cardLabel}：${cleanText(input.detail, 360) || "付款"}`,
      balanceAfter: remainingAfter,
      relatedOrderId: input.relatedOrderId,
    });
    const next = saveWalletState({
      ...current,
      allowanceCards: (current.allowanceCards ?? []).map(item => item.id === allowanceCard.id
        ? { ...item, usedAmount: usedAfter, usedMonth: getAllowanceMonthKey(), updatedAt: now }
        : item),
      transactions: [transaction, ...current.transactions],
    });
    return { ok: true, state: next, transaction };
  }

  if (isBalanceAccountId(accountId)) {
    if (normalizeMoney(current.balance) < paymentAmount) {
      return { ok: false, state: current, error: "余额不足，无法完成付款。" };
    }
    const balanceAfter = normalizeMoney(current.balance - paymentAmount);
    const transaction = createTransaction({
      accountId: WALLET_BALANCE_ACCOUNT_ID,
      accountType: "balance",
      title: cleanText(input.title, 120) || "余额付款",
      amount: -paymentAmount,
      kind: "payment",
      category: cleanText(input.category, 80) || "付款",
      detail: cleanText(input.detail, 400) || "余额付款",
      balanceAfter,
      relatedOrderId: input.relatedOrderId,
    });
    const next = saveWalletState({
      ...current,
      balance: balanceAfter,
      transactions: [transaction, ...current.transactions],
    });
    return { ok: true, state: next, transaction };
  }

  const card = current.cards.find(item => item.id === accountId);
  if (!card) return { ok: false, state: current, error: "未找到付款银行卡。" };
  if (normalizeMoney(card.balance) < paymentAmount) {
    return { ok: false, state: current, error: "该银行卡余额不足，无法完成付款。" };
  }
  const balanceAfter = normalizeMoney(card.balance - paymentAmount);
  const transaction = createTransaction({
    accountId: card.id,
    accountType: "card",
    title: cleanText(input.title, 120) || "银行卡付款",
    amount: -paymentAmount,
    kind: "payment",
    category: cleanText(input.category, 80) || "付款",
    detail: cleanText(input.detail, 400) || "银行卡付款",
    balanceAfter,
    relatedOrderId: input.relatedOrderId,
  });
  const next = saveWalletState({
    ...current,
    cards: current.cards.map(item => item.id === card.id ? { ...item, balance: balanceAfter, updatedAt: now } : item),
    transactions: [transaction, ...current.transactions],
  });
  return { ok: true, state: next, transaction };
}

export function payWithWalletBalance(input: Omit<WalletPaymentInput, "accountId" | "cardId">): WalletPaymentResult {
  return payWithWalletAccount({ ...input, accountId: WALLET_BALANCE_ACCOUNT_ID });
}

export function payWithWalletCard(input: WalletPaymentInput): WalletPaymentResult {
  return payWithWalletAccount({ ...input, accountId: input.cardId || input.accountId });
}
