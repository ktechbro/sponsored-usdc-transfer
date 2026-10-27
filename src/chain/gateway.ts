import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { z } from "zod";

const simulationResponseSchema = z.object({
  result: z.object({ value: z.object({ err: z.unknown() }) }).optional(),
  error: z.object({ message: z.string() }).optional(),
});

export interface LatestBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface ChainGateway {
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(): Promise<LatestBlockhash>;
  getBlockHeight(): Promise<number>;
  accountExists(address: PublicKey): Promise<boolean>;
  getFeeLamports(transaction: Transaction): Promise<number>;
  getRentExemptionLamports(space: number): Promise<number>;
  simulate(transaction: Transaction): Promise<void>;
  submit(transaction: Transaction, expectedSignature: string): Promise<string>;
}

export class SolanaChainGateway implements ChainGateway {
  private readonly connection: Connection;

  constructor(private readonly rpcUrl: string) {
    this.connection = new Connection(rpcUrl, { commitment: "confirmed" });
  }

  async getGenesisHash(): Promise<string> {
    return this.connection.getGenesisHash();
  }

  async getLatestBlockhash(): Promise<LatestBlockhash> {
    return this.connection.getLatestBlockhash("confirmed");
  }

  async getBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight("confirmed");
  }

  async accountExists(address: PublicKey): Promise<boolean> {
    return (await this.connection.getAccountInfo(address, "confirmed")) !== null;
  }

  async getFeeLamports(transaction: Transaction): Promise<number> {
    const response = await this.connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
    if (response.value === null) throw new Error("RPC could not estimate the transaction fee");
    return response.value;
  }

  async getRentExemptionLamports(space: number): Promise<number> {
    return this.connection.getMinimumBalanceForRentExemption(space, "confirmed");
  }

  async simulate(transaction: Transaction): Promise<void> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [
          transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
          { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" },
        ],
      }),
    });
    const body = simulationResponseSchema.parse(await response.json());
    if (!response.ok || body.error || !body.result) throw new Error("Simulation RPC request failed");
    if (body.result.value.err) throw new Error(`Simulation failed: ${JSON.stringify(body.result.value.err)}`);
  }

  async submit(transaction: Transaction, expectedSignature: string): Promise<string> {
    const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    if (signature !== expectedSignature) throw new Error("RPC returned an unexpected transaction signature");
    return signature;
  }
}
