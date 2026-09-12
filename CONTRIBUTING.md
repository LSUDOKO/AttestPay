# Contributing to AttestPay

## Getting set up

```bash
bun install
git submodule update --init --recursive   # forge-std, for the contracts
cp .env.example .env                      # every Attestcoin var is optional
```

Nothing in `.env` is required to run the tests. The Attestcoin integration is off unless
`ATTESTPAY_PAYMENT_ANCHOR_ADDRESS`, `ATTESTPAY_ASC_ADDRESS` and
`ATTESTPAY_ATTESTCOIN_PRIVATE_KEY` are all set, and the server says which are missing at
boot rather than silently no-oping.

## The checks

```bash
bun run test             # engine + server suites
bun run typecheck        # per-package tsc
cd contracts && forge test
bun run --cwd packages/dashboard build
```

Run `bun run test`, not a bare `bun test`. Suites that point at an unreachable RPC on
purpose need more than bun's default 5s per-test budget, because viem retries a refused
connection before the best-effort read gives up.

CI runs exactly these four.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), because releases are cut
from them by semantic-release. Keep the subject to one line.

```
feat(engine): anchor confirmed payments on an attested chain
fix: use the revocation-nonce test seam so the suite is order-independent
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `deploy`, `docs`, `test`, `chore`.
`feat` cuts a minor release, `fix`/`perf`/`refactor`/`deploy` a patch, and
`BREAKING CHANGE:` in the body cuts a major. `docs`, `test` and `chore` release nothing.

## Tests are the argument, not the decoration

Two house rules, both learned the hard way:

- **Don't test your own encoder against your own decoder.** `ProvenTxDecoder` parses an
  encoding defined by someone else's SDK, so its fixtures are real prover output
  (`contracts/test/RealProofFixtures.sol`). Self-consistency would prove nothing.
- **A test must not depend on the network or on file ordering.** `issueRootCard` takes a
  `revocationNonceOverride` seam precisely so suites don't make live chain reads; use it.
  A suite that passes only because another suite ran first and warmed a cached RPC client
  is not passing.

## Honesty about guarantees

This project's case rests on saying exactly what is proven and what is not. If you change
anything that a user- or agent-facing surface describes as "verified", check that
`TRUST_MODEL` in `packages/server/src/mcp/attestcoin-tools.ts`, `SECURITY.md` and the
README still describe what the code actually does. An agent relaying a receipt to a human
should not be able to overstate it.

Related: compliance is counted as `withinTermsPayments` over `termsCheckedPayments`, so a
card with no registered terms gets no free 100%. Don't "fix" that into a friendlier number.

## Pull requests

Keep them focused, make CI green, and say in the description what you verified and how.
If you deviate from an approach the docs describe, say why — a deviation with a reason is
welcome, a silent one is not.
