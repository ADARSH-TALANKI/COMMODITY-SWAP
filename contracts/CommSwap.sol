// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal Chainlink AggregatorV3 interface.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/*
 * ============================================================================
 *  CommSwap v2 : A Decentralized Framework for Commodity Swap
 * ============================================================================
 *  Fixed-for-floating commodity swap with
 *   - Module 1: registration (fee -> insurance pool), proposals, multi-accept,
 *               reputation-based counterparty selection, pull refunds
 *   - Module 2: collateral lock, fixed settlement schedule, margin calls
 *   - Module 3: periodic settlement priced at the SCHEDULED time via oracle
 *               round lookup, top-ups, grace periods, default + slashing
 *
 *  Economics (per settlement period i, quantity Q per period):
 *      payoff_long  = (P_i - K) * Q        payoff_short = -(P_i - K) * Q
 *  K (reference / fixed price) is snapshotted from the trusted oracle when the
 *  proposal is created, so nobody can type in a fake reference price.
 *
 *  Reputation:  start 5 | +1 per clean settlement (cap 10) |
 *               -2 for a missed top-up | set to 2 on serious default
 *
 *  Trust assumption: the contract owner only maps commodities to oracle feeds
 *  (oracle governance). The owner can NOT touch user funds or fees.
 * ============================================================================
 */
contract CommSwap is ReentrancyGuard, Ownable {
    // ---------------------------------------------------------------- types

    enum RequestStatus { None, Open, Finalized, Cancelled }
    enum SwapStatus { None, Active, Matured, Terminated }

    struct Commodity {
        string symbol;
        AggregatorV3Interface feed;
        uint8 feedDecimals;
        uint32 heartbeat; // max allowed age of an oracle answer (seconds)
        bool active;
    }

    struct User {
        bool registered;
        uint8 reputation;
        uint32 swapsCompleted;
        uint32 defaults;
    }

    struct Request {
        address creator;
        bool creatorIsLong; // true: creator receives (P-K)*Q when price rises
        RequestStatus status;
        uint32 commodityId;
        uint32 numPeriods;
        uint64 period; // seconds between settlements
        uint64 createdAt;
        uint64 acceptDeadline;
        uint64 selectDeadline;
        uint256 quantity; // units per settlement period
        int256 refPrice; // K, snapshotted from oracle at creation
        uint256 collateral; // per party, in wei
        uint256 activeAcceptors;
        uint256 swapId; // valid when status == Finalized
    }

    struct Acceptance {
        address acceptor;
        uint64 acceptedAt;
        uint8 reputationSnapshot;
        bool withdrawn;
    }

    struct Swap {
        uint256 requestId;
        address longParty;
        address shortParty;
        uint32 commodityId;
        uint32 numPeriods;
        uint32 roundsDone;
        SwapStatus status;
        uint64 start;
        uint64 period;
        uint256 quantity;
        int256 refPrice;
        uint256 required; // collateral each side must maintain
        int256 lastPrice;
    }

    struct PartyState {
        uint256 collateral; // locked balance (gains stay locked until close)
        uint256 shortfall; // loss that exceeded collateral, owed to counterparty
        uint64 topUpDeadline; // end of grace period, 0 = no open margin call
        bool strike; // already penalised (-2) for the current missed top-up
    }

    // ------------------------------------------------------------ constants

    uint8 public constant INITIAL_REPUTATION = 5;
    uint8 public constant MAX_REPUTATION = 10;
    uint8 public constant MISSED_TOPUP_PENALTY = 2;
    uint8 public constant DEFAULT_REPUTATION = 2;

    uint256 public constant MAX_ACCEPTORS = 20; // bounded, DoS safe
    uint32 public constant MAX_PERIODS = 52; // bounded settlement rounds
    uint256 public constant MAX_QUANTITY = 1e9;
    uint256 public constant ROUND_SEARCH_LIMIT = 100; // bounded oracle search

    uint8 private constant LONG = 0;
    uint8 private constant SHORT = 1;

    // ------------------------------------------------------- configuration

    uint256 public immutable registrationFee;
    uint64 public immutable gracePeriod;
    uint64 public immutable minPeriod;
    uint64 public immutable selectionWindow;

    // ----------------------------------------------------------------- state

    Commodity[] private _commodities;
    mapping(address => User) public users;

    Request[] private _requests;
    mapping(uint256 => Acceptance[]) private _acceptances;
    mapping(uint256 => mapping(address => uint256)) private _acceptIndex; // index + 1

    Swap[] private _swaps;
    mapping(uint256 => PartyState[2]) private _parties;

    mapping(address => uint256) public withdrawable; // pull-payment ledger
    uint256 public insuranceFund; // funded by registration fees

    // ---------------------------------------------------------------- events

    event CommodityAdded(uint256 indexed commodityId, string symbol, address feed, uint32 heartbeat);
    event CommodityStatusChanged(uint256 indexed commodityId, bool active);
    event Registered(address indexed user, uint256 fee, uint8 reputation);
    event ReputationChanged(address indexed user, uint8 oldRep, uint8 newRep, string reason);

    event RequestCreated(
        uint256 indexed requestId,
        address indexed creator,
        uint256 indexed commodityId,
        bool creatorIsLong,
        uint256 quantity,
        int256 refPrice,
        uint256 collateral,
        uint64 period,
        uint32 numPeriods,
        uint64 acceptDeadline
    );
    event RequestAccepted(uint256 indexed requestId, address indexed acceptor, uint8 reputation, uint64 acceptedAt);
    event AcceptanceWithdrawn(uint256 indexed requestId, address indexed acceptor);
    event RequestCancelled(uint256 indexed requestId);
    event SwapStarted(uint256 indexed swapId, uint256 indexed requestId, address indexed longParty, address shortParty, uint64 start);

    event Settled(
        uint256 indexed swapId,
        uint32 indexed round,
        int256 price,
        int256 priceDiff,
        uint256 amountDue,
        uint256 amountPaid,
        address winner
    );
    event MarginCall(uint256 indexed swapId, address indexed party, uint256 collateral, uint256 required, uint256 shortfall, uint64 deadline);
    event ToppedUp(uint256 indexed swapId, address indexed party, uint256 amount, uint256 shortfallPaid);
    event MissedTopUp(uint256 indexed swapId, address indexed party);
    event SwapMatured(uint256 indexed swapId, uint256 longPayout, uint256 shortPayout);
    event SwapTerminated(uint256 indexed swapId, address indexed defaulter, uint256 slashed, uint256 insurancePaid);
    event Withdrawn(address indexed user, uint256 amount);

    // ------------------------------------------------------------- modifiers

    modifier onlyRegistered() {
        require(users[msg.sender].registered, "Not registered");
        _;
    }

    // ---------------------------------------------------------- constructor

    constructor(uint256 _registrationFee, uint64 _gracePeriod, uint64 _minPeriod, uint64 _selectionWindow)
        Ownable(msg.sender)
    {
        require(_gracePeriod > 0 && _minPeriod > _gracePeriod, "Grace must be shorter than period");
        require(_selectionWindow > 0, "Bad selection window");
        registrationFee = _registrationFee;
        gracePeriod = _gracePeriod;
        minPeriod = _minPeriod;
        selectionWindow = _selectionWindow;
    }

    // ===================================================== oracle governance

    function addCommodity(string calldata symbol, address feed, uint32 heartbeat) external onlyOwner returns (uint256 id) {
        require(feed != address(0), "Feed required");
        require(heartbeat > 0, "Heartbeat required");
        uint8 dec = AggregatorV3Interface(feed).decimals();
        id = _commodities.length;
        _commodities.push(Commodity(symbol, AggregatorV3Interface(feed), dec, heartbeat, true));
        emit CommodityAdded(id, symbol, feed, heartbeat);
    }

    function setCommodityActive(uint256 id, bool active) external onlyOwner {
        require(id < _commodities.length, "Unknown commodity");
        _commodities[id].active = active;
        emit CommodityStatusChanged(id, active);
    }

    // ============================================ Module 1: registration

    function register() external payable {
        User storage u = users[msg.sender];
        require(!u.registered, "Already registered");
        require(msg.value == registrationFee, "Wrong registration fee");
        u.registered = true;
        u.reputation = INITIAL_REPUTATION;
        insuranceFund += msg.value; // fee is not revenue for anyone
        emit Registered(msg.sender, msg.value, INITIAL_REPUTATION);
    }

    // ======================================= Module 1: proposal lifecycle

    /// @param commodityId  commodity registered by oracle governance
    /// @param quantity     units exchanged per settlement period
    /// @param creatorIsLong true = creator profits when price rises above K
    /// @param period       seconds between settlements (>= minPeriod)
    /// @param numPeriods   number of settlement rounds (maturity = period * numPeriods after start)
    /// @param acceptWindow seconds from now during which others may accept
    /// msg.value = collateral each side must lock (suggested off-chain:
    ///             max historical move per window * quantity * threshold)
    function createRequest(
        uint32 commodityId,
        uint256 quantity,
        bool creatorIsLong,
        uint64 period,
        uint32 numPeriods,
        uint64 acceptWindow
    ) external payable onlyRegistered returns (uint256 requestId) {
        require(commodityId < _commodities.length, "Unknown commodity");
        require(_commodities[commodityId].active, "Commodity inactive");
        require(quantity > 0 && quantity <= MAX_QUANTITY, "Bad quantity");
        require(period >= minPeriod, "Period too short");
        require(numPeriods > 0 && numPeriods <= MAX_PERIODS, "Bad number of periods");
        require(acceptWindow > 0, "Bad accept window");
        require(msg.value > 0, "Need collateral");

        // K is the trusted oracle price right now, not a user input.
        int256 k = _latestFreshPrice(commodityId);

        requestId = _requests.length;
        Request storage r = _requests.push();
        r.creator = msg.sender;
        r.creatorIsLong = creatorIsLong;
        r.status = RequestStatus.Open;
        r.commodityId = commodityId;
        r.numPeriods = numPeriods;
        r.period = period;
        r.createdAt = uint64(block.timestamp);
        r.acceptDeadline = uint64(block.timestamp) + acceptWindow;
        r.selectDeadline = r.acceptDeadline + selectionWindow;
        r.quantity = quantity;
        r.refPrice = k;
        r.collateral = msg.value;

        emit RequestCreated(
            requestId, msg.sender, commodityId, creatorIsLong, quantity, k, msg.value, period, numPeriods, r.acceptDeadline
        );
    }

    function acceptRequest(uint256 requestId) external payable onlyRegistered {
        Request storage r = _req(requestId);
        require(r.status == RequestStatus.Open, "Not open");
        require(block.timestamp <= r.acceptDeadline, "Too late to accept");
        require(msg.sender != r.creator, "Creator cannot accept own");
        require(_acceptIndex[requestId][msg.sender] == 0, "Already accepted");
        require(msg.value == r.collateral, "Wrong collateral");
        require(_acceptances[requestId].length < MAX_ACCEPTORS, "Too many acceptors");

        uint8 rep = users[msg.sender].reputation;
        _acceptances[requestId].push(Acceptance(msg.sender, uint64(block.timestamp), rep, false));
        _acceptIndex[requestId][msg.sender] = _acceptances[requestId].length;
        r.activeAcceptors++;
        emit RequestAccepted(requestId, msg.sender, rep, uint64(block.timestamp));
    }

    /// @notice Acceptor pulls their collateral back: any time before being
    ///         selected, or after another party was selected / request ended.
    ///         No loop over acceptors anywhere -> no DoS by a reverting acceptor.
    function withdrawAcceptance(uint256 requestId) external {
        Request storage r = _req(requestId);
        uint256 idx = _acceptIndex[requestId][msg.sender];
        require(idx != 0, "Not an acceptor");
        Acceptance storage a = _acceptances[requestId][idx - 1];
        require(!a.withdrawn, "Already withdrawn");
        if (r.status == RequestStatus.Finalized) {
            require(_swaps[r.swapId].shortParty != msg.sender && _swaps[r.swapId].longParty != msg.sender, "Selected counterparty");
        }
        a.withdrawn = true;
        if (r.status == RequestStatus.Open) r.activeAcceptors--;
        withdrawable[msg.sender] += r.collateral;
        emit AcceptanceWithdrawn(requestId, msg.sender);
    }

    /// @notice Creator cancels any time while open; anyone may expire a
    ///         request whose selection window passed (frees creator's funds).
    function cancelRequest(uint256 requestId) external {
        Request storage r = _req(requestId);
        require(r.status == RequestStatus.Open, "Not open");
        require(msg.sender == r.creator || block.timestamp > r.selectDeadline, "Only creator before expiry");
        r.status = RequestStatus.Cancelled;
        withdrawable[r.creator] += r.collateral;
        emit RequestCancelled(requestId);
    }

    /// @notice Creator picks one acceptor (e.g. by reputation). Schedule and
    ///         K were fixed at creation, so acceptors knew all terms upfront.
    function selectCounterparty(uint256 requestId, address acceptor) external returns (uint256 swapId) {
        Request storage r = _req(requestId);
        require(r.status == RequestStatus.Open, "Not open");
        require(msg.sender == r.creator, "Only creator");
        require(block.timestamp <= r.selectDeadline, "Selection window over");
        uint256 idx = _acceptIndex[requestId][acceptor];
        require(idx != 0, "Not an acceptor");
        Acceptance storage a = _acceptances[requestId][idx - 1];
        require(!a.withdrawn, "Acceptor withdrew");

        a.withdrawn = true; // their collateral moves into the swap
        r.activeAcceptors--;
        r.status = RequestStatus.Finalized;

        swapId = _swaps.length;
        r.swapId = swapId;
        Swap storage s = _swaps.push();
        s.requestId = requestId;
        s.longParty = r.creatorIsLong ? r.creator : acceptor;
        s.shortParty = r.creatorIsLong ? acceptor : r.creator;
        s.commodityId = r.commodityId;
        s.numPeriods = r.numPeriods;
        s.status = SwapStatus.Active;
        s.start = uint64(block.timestamp);
        s.period = r.period;
        s.quantity = r.quantity;
        s.refPrice = r.refPrice;
        s.required = r.collateral;
        s.lastPrice = r.refPrice;

        _parties[swapId][LONG].collateral = r.collateral;
        _parties[swapId][SHORT].collateral = r.collateral;

        emit SwapStarted(swapId, requestId, s.longParty, s.shortParty, s.start);
    }

    // ===================================== Module 3: automated settlement

    /// @notice Permissionless: anyone (either party, a keeper, Chainlink
    ///         Automation) can trigger it. The price used is the oracle round
    ///         that was live AT THE SCHEDULED TIME, so calling late or early
    ///         cannot change the outcome (kills settlement-timing / ordering
    ///         games). Pass roundIdHint = 0 to let the contract search.
    function settle(uint256 swapId, uint80 roundIdHint) external nonReentrant {
        Swap storage s = _swap(swapId);
        require(s.status == SwapStatus.Active, "Swap not active");
        require(s.roundsDone < s.numPeriods, "All rounds settled");
        uint256 t = scheduledTime(swapId, s.roundsDone + 1);
        require(block.timestamp >= t, "Too early for settlement");

        PartyState[2] storage ps = _parties[swapId];
        for (uint8 i = 0; i < 2; i++) {
            require(ps[i].topUpDeadline == 0 || block.timestamp > ps[i].topUpDeadline, "Grace period running");
        }

        // Serious default #1: an unpaid shortfall survived the grace period.
        for (uint8 i = 0; i < 2; i++) {
            if (ps[i].shortfall > 0) {
                _terminate(swapId, i == LONG, i == SHORT);
                return;
            }
        }

        // Still under-collateralised at this settlement? Apply -2 if not yet
        // applied; this settlement runs and then the swap terminates.
        bool[2] memory under;
        for (uint8 i = 0; i < 2; i++) {
            if (ps[i].collateral < s.required) {
                under[i] = true;
                _strike(swapId, i);
            }
        }

        int256 price = _priceAt(s.commodityId, t, roundIdHint);
        s.roundsDone++;
        s.lastPrice = price;
        bool terminating = under[LONG] || under[SHORT];
        _applySettlement(swapId, price, under, terminating);

        if (terminating) {
            _terminate(swapId, under[LONG], under[SHORT]);
            return;
        }

        _bumpReputation(s.longParty);
        _bumpReputation(s.shortParty);

        if (s.roundsDone == s.numPeriods) _tryMature(swapId);
    }

    function _applySettlement(uint256 swapId, int256 price, bool[2] memory under, bool terminating) internal {
        Swap storage s = _swaps[swapId];
        PartyState[2] storage ps = _parties[swapId];
        int256 diff = price - s.refPrice;
        uint32 round = s.roundsDone;

        if (diff == 0) {
            emit Settled(swapId, round, price, diff, 0, 0, address(0));
            return;
        }

        uint8 w = diff > 0 ? LONG : SHORT;
        uint8 l = 1 - w;
        uint256 absDiff = uint256(diff > 0 ? diff : -diff);
        uint256 due = (absDiff * s.quantity * 1 ether) / (10 ** _commodities[s.commodityId].feedDecimals);
        address winner = w == LONG ? s.longParty : s.shortParty;

        uint256 paid;
        if (!under[w]) {
            // An under-collateralised winner forfeits this cycle's payment.
            paid = due <= ps[l].collateral ? due : ps[l].collateral;
            ps[l].collateral -= paid;
            ps[w].collateral += paid; // stays locked until close
            if (due > paid) ps[l].shortfall += due - paid;
        }
        emit Settled(swapId, round, price, diff, due, paid, winner);

        if (!terminating) _marginCall(swapId, l);
    }

    /// @dev After a loss: open a grace period if the loser owes a shortfall
    ///      or must restore collateral before the next settlement.
    function _marginCall(uint256 swapId, uint8 l) internal {
        Swap storage s = _swaps[swapId];
        PartyState storage lp = _parties[swapId][l];
        bool moreRounds = s.roundsDone < s.numPeriods;
        if (lp.shortfall > 0 || (moreRounds && lp.collateral < s.required)) {
            lp.topUpDeadline = uint64(block.timestamp) + gracePeriod;
            lp.strike = false;
            emit MarginCall(swapId, l == LONG ? s.longParty : s.shortParty, lp.collateral, s.required, lp.shortfall, lp.topUpDeadline);
        }
    }

    // ====================================== Module 2: collateral top-up

    /// @notice Pays any outstanding shortfall first (credited to the
    ///         counterparty's LOCKED balance, not pushed out), the rest
    ///         restores own collateral.
    function topUp(uint256 swapId) external payable nonReentrant {
        Swap storage s = _swap(swapId);
        require(s.status == SwapStatus.Active, "Swap not active");
        require(msg.value > 0, "No value");
        uint8 i = _sideOf(s, msg.sender);
        PartyState storage me = _parties[swapId][i];
        PartyState storage other = _parties[swapId][1 - i];

        uint256 v = msg.value;
        uint256 toShortfall = v < me.shortfall ? v : me.shortfall;
        if (toShortfall > 0) {
            me.shortfall -= toShortfall;
            other.collateral += toShortfall;
            v -= toShortfall;
        }
        me.collateral += v;

        if (me.shortfall == 0 && (me.collateral >= s.required || s.roundsDone == s.numPeriods)) {
            me.topUpDeadline = 0;
            me.strike = false;
        }
        emit ToppedUp(swapId, msg.sender, msg.value, toShortfall);

        if (s.roundsDone == s.numPeriods) _tryMature(swapId);
    }

    /// @notice Anyone can enforce after a grace period expires:
    ///   - unpaid shortfall  -> serious default, immediate termination
    ///   - collateral below required -> -2 reputation (once per miss)
    function enforce(uint256 swapId) external nonReentrant {
        Swap storage s = _swap(swapId);
        require(s.status == SwapStatus.Active, "Swap not active");
        PartyState[2] storage ps = _parties[swapId];
        bool acted;
        bool[2] memory serious;
        for (uint8 i = 0; i < 2; i++) {
            PartyState storage p = ps[i];
            if (p.topUpDeadline == 0 || block.timestamp <= p.topUpDeadline) continue;
            if (p.shortfall > 0) {
                serious[i] = true;
                acted = true;
            } else if (p.collateral < s.required && !p.strike) {
                _strike(swapId, i);
                acted = true;
            }
        }
        require(acted, "Nothing to enforce");
        if (serious[LONG] || serious[SHORT]) _terminate(swapId, serious[LONG], serious[SHORT]);
    }

    // ============================================================ payouts

    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        withdrawable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "Withdraw failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ========================================================== internals

    function _tryMature(uint256 swapId) internal {
        Swap storage s = _swaps[swapId];
        PartyState[2] storage ps = _parties[swapId];
        if (ps[LONG].shortfall > 0 || ps[SHORT].shortfall > 0) return; // wait for repayment / enforce()
        s.status = SwapStatus.Matured;
        uint256 a = ps[LONG].collateral;
        uint256 b = ps[SHORT].collateral;
        ps[LONG].collateral = 0;
        ps[SHORT].collateral = 0;
        ps[LONG].topUpDeadline = 0;
        ps[SHORT].topUpDeadline = 0;
        withdrawable[s.longParty] += a;
        withdrawable[s.shortParty] += b;
        users[s.longParty].swapsCompleted++;
        users[s.shortParty].swapsCompleted++;
        emit SwapMatured(swapId, a, b);
    }

    /// @dev One defaulter: its remaining collateral is slashed to the honest
    ///      party, and any shortfall it still owes is covered from the
    ///      insurance pool as far as possible. Both defaulted: each gets its
    ///      own remaining collateral back, both reputations set to 2.
    function _terminate(uint256 swapId, bool longDefaulted, bool shortDefaulted) internal {
        Swap storage s = _swaps[swapId];
        PartyState[2] storage ps = _parties[swapId];
        s.status = SwapStatus.Terminated;

        uint256 a = ps[LONG].collateral;
        uint256 b = ps[SHORT].collateral;
        ps[LONG].collateral = 0;
        ps[SHORT].collateral = 0;
        ps[LONG].topUpDeadline = 0;
        ps[SHORT].topUpDeadline = 0;

        if (longDefaulted && shortDefaulted) {
            withdrawable[s.longParty] += a;
            withdrawable[s.shortParty] += b;
            _setDefault(s.longParty);
            _setDefault(s.shortParty);
            emit SwapTerminated(swapId, address(0), 0, 0);
            return;
        }

        uint8 d = longDefaulted ? LONG : SHORT;
        address defaulter = d == LONG ? s.longParty : s.shortParty;
        address honest = d == LONG ? s.shortParty : s.longParty;
        uint256 slashed = d == LONG ? a : b;
        uint256 honestOwn = d == LONG ? b : a;

        uint256 owed = ps[d].shortfall;
        uint256 cover = owed <= insuranceFund ? owed : insuranceFund;
        insuranceFund -= cover;

        withdrawable[honest] += honestOwn + slashed + cover;
        _setDefault(defaulter);
        emit SwapTerminated(swapId, defaulter, slashed, cover);
    }

    function _strike(uint256 swapId, uint8 i) internal {
        PartyState storage p = _parties[swapId][i];
        if (p.strike) return;
        p.strike = true;
        Swap storage s = _swaps[swapId];
        address who = i == LONG ? s.longParty : s.shortParty;
        User storage u = users[who];
        uint8 old = u.reputation;
        u.reputation = old > MISSED_TOPUP_PENALTY ? old - MISSED_TOPUP_PENALTY : 0;
        emit MissedTopUp(swapId, who);
        emit ReputationChanged(who, old, u.reputation, "missed top-up");
    }

    function _setDefault(address who) internal {
        User storage u = users[who];
        uint8 old = u.reputation;
        u.reputation = DEFAULT_REPUTATION;
        u.defaults++;
        emit ReputationChanged(who, old, DEFAULT_REPUTATION, "serious default");
    }

    function _bumpReputation(address who) internal {
        User storage u = users[who];
        if (u.reputation >= MAX_REPUTATION) return;
        uint8 old = u.reputation;
        u.reputation = old + 1;
        emit ReputationChanged(who, old, u.reputation, "clean settlement");
    }

    function _latestFreshPrice(uint32 commodityId) internal view returns (int256) {
        Commodity storage c = _commodities[commodityId];
        (uint80 rid, int256 answer,, uint256 updatedAt, uint80 answeredIn) = c.feed.latestRoundData();
        require(answer > 0, "Invalid oracle price");
        require(updatedAt != 0 && answeredIn >= rid, "Incomplete oracle round");
        require(block.timestamp - updatedAt <= c.heartbeat, "Stale oracle price");
        return answer;
    }

    /// @dev Returns the oracle answer that was live at time t: the round with
    ///      updatedAt <= t whose successor (if any) has updatedAt > t.
    function _priceAt(uint32 commodityId, uint256 t, uint80 hint) internal view returns (int256) {
        Commodity storage c = _commodities[commodityId];
        if (hint == 0) hint = _findRound(c.feed, t);
        (uint80 latestId,,,,) = c.feed.latestRoundData();
        (, int256 answer,, uint256 updatedAt,) = c.feed.getRoundData(hint);
        require(answer > 0, "Invalid oracle price");
        require(updatedAt != 0 && updatedAt <= t, "Round after settlement time");
        require(t - updatedAt <= c.heartbeat, "Stale oracle price");
        if (hint < latestId) {
            (,,, uint256 nextUpdatedAt,) = c.feed.getRoundData(hint + 1);
            require(nextUpdatedAt > t, "Not the round live at settlement time");
        }
        return answer;
    }

    function _findRound(AggregatorV3Interface feed, uint256 t) internal view returns (uint80) {
        (uint80 rid,,, uint256 updatedAt,) = feed.latestRoundData();
        for (uint256 n = 0; n < ROUND_SEARCH_LIMIT && rid > 0; n++) {
            if (updatedAt <= t) return rid;
            rid--;
            if (rid == 0) break;
            (,,, updatedAt,) = feed.getRoundData(rid);
        }
        revert("No oracle round at settlement time");
    }

    function _sideOf(Swap storage s, address who) internal view returns (uint8) {
        if (who == s.longParty) return LONG;
        if (who == s.shortParty) return SHORT;
        revert("Not a participant");
    }

    function _req(uint256 id) internal view returns (Request storage) {
        require(id < _requests.length, "Unknown request");
        return _requests[id];
    }

    function _swap(uint256 id) internal view returns (Swap storage) {
        require(id < _swaps.length, "Unknown swap");
        return _swaps[id];
    }

    // ============================================================== views

    function scheduledTime(uint256 swapId, uint256 round) public view returns (uint256) {
        Swap storage s = _swap(swapId);
        return uint256(s.start) + round * uint256(s.period);
    }

    function findRoundAt(uint256 commodityId, uint256 t) external view returns (uint80) {
        return _findRound(_commodities[commodityId].feed, t);
    }

    function latestPrice(uint256 commodityId) external view returns (int256 answer, uint256 updatedAt, uint80 roundId) {
        (roundId, answer,, updatedAt,) = _commodities[commodityId].feed.latestRoundData();
    }

    function commodityCount() external view returns (uint256) { return _commodities.length; }
    function requestCount() external view returns (uint256) { return _requests.length; }
    function swapCount() external view returns (uint256) { return _swaps.length; }

    function getCommodity(uint256 id) external view returns (Commodity memory) { return _commodities[id]; }
    function getRequest(uint256 id) external view returns (Request memory) { return _req(id); }
    function getAcceptances(uint256 id) external view returns (Acceptance[] memory) { return _acceptances[id]; }
    function getSwap(uint256 id) external view returns (Swap memory) { return _swap(id); }

    function getParties(uint256 id) external view returns (PartyState memory longState, PartyState memory shortState) {
        _swap(id);
        return (_parties[id][LONG], _parties[id][SHORT]);
    }

    /// @notice Paginated list of requests still open for acceptance.
    function getOpenRequests(uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        uint256 end = offset + limit;
        if (end > _requests.length) end = _requests.length;
        uint256 n;
        uint256[] memory tmp = new uint256[](end > offset ? end - offset : 0);
        for (uint256 i = offset; i < end; i++) {
            if (_requests[i].status == RequestStatus.Open && block.timestamp <= _requests[i].acceptDeadline) tmp[n++] = i;
        }
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = tmp[i];
    }
}
