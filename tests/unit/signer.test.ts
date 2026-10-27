import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { LocalDevnetSponsorSigner } from "../../src/chain/signer.js";

describe("local devnet sponsor signer", () => {
  it("signs only the supplied message bytes with the configured key", async () => {
    const keypair = Keypair.generate();
    const signer = new LocalDevnetSponsorSigner(JSON.stringify(Array.from(keypair.secretKey)));
    const message = new TextEncoder().encode("authorized message");
    const signature = await signer.sign(message);
    expect(signer.publicKey.equals(keypair.publicKey)).toBe(true);
    expect(nacl.sign.detached.verify(message, signature, keypair.publicKey.toBytes())).toBe(true);
  });

  it("rejects malformed secret-key configuration", () => {
    expect(() => new LocalDevnetSponsorSigner("[1,2,3]")).toThrow("64-byte JSON array");
  });
});
