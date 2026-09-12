# Security Policy

AttestPay issues scoped, revocable spending authority to AI agents and writes payment
records to public chains. A vulnerability here can move other people's money or put a
false record on a chain, so please treat reports accordingly.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:
[Report a vulnerability](https://github.com/LSUDOKO/AttestPay/security/advisories/new).

Please include what you can of: affected component (contract, engine, server, dashboard),
the chain and address if on-chain, a reproduction, and the impact you believe it has.

You can expect an acknowledgement within 72 hours and an assessment within 7 days. If a
fix is warranted we will agree disclosure timing with you before publishing.

## Scope

In scope:

- `contracts/` — `PaymentAnchor`, `AttestPayASC`, `ProvenTxDecoder`
- `packages/engine` — delegation compilation, spend authorisation, the Attestcoin pipeline
- `packages/server` — REST API, MCP tools, OAuth, webhooks
- `packages/dashboard` — the issuance flow, in particular anything that signs

Out of scope:

- The testnet deployments' funds. They are testnet funds, deliberately.
- Rate limits or availability of third-party RPCs, the 1Shot relayer, or the Attestcoin
  prover API.
- Anything requiring a compromised operator key. The anchoring key is trusted by design;
  see the trust model below.

## Trust model, stated plainly

A cross-chain proof establishes that **an anchor record with exactly those values was
included in an attested block** — trustlessly, verified on-chain by the Block Prover
precompile. It does **not** establish that the underlying Base payment happened: the
AttestPay server writes the anchor.

Every anchor therefore records the source transaction hash and the anchorer's address, so
a false claim is attributable and publicly detectable, and `AttestPayASC` credits only its
configured `trustedAnchorer`.

A report showing that a payment record can be minted **without** the trusted anchorer, or
that the decoded fields can be made to disagree with the proven transaction bytes, is a
critical finding and exactly what we want to hear about.

## Supported versions

The `main` branch is the supported version. This is hackathon-stage software on testnets;
it has not been audited and should not custody real funds.
