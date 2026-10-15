export type WalletCardStyle = "obsidian" | "graphite" | "silver";

export type WalletCard = {
  id: string;
  title: string;
  bankLabel: string;
  maskedNumber: string;
  cardStyle: WalletCardStyle;
  balance: number;
  note: string;
  accentLabel: string;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WalletAccountType = "balance" | "card" | "allowance";

export type WalletTransactionKind = "transfer_in" | "transfer_out" | "payment" | "refund" | "adjustment";

export type WalletTransaction = {
  id: string;
  cardId: string;
  accountType?: WalletAccountType;
  title: string;
  amount: number;
  kind: WalletTransactionKind;
  category: string;
  createdAt: string;
  detail: string;
  balanceAfter: number;
  relatedOrderId?: string;
};

/** 额度卡：亲属卡 / 亲密付。由角色开给用户，用户付款时扣的是额度，而不是自己的余额。 */
export type AllowanceCardKind = "family" | "intimate";
export type AllowanceCardStatus = "active" | "closed";

export type AllowanceCard = {
  id: string;
  kind: AllowanceCardKind;
  /** 开卡的角色 ID / 名字 */
  issuerId: string;
  issuerName: string;
  /** 每月额度 */
  monthlyLimit: number;
  /** usedMonth 这个月里已经用掉的金额；月份变了就视为 0 */
  usedAmount: number;
  /** 形如 2026-10 */
  usedMonth: string;
  status: AllowanceCardStatus;
  note: string;
  /** 来源的聊天卡片消息，用来避免重复领取 */
  sourceMessageId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type WalletState = {
  balance: number;
  cards: WalletCard[];
  /** 亲属卡 / 亲密付；旧数据没有这个字段 */
  allowanceCards?: AllowanceCard[];
  transactions: WalletTransaction[];
  defaultCardId: string;
  updatedAt: string;
};

export type WalletPaymentInput = {
  accountId?: string;
  cardId?: string;
  amount: number;
  title: string;
  detail: string;
  category?: string;
  relatedOrderId?: string;
};

export type WalletPaymentResult = {
  ok: boolean;
  state: WalletState;
  transaction?: WalletTransaction;
  error?: string;
};
