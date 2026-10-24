// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ICommSwap {
    function register() external payable;
    function acceptRequest(uint256 requestId) external payable;
}

/// @notice Test helper: an acceptor contract that reverts on receiving ETH.
///         In the old design (push refunds in a loop) this blocked selection.
contract RejectingAcceptor {
    ICommSwap public immutable swap;

    constructor(address _swap) {
        swap = ICommSwap(_swap);
    }

    function registerSelf() external payable {
        swap.register{value: msg.value}();
    }

    function accept(uint256 requestId) external payable {
        swap.acceptRequest{value: msg.value}(requestId);
    }

    receive() external payable {
        revert("I reject ETH");
    }
}
