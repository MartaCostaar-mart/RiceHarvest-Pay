import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, bufferCV, uintCV, principalCV, someCV, noneCV } from "@stacks/transactions";

const ERR_INVALID_AMOUNT = 100;
const ERR_INVALID_INVOICE = 101;
const ERR_INVOICE_NOT_FOUND = 102;
const ERR_NOT_AUTHORIZED = 103;
const ERR_SETTLE_FAILED = 104;
const ERR_REFUND_FAILED = 105;
const ERR_BRIDGE_PAUSED = 106;
const ERR_INVALID_TIMEOUT = 107;
const ERR_LOCK_FAILED = 108;
const ERR_UNLOCK_FAILED = 109;
const ERR_SBTC_TRANSFER_FAILED = 110;
const ERR_ORACLE_NOT_VERIFIED = 111;

interface Invoice {
  invoiceHash: Buffer;
  amount: number;
  recipient: string;
  sender: string;
  timeout: number;
  status: string;
  timestamp: number;
  sbtcLockTxid?: Buffer | null;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class LightningBridgeMock {
  state: {
    nextInvoiceId: number;
    bridgePaused: boolean;
    authority: string;
    oraclePrincipal: string | null;
    invoices: Map<number, Invoice>;
    invoiceByHash: Map<string, number>;
  } = {
    nextInvoiceId: 0,
    bridgePaused: false,
    authority: "ST1AUTH",
    oraclePrincipal: null,
    invoices: new Map(),
    invoiceByHash: new Map(),
  };

  blockHeight: number = 0;
  caller: string = "ST1SENDER";
  crypto = require("crypto");

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextInvoiceId: 0,
      bridgePaused: false,
      authority: "ST1AUTH",
      oraclePrincipal: null,
      invoices: new Map(),
      invoiceByHash: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1SENDER";
  }

  setOracle(newOracle: string): Result<boolean> {
    if (this.caller !== this.state.authority) return { ok: false, value: false };
    this.state.oraclePrincipal = newOracle;
    return { ok: true, value: true };
  }

  pauseBridge(paused: boolean): Result<boolean> {
    if (this.caller !== this.state.authority) return { ok: false, value: false };
    this.state.bridgePaused = paused;
    return { ok: true, value: true };
  }

  generateInvoice(
    amount: number,
    invoiceHash: Buffer,
    recipient: string,
    timeout?: number | null
  ): Result<number> {
    if (this.state.nextInvoiceId >= 1000) return { ok: false, value: 0 };
    if (this.state.bridgePaused) return { ok: false, value: ERR_BRIDGE_PAUSED };
    if (amount <= 0) return { ok: false, value: ERR_INVALID_AMOUNT };
    if (invoiceHash.length !== 32) return { ok: false, value: ERR_INVALID_INVOICE };
    const useTimeout = timeout ?? 144;
    if (useTimeout <= 0 || useTimeout > 1008) return { ok: false, value: ERR_INVALID_TIMEOUT };
    const hashStr = invoiceHash.toString("hex");
    if (this.state.invoiceByHash.has(hashStr)) return { ok: false, value: ERR_INVOICE_NOT_FOUND };
    const id = this.state.nextInvoiceId;
    const invoice: Invoice = {
      invoiceHash,
      amount,
      recipient,
      sender: this.caller,
      timeout: this.blockHeight + useTimeout,
      status: "pending",
      timestamp: this.blockHeight,
      sbtcLockTxid: null,
    };
    this.state.invoices.set(id, invoice);
    this.state.invoiceByHash.set(hashStr, id);
    this.state.nextInvoiceId++;
    return { ok: true, value: id };
  }

  lockForInvoice(invoiceId: number, sbtcAmount: number): Result<boolean> {
    const inv = this.state.invoices.get(invoiceId);
    if (!inv) return { ok: false, value: ERR_INVOICE_NOT_FOUND };
    if (sbtcAmount !== inv.amount) return { ok: false, value: ERR_INVALID_AMOUNT };
    if (inv.status !== "pending") return { ok: false, value: 1 };
    if (this.caller !== inv.sender) return { ok: false, value: ERR_NOT_AUTHORIZED };
    const lockResult = true;
    if (!lockResult) return { ok: false, value: ERR_LOCK_FAILED };
    const txid = this.crypto.createHash("sha256").update(`${invoiceId}${this.blockHeight}`).digest();
    const updated: Invoice = {
      ...inv,
      status: "locked",
      sbtcLockTxid: txid,
    };
    this.state.invoices.set(invoiceId, updated);
    return { ok: true, value: true };
  }

  settleInvoice(invoiceId: number, preimage: Buffer): Result<boolean> {
    const inv = this.state.invoices.get(invoiceId);
    if (!inv) return { ok: false, value: ERR_INVOICE_NOT_FOUND };
    const computedHash = this.crypto.createHash("sha256").update(preimage).digest();
    if (!computedHash.equals(inv.invoiceHash)) return { ok: false, value: ERR_INVALID_INVOICE };
    if (inv.status !== "locked") return { ok: false, value: 1 };
    if (!this.state.oraclePrincipal) return { ok: false, value: ERR_ORACLE_NOT_VERIFIED };
    if (this.caller !== this.state.oraclePrincipal) return { ok: false, value: ERR_NOT_AUTHORIZED };
    const unlockResult = true;
    if (!unlockResult) return { ok: false, value: ERR_UNLOCK_FAILED };
    const updated: Invoice = {
      ...inv,
      status: "settled",
      timestamp: this.blockHeight,
    };
    this.state.invoices.set(invoiceId, updated);
    return { ok: true, value: true };
  }

  refundInvoice(invoiceId: number): Result<boolean> {
    const inv = this.state.invoices.get(invoiceId);
    if (!inv) return { ok: false, value: ERR_INVOICE_NOT_FOUND };
    if (!["locked", "pending"].includes(inv.status)) return { ok: false, value: 1 };
    if (this.blockHeight < inv.timeout) return { ok: false, value: 1 };
    if (this.caller !== inv.sender) return { ok: false, value: ERR_NOT_AUTHORIZED };
    const updated: Invoice = {
      ...inv,
      status: inv.sbtcLockTxid ? "refunded" : "expired",
      timestamp: this.blockHeight,
    };
    this.state.invoices.set(invoiceId, updated);
    return { ok: true, value: true };
  }

  getInvoice(id: number): Invoice | null {
    return this.state.invoices.get(id) ?? null;
  }

  getInvoiceByHash(hash: Buffer): Result<number> {
    const hashStr = hash.toString("hex");
    const id = this.state.invoiceByHash.get(hashStr);
    if (id === undefined) return { ok: true, value: 0 };
    return { ok: true, value: id };
  }

  isBridgeActive(): boolean {
    return !this.state.bridgePaused;
  }
}

describe("LightningBridge", () => {
  let contract: LightningBridgeMock;

  beforeEach(() => {
    contract = new LightningBridgeMock();
    contract.reset();
    contract.caller = "ST1SENDER";
  });

  it("generates an invoice successfully", () => {
    const hash = Buffer.alloc(32, 1);
    const result = contract.generateInvoice(1000, hash, "ST1RECIP", 100);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const inv = contract.getInvoice(0);
    expect(inv?.amount).toBe(1000);
    expect(inv?.recipient).toBe("ST1RECIP");
    expect(inv?.status).toBe("pending");
    expect(inv?.timeout).toBe(100);
    expect(contract.isBridgeActive()).toBe(true);
  });

  it("rejects generation when paused", () => {
    contract.caller = contract.state.authority;
    contract.pauseBridge(true);
    const hash = Buffer.alloc(32, 1);
    const result = contract.generateInvoice(1000, hash, "ST1RECIP");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_BRIDGE_PAUSED);
  });

  it("rejects invalid amount", () => {
    const hash = Buffer.alloc(32, 1);
    const result = contract.generateInvoice(0, hash, "ST1RECIP");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_AMOUNT);
  });

  it("rejects invalid invoice hash length", () => {
    const hash = Buffer.alloc(31, 1);
    const result = contract.generateInvoice(1000, hash, "ST1RECIP");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_INVOICE);
  });

  it("rejects duplicate invoice hash", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP");
    const result = contract.generateInvoice(2000, hash, "ST2RECIP");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVOICE_NOT_FOUND);
  });

  it("locks for invoice successfully", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP");
    contract.blockHeight = 1;
    const result = contract.lockForInvoice(0, 1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const inv = contract.getInvoice(0);
    expect(inv?.status).toBe("locked");
    expect(inv?.sbtcLockTxid).toBeDefined();
  });

  it("rejects lock with wrong amount", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP");
    const result = contract.lockForInvoice(0, 500);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_AMOUNT);
  });

  it("rejects lock for non-pending invoice", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP");
    contract.blockHeight = 1;
    contract.lockForInvoice(0, 1000);
    const result = contract.lockForInvoice(0, 1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(1);
  });

  it("rejects lock by non-sender", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP");
    contract.caller = "ST2FAKE";
    const result = contract.lockForInvoice(0, 1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("settles invoice successfully", () => {
    const preimage = Buffer.alloc(32, 2);
    const computedHash = contract.crypto.createHash("sha256").update(preimage).digest();
    contract.generateInvoice(1000, computedHash, "ST1RECIP");
    contract.blockHeight = 1;
    contract.lockForInvoice(0, 1000);
    contract.caller = contract.state.authority;
    contract.setOracle("ST1ORACLE");
    contract.caller = "ST1ORACLE";
    const result = contract.settleInvoice(0, preimage);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const inv = contract.getInvoice(0);
    expect(inv?.status).toBe("settled");
  });

  it("rejects settle with wrong preimage", () => {
    const hash = Buffer.alloc(32, 1);
    const preimage = Buffer.alloc(32, 2);
    contract.generateInvoice(1000, hash, "ST1RECIP");
    contract.blockHeight = 1;
    contract.lockForInvoice(0, 1000);
    contract.caller = contract.state.authority;
    contract.setOracle("ST1ORACLE");
    contract.caller = "ST1ORACLE";
    const result = contract.settleInvoice(0, preimage);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_INVOICE);
  });

  it("rejects settle without oracle", () => {
    const hash = Buffer.alloc(32, 1);
    const preimage = Buffer.alloc(32, 0);
    const computedHash = contract.crypto.createHash("sha256").update(preimage).digest();
    contract.generateInvoice(1000, computedHash, "ST1RECIP");
    contract.blockHeight = 1;
    contract.lockForInvoice(0, 1000);
    const result = contract.settleInvoice(0, preimage);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ORACLE_NOT_VERIFIED);
  });

  it("rejects settle by non-oracle", () => {
    const preimage = Buffer.alloc(32, 0);
    const computedHash = contract.crypto.createHash("sha256").update(preimage).digest();
    contract.generateInvoice(1000, computedHash, "ST1RECIP");
    contract.blockHeight = 1;
    contract.lockForInvoice(0, 1000);
    contract.caller = contract.state.authority;
    contract.setOracle("ST1ORACLE");
    contract.caller = "ST2FAKE";
    const result = contract.settleInvoice(0, preimage);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("refunds invoice after timeout successfully", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP", 5);
    contract.blockHeight = 6;
    const result = contract.refundInvoice(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const inv = contract.getInvoice(0);
    expect(inv?.status).toBe("expired");
  });

  it("refunds locked invoice after timeout", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP", 5);
    contract.blockHeight = 1;
    contract.lockForInvoice(0, 1000);
    contract.blockHeight = 7;
    const result = contract.refundInvoice(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const inv = contract.getInvoice(0);
    expect(inv?.status).toBe("refunded");
  });

  it("rejects refund before timeout", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP", 10);
    contract.blockHeight = 5;
    const result = contract.refundInvoice(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(1);
  });

  it("rejects refund by non-sender", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP", 5);
    contract.blockHeight = 6;
    contract.caller = "ST2FAKE";
    const result = contract.refundInvoice(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("rejects refund for settled invoice", () => {
    const preimage = Buffer.alloc(32, 0);
    const computedHash = contract.crypto.createHash("sha256").update(preimage).digest();
    contract.generateInvoice(1000, computedHash, "ST1RECIP", 5);
    contract.blockHeight = 1;
    contract.lockForInvoice(0, 1000);
    contract.caller = contract.state.authority;
    contract.setOracle("ST1ORACLE");
    contract.caller = "ST1ORACLE";
    contract.settleInvoice(0, preimage);
    contract.blockHeight = 6;
    contract.caller = "ST1SENDER";
    const result = contract.refundInvoice(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(1);
  });

  it("sets oracle successfully", () => {
    contract.caller = "ST1AUTH";
    const result = contract.setOracle("ST1ORACLE");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.oraclePrincipal).toBe("ST1ORACLE");
  });

  it("rejects set oracle by non-authority", () => {
    const result = contract.setOracle("ST1ORACLE");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("pauses bridge successfully", () => {
    contract.caller = "ST1AUTH";
    const result = contract.pauseBridge(true);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.isBridgeActive()).toBe(false);
  });

  it("retrieves invoice by hash correctly", () => {
    const hash = Buffer.alloc(32, 1);
    contract.generateInvoice(1000, hash, "ST1RECIP");
    const result = contract.getInvoiceByHash(hash);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const badHash = Buffer.alloc(32, 2);
    const badResult = contract.getInvoiceByHash(badHash);
    expect(badResult.ok).toBe(true);
    expect(badResult.value).toBe(0);
  });
});