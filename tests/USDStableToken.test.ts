import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, uintCV, principalCV, bufferCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INSUFFICIENT_COLLATERAL = 101;
const ERR_ORACLE_NOT_VERIFIED = 102;
const ERR_INVALID_MINT_AMOUNT = 103;
const ERR_INVALID_BURN_AMOUNT = 104;
const ERR_UNDER_COLLATERALIZED = 105;
const ERR_PEGGING_FAILED = 106;
const ERR_COLLATERAL_TRANSFER_FAILED = 107;
const ERR_RATIO_NOT_SET = 108;
const ERR_ORACLE_PRICE_ZERO = 109;
const ERR_MINT_EXCEEDS_RESERVES = 110;

interface Result<T> {
  ok: boolean;
  value: T;
}

interface CollateralBalance {
  user: string;
  amount: bigint;
}

class USDStableTokenMock {
  state: {
    admin: string;
    oracle: string;
    minCollateralRatio: bigint;
    pegPrice: bigint;
    totalCollateral: bigint;
    collateralBalances: Map<string, bigint>;
    userStableBalances: Map<string, bigint>;
    userCollateral: Map<string, bigint>;
    tokenSupply: bigint;
    stxBalances: Map<string, bigint>;
  } = {
    admin: "ST1TEST",
    oracle: "ST1TEST",
    minCollateralRatio: BigInt(150),
    pegPrice: BigInt(1000000),
    totalCollateral: BigInt(0),
    collateralBalances: new Map(),
    userStableBalances: new Map(),
    userCollateral: new Map(),
    tokenSupply: BigInt(0),
    stxBalances: new Map([
      ["ST1TEST", BigInt(1000000000000)],
    ]),
  };

  blockHeight: bigint = BigInt(0);
  caller: string = "ST1TEST";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      admin: "ST1TEST",
      oracle: "ST1TEST",
      minCollateralRatio: BigInt(150),
      pegPrice: BigInt(1000000),
      totalCollateral: BigInt(0),
      collateralBalances: new Map(),
      userStableBalances: new Map(),
      userCollateral: new Map(),
      tokenSupply: BigInt(0),
      stxBalances: new Map([
        ["ST1TEST", BigInt(1000000000000)],
      ]),
    };
    this.blockHeight = BigInt(0);
    this.caller = "ST1TEST";
  }

  setAdmin(newAdmin: string): Result<boolean> {
    if (this.caller !== this.state.admin) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  setOracle(newOracle: string): Result<boolean> {
    if (this.caller !== this.state.admin) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }
    this.state.oracle = newOracle;
    return { ok: true, value: true };
  }

  setMinCollateralRatio(ratio: bigint): Result<boolean> {
    if (this.caller !== this.state.admin) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }
    if (ratio <= BigInt(100)) {
      return { ok: false, value: ERR_RATIO_NOT_SET };
    }
    this.state.minCollateralRatio = ratio;
    return { ok: true, value: true };
  }

  updatePegPrice(price: bigint): Result<boolean> {
    if (this.caller !== this.state.oracle) {
      return { ok: false, value: ERR_ORACLE_NOT_VERIFIED };
    }
    if (price === BigInt(0)) {
      return { ok: false, value: ERR_ORACLE_PRICE_ZERO };
    }
    this.state.pegPrice = price;
    return { ok: true, value: true };
  }

  depositCollateral(amount: bigint): Result<bigint> {
    const sender = this.caller;
    const currentBalance = this.getCollateralBalance(sender);
    const newBalance = currentBalance + amount;
    const senderStx = this.state.stxBalances.get(sender) || BigInt(0);
    if (senderStx < amount) {
      return { ok: false, value: ERR_COLLATERAL_TRANSFER_FAILED };
    }
    this.state.stxBalances.set(sender, senderStx - amount);
    this.state.collateralBalances.set(sender, newBalance);
    this.state.totalCollateral += amount;
    this.state.userCollateral.set(sender, newBalance);
    return { ok: true, value: newBalance };
  }

  withdrawCollateral(amount: bigint): Result<bigint> {
    const sender = this.caller;
    const currentBalance = this.getCollateralBalance(sender);
    if (currentBalance < amount) {
      return { ok: false, value: ERR_INSUFFICIENT_COLLATERAL };
    }
    if (!this.isCollateralized(sender)) {
      return { ok: false, value: ERR_UNDER_COLLATERALIZED };
    }
    const newBalance = currentBalance - amount;
    this.state.stxBalances.set(sender, (this.state.stxBalances.get(sender) || BigInt(0)) + amount);
    this.state.collateralBalances.set(sender, newBalance);
    this.state.totalCollateral -= amount;
    this.state.userCollateral.set(sender, newBalance);
    return { ok: true, value: newBalance };
  }

  mintStable(amount: bigint): Result<bigint> {
    const sender = this.caller;
    const collateral = this.getCollateralBalance(sender);
    const price = this.state.pegPrice;
    const requiredCollateral = (amount * price) / BigInt(1000000);
    const needed = requiredCollateral * this.state.minCollateralRatio / BigInt(100);
    const currentStable = this.getStableBalance(sender);
    const newMint = currentStable + amount;
    const totalSupply = this.state.tokenSupply;
    if (amount === BigInt(0)) {
      return { ok: false, value: ERR_INVALID_MINT_AMOUNT };
    }
    if (collateral < needed) {
      return { ok: false, value: ERR_INSUFFICIENT_COLLATERAL };
    }
    if (totalSupply + amount > this.state.totalCollateral) {
      return { ok: false, value: ERR_MINT_EXCEEDS_RESERVES };
    }
    this.state.tokenSupply += amount;
    this.state.userStableBalances.set(sender, newMint);
    return { ok: true, value: newMint };
  }

  burnStable(amount: bigint): Result<bigint> {
    const sender = this.caller;
    const currentBalance = this.getStableBalance(sender);
    if (currentBalance < amount) {
      return { ok: false, value: ERR_INVALID_BURN_AMOUNT };
    }
    const newBalance = currentBalance - amount;
    this.state.tokenSupply -= amount;
    this.state.userStableBalances.set(sender, newBalance);
    return { ok: true, value: newBalance };
  }

  transfer(amount: bigint, sender: string, recipient: string, memo?: Buffer): Result<boolean> {
    if (amount === BigInt(0)) {
      return { ok: false, value: ERR_INVALID_MINT_AMOUNT };
    }
    const senderBalance = this.getStableBalance(sender);
    if (senderBalance < amount) {
      return { ok: false, value: ERR_INVALID_BURN_AMOUNT };
    }
    const newSenderBalance = senderBalance - amount;
    const recipientBalance = this.getStableBalance(recipient);
    const newRecipientBalance = recipientBalance + amount;
    this.state.userStableBalances.set(sender, newSenderBalance);
    this.state.userStableBalances.set(recipient, newRecipientBalance);
    return { ok: true, value: true };
  }

  getName(): Result<string> {
    return { ok: true, value: "USD Stable Token" };
  }

  getSymbol(): Result<string> {
    return { ok: true, value: "USDS" };
  }

  getDecimals(): Result<bigint> {
    return { ok: true, value: BigInt(6) };
  }

  getBalance(account: string): Result<bigint> {
    return { ok: true, value: this.getStableBalance(account) };
  }

  getTotalSupply(): Result<bigint> {
    return { ok: true, value: this.state.tokenSupply };
  }

  getTokenUri(): Result<null> {
    return { ok: true, value: null };
  }

  adjustPegReserves(delta: bigint): Result<bigint> {
    if (this.caller !== this.state.oracle) {
      return { ok: false, value: ERR_ORACLE_NOT_VERIFIED };
    }
    const newPeg = this.state.pegPrice + delta;
    if (newPeg <= BigInt(0) || newPeg > BigInt(2000000)) {
      return { ok: false, value: ERR_PEGGING_FAILED };
    }
    this.state.pegPrice = newPeg;
    return { ok: true, value: newPeg };
  }

  emergencyPauseMinting(pause: boolean): Result<boolean> {
    if (this.caller !== this.state.admin) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }
    return { ok: true, value: true };
  }

  private getCollateralBalance(user: string): bigint {
    return this.state.collateralBalances.get(user) || BigInt(0);
  }

  private getStableBalance(user: string): bigint {
    return this.state.userStableBalances.get(user) || BigInt(0);
  }

  private isCollateralized(user: string): boolean {
    const collateral = this.getCollateralBalance(user);
    const stable = this.getStableBalance(user);
    const price = this.state.pegPrice;
    const ratio = (collateral * BigInt(1000000)) / (stable * price);
    return ratio >= this.state.minCollateralRatio;
  }
}

describe("USDStableToken", () => {
  let contract: USDStableTokenMock;

  beforeEach(() => {
    contract = new USDStableTokenMock();
    contract.reset();
  });

  it("sets admin successfully", () => {
    const result = contract.setAdmin("ST2TEST");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.admin).toBe("ST2TEST");
  });

  it("rejects set admin by non-admin", () => {
    contract.caller = "ST2FAKE";
    const result = contract.setAdmin("ST3TEST");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("sets oracle successfully", () => {
    const result = contract.setOracle("ST2TEST");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.oracle).toBe("ST2TEST");
  });

  it("rejects set oracle by non-admin", () => {
    contract.caller = "ST2FAKE";
    const result = contract.setOracle("ST3TEST");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("sets min collateral ratio successfully", () => {
    const result = contract.setMinCollateralRatio(BigInt(200));
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.minCollateralRatio).toBe(BigInt(200));
  });

  it("rejects invalid min collateral ratio", () => {
    const result = contract.setMinCollateralRatio(BigInt(50));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_RATIO_NOT_SET);
  });

  it("updates peg price successfully", () => {
    const result = contract.updatePegPrice(BigInt(1050000));
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.pegPrice).toBe(BigInt(1050000));
  });

  it("rejects peg price update by non-oracle", () => {
    contract.caller = "ST2FAKE";
    const result = contract.updatePegPrice(BigInt(1050000));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ORACLE_NOT_VERIFIED);
  });

  it("rejects zero peg price", () => {
    const result = contract.updatePegPrice(BigInt(0));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ORACLE_PRICE_ZERO);
  });

  it("deposits collateral successfully", () => {
    const result = contract.depositCollateral(BigInt(1000000));
    expect(result.ok).toBe(true);
    expect(result.value).toBe(BigInt(1000000));
    expect(contract.state.totalCollateral).toBe(BigInt(1000000));
    expect(contract.getCollateralBalance("ST1TEST")).toBe(BigInt(1000000));
  });

  it("rejects collateral deposit without sufficient STX", () => {
    contract.state.stxBalances.set("ST1TEST", BigInt(500000));
    const result = contract.depositCollateral(BigInt(1000000));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_COLLATERAL_TRANSFER_FAILED);
  });

  it("rejects collateral withdrawal without sufficient balance", () => {
    const result = contract.withdrawCollateral(BigInt(1000000));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_COLLATERAL);
  });

  it("mints stable successfully", () => {
    contract.depositCollateral(BigInt(3000000));
    const result = contract.mintStable(BigInt(1000000));
    expect(result.ok).toBe(true);
    expect(result.value).toBe(BigInt(1000000));
    expect(contract.state.tokenSupply).toBe(BigInt(1000000));
  });

  it("rejects mint with insufficient collateral", () => {
    contract.depositCollateral(BigInt(1000000));
    const result = contract.mintStable(BigInt(1000000));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_COLLATERAL);
  });

  it("rejects zero mint amount", () => {
    const result = contract.mintStable(BigInt(0));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_MINT_AMOUNT);
  });

  it("burns stable successfully", () => {
    contract.depositCollateral(BigInt(3000000));
    contract.mintStable(BigInt(1000000));
    const result = contract.burnStable(BigInt(500000));
    expect(result.ok).toBe(true);
    expect(result.value).toBe(BigInt(500000));
    expect(contract.state.tokenSupply).toBe(BigInt(500000));
  });

  it("rejects burn with insufficient balance", () => {
    const result = contract.burnStable(BigInt(1000000));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_BURN_AMOUNT);
  });

  it("transfers stable successfully", () => {
    contract.depositCollateral(BigInt(3000000));
    contract.mintStable(BigInt(1000000));
    const result = contract.transfer(BigInt(500000), "ST1TEST", "ST2TEST");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getStableBalance("ST1TEST")).toBe(BigInt(500000));
    expect(contract.getStableBalance("ST2TEST")).toBe(BigInt(500000));
  });

  it("rejects transfer with insufficient balance", () => {
    const result = contract.transfer(BigInt(1000000), "ST1TEST", "ST2TEST");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_BURN_AMOUNT);
  });

  it("rejects zero transfer amount", () => {
    const result = contract.transfer(BigInt(0), "ST1TEST", "ST2TEST");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_MINT_AMOUNT);
  });

  it("adjusts peg reserves successfully", () => {
    const result = contract.adjustPegReserves(BigInt(50000));
    expect(result.ok).toBe(true);
    expect(result.value).toBe(BigInt(1050000));
  });

  it("rejects peg adjustment by non-oracle", () => {
    contract.caller = "ST2FAKE";
    const result = contract.adjustPegReserves(BigInt(50000));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ORACLE_NOT_VERIFIED);
  });

  it("rejects invalid peg adjustment", () => {
    const result = contract.adjustPegReserves(BigInt(-2000000));
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PEGGING_FAILED);
  });

  it("pauses minting successfully", () => {
    const result = contract.emergencyPauseMinting(true);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
  });

  it("rejects pause by non-admin", () => {
    contract.caller = "ST2FAKE";
    const result = contract.emergencyPauseMinting(true);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("returns correct SIP-010 values", () => {
    expect(contract.getName().value).toBe("USD Stable Token");
    expect(contract.getSymbol().value).toBe("USDS");
    expect(contract.getDecimals().value).toBe(BigInt(6));
    expect(contract.getBalance("ST1TEST").value).toBe(BigInt(0));
    expect(contract.getTotalSupply().value).toBe(BigInt(0));
    expect(contract.getTokenUri().value).toBe(null);
  });
});