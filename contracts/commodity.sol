//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice Chainlink-style price feed interface
interface IPriceFeed {
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

contract CommSwap is ReentrancyGuard {
    // =======================
    // ENUMS
    // =======================

    enum PricingMode {
        FIXED,
        ORACLE
    }

    // =======================
    // STRUCTS
    // =======================

    struct SwapRequest {
        uint256 id;
        address creator;
        string commodity;
        uint256 quantity;
        uint256 referencePrice;
        PricingMode pricingMode;
        address priceFeed;
        uint256 collateralRequired;
        uint256 maturityTimestamp;
        uint256 createdAt;
        uint256 acceptDeadline;
        bool active;
        address[] acceptors;
    }

    struct Acceptance {
        address responder;
        uint256 acceptedAt;
        uint8 reputationAtAccept;
        bool selected;
        bool refunded;
    }

    struct Swap {
        uint256 id;
        uint256 requestId;
        address payable partyA;
        address payable partyB;
        string commodity;
        uint256 quantity;
        uint256 referencePrice;
        PricingMode pricingMode;
        IPriceFeed priceFeed;
        uint256 collateralPerParty;
        uint256 collateralA;
        uint256 collateralB;
        uint256 maturityTimestamp;
        uint256[] settlementTimes;
        uint256 currentRound;
        bool active;
        bool finished;

        // deficit tracking
        uint256 pendingDeficitA;
        uint256 pendingDeficitB;
        uint256 deficitGraceDeadlineA;
        uint256 deficitGraceDeadlineB;

        // deficit type: 0 = none, 1 = full shortfall (amountOwed > collateral), 2 = remaining < collateralPerParty
        uint8 pendingDeficitTypeA;
        uint8 pendingDeficitTypeB;
    }

    // =======================
    // CONSTANTS
    // =======================

    uint256 public constant REGISTRATION_FEE = 0.01 ether;
    uint8 public constant MAX_REPUTATION = 10;
    uint256 public constant MAX_ORACLE_DELAY = 1 hours;
    uint256 public constant GRACE_PERIOD = 2 minutes;

    // Penalties
    uint8 public constant PENALTY_FULL_SHORTFALL = 5; // amountOwed > collateral
    uint8 public constant PENALTY_UNDER_COLLATERAL = 2; // remaining collateral < collateralPerParty

    // =======================
    // STATE VARIABLES
    // =======================

    uint256 public nextRequestId;
    uint256 public nextSwapId;

    mapping(address => bool) public isRegistered;
    mapping(address => uint8) public reputation;

    mapping(uint256 => SwapRequest) public swapRequests;
    mapping(uint256 => Swap) public swaps;

    mapping(uint256 => mapping(address => bool)) public hasAccepted;
    mapping(uint256 => Acceptance[]) private _acceptances;

    mapping(address => uint256) public pendingRefunds;

    // =======================
    // EVENTS
    // =======================

    event Registered(address indexed user, uint256 feePaid);
    event SwapRequestCreated(uint256 indexed id, address indexed creator);
    event SwapAccepted(uint256 indexed requestId, address indexed acceptor);
    event SwapFinalized(uint256 indexed swapId, address indexed partyA, address indexed partyB);
    event CollateralToppedUp(uint256 indexed swapId, address indexed user, uint256 amount);
    event SettlementExecuted(
        uint256 indexed swapId,
        uint256 indexed round,
        int256 priceDiff,
        uint256 amountPaid,
        address indexed winner
    );
    event SwapCompleted(uint256 indexed swapId);
    event ReputationSlashed(address indexed user, uint8 oldRep, uint8 newRep);
    event RefundWithdrawn(address indexed user, uint256 amount);
    event DeficitCreated(uint256 indexed swapId, address indexed who, uint256 shortfall, uint256 deadline, uint8 dtype);
    event ReputationIncreased(address indexed user, uint8 oldRep, uint8 newRep);

    // =======================
    // MODIFIERS
    // =======================

    modifier onlyRegistered() {
        require(isRegistered[msg.sender], "Not registered");
        _;
    }

    // =======================
    // REGISTRATION
    // =======================

    function register() external payable nonReentrant {
        require(!isRegistered[msg.sender], "Already registered");
        require(msg.value >= REGISTRATION_FEE, "Fee too low");
        isRegistered[msg.sender] = true;
        reputation[msg.sender] = MAX_REPUTATION;
        emit Registered(msg.sender, msg.value);
    }

    // =======================
    // CREATE SWAP REQUEST
    // =======================

    function createSwapRequest(
        string memory _commodity,
        uint256 _quantity,
        uint256 _referencePrice,
        uint8 _pricingMode,
        address _priceFeed,
        uint256 _maturityTimestamp,
        uint256 _acceptDeadline
    ) external payable onlyRegistered nonReentrant {
        require(_maturityTimestamp > block.timestamp, "Bad maturity");
        require(_acceptDeadline > block.timestamp, "Deadline in past");
        require(_acceptDeadline < _maturityTimestamp, "Deadline after maturity");
        require(msg.value > 0, "Need collateral");
        require(_pricingMode <= uint8(PricingMode.ORACLE), "Invalid mode");
        require(_priceFeed != address(0), "Price feed required");

        SwapRequest storage r = swapRequests[nextRequestId];
        r.id = nextRequestId;
        r.creator = msg.sender;
        r.commodity = _commodity;
        r.quantity = _quantity;
        r.referencePrice = _referencePrice;
        r.pricingMode = PricingMode(_pricingMode);
        r.priceFeed = _priceFeed;
        r.collateralRequired = msg.value;
        r.maturityTimestamp = _maturityTimestamp;
        r.createdAt = block.timestamp;
        r.acceptDeadline = _acceptDeadline;
        r.active = true;

        emit SwapRequestCreated(nextRequestId, msg.sender);
        nextRequestId++;
    }

    // =======================
    // VIEW OPEN REQUESTS
    // =======================

    function getOpenRequests() external view returns (uint256[] memory) {
        uint256 total = nextRequestId;
        uint256 count;
        for (uint256 i = 0; i < total; i++) if (swapRequests[i].active) count++;
        uint256[] memory open = new uint256[](count);
        uint256 index;
        for (uint256 i = 0; i < total; i++) {
            if (swapRequests[i].active) open[index++] = i;
        }
        return open;
    }

    // =======================
    // ACCEPT REQUEST
    // =======================

    function acceptSwapRequest(uint256 _requestId) external payable onlyRegistered nonReentrant {
        SwapRequest storage r = swapRequests[_requestId];
        require(r.active, "Not active");
        require(block.timestamp <= r.acceptDeadline, "Too late to accept");
        require(msg.sender != r.creator, "Creator cannot accept own");
        require(!hasAccepted[_requestId][msg.sender], "Already accepted");
        require(msg.value == r.collateralRequired, "Wrong collateral");

        r.acceptors.push(msg.sender);
        hasAccepted[_requestId][msg.sender] = true;

        _acceptances[_requestId].push(
            Acceptance({
                responder: msg.sender,
                acceptedAt: block.timestamp,
                reputationAtAccept: reputation[msg.sender],
                selected: false,
                refunded: false
            })
        );

        emit SwapAccepted(_requestId, msg.sender);
    }

    // =======================
    // VIEW ACCEPTORS + METADATA
    // =======================

    function getAcceptors(uint256 _requestId) external view returns (address[] memory) {
        SwapRequest storage r = swapRequests[_requestId];
        require(msg.sender == r.creator, "Only creator");
        return r.acceptors;
    }

    function getAcceptanceInfo(uint256 _requestId) external view returns (Acceptance[] memory) {
        SwapRequest storage r = swapRequests[_requestId];
        require(msg.sender == r.creator, "Only creator");
        Acceptance[] storage list = _acceptances[_requestId];
        Acceptance[] memory out = new Acceptance[](list.length);
        for (uint256 i = 0; i < list.length; i++) out[i] = list[i];
        return out;
    }

    // =======================
    // HELPER: MARK SELECTED & SET REFUNDS
    // =======================

    function _markSelected(uint256 _requestId, address chosen) internal {
        Acceptance[] storage list = _acceptances[_requestId];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].responder == chosen) {
                list[i].selected = true;
            } else {
                if (!list[i].refunded && !list[i].selected) {
                    list[i].refunded = true;
                    pendingRefunds[list[i].responder] += swapRequests[_requestId].collateralRequired;
                }
            }
        }
    }

    // =======================
    // FINALIZE SWAP
    // =======================

    function selectAcceptor(
        uint256 _requestId,
        address payable _chosenAcceptor,
        uint256[] calldata _settlementTimes
    ) external onlyRegistered nonReentrant {
        SwapRequest storage r = swapRequests[_requestId];
        require(r.active, "Request inactive");
        require(msg.sender == r.creator, "Only creator");
        require(_settlementTimes.length > 0, "No settlement times");
        require(_settlementTimes[_settlementTimes.length - 1] <= r.maturityTimestamp, "Beyond maturity");
        require(hasAccepted[_requestId][_chosenAcceptor], "Not an acceptor");

        uint256 swapId = _initSwap(_requestId, _chosenAcceptor, _settlementTimes);
        _markSelected(_requestId, _chosenAcceptor);

        emit SwapFinalized(swapId, r.creator, _chosenAcceptor);
    }

    function _initSwap(
        uint256 _requestId,
        address payable _chosenAcceptor,
        uint256[] calldata _settlementTimes
    ) internal returns (uint256) {
        SwapRequest storage r = swapRequests[_requestId];
        uint256 sid = nextSwapId++;

        Swap storage s = swaps[sid];
        s.id = sid;
        s.requestId = _requestId;
        s.partyA = payable(r.creator);
        s.partyB = _chosenAcceptor;
        s.commodity = r.commodity;
        s.quantity = r.quantity;
        s.referencePrice = r.referencePrice;
        s.pricingMode = r.pricingMode;
        s.priceFeed = IPriceFeed(r.priceFeed);
        s.collateralPerParty = r.collateralRequired;
        s.collateralA = r.collateralRequired;
        s.collateralB = r.collateralRequired;
        s.maturityTimestamp = r.maturityTimestamp;
        s.active = true;

        s.settlementTimes = new uint256[](_settlementTimes.length);
        for (uint256 i = 0; i < _settlementTimes.length; i++) s.settlementTimes[i] = _settlementTimes[i];

        r.active = false;
        return sid;
    }

    // =======================
    // WITHDRAW REFUNDS
    // =======================

    function withdrawRefund() external nonReentrant {
        uint256 amount = pendingRefunds[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        pendingRefunds[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Withdraw failed");
        emit RefundWithdrawn(msg.sender, amount);
    }

    // =======================
    // TOP-UP COLLATERAL
    // =======================

    function topUpCollateral(uint256 _swapId) external payable onlyRegistered nonReentrant {
        Swap storage s = swaps[_swapId];
        require(s.active, "Inactive");
        require(msg.value > 0, "No value");

        if (msg.sender == s.partyA) {
            s.collateralA += msg.value;

            if (s.pendingDeficitA > 0) {
                uint256 pay = s.pendingDeficitA <= s.collateralA ? s.pendingDeficitA : s.collateralA;
                if (pay > 0) {
                    s.collateralA -= pay;
                    s.pendingDeficitA -= pay;
                    (bool ok, ) = s.partyB.call{value: pay}("");
                    require(ok, "Deficit pay A->B failed");
                    if (s.pendingDeficitA == 0) {
                        s.deficitGraceDeadlineA = 0;
                        s.pendingDeficitTypeA = 0;
                    }
                }
            }
        } else if (msg.sender == s.partyB) {
            s.collateralB += msg.value;

            if (s.pendingDeficitB > 0) {
                uint256 pay = s.pendingDeficitB <= s.collateralB ? s.pendingDeficitB : s.collateralB;
                if (pay > 0) {
                    s.collateralB -= pay;
                    s.pendingDeficitB -= pay;
                    (bool ok2, ) = s.partyA.call{value: pay}("");
                    require(ok2, "Deficit pay B->A failed");
                    if (s.pendingDeficitB == 0) {
                        s.deficitGraceDeadlineB = 0;
                        s.pendingDeficitTypeB = 0;
                    }
                }
            }
        } else {
            revert("Not participant");
        }

        emit CollateralToppedUp(_swapId, msg.sender, msg.value);
    }

    // =======================
    // SETTLEMENT
    // =======================

    function settle(uint256 _swapId) external nonReentrant {
        Swap storage s = swaps[_swapId];
        require(s.active, "Inactive swap");
        require(!s.finished, "Already finished");
        require(s.currentRound < s.settlementTimes.length, "All rounds done");
        require(block.timestamp >= s.settlementTimes[s.currentRound], "Too early");

        // handle expired grace periods
        if (s.pendingDeficitA > 0 && s.deficitGraceDeadlineA != 0 && block.timestamp > s.deficitGraceDeadlineA) {
            uint8 pen = s.pendingDeficitTypeA == 1 ? PENALTY_FULL_SHORTFALL : PENALTY_UNDER_COLLATERAL;
            if (pen > 0) _slashReputation(s.partyA, pen);
            s.pendingDeficitA = 0;
            s.deficitGraceDeadlineA = 0;
            s.pendingDeficitTypeA = 0;
        }
        if (s.pendingDeficitB > 0 && s.deficitGraceDeadlineB != 0 && block.timestamp > s.deficitGraceDeadlineB) {
            uint8 pen = s.pendingDeficitTypeB == 1 ? PENALTY_FULL_SHORTFALL : PENALTY_UNDER_COLLATERAL;
            if (pen > 0) _slashReputation(s.partyB, pen);
            s.pendingDeficitB = 0;
            s.deficitGraceDeadlineB = 0;
            s.pendingDeficitTypeB = 0;
        }

        // BLOCK: prevent moving to the next round if an active (unexpired) deficit exists
        bool aHasActiveDeficit = (s.pendingDeficitA > 0 && s.deficitGraceDeadlineA != 0 && block.timestamp <= s.deficitGraceDeadlineA);
        bool bHasActiveDeficit = (s.pendingDeficitB > 0 && s.deficitGraceDeadlineB != 0 && block.timestamp <= s.deficitGraceDeadlineB);
        if (aHasActiveDeficit || bHasActiveDeficit) {
            revert("Pending deficit unresolved: top-up or wait for grace expiry");
        }

        (
            ,
            int256 answer,
            ,
            uint256 updatedAt,
            /* answeredInRound */
        ) = s.priceFeed.latestRoundData();

        require(answer > 0, "Invalid oracle price");
        require(updatedAt != 0, "Oracle round incomplete");
        require(block.timestamp - updatedAt <= MAX_ORACLE_DELAY, "Stale oracle price");

        int256 currentPrice = answer;
        int256 signedDiff = currentPrice - int256(s.referencePrice);

        if (signedDiff == 0) {
            s.currentRound++;
            if (s.currentRound == s.settlementTimes.length) _finalizeSwap(_swapId);
            emit SettlementExecuted(_swapId, s.currentRound, signedDiff, 0, address(0));
            return;
        }

        address payable winner;
        address payable loser;
        uint256 loserCollateral;

        if (signedDiff > 0) {
            winner = s.partyA;
            loser = s.partyB;
            loserCollateral = s.collateralB;
        } else {
            signedDiff = -signedDiff;
            winner = s.partyB;
            loser = s.partyA;
            loserCollateral = s.collateralA;
        }

        uint256 amountOwed = uint256(signedDiff) * s.quantity;
        uint256 amountPaid;
        uint256 deficit;

        if (amountOwed > loserCollateral) {
            amountPaid = loserCollateral;
            deficit = amountOwed - amountPaid;

            if (loser == s.partyA) {
                s.pendingDeficitA += deficit;
                s.deficitGraceDeadlineA = block.timestamp + GRACE_PERIOD;
                s.pendingDeficitTypeA = 1; // full shortfall
                emit DeficitCreated(_swapId, s.partyA, deficit, s.deficitGraceDeadlineA, 1);
            } else {
                s.pendingDeficitB += deficit;
                s.deficitGraceDeadlineB = block.timestamp + GRACE_PERIOD;
                s.pendingDeficitTypeB = 1;
                emit DeficitCreated(_swapId, s.partyB, deficit, s.deficitGraceDeadlineB, 1);
            }
        } else {
            amountPaid = amountOwed;
        }

        // Transfer to winner
        if (amountPaid > 0) {
            (bool ok, ) = winner.call{value: amountPaid}("");
            require(ok, "Transfer failed");

            if (loser == s.partyA) {
                s.collateralA -= amountPaid;

                // if remaining collateral < collateralPerParty and no existing deficit, create deficit type 2
                if (s.collateralA < s.collateralPerParty && s.pendingDeficitA == 0) {
                    uint256 shortfall = s.collateralPerParty - s.collateralA;
                    s.pendingDeficitA = shortfall;
                    s.deficitGraceDeadlineA = block.timestamp + GRACE_PERIOD;
                    s.pendingDeficitTypeA = 2; // under-collateralization
                    emit DeficitCreated(_swapId, s.partyA, shortfall, s.deficitGraceDeadlineA, 2);
                }
            } else {
                s.collateralB -= amountPaid;

                if (s.collateralB < s.collateralPerParty && s.pendingDeficitB == 0) {
                    uint256 shortfall = s.collateralPerParty - s.collateralB;
                    s.pendingDeficitB = shortfall;
                    s.deficitGraceDeadlineB = block.timestamp + GRACE_PERIOD;
                    s.pendingDeficitTypeB = 2;
                    emit DeficitCreated(_swapId, s.partyB, shortfall, s.deficitGraceDeadlineB, 2);
                }
            }
        }

        // If no deficit was created this round (amountOwed fully paid and no under-collateralization),
        // reward both parties with +1 reputation (capped at MAX_REPUTATION)
        if (deficit == 0) {
            // since active deficits would have blocked earlier, it's safe to grant +1 to both
            _increaseReputationIfNeeded(s.partyA, 1);
            _increaseReputationIfNeeded(s.partyB, 1);
        }

        s.currentRound++;

        emit SettlementExecuted(_swapId, s.currentRound, signedDiff, amountPaid, winner);

        if (s.currentRound == s.settlementTimes.length || s.collateralA == 0 || s.collateralB == 0) {
            _finalizeSwap(_swapId);
        }
    }

    function _finalizeSwap(uint256 _swapId) internal {
        Swap storage s = swaps[_swapId];
        if (s.finished) return;

        if (s.collateralA > 0) {
            uint256 amtA = s.collateralA;
            s.collateralA = 0;
            (bool okA, ) = s.partyA.call{value: amtA}("");
            require(okA, "Refund A failed");
        }

        if (s.collateralB > 0) {
            uint256 amtB = s.collateralB;
            s.collateralB = 0;
            (bool okB, ) = s.partyB.call{value: amtB}("");
            require(okB, "Refund B failed");
        }

        s.active = false;
        s.finished = true;

        emit SwapCompleted(_swapId);
    }

    // =======================
    // REPUTATION HELPERS
    // =======================

    function _slashReputation(address user, uint8 penalty) internal {
        uint8 oldRep = reputation[user];
        if (oldRep == 0) return;
        uint8 newRep = oldRep > penalty ? oldRep - penalty : 0;
        reputation[user] = newRep;
        emit ReputationSlashed(user, oldRep, newRep);
    }

    function _increaseReputationIfNeeded(address user, uint8 inc) internal {
        uint8 oldRep = reputation[user];
        if (oldRep >= MAX_REPUTATION) return;
        uint8 newRep = oldRep + inc;
        if (newRep > MAX_REPUTATION) newRep = MAX_REPUTATION;
        reputation[user] = newRep;
        emit ReputationIncreased(user, oldRep, newRep);
    }
}
