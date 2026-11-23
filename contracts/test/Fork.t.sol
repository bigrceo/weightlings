// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {CreatureWallet} from "../src/CreatureWallet.sol";
import {WeightlingsFactory} from "../src/WeightlingsFactory.sol";
import {WeightlingsTreasury} from "../src/WeightlingsTreasury.sol";

interface IUSDGv3 {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function transferWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32) external;
    function receiveWithAuthorization(address, address, uint256, uint256, uint256, bytes32, uint8, bytes32, bytes32) external;
}

/// Version 3 against the real USDG and identity registry on a copy of Robinhood Chain.
///   FORK_RPC_URL=... forge test --match-contract V3ForkTest -vv
contract V3ForkTest is Test {
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    bytes32 constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant RCPT = keccak256("receipt");

    bool live;
    WeightlingsFactory factory;
    WeightlingsTreasury treasury;
    CreatureWallet a;
    CreatureWallet b;
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address mallory = makeAddr("mallory");
    uint256 ownerKey = 0xA11CE;
    address owner;
    address ownerB = makeAddr("ownerB");
    uint256 customerKey = 0xC0FFEE;
    address customer;

    function setUp() public {
        string memory url = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        vm.setEvmVersion("cancun");
        live = true;
        owner = vm.addr(ownerKey);
        customer = vm.addr(customerKey);
        treasury = new WeightlingsTreasury(admin);
        factory = new WeightlingsFactory(USDG, admin, operator, address(treasury), 2_000, REGISTRY, guardian);
        (, address w1) = factory.createAgent(owner, 1e6, 5e6, keccak256("spec-a"), "https://weightlings.vercel.app/card/a.json", address(treasury), 2_000);
        (, address w2) = factory.createAgent(ownerB, 1e6, 5e6, keccak256("spec-b"), "https://weightlings.vercel.app/card/b.json", address(treasury), 2_000);
        a = CreatureWallet(w1);
        b = CreatureWallet(w2);
        deal(USDG, customer, 10e6);
    }

    function _sign(bytes32 typehash, address to, uint256 value, bytes32 nonce) internal view returns (uint8 v, bytes32 r, bytes32 s, uint256 deadline) {
        deadline = block.timestamp + 600;
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IUSDGv3(USDG).DOMAIN_SEPARATOR(), keccak256(abi.encode(typehash, customer, to, value, 0, deadline, nonce)))
        );
        (v, r, s) = vm.sign(customerKey, digest);
    }

    function _bal(address who) internal view returns (uint256) {
        return IUSDGv3(USDG).balanceOf(who);
    }

    function test_fork_receive_form_cannot_be_front_run_and_pays_holds_and_bills() public {
        if (!live) return;
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(RECEIVE_TYPEHASH, address(a), 1e6, "n1");

        // The owner, and a stranger, try to submit the customer's signed payment themselves: real USDG refuses both.
        vm.prank(owner);
        vm.expectRevert();
        IUSDGv3(USDG).receiveWithAuthorization(customer, address(a), 1e6, 0, deadline, "n1", v, r, s);
        vm.prank(mallory);
        vm.expectRevert();
        IUSDGv3(USDG).transferWithAuthorization(customer, address(a), 1e6, 0, deadline, "n1", v, r, s);
        assertEq(_bal(customer), 10e6);

        vm.prank(operator);
        uint256 g = gasleft();
        a.pay(customer, 1e6, 0, deadline, "n1", v, r, s, "run-1", 500_000, true);
        console.log("gas pay (receive form, fresh wallet)", g - gasleft());
        assertEq(_bal(address(a)), 1e6);
        assertEq(a.heldTotal(), 1e6, "the whole payment is held");
        assertEq(a.externalIncome(), 1e6);

        // The owner cannot take a held payment.
        vm.prank(owner);
        vm.expectRevert();
        a.withdraw(USDG, owner, 1);

        // The same signed payment again moves nothing and is refused.
        vm.prank(operator);
        vm.expectRevert();
        a.pay(customer, 1e6, 0, deadline, "n1", v, r, s, "run-2", 500_000, true);

        vm.prank(operator);
        g = gasleft();
        a.chargeAndSettle("run-1", 100_000, type(uint256).max, RCPT);
        console.log("gas chargeAndSettle", g - gasleft());
        assertEq(_bal(address(treasury)), 120_000);
        assertEq(a.withdrawable(), 880_000);

        // A second payment from the same customer: the warm-wallet cost.
        (v, r, s, deadline) = _sign(RECEIVE_TYPEHASH, address(a), 1e6, "n2");
        vm.prank(operator);
        g = gasleft();
        a.pay(customer, 1e6, 0, deadline, "n2", v, r, s, "run-3", 500_000, true);
        console.log("gas pay (receive form, warm wallet)", g - gasleft());
    }

    function test_fork_transfer_form_still_works_for_other_clients() public {
        if (!live) return;
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(TRANSFER_TYPEHASH, address(a), 1e6, "t1");
        vm.prank(operator);
        uint256 g = gasleft();
        a.pay(customer, 1e6, 0, deadline, "t1", v, r, s, "run-t", 500_000, false);
        console.log("gas pay (transfer form, fresh wallet)", g - gasleft());
        assertEq(a.heldTotal(), 1e6);
        // A transfer-form signature is not accepted on the receive path.
        (v, r, s, deadline) = _sign(TRANSFER_TYPEHASH, address(a), 1e6, "t2");
        vm.prank(operator);
        vm.expectRevert();
        a.pay(customer, 1e6, 0, deadline, "t2", v, r, s, "run-u", 500_000, true);
    }

    function test_fork_refund_and_timed_out_release_send_real_usdg_back() public {
        if (!live) return;
        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(RECEIVE_TYPEHASH, address(a), 1e6, "n1");
        vm.prank(operator);
        a.pay(customer, 1e6, 0, deadline, "n1", v, r, s, "run-1", 500_000, true);
        vm.prank(operator);
        uint256 g = gasleft();
        a.refund("run-1", 10_000, RCPT); // one cent of real cost, the rest goes back
        console.log("gas refund", g - gasleft());
        assertEq(_bal(customer), 10e6 - 12_000, "the customer is out only the cost and its fee");
        assertEq(_bal(address(treasury)), 12_000);
        assertEq(a.income(), 12_000);
        assertEq(a.heldTotal(), 0);

        // A run nobody bills: after a day anyone can send the whole payment back.
        (v, r, s, deadline) = _sign(RECEIVE_TYPEHASH, address(a), 1e6, "n2");
        vm.prank(operator);
        a.pay(customer, 1e6, 0, deadline, "n2", v, r, s, "run-2", 500_000, true);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(mallory);
        a.release("run-2");
        assertEq(_bal(customer), 10e6 - 12_000);
        assertEq(a.heldTotal(), 0);
    }

    function test_fork_one_agent_pays_another_and_a_refund_flows_back_to_the_customer() public {
        if (!live) return;
        vm.prank(owner);
        a.setPayable(address(b), true);

        (uint8 v, bytes32 r, bytes32 s, uint256 deadline) = _sign(RECEIVE_TYPEHASH, address(a), 1e6, "n1");
        vm.startPrank(operator);
        a.pay(customer, 1e6, 0, deadline, "n1", v, r, s, "run-1", 500_000, true);
        uint256 g = gasleft();
        a.payAgent("run-1", address(b), 200_000, "sub-1", 100_000);
        console.log("gas payAgent", g - gasleft());
        vm.stopPrank();
        assertEq(_bal(address(b)), 200_000);
        assertEq(b.heldTotal(), 200_000);

        // The sub-run is refunded in full: the money goes back into the first run on wallet A.
        bytes32 key = b.subRunKey(address(a), "sub-1");
        vm.prank(operator);
        b.refund(key, 0, RCPT);
        assertEq(_bal(address(b)), 0);
        assertEq(_bal(address(a)), 1e6);
        assertEq(a.heldTotal(), 1e6);

        // And when the first run is refunded too, the customer is whole.
        vm.prank(operator);
        a.refund("run-1", 0, RCPT);
        assertEq(_bal(customer), 10e6);
        assertEq(a.income(), 0);
        assertEq(b.income(), 0);
    }
}
