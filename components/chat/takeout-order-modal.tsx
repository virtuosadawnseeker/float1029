"use client";

import { useState } from "react";
import { Bike, X } from "lucide-react";
import { TAKEOUT_ETA_MINUTES, TAKEOUT_QUICK_PICKS } from "@/lib/takeout";

export type TakeoutOrderInput = {
    shop: string;
    items: string;
    note: string;
    amount: number;
};

type TakeoutOrderModalProps = {
    characterName: string;
    onSend: (order: TakeoutOrderInput) => void;
    onClose: () => void;
};

export function TakeoutOrderModal({ characterName, onSend, onClose }: TakeoutOrderModalProps) {
    const [shop, setShop] = useState("");
    const [items, setItems] = useState("");
    const [amount, setAmount] = useState("");
    const [note, setNote] = useState("");

    const price = parseFloat(amount);
    const canSend = items.trim().length > 0 && Number.isFinite(price) && price > 0;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="w-[340px] max-w-[calc(100vw-32px)] max-h-[82vh] rounded-[24px] text-[var(--c-text)] overflow-hidden flex flex-col"
                style={{
                    background: "linear-gradient(180deg, var(--c-card) 0%, color-mix(in srgb, var(--c-input) 42%, var(--c-card)) 100%)",
                    boxShadow: "0 24px 60px rgba(0,0,0,0.24)",
                }}
            >
                <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <div
                            className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0"
                            style={{ background: "color-mix(in srgb, var(--c-success) 14%, var(--c-input))" }}
                        >
                            <Bike size={19} strokeWidth={1.8} />
                        </div>
                        <div className="min-w-0">
                            <div className="ts-16 font-semibold">给 {characterName} 点外卖</div>
                            <div className="ts-11 text-[var(--c-icon)] truncate">从钱包扣款 · 约 {TAKEOUT_ETA_MINUTES} 分钟后送达</div>
                        </div>
                    </div>
                    <button
                        type="button"
                        aria-label="关闭"
                        onClick={onClose}
                        className="w-9 h-9 rounded-full bg-[var(--c-input)] flex items-center justify-center"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="p-4 pt-1 flex flex-col gap-3 overflow-y-auto">
                    <div>
                        <div className="ts-12 text-[var(--c-icon)] mb-1.5">常用快选</div>
                        <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-1">
                            {TAKEOUT_QUICK_PICKS.map(pick => (
                                <button
                                    key={pick.shop + pick.items}
                                    type="button"
                                    onClick={() => { setShop(pick.shop); setItems(pick.items); setAmount(String(pick.price)); }}
                                    className="shrink-0 px-3 py-2 rounded-xl bg-[var(--c-input)] ts-12 flex items-center gap-1.5"
                                >
                                    <span>{pick.icon}</span>
                                    <span>{pick.items}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <div className="ts-12 text-[var(--c-icon)] mb-1.5">店名(选填)</div>
                        <input value={shop} onChange={e => setShop(e.target.value)} placeholder="例如：楼下那家奶茶店" maxLength={30} className="ui-input w-full" />
                    </div>
                    <div>
                        <div className="ts-12 text-[var(--c-icon)] mb-1.5">点了什么</div>
                        <input value={items} onChange={e => setItems(e.target.value)} placeholder="例如：杨枝甘露(少糖) x2" maxLength={60} className="ui-input w-full" />
                    </div>
                    <div>
                        <div className="ts-12 text-[var(--c-icon)] mb-1.5">金额(元)</div>
                        <input
                            value={amount}
                            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                            placeholder="0.00"
                            inputMode="decimal"
                            className="ui-input w-full"
                        />
                    </div>
                    <div>
                        <div className="ts-12 text-[var(--c-icon)] mb-1.5">留言(选填)</div>
                        <input value={note} onChange={e => setNote(e.target.value)} placeholder="例如：记得趁热吃" maxLength={60} className="ui-input w-full" />
                    </div>

                    <button
                        type="button"
                        disabled={!canSend}
                        onClick={() => onSend({ shop: shop.trim(), items: items.trim(), note: note.trim(), amount: Math.round(price * 100) / 100 })}
                        className="w-full py-3 rounded-2xl ts-14 font-semibold text-white disabled:opacity-40"
                        style={{ background: "var(--c-success)" }}
                    >
                        {canSend ? `支付 ¥${price.toFixed(2)} 并下单` : "下单"}
                    </button>
                </div>
            </div>
        </div>
    );
}
