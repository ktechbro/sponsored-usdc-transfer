import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

export interface SponsorSigner {
  readonly publicKey: PublicKey;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export class LocalDevnetSponsorSigner implements SponsorSigner {
  private readonly keypair: Keypair;

  constructor(secretKey: string) {
    const parsed: unknown = JSON.parse(secretKey);
    if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      throw new Error("SPONSOR_SECRET_KEY must be a 64-byte JSON array");
    }
    this.keypair = Keypair.fromSecretKey(Uint8Array.from(parsed));
  }

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, this.keypair.secretKey);
  }
}
