# CommSwap v2: Decentralized Commodity Swap

Smart contracts + full test suite + a local DApp for the CommSwap paper (NIT Trichy).
Your original Remix files are untouched in `../contracts/`. This folder is the fixed version.

```
commswap-v2/
  contracts/CommSwap.sol          main contract (all paper fixes)
  contracts/MockV3Aggregator.sol  Chainlink-compatible mock oracle WITH round history
  contracts/test/RejectingAcceptor.sol  attacker contract used in tests
  test/CommSwap.test.js           35 automated tests (every scenario in the paper + attacks)
  scripts/deploy.js               deploys to local chain, seeds price history, writes frontend/config.js
  frontend/                       the DApp (index.html, app.js, style.css)
  CHANGES.md                      every bug found in v1 and how v2 fixes it (viva material)
```

## Run it (Windows, needs Node.js 18+)

Open the `commswap-v2` folder in a terminal (VS Code terminal is fine).

```bash
npm install                 # once
npm test                    # runs the 35 tests, prints the gas table
```

Then for the DApp, two terminals:

```bash
# terminal 1: local blockchain (leave it running)
npm run node

# terminal 2: deploy contracts + oracles
npm run deploy              # clean start: nobody registered
# or
npm run deploy:seed         # Alice, Bob, Carol registered + one GOLD proposal already open
```

Now double-click `frontend/index.html` (opens in Chrome/Edge). No MetaMask needed: the DApp uses the
local node's unlocked demo accounts and you switch between them with the **Acting as** dropdown.

If you restart `npm run node`, the chain is wiped, so run the deploy again and reload the page.
Compiling uses the solc bundled in `node_modules`, so no internet is needed after `npm install`
(ethers.js is also copied locally by the deploy script).

## Accounts in the DApp

| Dropdown | Role |
|---|---|
| Oracle Admin | deployer, maps commodities to feeds, pushes oracle prices (the trusted reporter) |
| Alice, Bob, Carol, Dave, Mallory | traders |

Price buttons always sign with the Oracle Admin account, whoever you are "acting as".

## Demo script (about 5 minutes inside a 15 minute slot)

Use `npm run deploy:seed` before you present so registration is already done.

1. **Show the proposal.** Acting as Alice: proposal #0 GOLD × 10, LONG, K = 1.00 *taken from the oracle*.
   Point at the K box: "nobody can type a fake reference price".
2. **Accept.** Switch to Bob, click *Accept & lock 3 ETH*. Switch to Carol, accept too.
   Show the acceptors table with reputation snapshots.
3. **Select.** Switch to Alice, click *Select* on Bob. Swap #0 starts. Carol now has a
   *Withdraw my acceptance* button (pull refund, no loop).
4. **Settlement 1 (long wins).** GOLD *+10%* (1.10). Click *Jump to settlement time*, then *Settle round 1*.
   1 ETH moves from Bob to Alice inside the contract (still locked). Bob gets a margin call with a
   60 s grace period. Both reputations go 5 → 6.
5. **Top-up.** Switch to Bob, click *Top up* (amount is pre-filled). Back to 3 ETH.
6. **Front-running / timing defence.** Jump to settlement time, *then* push GOLD to 2.00, then settle.
   The round is priced at 1.10 because the contract reads the oracle round that was live at the
   scheduled time. Calling late or racing the oracle update changes nothing.
   Then type 1.10 in GOLD's box and *Push price* to put the market back.
7. **Default.** Do not top up. *+1 min* and *+30s*, click *Enforce* → Bob −2 reputation.
   Jump and settle again → swap terminates, Bob's remaining collateral is slashed to Alice,
   Bob's reputation is set to 2.
8. **Withdraw.** Alice clicks *Withdraw* and the ETH lands in her wallet.

Bonus scenario (loss bigger than collateral): new proposal, select, GOLD +50%, settle.
The short owes a shortfall. Either top up (shortfall goes to the counterparty's locked balance)
or let the grace period expire and *Enforce* → serious default, insurance pool pays the winner.

## Using Remix instead

`CommSwap.sol` and `MockV3Aggregator.sol` compile in Remix as is (compiler 0.8.24, optimizer on).
Order: deploy `MockV3Aggregator(8, 100000000, "GOLD/ETH")`, deploy
`CommSwap(10000000000000000, 60, 120, 600)`, call `addCommodity("GOLD", <feed>, 86400)`.
Remix VM cannot fast-forward time, so you wait the real 120 s period. Pass `0` as `roundIdHint` to `settle`.

## Key design rules implemented

| Rule | Value |
|---|---|
| Payoff per period | (P − K) × Q, long receives when positive, short when negative |
| K | oracle price at proposal creation (staleness checked) |
| Settlement price | oracle round live at the scheduled time (`start + n × period`) |
| Who can settle / enforce | anyone (permissionless keeper) |
| Reputation | start 5, +1 per clean settlement (cap 10), −2 missed top-up, set to 2 on serious default |
| Under-collateralised at next settlement | that settlement runs, then terminate; under-collateralised winner gets nothing |
| Loss > collateral | shortfall must be repaid within grace, else serious default |
| On default | defaulter's remaining collateral slashed to honest party, insurance pool covers unpaid shortfall |
| Registration fee | goes to the insurance pool, nobody (not even the owner) can withdraw it |
| Payments | everything credited to `withdrawable`, users pull with `withdraw()` |
| Bounds | max 20 acceptors, max 52 periods, quantity ≤ 1e9, oracle search ≤ 100 rounds |

## Gas (Hardhat, optimizer 200 runs)

| Function | Gas |
|---|---|
| deploy CommSwap | 4,587,596 |
| register | 67,490 |
| createRequest | 180,351 |
| acceptRequest | 124,536 |
| selectCounterparty | 283,252 |
| withdrawAcceptance | 70,909 |
| settle (contract searches the round) | 136,204 |
| topUp | 45,445 |
| withdraw | 32,388 |
| oracle updateAnswer | 97,608 |
