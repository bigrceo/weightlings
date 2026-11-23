// SPDX-License-Identifier: MIT
// Ported for Weightlings from Zero Lux (MIT, (c) 2026 Zero Lux); see THIRD_PARTY.md. Logic unchanged.
pragma solidity ^0.8.26;

/// @title WeightlingsTreasury
/// @notice Where run charges land. Agent wallets keep paying the treasury they
///         were made with, so this address must never need to change: it is a
///         contract whose owner key can be rotated, and whose owner can take
///         any token out at any time.
contract WeightlingsTreasury {
    address public owner;
    address public pendingOwner;

    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipOffered(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error ZeroAddress();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    receive() external payable {}

    /// @notice Take out a token, or ETH when `token` is the zero address.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            (bool sent,) = to.call{value: amount}("");
            if (!sent) revert TransferFailed();
        } else {
            (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
            if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
        }
        emit Withdrawn(token, to, amount);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
