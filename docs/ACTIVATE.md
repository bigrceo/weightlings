# Switching paid hires on

Everything is built and rehearsed on a local fork. Nothing is deployed, nothing is set on Railway, and hires stay free
until the steps below are run. One command does the chain part; Railway is two more.

## What it costs

Measured on a fork of Robinhood Chain at today's gas price (0.02 gwei), with a 30% margin:

| | gas | ETH at 0.02 gwei |
|---|---|---|
| deploy (treasury + factory) | 6,818,672 | 0.00014 |
| reserve: 20 creature wallets (372,116 each) | 7,442,320 | 0.00015 |
| reserve: 50 paid hires (pay 253,101 + charge 169,687) | 21,139,400 | 0.00042 |
| total + 30% | | **about 0.0009 ETH** |

`node scripts/activate.mjs` prints the exact figure at the moment you run it and refuses below it, saying how much is
missing. 0.003 ETH covers the deploy and roughly 300 paid hires or new wallets after it. The operator pays gas for every
paid hire (two transactions), so keep an eye on its balance: below 1.5M gas worth (x2) the server refuses new paid hires
with "the operator is low on gas", and nothing is charged.

## The commands (owner)

From `~/weightlings`, after sending the ETH to the operator `0x988bf4E4Aba3F7Cfc5b4dfd95581061B7E63F00e` on Robinhood Chain (4663):

```
node scripts/activate.mjs --dry-run          # optional: the whole thing again on a local fork, 36 checks, sends nothing
node scripts/activate.mjs                    # checks the balance, asks you to type "deploy", deploys, verifies
sed -n 's/^OPERATOR_KEY=//p' .secrets/operator.env | npx -y @railway/cli variable set OPERATOR_KEY --stdin --skip-deploys
node scripts/activate.mjs --apply            # sets the addresses on Railway, then PAYMENTS=on last (one redeploy)
```

- The second command is safe to run again: addresses and transaction hashes go to `.secrets/deployed.json` as soon as they
  exist, and a run that was interrupted picks up where it stopped (it finds a contract that was sent but not recorded at its
  predictable address, and never deploys twice).
- It reads every setting back from the chain (owner, operator, guardian, treasury, USDG, ERC-8004 registry, markup 20%,
  pause off, and the deployed code against the build) and stops on any difference.
- The key is read from `.secrets/operator.env` only. It is never printed. The `sed ... | railway variable set --stdin` line
  pipes it straight from the file to Railway: it is never shown and never on a command line.
- `--apply` sets `CHAIN_ID, USDG, FACTORY, FACTORY_BLOCK, TREASURY, MARKUP_BPS, WALLETS_PER_DAY` without redeploying, then
  checks that `OPERATOR_KEY` is on Railway and belongs to the operator (in memory, never printed), and only then sets
  `PAYMENTS=on`. If the key is not there yet it stops and says so; payments stay off.

## How a paid hire works once it is on

1. A visitor asks to hire a creature. If the creature has no wallet yet, the server makes one now (`createAgent`), owned by
   the wallet that founded the creature's lineage. At most `WALLETS_PER_DAY` (20) new wallets a day, and at most 3 per
   visitor connection an hour. No wallet is made in advance.
2. The answer is 402 with the price and an EIP-712 message to sign: USDG `ReceiveWithAuthorization` to the creature's wallet.
   The visitor signs it. No gas, no transaction of their own.
3. The server checks the signature, amount, time window, nonce and funds, simulates, then the operator sends `pay`: the
   creature's wallet pulls the payment in and holds all of it for this run.
4. The hire runs. Its model cost is capped by the run's budget (the price less the markup).
5. Done: `charge(run, model cost, workHash)`. Model cost + 20% markup go to the treasury; the rest stays in the creature's
   wallet as its earnings. Failed: `refund(run, 0, workHash)`, the whole payment goes back to the visitor.
6. The signed receipt carries both transaction hashes (`paidBy.payTx`, `settlement.tx`). `workHash` is the sha256 of the
   receipt without `settlement`, and the same value is in the contract's `Charged` event, so anyone can tie the receipt to
   the chain: `node server/hire/verify-receipt.mjs https://<site>/api/hire/<id> --rpc https://rpc.mainnet.chain.robinhood.com`.

If the creature's wallet would refuse the payment (its owner paused it or lowered its limits), the server refuses before
sending anything: no transaction, the visitor's signature stays unused.

Who owns a creature's earnings: the owner of its wallet contract, which is the lineage wallet when it is made. It changes
only through the contract (`transferOwnership` then `acceptOwnership`, signed by the current owner). The server cannot move
it or take the money; the owner withdraws with `withdraw(USDG, to, amount)`.

## What the site can show

- `GET /api/earnings`: per creature wallet, `earned` (USDG paid in, net of refunds), `cost` (model cost + markup charged),
  `profit` (what the owner keeps), `withdrawable`, `runs` (charged, refunded, open), `owner` (from the chain) and whether it
  is the lineage wallet. Read from the chain, cached 60 s.
- `GET /api/earnings/total`: the same, summed, plus the treasury's balance.
- With `PAYMENTS` off both answer `{ "live": false }`, and nothing anywhere claims earnings.
- `GET /api/hire/config` names the mode, factory, treasury and prices; `GET /api/hire/<id>` adds `payment` (the run's
  on-chain record and any late settlement, signed).

The hire page does not sign payments yet: a page that wants paid hires asks the visitor's wallet to sign `terms.sign.typedData`
(eth_signTypedData_v4) and sends the result in the `X-PAYMENT` header, as described in `terms.sign.how`.

## Switching it off

- `npx -y @railway/cli variable set PAYMENTS=off`: hires are free again (the operator's daily budget), earnings answer
  `{ live: false }`. Money already in creature wallets stays there, owned by their lineage wallets.
- Emergency, on chain: the guardian (the operator address by default) calls `factory.setOperatorPaused(true)`. No meter can
  act on any wallet until it is unpaused; owners can still withdraw.

## Settings (Railway variables, all optional except the first group)

| variable | default | meaning |
|---|---|---|
| `PAYMENTS`, `FACTORY`, `TREASURY`, `USDG`, `OPERATOR_KEY` | | the switch, the addresses, the operator's key |
| `WALLETS_PER_DAY` | 20 | new creature wallets a day |
| `WALLET_PER_RUN_CAP` / `WALLET_PER_DAY_CAP` | 250000 / 12500000 | each new wallet's limits in USDG units (0.25 / 12.5 USDG); its owner can change them |
| `PAY_MIN_GAS` | 1500000 | gas the operator must be able to pay (x2) before taking a payment |
| `PAY_RPC_URL` | the public RPC | where the operator reads and sends |
| `HIRE_PRICE_<TIER>` | 50000 ... 300000 | price per tier in USDG units |

## What was not tested

- Nothing ran on Robinhood Chain itself: every transaction in the rehearsal is on a local fork, signed by throwaway keys.
- The hire engine was driven by a local stand-in for the Anthropic API (no key on this machine): the payment, charge,
  refund and receipt path is real; the model's answer in the rehearsal is not.
- `--apply` was exercised against a stand-in Railway CLI (it recorded the calls), not against Railway.
- The background retrier (a settlement that failed, or a payment held when the server restarted) is written but was not
  forced to happen in the rehearsal. If it ever fails for a day, the contract itself lets anyone release the hold and the
  payment goes back to the visitor.
- The standard x402 `TransferWithAuthorization` form is accepted but only the `ReceiveWithAuthorization` form was rehearsed.
