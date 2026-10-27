import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { buildSponsoredTransaction, serializeTransaction } from "../../src/policy/construction.js";
import { validateSponsoredTransaction, type ValidationContext } from "../../src/policy/validator.js";
import { policyFixture, signPayload, transferInstruction, type PolicyFixture } from "../fixtures.js";

function validate(fixture: PolicyFixture, payload: Uint8Array, context: ValidationContext = fixture.context) {
  return validateSponsoredTransaction(payload, fixture.snapshot, context);
}

function mutated(fixture: PolicyFixture, mutate: (transaction: Transaction) => Transaction | void): Uint8Array {
  const transaction = buildSponsoredTransaction(fixture.snapshot);
  const replacement = mutate(transaction);
  return signPayload(fixture, replacement ?? transaction);
}

function mutateSigned(fixture: PolicyFixture, mutate: (transaction: Transaction) => void): Uint8Array {
  const transaction = Transaction.from(signPayload(fixture));
  mutate(transaction);
  transaction.signatures = [];
  return serializeTransaction(transaction);
}

describe("sponsored transaction policy", () => {
  it("accepts the exact authorized user-signed transaction", () => {
    const fixture = policyFixture();
    const result = validate(fixture, signPayload(fixture));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messageHash).toBe(fixture.context.canonicalMessageHash);
  });

  it("accepts the explicitly constructed recipient ATA instruction", () => {
    const fixture = policyFixture(true);
    const result = validate(fixture, signPayload(fixture));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["changed recipient", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transferInstruction(transaction).keys[2]!.pubkey = Keypair.generate().publicKey;
    })],
    ["amount changed by one minor unit", (fixture: PolicyFixture) => signPayload(fixture,
      buildSponsoredTransaction({ ...fixture.snapshot, amountMinor: "1000001" }))],
    ["changed mint", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transferInstruction(transaction).keys[1]!.pubkey = Keypair.generate().publicKey;
    })],
    ["changed decimals", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transferInstruction(transaction).data[9] = 7;
    })],
    ["changed source authority", (fixture: PolicyFixture) => mutateSigned(fixture, (transaction) => {
      transferInstruction(transaction).keys[3]!.pubkey = Keypair.generate().publicKey;
    })],
    ["removed reference", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transferInstruction(transaction).keys.pop();
    })],
    ["replaced reference", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transferInstruction(transaction).keys[4]!.pubkey = Keypair.generate().publicKey;
    })],
    ["writable reference", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transferInstruction(transaction).keys[4]!.isWritable = true;
    })],
    ["changed fee payer", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transaction.feePayer = Keypair.generate().publicKey;
    })],
    ["sponsor as token authority", (fixture: PolicyFixture) => mutateSigned(fixture, (transaction) => {
      transferInstruction(transaction).keys[3]!.pubkey = fixture.sponsor.publicKey;
    })],
    ["extra instruction", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transaction.add(SystemProgram.transfer({
        fromPubkey: fixture.user.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }));
    })],
    ["sponsor SOL withdrawal", (fixture: PolicyFixture) => mutated(fixture, (transaction) => {
      transaction.add(SystemProgram.transfer({
        fromPubkey: fixture.sponsor.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }));
    })],
  ])("rejects %s", (_name, payloadFactory) => {
    const fixture = policyFixture();
    expect(validate(fixture, payloadFactory(fixture)).ok).toBe(false);
  });

  it("rejects a modified recipient ATA account", () => {
    const fixture = policyFixture(true);
    const payload = mutated(fixture, (transaction) => {
      transaction.instructions[0]!.keys[1]!.pubkey = Keypair.generate().publicKey;
    });
    expect(validate(fixture, payload).ok).toBe(false);
  });

  it("rejects an invalid user signature", () => {
    const fixture = policyFixture();
    const transaction = Transaction.from(signPayload(fixture));
    const user = transaction.signatures.find((entry) => entry.publicKey.equals(fixture.user.publicKey))!;
    user.signature![0] = user.signature![0]! ^ 1;
    expect(validate(fixture, serializeTransaction(transaction)).ok).toBe(false);
  });

  it("rejects a transaction already signed by the sponsor", () => {
    const fixture = policyFixture();
    const transaction = buildSponsoredTransaction(fixture.snapshot);
    transaction.partialSign(fixture.user, fixture.sponsor);
    const result = validate(fixture, serializeTransaction(transaction));
    expect(result).toMatchObject({ ok: false, code: "sponsor_signature_present" });
  });

  it("rejects an expired blockhash", () => {
    const fixture = policyFixture();
    const result = validate(fixture, signPayload(fixture), { ...fixture.context, currentBlockHeight: 101 });
    expect(result).toMatchObject({ ok: false, code: "transaction_expired" });
  });

  it("rejects a persisted message-hash mismatch", () => {
    const fixture = policyFixture();
    const canonicalMessageHash = createHash("sha256").update("different").digest("hex");
    const result = validate(fixture, signPayload(fixture), { ...fixture.context, canonicalMessageHash });
    expect(result).toMatchObject({ ok: false, code: "message_hash_mismatch" });
  });

  it("fails closed on malformed transaction bytes", () => {
    const fixture = policyFixture();
    expect(validate(fixture, new Uint8Array([1, 2, 3])).ok).toBe(false);
  });
});
