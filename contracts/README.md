# Weightlings contracts (Robinhood Chain 4663)

- `CreatureWallet` — one USDG wallet per creature (or lineage). Customer payments are held whole per run
  (`pay`, EIP-3009 receive or transfer form), then `charge`/`chargeAndSettle`/`refund` with a bytes32 receipt
  in the `Charged` event. Per-run and per-UTC-day caps, owner pause, factory-wide guardian pause, withdraw
  limited to free money, profit liens with a one-way checkpoint, run-to-run `payAgent` on an owner list,
  ERC-1271 for ERC-8004 `setAgentWallet`. Anyone may release a hold after 1 day; an unbilled payment then
  goes back to its payer.
- `WeightlingsFactory` — permissionless `createAgent` (EIP-1167 clone via CREATE2, optional ERC-8004 identity
  minted and passed to the owner). Operator, markup (max 50%), treasury, guardian, rates and network cost
  change only by propose → 2 days → accept within 7 days.
- `WeightlingsTreasury` — where charges land; owner withdraws; two-step ownership.

The ABI (function, event and error names, selectors) is identical to the reference it was ported from, so a
server written against `pay/open/charge/refund/payAgent/createAgent/isAgentWallet` works unchanged.

## Build and test

```
forge build
forge test --no-match-path "test/Fork*"                       # unit, review and invariant suites
FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path "test/Fork*" -vv   # real USDG + ERC-8004, local fork only
```

## Deploy (a human, later)

```
node scripts/deploy.mjs --dry-run                              # gas + ETH at current eth_gasPrice, sends nothing
DEPLOYER_KEY=0x... OPERATOR=0x<server operator address> node scripts/deploy.mjs
```

Optional env: `OWNER`, `GUARDIAN`, `MARKUP_BPS` (default 2000), `TREASURY` (reuse), `FIRST_WALLET_OWNER`,
`PER_RUN_CAP`, `PER_DAY_CAP`, `SPEC_HASH`, `AGENT_URI`, `PUBLISH_NETWORK_COST`. The script asks you to type
`deploy`, reads every setting back from the chain, writes `deployments/<chain>-<time>.json` and prints the env
lines for the server. Rehearse first against a local fork:
`anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8547` then `RPC_URL=http://127.0.0.1:8547 ...`.

Measured on a local fork (2026-11-22): treasury 367,698 gas, factory with wallet implementation 6,450,974,
createAgent with ERC-8004 identity 552,575. Robinhood Chain charges no L1 data component at present
(ArbGasInfo L1 base fee estimate is 0), so gas × eth_gasPrice is the cost.
