# What was wrong in v1 (`contracts/commodity.sol`) and how v2 fixes it

Every fix below has at least one automated test in `test/CommSwap.test.js`.

## Critical (money or security)

| # | v1 problem | Impact | v2 fix |
|---|---|---|---|
| 1 | Proposer typed `referencePrice` **and** passed any `priceFeed` address | Creator can point the swap at his own fake oracle and set any price | Owner maps commodity → feed once (oracle governance). K is read from that feed at creation |
| 2 | `topUpCollateral` sends type-2 deficit (restoring own collateral) **to the counterparty** | Losing party pays twice: the loss, then the top-up also goes to the winner | Top-up first clears a real shortfall (credited to the counterparty's *locked* balance), the rest restores own collateral |
| 3 | `settle()` used `latestRoundData()` at call time; mock returned `block.timestamp` as `updatedAt` | Winning party picks *when* to call settle (timing / front-running attack); staleness check always passed | Price = oracle round live at the **scheduled** time, verified with round history. Mock keeps real rounds |
| 4 | Winnings and final refunds **pushed** with `.call` inside `settle()` | A party whose contract rejects ETH blocks settlement for both (DoS); gains were not "locked until maturity" as the paper says | Balances stay locked in the contract, everything is paid through `withdraw()` (pull pattern) |
| 5 | After grace expiry the deficit was set to 0 (forgiven) | Loser never pays the shortfall, swap continues under-collateralised, no termination | Unpaid shortfall = serious default → terminate, slash, rep = 2, insurance covers the winner |
| 6 | No way out for acceptors before selection; creator could not cancel | Acceptor and creator funds stuck forever if creator never selects | `withdrawAcceptance`, `cancelRequest`, and anyone can expire a request after the selection window |

## Logic / paper consistency

| # | v1 problem | v2 fix |
|---|---|---|
| 7 | `register()` set reputation to 10 (max) | Starts at 5, so a defaulter's new wallet ranks below honest veterans (Sybil test) |
| 8 | Penalties −5 / −2, no "set to 2" rule | Paper rules: −2 missed top-up, set to 2 on serious default, +1 per clean settlement |
| 9 | `settlementTimes[]` passed at selection: unsorted, unbounded, unknown to acceptors | Period and count fixed at creation, schedule = `start + n × period` |
| 10 | Proposer always party A (long) | `creatorIsLong` lets the proposer be long or short |
| 11 | No "under-collateralised at next settlement → terminate" rule | Implemented, including "under-collateralised winner gets no payment" |
| 12 | Price units: `diff × quantity` in raw wei, no decimals | `|P − K| × Q × 1e18 / 10^decimals`, price = ETH per unit with 8 decimals |
| 13 | Pricing mode FIXED / ORACLE (ORACLE made P − K always 0) | Removed. Single mode: K snapshotted from the oracle |
| 14 | Registration fee `>=`, excess kept, fees locked with no purpose | Exact fee, goes to an insurance pool that nobody can withdraw |
| 15 | `getAcceptors` restricted to the creator inside a `view` | Removed: chain data is public anyway; restriction gave false sense of privacy |
| 16 | OpenZeppelin path `security/ReentrancyGuard.sol` only exists in OZ v4 | OZ v5 `utils/ReentrancyGuard.sol` + `Ownable` |
| 17 | No bounds on quantity, acceptors, rounds | MAX_QUANTITY, MAX_ACCEPTORS = 20, MAX_PERIODS = 52, bounded oracle search |

## Paper text that should follow the code later (not changed yet)

- Section 2.6 / 3.1 / 4 / 5.1: one reputation rule set (start 5, +1, −2, set to 2).
- Algorithm 5: compare with K, not `lastPrice`; quantity is stored, not a parameter.
- Algorithm 3: no `settlementTimes` argument.
- Algorithm 4: shortfall is credited to the counterparty's locked balance, not transferred.
- Front-running section: real defences are (a) proposer chooses the counterparty, so being first to accept gives no advantage, and (b) settlement priced at the scheduled time.
- Collateral formula: multiply by quantity; it is an off-chain recommendation (the DApp computes it from oracle history).
- Oracle: say which feed (Chainlink commodity/ETH, or commodity/USD × ETH/USD) and that the owner only does feed governance.
- Table 2 is "manual analysis + Slither", not Slither alone.
