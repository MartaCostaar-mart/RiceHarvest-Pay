import { describe, it, expect, beforeEach } from "vitest";
import { uintCV, principalCV, bufferCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_SALARY_AMOUNT = 101;
const ERR_INVALID_PAY_PERIOD = 102;
const ERR_INVALID_WORKER_PRINCIPAL = 103;
const ERR_ESCROW_ALREADY_EXISTS = 104;
const ERR_ESCROW_NOT_FOUND = 105;
const ERR_INVALID_TIMESTAMP = 106;
const ERR_RELEASE_NOT_AUTHORIZED = 107;
const ERR_REFUND_PERIOD_NOT_ENDED = 108;
const ERR_INVALID_PROOF_HASH = 109;
const ERR_MAX_ESCROWS_EXCEEDED = 110;
const ERR_INVALID_REFUND_AMOUNT = 111;
const ERR_ESCROW_ALREADY_RELEASED = 112;

const EMPLOYER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const WORKER1 = "ST2JHG361ZXG51QTK7KL2NC6QXJG749S4J3BY2D3M";
const WORKER2 = "ST3NBRSFKX28QQYCG565RJ7KQSNJ6E3BR7TPN73QR";
const FAKE = "ST1HTBVD3JG9C05J7HBJTHGR0GGW7K2QL8N499R32";
const TOKEN = `${EMPLOYER}.rice-usd-token`;
const CONTRACT_PRINCIPAL = `${EMPLOYER}.rice-pay-escrow`;

interface Escrow {
  employer: string;
  worker: string;
  salaryAmount: number;
  payPeriodStart: number;
  payPeriodEnd: number;
  tokenContract: string;
  proofHash: Uint8Array;
  status: string;
  timestamp: number;
  releasedTo: string | null;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class TokenMock {
  balances: Map<string, number> = new Map();

  constructor() {
    this.balances.set(EMPLOYER, 1000000);
    this.balances.set("contract", 0);
  }

  transfer(from: string, to: string, amount: number): Result<boolean> {
    const balance = this.balances.get(from) || 0;
    if (balance < amount) {
      return { ok: false, value: false };
    }
    this.balances.set(from, balance - amount);
    const toBalance = this.balances.get(to) || 0;
    this.balances.set(to, toBalance + amount);
    return { ok: true, value: true };
  }
}

class RicePayEscrowMock {
  state: {
    nextEscrowId: number;
    maxEscrows: number;
    adminPrincipal: string;
    escrows: Map<number, Escrow>;
    escrowsByEmployerWorker: Map<string, number>;
  } = {
    nextEscrowId: 0,
    maxEscrows: 500,
    adminPrincipal: EMPLOYER,
    escrows: new Map(),
    escrowsByEmployerWorker: new Map(),
  };
  blockHeight: number = 0;
  caller: string = EMPLOYER;
  tokenMock: TokenMock;

  constructor() {
    this.tokenMock = new TokenMock();
    this.reset();
  }

  reset() {
    this.state = {
      nextEscrowId: 0,
      maxEscrows: 500,
      adminPrincipal: EMPLOYER,
      escrows: new Map(),
      escrowsByEmployerWorker: new Map(),
    };
    this.blockHeight = 0;
    this.caller = EMPLOYER;
    this.tokenMock = new TokenMock();
  }

  setAdminPrincipal(newAdmin: string): Result<boolean> {
    if (this.caller !== this.state.adminPrincipal) {
      return { ok: false, value: false };
    }
    if (newAdmin.includes(".") || !newAdmin.startsWith("ST")) {
      return { ok: false, value: ERR_INVALID_WORKER_PRINCIPAL };
    }
    this.state.adminPrincipal = newAdmin;
    return { ok: true, value: true };
  }

  setMaxEscrows(newMax: number): Result<boolean> {
    if (this.caller !== this.state.adminPrincipal) {
      return { ok: false, value: false };
    }
    if (newMax <= 0) {
      return { ok: false, value: false };
    }
    this.state.maxEscrows = newMax;
    return { ok: true, value: true };
  }

  lockSalary(
    worker: string,
    salaryAmount: number,
    payPeriodStart: number,
    payPeriodEnd: number,
    tokenContract: string,
    proofHash: Uint8Array
  ): Result<number> {
    if (this.state.nextEscrowId >= this.state.maxEscrows) {
      return { ok: false, value: ERR_MAX_ESCROWS_EXCEEDED };
    }
    if (proofHash.length !== 32) {
      return { ok: false, value: ERR_INVALID_PROOF_HASH };
    }
    if (!worker.startsWith("ST") || worker.includes(".") || worker === this.caller) {
      return { ok: false, value: ERR_INVALID_WORKER_PRINCIPAL };
    }
    if (salaryAmount <= 0) {
      return { ok: false, value: ERR_INVALID_SALARY_AMOUNT };
    }
    if (!(payPeriodStart > 0 && payPeriodEnd > payPeriodStart)) {
      return { ok: false, value: ERR_INVALID_PAY_PERIOD };
    }
    const key = `${this.caller}-${worker}`;
    if (this.state.escrowsByEmployerWorker.has(key)) {
      return { ok: false, value: ERR_ESCROW_ALREADY_EXISTS };
    }
    const transferResult = this.tokenMock.transfer(this.caller, "contract", salaryAmount);
    if (!transferResult.ok) {
      return { ok: false, value: false };
    }
    const id = this.state.nextEscrowId;
    const escrow: Escrow = {
      employer: this.caller,
      worker,
      salaryAmount,
      payPeriodStart,
      payPeriodEnd,
      tokenContract,
      proofHash,
      status: "locked",
      timestamp: this.blockHeight,
      releasedTo: null,
    };
    this.state.escrows.set(id, escrow);
    this.state.escrowsByEmployerWorker.set(key, id);
    this.state.nextEscrowId++;
    return { ok: true, value: id };
  }

  getEscrow(id: number): Escrow | null {
    return this.state.escrows.get(id) || null;
  }

  getEscrowByEmployerWorker(employer: string, worker: string): number | null {
    const key = `${employer}-${worker}`;
    return this.state.escrowsByEmployerWorker.get(key) || null;
  }

  releaseToWorker(id: number, providedHash: Uint8Array): Result<boolean> {
    const escrow = this.state.escrows.get(id);
    if (!escrow) {
      return { ok: false, value: false };
    }
    if (!arraysEqual(escrow.proofHash, providedHash)) {
      return { ok: false, value: ERR_INVALID_PROOF_HASH };
    }
    if (escrow.status !== "locked") {
      return { ok: false, value: ERR_ESCROW_ALREADY_RELEASED };
    }
    if (this.blockHeight < escrow.payPeriodEnd) {
      return { ok: false, value: ERR_REFUND_PERIOD_NOT_ENDED };
    }
    if (!(this.caller === escrow.employer || this.caller === escrow.worker)) {
      return { ok: false, value: ERR_RELEASE_NOT_AUTHORIZED };
    }
    const transferResult = this.tokenMock.transfer("contract", escrow.worker, escrow.salaryAmount);
    if (!transferResult.ok) {
      return { ok: false, value: false };
    }
    const updatedEscrow: Escrow = {
      ...escrow,
      status: "released",
      timestamp: this.blockHeight,
      releasedTo: escrow.worker,
    };
    this.state.escrows.set(id, updatedEscrow);
    return { ok: true, value: true };
  }

  claimRefund(id: number): Result<boolean> {
    const escrow = this.state.escrows.get(id);
    if (!escrow) {
      return { ok: false, value: false };
    }
    if (this.caller !== escrow.employer) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }
    if (escrow.status !== "locked") {
      return { ok: false, value: ERR_ESCROW_ALREADY_RELEASED };
    }
    if (this.blockHeight <= escrow.payPeriodEnd) {
      return { ok: false, value: ERR_REFUND_PERIOD_NOT_ENDED };
    }
    const transferResult = this.tokenMock.transfer("contract", this.caller, escrow.salaryAmount);
    if (!transferResult.ok) {
      return { ok: false, value: false };
    }
    const updatedEscrow: Escrow = {
      ...escrow,
      status: "refunded",
      timestamp: this.blockHeight,
      releasedTo: null,
    };
    this.state.escrows.set(id, updatedEscrow);
    return { ok: true, value: true };
  }

  getEscrowCount(): Result<number> {
    return { ok: true, value: this.state.nextEscrowId };
  }

  checkEscrowExistence(employer: string, worker: string): Result<boolean> {
    const key = `${employer}-${worker}`;
    return { ok: true, value: this.state.escrowsByEmployerWorker.has(key) };
  }
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe("RicePayEscrow", () => {
  let contract: RicePayEscrowMock;

  beforeEach(() => {
    contract = new RicePayEscrowMock();
    contract.reset();
  });

  it("locks salary successfully", () => {
    const proofHash = new Uint8Array(32);
    const result = contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const escrow = contract.getEscrow(0);
    expect(escrow?.employer).toBe(EMPLOYER);
    expect(escrow?.worker).toBe(WORKER1);
    expect(escrow?.salaryAmount).toBe(500);
    expect(escrow?.payPeriodStart).toBe(100);
    expect(escrow?.payPeriodEnd).toBe(200);
    expect(escrow?.tokenContract).toBe(TOKEN);
    expect(escrow?.proofHash).toEqual(proofHash);
    expect(escrow?.status).toBe("locked");
    expect(contract.tokenMock.balances.get("contract")).toBe(500);
  });

  it("rejects duplicate escrow for same employer-worker", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    const result = contract.lockSalary(
      WORKER1,
      600,
      150,
      250,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ESCROW_ALREADY_EXISTS);
  });

  it("rejects invalid worker principal", () => {
    const proofHash = new Uint8Array(32);
    const result = contract.lockSalary(
      "INVALID",
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_WORKER_PRINCIPAL);
  });

  it("rejects invalid salary amount", () => {
    const proofHash = new Uint8Array(32);
    const result = contract.lockSalary(
      WORKER1,
      0,
      100,
      200,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_SALARY_AMOUNT);
  });

  it("rejects invalid pay period", () => {
    const proofHash = new Uint8Array(32);
    const result = contract.lockSalary(
      WORKER1,
      500,
      0,
      200,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_PAY_PERIOD);
  });

  it("rejects invalid proof hash length", () => {
    const proofHash = new Uint8Array(31);
    const result = contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_PROOF_HASH);
  });

  it("rejects lock with insufficient token balance", () => {
    contract.tokenMock.balances.set(EMPLOYER, 400);
    const proofHash = new Uint8Array(32);
    const result = contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("releases to worker successfully after period end", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 201;
    contract.caller = WORKER1;
    const result = contract.releaseToWorker(0, proofHash);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const escrow = contract.getEscrow(0);
    expect(escrow?.status).toBe("released");
    expect(escrow?.releasedTo).toBe(WORKER1);
    expect(contract.tokenMock.balances.get(WORKER1)).toBe(500);
  });

  it("rejects release with wrong proof hash", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 201;
    const wrongHash = new Uint8Array(32).fill(1);
    const result = contract.releaseToWorker(0, wrongHash);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_PROOF_HASH);
  });

  it("rejects release before period end", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 150;
    const result = contract.releaseToWorker(0, proofHash);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_REFUND_PERIOD_NOT_ENDED);
  });

  it("rejects release by unauthorized caller", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 201;
    contract.caller = FAKE;
    const result = contract.releaseToWorker(0, proofHash);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_RELEASE_NOT_AUTHORIZED);
  });

  it("rejects release after already released", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 201;
    contract.releaseToWorker(0, proofHash);
    const result = contract.releaseToWorker(0, proofHash);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ESCROW_ALREADY_RELEASED);
  });

  it("claims refund successfully after period end", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 201;
    const result = contract.claimRefund(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const escrow = contract.getEscrow(0);
    expect(escrow?.status).toBe("refunded");
    expect(escrow?.releasedTo).toBeNull();
    expect(contract.tokenMock.balances.get(EMPLOYER)).toBe(1000000);
  });

  it("rejects refund before period end", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 150;
    const result = contract.claimRefund(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_REFUND_PERIOD_NOT_ENDED);
  });

  it("rejects refund by non-employer", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 201;
    contract.caller = FAKE;
    const result = contract.claimRefund(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("rejects refund after released", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.blockHeight = 201;
    contract.caller = WORKER1;
    contract.releaseToWorker(0, proofHash);
    contract.caller = EMPLOYER;
    const result = contract.claimRefund(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ESCROW_ALREADY_RELEASED);
  });

  it("sets admin principal successfully", () => {
    const result = contract.setAdminPrincipal(WORKER1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.adminPrincipal).toBe(WORKER1);
  });

  it("rejects set admin by non-admin", () => {
    contract.caller = FAKE;
    const result = contract.setAdminPrincipal(WORKER1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("sets max escrows successfully", () => {
    const result = contract.setMaxEscrows(1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.maxEscrows).toBe(1000);
  });

  it("rejects set max escrows by non-admin", () => {
    contract.caller = FAKE;
    const result = contract.setMaxEscrows(1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects lock with max escrows exceeded", () => {
    contract.state.maxEscrows = 1;
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    const result = contract.lockSalary(
      WORKER2,
      600,
      150,
      250,
      TOKEN,
      proofHash
    );
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_MAX_ESCROWS_EXCEEDED);
  });

  it("returns correct escrow count", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    contract.lockSalary(
      WORKER2,
      600,
      150,
      250,
      TOKEN,
      proofHash
    );
    const result = contract.getEscrowCount();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
  });

  it("checks escrow existence correctly", () => {
    const proofHash = new Uint8Array(32);
    contract.lockSalary(
      WORKER1,
      500,
      100,
      200,
      TOKEN,
      proofHash
    );
    let result = contract.checkEscrowExistence(EMPLOYER, WORKER1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    result = contract.checkEscrowExistence(EMPLOYER, WORKER2);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(false);
  });

  it("rejects release for non-existent escrow", () => {
    const proofHash = new Uint8Array(32);
    const result = contract.releaseToWorker(99, proofHash);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects refund for non-existent escrow", () => {
    const result = contract.claimRefund(99);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });
});