// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockV3Aggregator
/// @notice Chainlink AggregatorV3Interface-compatible mock price feed.
///         Unlike a "return whatever price now" mock, this one keeps a full
///         round history (roundId -> answer, updatedAt) exactly like a real
///         Chainlink aggregator. That lets CommSwap price each settlement at
///         its *scheduled* timestamp instead of at the moment someone calls
///         settle(), which is what kills the settlement-timing attack.
///
///         Price convention used by CommSwap: answer / 10**decimals = price
///         of ONE unit of the commodity in ETH (e.g. 8 decimals, 1.25 ETH/unit
///         = 125000000). On mainnet this would be a commodity/ETH feed or a
///         commodity/USD feed combined with ETH/USD.
///
///         The owner models the trusted oracle reporter (Chainlink DON).
contract MockV3Aggregator {
    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    string public description;
    uint256 public constant version = 4;
    address public owner;

    uint80 public latestRound;
    mapping(uint80 => Round) private _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event NewRound(uint256 indexed roundId, address indexed startedBy, uint256 startedAt);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only oracle reporter");
        _;
    }

    constructor(uint8 _decimals, int256 _initialAnswer, string memory _description) {
        decimals = _decimals;
        description = _description;
        owner = msg.sender;
        _push(_initialAnswer);
    }

    /// @notice Oracle reporter pushes a new price round.
    function updateAnswer(int256 _answer) external onlyOwner {
        _push(_answer);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    function _push(int256 _answer) internal {
        require(_answer > 0, "Price must be positive");
        latestRound++;
        _rounds[latestRound] = Round(_answer, block.timestamp, block.timestamp);
        emit NewRound(latestRound, msg.sender, block.timestamp);
        emit AnswerUpdated(_answer, latestRound, block.timestamp);
    }

    function getRoundData(uint80 _roundId)
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[_roundId];
        require(r.updatedAt != 0, "No data present");
        return (_roundId, r.answer, r.startedAt, r.updatedAt, _roundId);
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        Round memory r = _rounds[latestRound];
        return (latestRound, r.answer, r.startedAt, r.updatedAt, latestRound);
    }
}
