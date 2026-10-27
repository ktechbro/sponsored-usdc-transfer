# Sponsored USDC Transfer

A devnet-only TypeScript module for sponsoring the network fee of an exact, user-authorized SPL USDC transfer on Solana. The user keeps custody of their wallet and signs the transfer; the sponsor pays only the transaction fee and, when required, creation of the recipient's associated token account.

The central security invariant is:

> The sponsor signs only the exact serialized message that passed default-deny policy validation.

This repository is a portfolio reference implementation, not a production custody or payment service. It does not support mainnet, arbitrary transaction signing, token launches, trading, lending, NFTs, or DeFi.

## What it demonstrates

- Self-custodial user authorization without backend access to user private keys.
- Exact SPL `transferChecked` construction using integer minor units.
- Optional idempotent recipient associated token account creation.
- Exact transaction-policy verification before sponsor signing.
- Cryptographic verification of the user's Ed25519 signature.
- Exact-transaction simulation without signature replacement or blockhash substitution.
- Transactional per-user and global sponsor-cost budgets with PostgreSQL row locking.
- Database-enforced immutable sponsorship-usage records and an audit-event trail.
- Idempotent construction and submission replay.
- One RPC submission attempt per signed payload, including safe handling of ambiguous timeouts.
- A signer interface that can be replaced by a KMS, HSM, or Turnkey-backed implementation.

## Architecture

```text
Client wallet                    Sponsorship service                 Solana devnet
     |                                   |                                  |
     |-- create payment intent --------->|                                  |
     |-- request construction ---------->|-- genesis / ATA / fee / blockhash ->|
     |<- exact unsigned transaction -----|                                  |
     |                                   |                                  |
     |-- sign with user key (client only)|                                  |
     |-- submit user-signed bytes ------>|                                  |
     |                                   |-- validate exact policy           |
     |                                   |-- simulate exact transaction ---->|
     |                                   |-- reserve budget in PostgreSQL    |
     |                                   |-- sponsor signs validated message |
     |                                   |-- persist submission record       |
     |                                   |-- submit once ------------------->|
     |<- signature / ambiguous status ---|                                  |
```

PostgreSQL stores payment intents, persisted policy snapshots, canonical message hashes, budget usage, submission state, and audit events. An external watcher such as [Solana Payment Reliability](https://github.com/ktechbro/solana-payment-reliability) should resolve ambiguous submissions and reconcile observed chain state; that watcher is not included in this repository.

## Default-deny transaction policy

A submitted payload must match the persisted construction snapshot and canonical message hash. Validation rejects the request before sponsor signing if any protected property differs.

| Area | Enforced rule |
| --- | --- |
| Network | RPC genesis hash must equal the hard-coded devnet genesis hash. |
| Expiry | Current time and block height must be within the stored validity window. |
| Fee payer | The configured sponsor must be the fee payer. |
| Signers | The exact expected signer set and order are required. |
| User authorization | A valid user signature over the exact serialized message is required. |
| Sponsor state | A sponsor signature supplied before validation is rejected. |
| Instructions | Only optional idempotent recipient ATA creation and one SPL `transferChecked` are allowed. |
| Transfer | Source, destination, mint, owner authority, amount, and decimals must exactly match the snapshot. |
| Reference | Exactly one expected read-only, non-signing reference account is required. |
| Account metadata | Program IDs, account order, signer flags, writability, and instruction data must match exactly. |
| Sponsor isolation | The sponsor cannot appear in the token transfer as source, destination, owner, or another token account. |
| Message integrity | The expected, supplied, and reconstructed SHA-256 message hashes must agree. |

Simulation is a diagnostic and eligibility check, not the security boundary. It uses the validated transaction with `sigVerify: false` and `replaceRecentBlockhash: false`, so the RPC cannot silently substitute a different blockhash.

## Submission and budget semantics

1. Replaying an already submitted payload returns its stored signature without another signer call or RPC submission.
2. Submitting different bytes for an already submitted attempt returns `idempotency_mismatch`.
3. Simulation happens before budget reservation and before sponsor signing.
4. PostgreSQL `FOR UPDATE` locks serialize global and per-user budget reservations.
5. The signed payload hash and sponsor signature are committed as `sponsor_signed` with an explicit "outcome unknown" marker before the external RPC call. `submitted` is written only after the RPC acknowledges the signature.
6. An RPC timeout, crash before the call, or other submission error leaves a durable ambiguous record. A retry returns the stored signature with `ambiguous: true` instead of blindly submitting again.
7. A separate chain watcher must determine whether an ambiguous transaction actually landed.

Budget usage records the estimated total sponsor cost — the transaction fee plus any recipient ATA rent — and is immutable. Production reconciliation should separately account for actual observed fees.

## API

All routes except `/health` and `/ready` require:

```http
Authorization: Bearer <API_AUTH_TOKEN>
```

This is internal service authentication, not an end-user identity system.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Static liveness probe; does not query the chain or database. |
| `GET` | `/ready` | PostgreSQL readiness. |
| `POST` | `/payment-intents` | Create a fixed USDC payment intent. |
| `POST` | `/payments/:id/sponsored-transaction` | Construct or reuse an exact unsigned transaction. |
| `POST` | `/sponsored-transactions/:id/sign-and-submit` | Validate, co-sign, and submit user-signed bytes. |
| `GET` | `/sponsored-transactions/:id` | Inspect sponsorship and submission state. |

### Create a payment intent

```bash
curl -X POST http://localhost:3003/payment-intents \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-123",
    "ownerWallet": "<USER_WALLET>",
    "recipientOwner": "<RECIPIENT_WALLET>",
    "amountMinor": "1000000",
    "expiresAt": "<FUTURE_ISO_TIMESTAMP>"
  }'
```

`amountMinor` is a base-unit integer string: `1000000` is `1.000000` for six-decimal USDC. The server derives the source ATA and generates the payment reference; clients cannot supply arbitrary instructions.

### Construct the transaction

```bash
curl -X POST \
  "http://localhost:3003/payments/$PAYMENT_INTENT_ID/sponsored-transaction" \
  -H "Authorization: Bearer $API_AUTH_TOKEN"
```

The response contains the unsigned transaction as canonical base64, its sponsorship ID, canonical message hash, estimated total sponsor cost, and expiry. Do not add a JSON content-type header to this empty request.

### Sign on the client

```ts
import { Transaction } from "@solana/web3.js";

const transaction = Transaction.from(Buffer.from(unsignedBase64, "base64"));
transaction.partialSign(userKeypair);
const userSignedBase64 = transaction.serialize({
  requireAllSignatures: false,
  verifySignatures: false,
}).toString("base64");
```

`userKeypair` represents a client-side wallet and must never be sent to this service. An embedded-wallet integration can replace this example while preserving the same boundary: the backend receives signed bytes, never the user's private key.

### Submit the user-signed transaction

```bash
curl -X POST \
  "http://localhost:3003/sponsored-transactions/$SPONSORSHIP_ID/sign-and-submit" \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"transaction\":\"$USER_SIGNED_BASE64\"}"
```

A definite submission returns HTTP `200`; an ambiguous external RPC outcome returns HTTP `202` with `ambiguous: true`. Neither response alone proves final on-chain confirmation.

## Local setup

### Requirements

- Node.js 22 or newer.
- pnpm 11.
- Docker with Docker Compose for PostgreSQL 16.
- A devnet-only sponsor keypair. Use a separate key with no mainnet authority or funds.

### Configure

```bash
pnpm install
cp .env.example .env
pnpm db:up
```

Set a long random `API_AUTH_TOKEN` and a devnet-only `SPONSOR_SECRET_KEY` in `.env`. The local signer accepts only a 64-byte JSON keypair array. After installing dependencies, a disposable development key can be generated with:

```bash
node --input-type=module -e \
  'import { Keypair } from "@solana/web3.js"; console.log(JSON.stringify(Array.from(Keypair.generate().secretKey)))'
```

The command prints secret material to the terminal; use it only for a disposable devnet key. `.env` is ignored by Git. Never commit, return, or log the sponsor secret.

The application reads environment variables from the process rather than automatically loading `.env`. In Git Bash, export the file before running migrations or the server:

```bash
set -a
source .env
set +a
pnpm db:migrate
pnpm dev
```

The API listens on port `3003`; Docker PostgreSQL listens on host port `5435`.

For a real devnet submission, the sponsor needs enough devnet SOL for fees and any sponsored ATA rent. The user needs a funded source USDC token account but does not need SOL. Use only devnet faucets and test assets.

### Production build

```bash
pnpm build
pnpm start
```

## Verification

```bash
pnpm test              # Policy and signer unit tests
pnpm test:integration  # PostgreSQL-backed service and HTTP tests
pnpm test:all
pnpm typecheck
pnpm build
```

Integration tests use `TEST_DATABASE_URL`, defaulting to `sponsored_usdc_transfer_test` on port `5435`, and run serially because they reset the test database.

Current verification evidence:

- 22 unit tests and 15 PostgreSQL/HTTP integration tests pass.
- Strict type checking and the production build pass.
- Tests mutate the recipient, mint, amount, decimals, authority, reference, fee payer, ATA accounts, signatures, expiry, and instruction set, including a crafted sponsor SOL-withdrawal attempt.
- Concurrent integration tests prove budget reservations cannot exceed the configured global limit.
- Replay and RPC-timeout tests prove that a signed payload is not submitted twice.
- Regression tests prove that an expired or cancelled intent cannot reuse a previously constructed transaction.
- A live devnet smoke test successfully constructed transactions through real RPC calls.
- The live smoke test rejected a one-minor-unit tamper with `transfer_mismatch` and recorded no sponsor signature.
- A valid but unfunded transaction failed exact-transaction simulation with `simulation_failed` and recorded no sponsor signature.

## Limitations and production requirements

- **Devnet only.** Configuration rejects every other Solana cluster, and the devnet genesis hash is hard-coded rather than environment-controlled. An RPC endpoint pointed at another cluster fails validation before construction or signing. No mainnet or real-funds use is authorized by this implementation.
- **No funded zero-SOL acceptance claim.** A successful end-to-end devnet transfer using a user with USDC but zero SOL has not yet been executed. The live test used unfunded ephemeral accounts specifically to verify safe simulation failure.
- **Local signer is for development only.** The JSON keypair signer keeps a secret in server memory and is not a production key-management design. Production should implement `SponsorSigner` with KMS/HSM/Turnkey controls, restricted signing permissions, rotation, monitoring, and audited access while retaining the exact-message policy checks.
- **Narrow transaction support.** Only legacy transactions, classic SPL Token, one exact transfer, and optional recipient ATA creation are supported. Versioned transactions, Token-2022, multisig authorities, and arbitrary instructions are intentionally rejected or unsupported.
- **Internal API boundary.** Production deployment still needs the parent application's user authentication, authorization, anti-abuse controls, tenant isolation, and secure transport.
- **Recovery is external.** This module preserves ambiguous submissions but does not confirm, finalize, recover, or reconcile them. Pair it with an independent watcher before considering real payment flows.
- **Operational controls are still required.** Production needs RPC redundancy, alert thresholds, sponsor-balance monitoring, database backups, secret management, rate limiting at the edge, and reviewed fee/budget policy.

## Project layout

```text
src/
  chain/       Devnet RPC gateway and sponsor-signer boundary
  db/          PostgreSQL pool, migrations, and row mapping
  http/        Fastify routes, authentication, and error mapping
  policy/      Exact transaction construction and default-deny validation
  service/     Intents, budgets, sponsorship orchestration, and audit events
  config.ts    Validated devnet-only environment configuration
  domain.ts    Payment, sponsorship, and immutable policy-snapshot types
tests/
  unit/        Tamper matrix and signer tests
  integration/ PostgreSQL, concurrency, replay, timeout, and HTTP tests
```
