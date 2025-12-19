// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockPriceFeed {
    int256 private price = 100;

    function setPrice(int256 newPrice) external {
        price = newPrice;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (0, price, block.timestamp, block.timestamp, 0);
    }
}
