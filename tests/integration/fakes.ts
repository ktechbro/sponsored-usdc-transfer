import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { ChainGateway, LatestBlockhash } from "../../src/chain/gateway.js";
import type { SponsorSigner } from "../../src/chain/signer.js";
import { DEVNET_GENESIS } from "../fixtures.js";

export class FakeChainGateway implements ChainGateway {
  readonly accounts = new Set<string>();
  readonly blockhash = Keypair.generate().publicKey.toBase58();
  readonly lastValidBlockHeight = 1_000;
  blockHeight = 999;
  genesisHash = DEVNET_GENESIS;
  feeLamports = 5_000;
  rentExemptionLamports = 2_039_280;
  failSimulation = false;
  failSubmission = false;
  beforeSubmission?: () => Promise<void>;
  simulationCalls = 0;
  submissionCalls = 0;

  async getGenesisHash(): Promise<string> {
    return this.genesisHash;
  }

  async getLatestBlockhash(): Promise<LatestBlockhash> {
    return { blockhash: this.blockhash, lastValidBlockHeight: this.lastValidBlockHeight };
  }

  async getBlockHeight(): Promise<number> {
    return this.blockHeight;
  }

  async accountExists(address: PublicKey): Promise<boolean> {
    return this.accounts.has(address.toBase58());
  }

  async getFeeLamports(_transaction: Transaction): Promise<number> {
    return this.feeLamports;
  }

  async getRentExemptionLamports(_space: number): Promise<number> {
    return this.rentExemptionLamports;
  }

  async simulate(_transaction: Transaction): Promise<void> {
    this.simulationCalls += 1;
    if (this.failSimulation) throw new Error("simulation failed");
  }

  async submit(transaction: Transaction, expectedSignature: string): Promise<string> {
    this.submissionCalls += 1;
    if (!transaction.signature) throw new Error("Missing sponsor signature");
    if (this.beforeSubmission) await this.beforeSubmission();
    if (this.failSubmission) throw new Error("RPC timeout");
    return expectedSignature;
  }
}

export class FakeSponsorSigner implements SponsorSigner {
  readonly keypair = Keypair.generate();
  calls = 0;

  get publicKey(): PublicKey {
    return this.keypair.publicKey;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    this.calls += 1;
    return nacl.sign.detached(message, this.keypair.secretKey);
  }
}
