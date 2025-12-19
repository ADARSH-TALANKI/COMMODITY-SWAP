#Commodity Swap Smart Contract
Overview:
This project implements a decentralized commodity swap system using Solidity. It simulates real-world commodity derivative contracts where two parties agree on a fixed reference price and settle the contract at maturity using oracle-based market prices. The design focuses on margin enforcement, time-based grace handling, and an on-chain reputation mechanism to encourage responsible participation.

The contract is developed and tested using Remix IDE with a mock oracle for price injection and controlled testing.

Problem Statement:
Traditional commodity swaps rely on centralized intermediaries for settlement, margin enforcement, and trust. This project explores how smart contracts can automate these processes transparently, reduce counterparty risk, and enforce discipline using collateral and reputation instead of manual intervention.

How the System Works
1. Registration
Users register by paying a fixed registration fee. Each registered user starts with a neutral reputation score.
2. Swap Creation
A proposer creates a swap request by specifying:
Commodity type
Quantity
Fixed reference price
Acceptance deadline
Maturity time
Oracle address
Multiple users may accept the request.

3. Counterparty Selection
The proposer selects one counterparty from the acceptors. Both parties deposit collateral to secure the position.

5. Settlement & Margin Check
At maturity:
The contract fetches the market price from the oracle
Profit/Loss is calculated
Required margin is evaluated
If collateral is insufficient, a grace period is automatically triggered.

5. Grace Period Handling
The losing party is given a limited time window to cover the margin shortfall:
Failure to respond results in reputation penalties
Compliance allows the contract to proceed without immediate liquidation

6. Reputation System
The contract tracks user behavior using an on-chain reputation score:
+1 for successful, compliant settlement
−2 for minor margin non-compliance
−4 for ignoring margin calls after the grace period
This system incentivizes reliability without penalizing market losses.

Key Features
Oracle-based price settlement (mock oracle for testing)
Margin and collateral enforcement
Automatic grace period handling
Behavior-based reputation tracking
Time-bound acceptance and maturity
Fully on-chain and transparent logic

Tech Stack
Solidity
Remix IDE
Mock Oracle (MockPriceFeed)
Ethereum Virtual Machine (JavaScript VM for testing)

Testing
Contracts were written and tested in Remix
Oracle prices are manually injected via a mock contract
Time-based logic (grace period, maturity) verified using VM time manipulation

Project Status
✔ Core logic implemented
✔ Tested with mock oracle
✔ Ready for documentation expansion and future enhancements

Future Enhancements
Integration with real oracle feeds (e.g., Chainlink)
Liquidation mechanisms
Frontend interface
Advanced reputation-based restrictions
Multi-commodity support
