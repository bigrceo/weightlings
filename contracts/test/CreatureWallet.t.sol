// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {WeightlingsFactory} from "../src/WeightlingsFactory.sol";
import {CreatureWallet} from "../src/CreatureWallet.sol";

/// USDG stand-in for version 3: an issuer block list, approve/transferFrom, and
/// EIP-3009 where a used authorization is accepted again and moves nothing.
contract MockUSDGV3 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint256 public minted;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        minted += amount;
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(!blocked[msg.sender] && !blocked[to], "blocked");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(!blocked[from] && !blocked[to], "blocked");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    /// The same authorization in its receive form: only the payee may submit it, and
    /// the customer signs a different type. v == 28 stands for a good signature of
    /// that type, so a transfer-type signature (27) fails here and the other way round.
    function receiveWithAuthorization(
        address from, address to, uint256 value, uint256, uint256 validBefore, bytes32 nonce, uint8 v, bytes32, bytes32
    ) external {
        require(to == msg.sender, "CallerMustBePayee");
        require(block.timestamp < validBefore, "expired");
        require(v == 28, "bad signature");
        if (authorizationState[from][nonce]) return;
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    /// v == 27 stands for a good customer signature of the transfer type.
    function transferWithAuthorization(
        address from, address to, uint256 value, uint256, uint256 validBefore, bytes32 nonce, uint8 v, bytes32, bytes32
    ) external {
        require(block.timestamp < validBefore, "expired");
        require(v == 27, "bad signature");
        if (authorizationState[from][nonce]) return; // replay: no revert, no movement
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

abstract contract V3Base is Test {
    MockUSDGV3 usdg;
    WeightlingsFactory factory;
    CreatureWallet wallet; // alice's
    CreatureWallet wallet2; // bob's
    CreatureWallet wallet3; // alice's second

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    uint256 aliceKey = 0xA11CE;
    address alice;
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address customer = makeAddr("customer");
    address customer2 = makeAddr("customer2");
    address lender = makeAddr("lender");
    address mallory = makeAddr("mallory");

    uint128 constant RUN_CAP = 10e6; // $10 a run, fee included
    uint128 constant DAY_CAP = 50e6;
    bytes32 constant RCPT = keccak256("receipt");

    uint256 internal nonceSeq;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        alice = vm.addr(aliceKey);
        usdg = new MockUSDGV3();
        factory = new WeightlingsFactory(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        wallet = _make(alice);
        wallet2 = _make(bob);
        wallet3 = _make(alice);
        usdg.mint(customer, 1_000e6);
        usdg.mint(customer2, 1_000e6);
    }

    function _make(address owner_) internal returns (CreatureWallet) {
        (, address w) = factory.createAgent(owner_, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        return CreatureWallet(w);
    }

    function _payTo(CreatureWallet w, address from, uint256 value, bytes32 runId, uint256 budget) internal {
        address op = w.operator();
        bytes32 nonce = bytes32(++nonceSeq);
        vm.prank(op);
        w.pay(from, value, 0, block.timestamp + 600, nonce, 27, bytes32(0), bytes32(0), runId, budget, false);
    }

    /// The same payment signed in the receive form, which only the wallet can submit.
    function _payReceive(CreatureWallet w, address from, uint256 value, bytes32 runId, uint256 budget) internal {
        address op = w.operator();
        bytes32 nonce = bytes32(++nonceSeq);
        vm.prank(op);
        w.pay(from, value, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0), runId, budget, true);
    }

    function _pay(uint256 value, bytes32 runId, uint256 budget) internal {
        _payTo(wallet, customer, value, runId, budget);
    }

    function _bal(CreatureWallet w) internal view returns (uint256) {
        return usdg.balanceOf(address(w));
    }

    function _backed(CreatureWallet w) internal view {
        assertGe(_bal(w), w.heldTotal() + w.parkedTotal() + w.lienUnpaid(), "balance < held + parked + lien owed");
    }
}

// =========================================================================
// A. The pledge gaps of version 2 are closed
// =========================================================================
contract V3PledgeTest is V3Base {
    /// V2 finding 1: a hold could be opened on the payee's unpaid share.
    function test_a_hold_cannot_be_opened_on_money_owed_to_the_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0); // half of profit

        usdg.mint(address(wallet), 1e6); // $1 of income, no run attached
        vm.prank(operator);
        wallet.settle(1e6); // nothing is held, so all of it is final
        assertEq(wallet.lienUnpaid(), 500_000);

        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 500_000); // the owner's half
        assertEq(wallet.withdrawable(), 0);

        vm.prank(operator);
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet.open("r1", 400_000); // all that is left is the lender's
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet.open("r1", 1);
        _backed(wallet);

        assertEq(wallet.settleLien(), 500_000, "the lender collects all of its half");
        assertEq(usdg.balanceOf(lender), 500_000);
    }

    /// The same check with free money next to the lender's share: only the free part can be held.
    function test_open_can_use_only_what_is_left_after_the_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 1e6);
        vm.prank(operator);
        wallet.settle(1e6);
        // $0.50 is the lender's, $0.50 is free.
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet.open("r1", 420_000); // $0.504 with the fee
        wallet.open("r2", 400_000); // $0.48 fits
        vm.stopPrank();
        _backed(wallet);
    }

    /// V2 finding 2: the meter could settle over money still held.
    function test_the_meter_cannot_settle_over_money_still_held() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0); // all of profit

        _pay(600_000, "r1", 500_000);
        assertEq(wallet.heldTotal(), 600_000);

        vm.prank(operator);
        wallet.settle(600_000); // asks for too much
        assertEq(wallet.settledProfit(), 0, "the wallet moves the checkpoint only to profit less held");
        assertEq(wallet.lienUnpaid(), 0);
        _backed(wallet);

        vm.prank(operator);
        wallet.settle(type(uint256).max);
        assertEq(wallet.settledProfit(), 0);

        // Once the run is billed, what is left is profit and can be settled.
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 100_000, type(uint256).max, RCPT);
        assertEq(wallet.profit(), 480_000);
        assertEq(wallet.settledProfit(), 480_000);
        assertEq(wallet.lienUnpaid(), 480_000);
        _backed(wallet);
    }

    /// V2 finding 3: an early checkpoint paid the lien out of the owner's own money.
    function test_an_early_checkpoint_no_longer_pays_the_lien_from_the_owners_money() public {
        usdg.mint(address(wallet), 1e6); // the owner's, before any lien
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        assertEq(wallet.withdrawable(), 1e6, "all of it is the owner's to take");

        _pay(600_000, "r1", 500_000);
        vm.prank(operator);
        wallet.settle(1_600_000); // would count the unbilled $0.60 as final
        assertEq(wallet.settledProfit(), 1e6);
        assertEq(wallet.settleLien(), 0, "the lender collects nothing yet");

        vm.prank(operator);
        wallet.charge("r1", 500_000, RCPT); // the run cost all $0.60
        (,,,, uint256 baseProfit) = wallet.lien();
        assertEq(wallet.profit(), baseProfit, "the lien has earned nothing");
        assertEq(usdg.balanceOf(lender), 0);
        assertEq(wallet.withdrawable(), 1e6, "and the owner's $1.00 is intact");
    }

    /// V2 finding 4: a checkpoint taken by anyone counted held money as final.
    function test_a_taken_checkpoint_leaves_held_money_out() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        _pay(600_000, "r1", 500_000);

        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();

        assertEq(wallet.heldTotal(), 600_000, "the hold is still open");
        assertEq(wallet.lienUnpaid(), 0);
        _backed(wallet);

        // The hold is a day old: anyone releases it, the unbilled payment goes back to
        // the customer, and there is nothing for the next checkpoint to count.
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(usdg.balanceOf(customer), 1_000e6);
        assertEq(wallet.pendingAt(), 0, "the request asked for nothing: every dollar was held when it was made");
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(wallet.profit(), 0);
        _backed(wallet);

        // Income that is billed in time is counted by a taken checkpoint.
        _pay(600_000, "r2", 500_000);
        vm.prank(operator);
        wallet.charge("r2", 100_000, RCPT);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        assertEq(wallet.lienUnpaid(), 480_000);
        _backed(wallet);
    }

    function test_take_checkpoint_needs_a_request_and_a_day() public {
        vm.expectRevert(CreatureWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
        wallet.requestCheckpoint();
        vm.expectRevert(CreatureWallet.CheckpointPending.selector);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(CreatureWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
    }

    /// The meter can no longer move the checkpoint down. In V2 terms this was the
    /// way round the two fixes above: lower it, open a hold on what looks free,
    /// raise it again.
    function test_the_meter_cannot_lower_the_checkpoint_to_free_the_lenders_share() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 2e6);
        vm.prank(operator);
        wallet.settle(2e6);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 1e6);
        assertEq(wallet.lienUnpaid(), 1e6);

        vm.prank(operator);
        wallet.settle(0);
        assertEq(wallet.settledProfit(), 2e6, "the checkpoint did not move");
        assertEq(wallet.lienUnpaid(), 1e6);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet.open("x", 500_000);
        _backed(wallet);
    }

    /// A charge lowers profit, and the checkpoint follows it down: that is the one way it falls.
    function test_a_charge_pulls_the_checkpoint_down_with_profit() public {
        usdg.mint(address(wallet), 2e6);
        vm.prank(operator);
        wallet.settle(2e6);
        vm.prank(operator);
        wallet.open("r1", 1e6);
        vm.prank(operator);
        wallet.charge("r1", 1e6, RCPT);
        assertEq(wallet.profit(), 800_000);
        assertEq(wallet.settledProfit(), 800_000);
    }

    function test_setLien_leaves_money_held_for_open_runs_out_of_its_base() public {
        usdg.mint(address(wallet), 1e6); // free, the owner's
        _pay(3e6, "r1", 1e6); // in flight when the lien begins
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        (,,,, uint256 base) = wallet.lien();
        assertEq(base, 1e6);
        assertEq(wallet.settledProfit(), 1e6);
        assertEq(wallet.withdrawable(), 1e6, "the owner's free money is still the owner's");

        // The run is billed at $0.60; the $2.40 left is profit earned under the lien.
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 500_000, type(uint256).max, RCPT);
        assertEq(wallet.lienUnpaid(), 2_400_000);
        _backed(wallet);
    }

    function test_withdrawable_under_a_lien_keeps_holds_and_unsettled_income_without_counting_twice() public {
        usdg.mint(address(wallet), 1e6); // the owner's, free
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _pay(3e6, "r1", 1e6); // held whole, and unsettled
        assertEq(wallet.unsettled(), 3e6);
        assertEq(wallet.heldTotal(), 3e6);
        assertEq(wallet.withdrawable(), 1e6, "the held payment is kept once, not twice");

        usdg.mint(address(wallet), 500_000); // unsettled income with no run
        assertEq(wallet.withdrawable(), 1e6, "unsettled income beyond the holds is kept too");

        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1e6 + 1);
        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 1e6);
        _backed(wallet);
    }

    function test_owner_cannot_end_a_capped_lien_with_money_that_is_held() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 1e6);
        usdg.mint(address(wallet), 1e6);
        vm.prank(operator);
        wallet.settle(1e6);
        assertEq(wallet.lienUnpaid(), 1e6);
        // The owner takes nothing; a later payment is held whole and is not the lender's money.
        _pay(2e6, "r1", 1e6);
        vm.prank(alice);
        wallet.endLien(); // $1 free and owed: paid, cap reached
        assertEq(usdg.balanceOf(lender), 1e6);
        assertEq(_bal(wallet), 2e6);
        assertEq(wallet.heldTotal(), 2e6);
    }

    function test_owner_cannot_end_a_lien_before_its_cap() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 1e6);
        usdg.mint(address(wallet), 400_000);
        vm.prank(operator);
        wallet.settle(400_000);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienStands.selector);
        wallet.endLien();
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.endLien();
        vm.prank(lender);
        wallet.endLien();
        vm.expectRevert(CreatureWallet.NoLien.selector);
        wallet.settleLien();
    }

    function test_lien_basics_are_as_in_v2() public {
        vm.startPrank(alice);
        vm.expectRevert(CreatureWallet.ZeroAddress.selector);
        wallet.setLien(address(0), 1, 0);
        vm.expectRevert(CreatureWallet.BadLien.selector);
        wallet.setLien(lender, 10_001, 0);
        wallet.setLien(lender, 2_500, 0);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setLien(lender, 1, 0);
        vm.stopPrank();

        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.setLienPayee(mallory);
        vm.prank(lender);
        wallet.setLienPayee(carol);
        (address payee,,,,) = wallet.lien();
        assertEq(payee, carol);

        // adoptTerms needs the payee's yes to the exact terms.
        vm.prank(admin);
        factory.proposeMarkup(1_000);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptMarkup();
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.adoptTerms(treasury, 1_000);
        vm.prank(carol);
        wallet.consentToTerms(treasury, 999);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.TermsChanged.selector);
        wallet.adoptTerms(treasury, 999); // agreed to, but not what the factory holds
        vm.prank(carol);
        wallet.consentToTerms(treasury, 1_000);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.adoptTerms(treasury, 2_000); // not what was agreed to
        vm.prank(alice);
        wallet.adoptTerms(treasury, 1_000);
        assertEq(wallet.markupBps(), 1_000);
    }
}

// =========================================================================
// B. Whole-payment holds and refunds; D. receipts
// =========================================================================
contract V3PayRefundTest is V3Base {
    event Charged(bytes32 indexed runId, uint256 cost, uint256 fee, address indexed treasury, bytes32 receipt);
    event Paid(bytes32 indexed runId, address indexed payer, uint256 value, bool outside);
    event Refunded(bytes32 indexed runId, address indexed payer, uint256 amount, bool parked);

    function test_pay_holds_the_whole_payment_and_records_who_paid() public {
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Paid("r1", customer, 5e6, true);
        _pay(5e6, "r1", 1e6);

        (address opener, uint32 day, uint64 openedAt, uint96 amount, uint80 budget, uint80 reserved) = wallet.holds("r1");
        assertEq(opener, operator, "the hold remembers which meter opened it");
        assertEq(amount, 5e6, "all of the payment is held");
        assertEq(budget, 1e6);
        assertEq(reserved, 1_200_000);
        assertEq(day, block.timestamp / 1 days);
        assertEq(openedAt, block.timestamp);
        assertEq(wallet.heldTotal(), 5e6);
        assertEq(wallet.withdrawable(), 0);
        assertEq(wallet.remainingToday(), DAY_CAP - 1_200_000, "only the run's maximum cost counts against the day");

        (address payer, uint80 value, bool outside,) = wallet.payments("r1");
        assertEq(payer, customer);
        assertEq(value, 5e6);
        assertTrue(outside);

        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
    }

    function test_only_the_operator_can_pay_open_charge_refund_settle() public {
        vm.startPrank(alice);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 1e6, false);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.open("r1", 1);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.charge("r1", 1, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.chargeAndSettle("r1", 1, 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.refund("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.settle(0);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.payAgent("r1", address(wallet2), 1, "s", 1);
        vm.stopPrank();
    }

    function test_a_payment_must_cover_the_runs_maximum_cost_with_the_fee() public {
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.Underpaid.selector);
        wallet.pay(customer, 1_199_999, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 1e6, false);
        assertEq(usdg.balanceOf(customer), 1_000e6, "nothing was taken");
        assertFalse(usdg.authorizationState(customer, "n"));
        _pay(1_200_000, "r1", 1e6); // exactly enough
    }

    function test_pay_refusals_take_nothing() public {
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.NotPaid.selector); // bad signature
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 28, bytes32(0), bytes32(0), "r1", 1e6, false);
        vm.expectRevert(CreatureWallet.ZeroCost.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 0, false);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.pay(customer, 50e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 9e6, false);
        vm.stopPrank();
        vm.prank(alice);
        wallet.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.Paused.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 1e6, false);
        assertEq(usdg.balanceOf(customer), 1_000e6);

        vm.prank(alice);
        wallet.setPaused(false);
        _pay(5e6, "r1", 1e6);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.NotPaid.selector); // the same authorization again moves nothing
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, bytes32(nonceSeq), 27, bytes32(0), bytes32(0), "r2", 1e6, false);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector); // the same run id again
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n2", 27, bytes32(0), bytes32(0), "r1", 1e6, false);
        vm.stopPrank();
    }

    function test_the_day_limit_counts_budgets_not_payments() public {
        for (uint256 i = 0; i < 5; i++) {
            _pay(100e6, bytes32(i + 100), 8_333_333); // 8,333,333 + 20% = 9,999,999
        }
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.OverDayCap.selector);
        wallet.pay(customer, 100e6, 0, block.timestamp + 600, "n9", 27, bytes32(0), bytes32(0), "r9", 8_333_333, false);
    }

    function test_charge_publishes_the_receipt_and_frees_the_rest_for_the_agent() public {
        _pay(5e6, "r1", 1e6);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Charged("r1", 400_000, 80_000, treasury, RCPT);
        vm.prank(operator);
        wallet.charge("r1", 400_000, RCPT);
        assertEq(usdg.balanceOf(treasury), 480_000);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.withdrawable(), 5e6 - 480_000);
        assertEq(wallet.remainingToday(), DAY_CAP - 480_000);
        assertEq(wallet.income(), 5e6);
        assertEq(wallet.externalIncome(), 5e6);
        assertEq(usdg.balanceOf(customer), 995e6, "a charge sends nothing back");
        assertTrue(wallet.runCharged("r1"));
    }

    function test_chargeAndSettle_publishes_the_receipt() public {
        _pay(5e6, "r1", 1e6);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Charged("r1", 1e6, 200_000, treasury, bytes32("abc"));
        vm.prank(operator);
        wallet.chargeAndSettle("r1", 1e6, type(uint256).max, bytes32("abc"));
        assertEq(wallet.settledProfit(), 3_800_000);
    }

    function test_a_charge_cannot_exceed_the_budget_or_be_zero() public {
        _pay(5e6, "r1", 1e6);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.charge("r1", 1e6 + 1, RCPT);
        vm.expectRevert(CreatureWallet.ZeroCost.selector);
        wallet.charge("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.ZeroCost.selector);
        wallet.chargeAndSettle("r1", 0, 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.charge("nope", 1, RCPT);
        vm.stopPrank();
    }

    function test_a_raised_markup_cannot_take_a_charge_past_what_was_reserved() public {
        _pay(5e6, "r1", 1e6); // reserved 1.2
        vm.prank(admin);
        factory.proposeMarkup(5_000);
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptMarkup();
        vm.prank(alice);
        wallet.adoptTerms(treasury, 5_000);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.refund("r1", 1e6, RCPT); // 1.5 with the new fee
        wallet.refund("r1", 800_000, RCPT); // 1.2
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 1_200_000);
    }

    function test_refund_with_no_cost_returns_the_whole_payment() public {
        _pay(5e6, "r1", 1e6);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Charged("r1", 0, 0, treasury, RCPT);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Refunded("r1", customer, 5e6, false);
        vm.prank(operator);
        wallet.refund("r1", 0, RCPT);

        assertEq(usdg.balanceOf(customer), 1_000e6);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(_bal(wallet), 0);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.income(), 0, "a refund is not income");
        assertEq(wallet.profit(), 0);
        assertEq(wallet.externalIncome(), 0);
        assertEq(wallet.paidBy(customer), 0);
        assertEq(wallet.payerCount(), 0);
        assertEq(wallet.topPayerPaid(), 0);
        assertEq(wallet.totalRefunded(), 5e6);
        assertEq(wallet.totalCharged(), 0);
        assertEq(wallet.remainingToday(), DAY_CAP, "the day's room comes back");
        assertTrue(wallet.runCharged("r1"));
    }

    function test_refund_at_full_budget_bills_the_run_and_returns_the_rest() public {
        _pay(5e6, "r1", 1e6);
        vm.prank(operator);
        wallet.refund("r1", 1e6, RCPT);
        assertEq(usdg.balanceOf(treasury), 1_200_000);
        assertEq(usdg.balanceOf(customer), 1_000e6 - 1_200_000);
        assertEq(_bal(wallet), 0);
        assertEq(wallet.income(), 1_200_000);
        assertEq(wallet.totalCharged(), 1_200_000);
        assertEq(wallet.profit(), 0);
        assertEq(wallet.externalIncome(), 1_200_000);
        assertEq(wallet.paidBy(customer), 1_200_000);
        assertEq(wallet.payerCount(), 1);
        assertEq(wallet.remainingToday(), DAY_CAP - 1_200_000);
    }

    function test_refund_when_the_payment_equals_the_cost_sends_nothing_back() public {
        _pay(1_200_000, "r1", 1e6);
        vm.prank(operator);
        wallet.refund("r1", 1e6, RCPT);
        assertEq(wallet.totalRefunded(), 0);
        assertEq(usdg.balanceOf(treasury), 1_200_000);
    }

    function test_refund_cannot_exceed_the_budget() public {
        _pay(5e6, "r1", 1e6);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.refund("r1", 1e6 + 1, RCPT);
    }

    function test_refund_needs_a_recorded_payment_and_an_open_hold() public {
        usdg.mint(address(wallet), 5e6);
        vm.startPrank(operator);
        wallet.open("r1", 1e6);
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.refund("r1", 0, RCPT); // opened from the balance: there is no payer to refund
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.refund("r2", 0, RCPT);
        vm.stopPrank();
    }

    function test_refund_then_charge_reverts_and_charge_then_refund_reverts() public {
        _pay(5e6, "r1", 1e6);
        _pay(5e6, "r2", 1e6);
        vm.startPrank(operator);
        wallet.refund("r1", 100_000, RCPT);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.charge("r1", 100_000, RCPT);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.refund("r1", 0, RCPT);

        wallet.charge("r2", 100_000, RCPT);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.refund("r2", 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.charge("r2", 1, RCPT);

        // Neither id can be opened again, by either door, even with money to cover it.
        usdg.mint(address(wallet), 10e6);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector);
        wallet.open("r1", 1);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector);
        wallet.open("r2", 1);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "nx", 27, bytes32(0), bytes32(0), "r1", 1e6, false);
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 1_000e6 - 10e6 + 4_880_000, "one refund, once");
    }

    function test_a_blocked_payer_does_not_brick_the_refund_and_claims_later() public {
        _pay(5e6, "r1", 1e6);
        usdg.setBlocked(customer, true);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Refunded("r1", customer, 4_400_000, true);
        vm.prank(operator);
        wallet.refund("r1", 500_000, RCPT);

        assertEq(usdg.balanceOf(treasury), 600_000, "the run was billed");
        assertEq(wallet.parked(customer), 4_400_000);
        assertEq(wallet.parkedTotal(), 4_400_000);
        assertEq(_bal(wallet), 4_400_000);
        assertEq(wallet.income(), 600_000, "parked refund is not income");
        assertEq(wallet.externalIncome(), 600_000);
        assertEq(wallet.withdrawable(), 0, "and not the owner's");
        assertEq(wallet.heldTotal(), 0);

        // It cannot be set aside for another run either.
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet.open("r2", 1);

        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NothingParked.selector);
        wallet.claimParked(mallory);
        vm.prank(customer);
        vm.expectRevert(CreatureWallet.ZeroAddress.selector);
        wallet.claimParked(address(0));
        vm.prank(customer);
        wallet.claimParked(customer2); // to an address USDG will pay
        assertEq(usdg.balanceOf(customer2), 1_000e6 + 4_400_000);
        assertEq(wallet.parkedTotal(), 0);
        assertEq(wallet.income(), 600_000, "claiming changes no income figure");
        assertEq(wallet.profit(), 0);
    }

    function test_a_timed_out_payment_goes_back_to_the_customer_whoever_releases_it() public {
        _pay(5e6, "r1", 1e6);
        uint256 day = block.timestamp / 1 days;
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r1");
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r1");
        vm.warp(block.timestamp + 1);

        vm.expectEmit(true, true, false, true, address(wallet));
        emit Refunded("r1", customer, 5e6, false);
        vm.prank(mallory);
        wallet.release("r1");

        assertEq(usdg.balanceOf(customer), 1_000e6, "the whole payment is back with the customer");
        assertEq(_bal(wallet), 0);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.withdrawable(), 0);
        assertEq(wallet.income(), 0);
        assertEq(wallet.profit(), 0);
        assertEq(wallet.externalIncome(), 0);
        assertEq(wallet.paidBy(customer), 0);
        assertEq(wallet.payerCount(), 0);
        assertEq(wallet.topPayerPaid(), 0);
        assertEq(wallet.totalRefunded(), 5e6);
        assertEq(wallet.totalCharged(), 0);
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(wallet.spentOnDay(day), 0, "the day's room comes back");
        assertTrue(wallet.runCharged("r1"), "the run is closed for good");

        // No refund, no charge, no second release, and the id is not reused.
        usdg.mint(address(wallet), 10e6);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.refund("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.charge("r1", 1, RCPT);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector);
        wallet.open("r1", 1e6);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.release("r1");
        vm.stopPrank();
    }

    function test_the_operator_releasing_after_the_timeout_refunds_too() public {
        usdg.mint(alice, 5e6);
        _payTo(wallet, alice, 5e6, "r1", 1e6); // an insider's payment
        assertEq(wallet.insiderIncome(), 5e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        wallet.release("r1");
        assertEq(usdg.balanceOf(alice), 5e6);
        assertEq(wallet.insiderIncome(), 0);
        assertEq(wallet.income(), 0);
    }

    function test_a_timed_out_payment_to_a_blocked_payer_is_parked_for_them() public {
        _pay(5e6, "r1", 1e6);
        usdg.setBlocked(customer, true);
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Refunded("r1", customer, 5e6, true);
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(wallet.parked(customer), 5e6);
        assertEq(wallet.parkedTotal(), 5e6);
        assertEq(wallet.withdrawable(), 0);
        assertEq(wallet.income(), 0);
        assertEq(wallet.externalIncome(), 0);
        vm.prank(customer);
        wallet.claimParked(customer2);
        assertEq(usdg.balanceOf(customer2), 1_005e6);
    }

    function test_a_timed_out_run_returns_what_its_sub_payments_left() public {
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        _pay(5e6, "r1", 3e6);
        uint256 day = block.timestamp / 1 days;
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        vm.warp(block.timestamp + 1 days);
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(usdg.balanceOf(customer), 1_000e6 - 1e6);
        assertEq(wallet.income(), 1e6);
        assertEq(wallet.totalCharged(), 1e6);
        assertEq(wallet.profit(), 0);
        assertEq(wallet.externalIncome(), 1e6);
        assertEq(wallet.spentOnDay(day), 1e6, "the sub-payment stays counted");

        // The sub-run timed out as well: its payment goes back through the paying
        // wallet to the customer, whose run it was.
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.prank(mallory);
        wallet2.release(key);
        assertEq(_bal(wallet2), 0);
        assertEq(wallet2.externalIncome(), 0);
        assertEq(wallet2.income(), 0);
        assertEq(usdg.balanceOf(customer), 1_000e6, "the customer has the whole payment back");
        assertEq(_bal(wallet), 0);
        assertEq(wallet.income(), 0);
        assertEq(wallet.totalCharged(), 0);
        assertEq(wallet.externalIncome(), 0);
        assertEq(wallet.payerCount(), 0);
    }

    function test_a_timed_out_hold_from_the_balance_just_becomes_free_again() public {
        usdg.mint(address(wallet), 5e6);
        vm.prank(operator);
        wallet.open("r1", 1e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(_bal(wallet), 5e6);
        assertEq(wallet.withdrawable(), 5e6);
        assertEq(wallet.income(), 5e6);
        assertEq(wallet.totalRefunded(), 0);
        assertFalse(wallet.runCharged("r1"));
        vm.prank(operator);
        wallet.open("r1", 1e6); // and, as in v2, the id can be used again
    }

    function test_the_operators_early_release_leaves_the_money_with_the_agent() public {
        _pay(5e6, "r1", 1e6);
        vm.prank(operator);
        wallet.release("r1");
        assertEq(wallet.remainingToday(), DAY_CAP);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.withdrawable(), 5e6);
        assertEq(wallet.income(), 5e6);
        assertEq(wallet.externalIncome(), 5e6);
        assertEq(wallet.totalRefunded(), 0);
        assertEq(usdg.balanceOf(customer), 995e6);
        assertFalse(wallet.runCharged("r1"));

        // The run is over all the same: nothing to refund, and the id is not reused.
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.refund("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector);
        wallet.open("r1", 1e6);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.release("r1");
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.release("r1");
        assertEq(usdg.balanceOf(customer), 995e6);
    }

    function test_the_guardian_pause_does_not_stop_a_timed_out_payment_going_back() public {
        _pay(5e6, "r1", 1e6);
        vm.prank(guardian);
        factory.setOperatorPaused(true);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.release("r1");
        vm.warp(block.timestamp + 1 days);
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(usdg.balanceOf(customer), 1_000e6);
    }

    function test_a_timed_out_refund_under_a_lien_pulls_nothing_from_the_lender() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        usdg.mint(address(wallet), 2e6);
        vm.prank(operator);
        wallet.settle(type(uint256).max);
        _pay(5e6, "r1", 1e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(wallet.lienUnpaid(), 2e6);
        _backed(wallet);
        assertEq(wallet.settleLien(), 2e6);
    }

    function test_owner_cannot_stop_an_open_run_being_billed_or_refunded() public {
        _pay(5e6, "r1", 1e6);
        _pay(5e6, "r2", 1e6);
        vm.startPrank(alice);
        wallet.setPaused(true);
        wallet.setLimits(0, 0);
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
        vm.stopPrank();
        vm.startPrank(operator);
        wallet.charge("r1", 1e6, RCPT);
        wallet.refund("r2", 1e6, RCPT);
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 2_400_000);
    }

    function test_income_figures_after_a_mix_of_charges_and_refunds() public {
        _pay(5e6, "r1", 1e6);
        _payTo(wallet, customer2, 4e6, "r2", 1e6);
        usdg.mint(address(wallet), 700_000); // a plain transfer
        vm.startPrank(operator);
        wallet.charge("r1", 500_000, RCPT); // 0.6 to the treasury
        wallet.refund("r2", 250_000, RCPT); // 0.3 to the treasury, 3.7 back
        vm.stopPrank();
        assertEq(wallet.income(), 5e6 + 300_000 + 700_000);
        assertEq(wallet.totalCharged(), 900_000);
        assertEq(wallet.profit(), 5e6 + 700_000 - 600_000);
        assertEq(wallet.externalIncome(), 5_300_000);
        assertEq(wallet.insiderIncome(), 0);
        assertLe(wallet.externalIncome() + wallet.insiderIncome(), wallet.income());
        assertEq(wallet.totalRefunded(), 3_700_000);
        assertEq(wallet.totalOut(), 900_000 + 3_700_000);
        assertEq(wallet.paidBy(customer), 5e6);
        assertEq(wallet.paidBy(customer2), 300_000);
        assertEq(wallet.payerCount(), 2);
    }
}

// =========================================================================
// C. Income from outside customers
// =========================================================================
contract V3IncomeTest is V3Base {
    event Paid(bytes32 indexed runId, address indexed payer, uint256 value, bool outside);

    function test_a_plain_transfer_is_income_but_never_external() public {
        usdg.mint(address(wallet), 3e6);
        assertEq(wallet.income(), 3e6);
        assertEq(wallet.externalIncome(), 0);
        assertEq(wallet.insiderIncome(), 0);
        assertEq(wallet.payerCount(), 0);
        // Even when the meter then opens a run on it.
        vm.prank(operator);
        wallet.open("r1", 1e6);
        assertEq(wallet.externalIncome(), 0);
    }

    function test_the_owner_is_an_insider() public {
        usdg.mint(alice, 5e6);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit Paid("r1", alice, 5e6, false);
        _payTo(wallet, alice, 5e6, "r1", 1e6);
        assertEq(wallet.insiderIncome(), 5e6);
        assertEq(wallet.externalIncome(), 0);
        assertEq(wallet.payerCount(), 0);
        assertEq(wallet.paidBy(alice), 0);
        assertEq(wallet.topPayer(), address(0));
        // An insider's refund comes off the insider figure.
        vm.prank(operator);
        wallet.refund("r1", 0, RCPT);
        assertEq(wallet.insiderIncome(), 0);
    }

    function test_a_previous_owner_stays_an_insider() public {
        vm.prank(alice);
        wallet.transferOwnership(carol);
        vm.prank(carol);
        wallet.acceptOwnership();
        assertTrue(wallet.wasOwner(alice));
        assertTrue(wallet.wasOwner(carol));
        usdg.mint(alice, 5e6);
        usdg.mint(carol, 5e6);
        _payTo(wallet, alice, 5e6, "r1", 1e6);
        _payTo(wallet, carol, 5e6, "r2", 1e6);
        assertEq(wallet.insiderIncome(), 10e6);
        assertEq(wallet.externalIncome(), 0);
    }

    function test_the_lien_payee_is_an_insider() public {
        vm.prank(alice);
        wallet.setLien(lender, 1_000, 0);
        usdg.mint(lender, 5e6);
        _payTo(wallet, lender, 5e6, "r1", 1e6);
        assertEq(wallet.insiderIncome(), 5e6);
        assertEq(wallet.externalIncome(), 0);
    }

    function test_another_wallet_of_the_same_owner_is_an_insider_and_a_strangers_wallet_is_not() public {
        // wallet3 is alice's too; wallet2 is bob's. Each pays `wallet` out of a run of its own.
        _payTo(wallet3, customer, 5e6, "a", 3e6);
        _payTo(wallet2, customer, 5e6, "b", 3e6);
        vm.prank(alice);
        wallet3.setPayable(address(wallet), true);
        vm.prank(bob);
        wallet2.setPayable(address(wallet), true);
        vm.startPrank(operator);
        wallet3.payAgent("a", address(wallet), 1e6, "sub", 500_000);
        wallet2.payAgent("b", address(wallet), 2e6, "sub", 500_000);
        vm.stopPrank();
        assertEq(wallet.insiderIncome(), 1e6);
        assertEq(wallet.externalIncome(), 2e6);
        assertEq(wallet.paidBy(address(wallet2)), 2e6);
        assertEq(wallet.paidBy(address(wallet3)), 0);
        assertEq(wallet.payerCount(), 1);
        assertEq(wallet.topPayer(), address(wallet2));
    }

    function test_insider_or_not_is_decided_when_the_payment_is_made() public {
        // carol and the lender pay as outsiders ...
        usdg.mint(carol, 10e6);
        usdg.mint(lender, 10e6);
        _payTo(wallet, carol, 5e6, "r1", 1e6);
        _payTo(wallet, lender, 5e6, "r2", 1e6);
        assertEq(wallet.externalIncome(), 10e6);
        assertEq(wallet.payerCount(), 2);

        // ... then one becomes the owner and the other the lien payee.
        vm.prank(alice);
        wallet.transferOwnership(carol);
        vm.prank(carol);
        wallet.acceptOwnership();
        vm.prank(carol);
        wallet.setLien(lender, 1_000, 0);
        assertEq(wallet.externalIncome(), 10e6, "what was counted stays counted");
        assertEq(wallet.paidBy(carol), 5e6);

        // From now on they are insiders.
        _payTo(wallet, carol, 5e6, "r3", 1e6);
        _payTo(wallet, lender, 5e6, "r4", 1e6);
        assertEq(wallet.externalIncome(), 10e6);
        assertEq(wallet.insiderIncome(), 10e6);

        // A refund follows the payment's own record, not who the payer is today.
        vm.startPrank(operator);
        wallet.refund("r1", 0, RCPT); // paid as an outsider
        wallet.refund("r3", 0, RCPT); // paid as an insider
        vm.stopPrank();
        assertEq(wallet.externalIncome(), 5e6);
        assertEq(wallet.insiderIncome(), 5e6);
        assertEq(wallet.paidBy(carol), 0);
        assertEq(wallet.payerCount(), 1);

        // And a payee who lets go is an outsider again.
        vm.prank(lender);
        wallet.endLien();
        usdg.mint(lender, 5e6);
        _payTo(wallet, lender, 5e6, "r5", 1e6);
        assertEq(wallet.externalIncome(), 10e6);
    }

    function test_top_payer_under_interleaved_payments() public {
        _payTo(wallet, customer, 2e6, "r1", 1e6);
        assertEq(wallet.topPayer(), customer);
        assertEq(wallet.topPayerPaid(), 2e6);
        _payTo(wallet, customer2, 3e6, "r2", 1e6);
        assertEq(wallet.topPayer(), customer2);
        assertEq(wallet.topPayerPaid(), 3e6);
        _payTo(wallet, customer, 1e6 + 200_000, "r3", 1e6); // 3.2 in all
        assertEq(wallet.topPayer(), customer);
        assertEq(wallet.topPayerPaid(), 3_200_000);
        _payTo(wallet, customer2, 2e6, "r4", 1e6); // 5.0 in all
        assertEq(wallet.topPayer(), customer2);
        assertEq(wallet.topPayerPaid(), 5e6);
        _payTo(wallet, customer2, 2e6, "r5", 1e6); // the top payer pays again
        assertEq(wallet.topPayerPaid(), 7e6);
        assertEq(wallet.payerCount(), 2);
        assertEq(wallet.paidBy(customer), 3_200_000);
        // An equal total does not displace the payer on record.
        _payTo(wallet, customer, 3_800_000, "r6", 1e6); // 7.0 in all
        assertEq(wallet.topPayer(), customer2);
    }

    function test_top_payer_after_refunds() public {
        _payTo(wallet, customer, 2e6, "r1", 1e6);
        _payTo(wallet, customer2, 3e6, "r2", 1e6);
        _payTo(wallet, customer, 2e6, "r3", 1e6); // customer leads, 4 to 3
        assertEq(wallet.topPayer(), customer);

        // A refund to someone who is not on top changes nothing on top.
        vm.prank(operator);
        wallet.refund("r2", 1e6, RCPT); // customer2 down to 1.2
        assertEq(wallet.topPayer(), customer);
        assertEq(wallet.topPayerPaid(), 4e6);

        _payTo(wallet, customer2, 2e6, "r4", 1e6); // customer2 at 3.2
        // A refund to the top payer lowers the figure with it ...
        vm.prank(operator);
        wallet.refund("r3", 0, RCPT); // customer down to 2
        assertEq(wallet.topPayer(), customer, "the record stays on the old payer");
        assertEq(wallet.topPayerPaid(), 2e6, "at its true total");
        assertEq(wallet.topPayerPaid(), wallet.paidBy(wallet.topPayer()));

        // ... and anyone can point the record at the larger payer.
        vm.prank(mallory);
        wallet.notePayer(customer); // no change
        assertEq(wallet.topPayer(), customer);
        vm.prank(mallory);
        wallet.notePayer(customer2);
        assertEq(wallet.topPayer(), customer2);
        assertEq(wallet.topPayerPaid(), 3_200_000);
        vm.prank(mallory);
        wallet.notePayer(mallory); // someone who paid nothing
        assertEq(wallet.topPayer(), customer2);
    }

    function test_top_payer_corrects_itself_when_the_larger_payer_pays_again() public {
        _payTo(wallet, customer, 4e6, "r1", 1e6);
        _payTo(wallet, customer2, 3e6, "r2", 1e6);
        vm.prank(operator);
        wallet.refund("r1", 0, RCPT); // customer at 0, still on record
        assertEq(wallet.topPayer(), customer);
        assertEq(wallet.topPayerPaid(), 0);
        assertEq(wallet.payerCount(), 1);
        _payTo(wallet, customer2, 1_200_000, "r3", 1e6);
        assertEq(wallet.topPayer(), customer2);
        assertEq(wallet.topPayerPaid(), 4_200_000);
    }
}

// =========================================================================
// E. Factory: delayed settings, guardian, rate table
// =========================================================================
contract V3FactoryTest is V3Base {
    function test_constructor_checks() public {
        vm.expectRevert(WeightlingsFactory.ZeroAddress.selector);
        new WeightlingsFactory(address(usdg), admin, operator, treasury, 2_000, address(0), address(0));
        vm.expectRevert(WeightlingsFactory.MarkupTooHigh.selector);
        new WeightlingsFactory(address(usdg), admin, operator, treasury, 5_001, address(0), guardian);
        assertEq(factory.guardian(), guardian);
        assertEq(factory.DELAY(), 2 days);
        assertEq(factory.MAX_MARKUP_BPS(), 5_000);
        assertTrue(factory.isAgentWallet(address(wallet)));
        assertFalse(factory.isAgentWallet(mallory));
        assertEq(factory.agentCount(), 3);
    }

    function test_the_wallet_implementation_cannot_be_initialised() public {
        CreatureWallet impl = CreatureWallet(factory.walletImplementation());
        vm.expectRevert(CreatureWallet.AlreadyInitialised.selector);
        impl.init(mallory, 1, 1);
        vm.expectRevert(CreatureWallet.AlreadyInitialised.selector);
        wallet.init(mallory, 1, 1);
    }

    function test_operator_change_waits_two_days() public {
        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeOperator(mallory);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.ZeroAddress.selector);
        factory.proposeOperator(address(0));
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptOperator();

        vm.prank(admin);
        factory.proposeOperator(carol);
        (uint256 value, uint64 readyAt) = factory.pending(factory.OPERATOR());
        assertEq(value, uint160(carol));
        assertEq(readyAt, block.timestamp + 2 days);
        assertEq(factory.operator(), operator, "nothing has changed yet");

        vm.warp(block.timestamp + 2 days - 1);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptOperator();
        vm.warp(block.timestamp + 1);
        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.acceptOperator();
        vm.prank(admin);
        factory.acceptOperator();
        assertEq(factory.operator(), carol);
        assertEq(wallet.operator(), carol, "wallets follow the factory's operator");
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptOperator();
    }

    function test_markup_change_waits_two_days_and_reaches_only_new_wallets() public {
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.MarkupTooHigh.selector);
        factory.proposeMarkup(5_001);
        vm.prank(admin);
        factory.proposeMarkup(5_000);
        vm.warp(block.timestamp + 2 days - 1);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptMarkup();
        vm.warp(block.timestamp + 1);
        vm.prank(admin);
        factory.acceptMarkup();
        assertEq(factory.markupBps(), 5_000);
        assertEq(wallet.markupBps(), 2_000, "an existing wallet keeps its markup");
        vm.expectRevert(WeightlingsFactory.TermsChanged.selector);
        factory.createAgent(carol, RUN_CAP, DAY_CAP, "s", "", treasury, 2_000);
        (, address w) = factory.createAgent(carol, RUN_CAP, DAY_CAP, "s", "", treasury, 5_000);
        assertEq(CreatureWallet(w).markupBps(), 5_000);
    }

    function test_treasury_change_waits_two_days_and_reaches_a_wallet_only_if_its_owner_adopts() public {
        address t2 = makeAddr("treasury2");
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.ZeroAddress.selector);
        factory.proposeTreasury(address(0));
        vm.prank(admin);
        factory.proposeTreasury(t2);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptTreasury();
        vm.warp(block.timestamp + 2 days);
        vm.prank(admin);
        factory.acceptTreasury();
        assertEq(factory.treasury(), t2);
        assertEq(wallet.treasury(), treasury);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.TermsChanged.selector);
        wallet.adoptTerms(treasury, 2_000);
        vm.prank(alice);
        wallet.adoptTerms(t2, 2_000);
        assertEq(wallet.treasury(), t2);
    }

    function test_guardian_change_waits_two_days() public {
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.ZeroAddress.selector);
        factory.proposeGuardian(address(0));
        vm.prank(admin);
        factory.proposeGuardian(carol);
        vm.warp(block.timestamp + 2 days - 1);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptGuardian();
        vm.prank(carol);
        vm.expectRevert(WeightlingsFactory.NotGuardian.selector);
        factory.setOperatorPaused(true);
        vm.warp(block.timestamp + 1);
        vm.prank(admin);
        factory.acceptGuardian();
        assertEq(factory.guardian(), carol);
        vm.prank(guardian);
        vm.expectRevert(WeightlingsFactory.NotGuardian.selector);
        factory.setOperatorPaused(true);
        vm.prank(carol);
        factory.setOperatorPaused(true);
    }

    function test_a_models_first_rate_needs_no_wait_and_every_later_change_does() public {
        bytes32 model = "model-a";
        (uint64 i0, uint64 o0) = factory.rates(model);
        assertEq(i0, 0);
        assertEq(o0, 0);
        assertFalse(factory.rateSet(model));
        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeRate(model, 1, 2);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptRate(model); // even the first needs a proposal

        vm.prank(admin);
        factory.proposeRate(model, 3_000_000, type(uint64).max); // 3 USDG units a token in; the largest figure out
        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.acceptRate(model);
        vm.prank(admin);
        factory.acceptRate(model); // at once
        (uint64 i1, uint64 o1) = factory.rates(model);
        assertEq(i1, 3_000_000);
        assertEq(o1, type(uint64).max);
        assertTrue(factory.rateSet(model));

        // The second change waits.
        vm.prank(admin);
        factory.proposeRate(model, 5, 6);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptRate(model);
        vm.warp(block.timestamp + 2 days - 1);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptRate(model);
        (i1, o1) = factory.rates(model);
        assertEq(i1, 3_000_000, "nothing has changed yet");
        vm.warp(block.timestamp + 1);
        vm.prank(admin);
        factory.acceptRate(model);
        (i1, o1) = factory.rates(model);
        assertEq(i1, 5);
        assertEq(o1, 6);

        // Each model has its own first time.
        vm.prank(admin);
        factory.proposeRate("model-b", 7, 9);
        vm.prank(admin);
        factory.acceptRate("model-b");
        (uint64 i3, uint64 o3) = factory.rates("model-b");
        assertEq(i3, 7);
        assertEq(o3, 9);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptRate("model-c");
    }

    function test_a_first_rate_of_zero_still_uses_up_the_first_time() public {
        vm.startPrank(admin);
        factory.proposeRate("free", 0, 0);
        factory.acceptRate("free");
        assertTrue(factory.rateSet("free"));
        factory.proposeRate("free", 1, 1);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptRate("free");
        vm.stopPrank();
    }

    function test_the_first_network_cost_needs_no_wait_and_every_later_change_does() public {
        assertFalse(factory.networkCostSet());
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptNetworkCost();
        vm.prank(admin);
        factory.proposeNetworkCost(1_234);
        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.acceptNetworkCost();
        vm.prank(admin);
        factory.acceptNetworkCost();
        assertEq(factory.networkCost(), 1_234);
        assertTrue(factory.networkCostSet());

        vm.prank(admin);
        factory.proposeNetworkCost(99);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptNetworkCost();
        vm.warp(block.timestamp + 2 days - 1);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptNetworkCost();
        vm.warp(block.timestamp + 1);
        vm.prank(admin);
        factory.acceptNetworkCost();
        assertEq(factory.networkCost(), 99);
    }

    function test_the_first_time_exception_does_not_reach_the_other_settings() public {
        vm.startPrank(admin);
        factory.proposeOperator(carol);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptOperator();
        factory.proposeMarkup(1);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptMarkup();
        factory.proposeTreasury(carol);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptTreasury();
        factory.proposeGuardian(carol);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptGuardian();
        vm.stopPrank();
    }

    function test_cancel_drops_each_kind_of_pending_change() public {
        vm.startPrank(admin);
        factory.proposeOperator(carol);
        factory.proposeMarkup(100);
        factory.proposeTreasury(carol);
        factory.proposeGuardian(carol);
        factory.proposeRate("m", 1, 2);
        factory.proposeNetworkCost(5);
        vm.stopPrank();

        bytes32 opKey = factory.OPERATOR();
        bytes32 markupKey = factory.MARKUP();
        bytes32 treasuryKey = factory.TREASURY();
        bytes32 guardianKey = factory.GUARDIAN();
        bytes32 rateKey = factory.rateKey("m");
        bytes32 netKey = factory.NETWORK_COST();
        assertEq(opKey, bytes32("operator"));

        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.cancel(opKey);

        vm.startPrank(admin);
        factory.cancel(opKey);
        factory.cancel(markupKey);
        factory.cancel(treasuryKey);
        factory.cancel(guardianKey);
        factory.cancel(rateKey);
        factory.cancel(netKey);
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.cancel(opKey);
        vm.warp(block.timestamp + 3 days);
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptOperator();
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptMarkup();
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptTreasury();
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptGuardian();
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptRate("m");
        vm.expectRevert(WeightlingsFactory.NothingPending.selector);
        factory.acceptNetworkCost();
        vm.stopPrank();
        assertEq(factory.operator(), operator);
        assertEq(factory.markupBps(), 2_000);
        assertEq(factory.treasury(), treasury);
        assertEq(factory.guardian(), guardian);
    }

    function test_proposing_again_replaces_the_value_and_restarts_the_wait() public {
        vm.prank(admin);
        factory.proposeOperator(carol);
        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        factory.proposeOperator(mallory);
        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptOperator();
        vm.warp(block.timestamp + 1 days);
        vm.prank(admin);
        factory.acceptOperator();
        assertEq(factory.operator(), mallory);
    }

    function test_factory_ownership_is_two_step() public {
        vm.prank(admin);
        factory.transferOwnership(carol);
        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.acceptOwnership();
        vm.prank(carol);
        factory.acceptOwnership();
        assertEq(factory.owner(), carol);
    }

    // ---- guardian ----

    function test_who_may_pause_and_unpause() public {
        vm.prank(mallory);
        vm.expectRevert(WeightlingsFactory.NotGuardian.selector);
        factory.setOperatorPaused(true);
        vm.prank(operator);
        vm.expectRevert(WeightlingsFactory.NotGuardian.selector);
        factory.setOperatorPaused(true);

        vm.prank(admin);
        factory.setOperatorPaused(true); // the owner may pause
        assertTrue(factory.operatorPaused());
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.NotGuardian.selector);
        factory.setOperatorPaused(false); // but not unpause
        vm.prank(guardian);
        factory.setOperatorPaused(false);
        assertFalse(factory.operatorPaused());
        vm.prank(guardian);
        factory.setOperatorPaused(true);
        assertTrue(factory.operatorPaused());
    }

    function test_the_guardian_can_do_nothing_else() public {
        vm.startPrank(guardian);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeOperator(guardian);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeMarkup(1);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeTreasury(guardian);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeGuardian(guardian);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeRate("m", 1, 1);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.proposeNetworkCost(1);
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.cancel("operator");
        vm.expectRevert(WeightlingsFactory.NotOwner.selector);
        factory.transferOwnership(guardian);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.open("r", 1);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.withdraw(address(usdg), guardian, 0);
        vm.stopPrank();
    }

    function test_the_pause_blocks_every_operator_action() public {
        _pay(5e6, "r1", 3e6);
        usdg.mint(address(wallet), 5e6);
        vm.prank(guardian);
        factory.setOperatorPaused(true);

        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r2", 1e6, false);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.open("r2", 1e6);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.charge("r1", 1e6, RCPT);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.chargeAndSettle("r1", 1e6, 0, RCPT);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.settle(1);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.refund("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.release("r1"); // the operator's early release is an operator action too
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 995e6);
        assertEq(wallet.heldTotal(), 5e6);

        vm.prank(guardian);
        factory.setOperatorPaused(false);
        vm.prank(operator);
        wallet.charge("r1", 1e6, RCPT);
    }

    function test_the_pause_blocks_nothing_else() public {
        // A lien with money owed, a parked refund, an open hold, a pending checkpoint.
        usdg.mint(address(wallet), 1e6);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 2e6);
        vm.prank(operator);
        wallet.settle(type(uint256).max); // lender is owed 1.0
        _pay(5e6, "r1", 1e6);
        _payTo(wallet, customer2, 5e6, "r2", 1e6);
        usdg.setBlocked(customer2, true);
        vm.prank(operator);
        wallet.refund("r2", 0, RCPT); // parked for customer2
        usdg.setBlocked(customer2, false);

        vm.prank(guardian);
        factory.setOperatorPaused(true);

        // owner
        vm.startPrank(alice);
        wallet.withdraw(address(usdg), alice, wallet.withdrawable());
        assertEq(usdg.balanceOf(alice), 2e6);
        wallet.setLimits(1, 2);
        wallet.setPaused(true);
        wallet.setPaused(false);
        wallet.transferOwnership(carol);
        vm.stopPrank();
        // lien
        assertEq(wallet.settleLien(), 1e6);
        vm.prank(lender);
        wallet.consentToTerms(treasury, 2_000);
        vm.prank(lender);
        wallet.consentToOperator(carol);
        vm.prank(alice);
        wallet.setOperator(carol);
        vm.prank(lender);
        wallet.consentToPayable(address(wallet2));
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        vm.prank(lender);
        wallet.setLienPayee(mallory);
        // parked
        vm.prank(customer2);
        wallet.claimParked(customer2);
        assertEq(usdg.balanceOf(customer2), 1_000e6);
        // checkpoint by anyone
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        // release after the timeout, by anyone
        vm.prank(mallory);
        wallet.release("r1");
        assertEq(wallet.heldTotal(), 0);
        assertEq(usdg.balanceOf(customer), 1_000e6, "and the unbilled payment goes back");
        wallet.notePayer(customer);
        vm.prank(mallory);
        wallet.endLien();
        // the factory still takes agents and proposals
        factory.createAgent(carol, 1, 1, "s", "", treasury, 2_000);
        vm.prank(admin);
        factory.proposeMarkup(1);
    }
}

// =========================================================================
// F. A billing key each owner can replace
// =========================================================================
contract V3CustomOperatorTest is V3Base {
    address ownOp = makeAddr("own-operator");

    function test_only_the_owner_names_the_wallets_operator() public {
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.setOperator(mallory);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.setOperator(operator);
    }

    function test_custom_operator_has_the_powers_and_the_factory_operator_has_none() public {
        assertEq(wallet.operator(), operator);
        vm.startPrank(alice);
        wallet.setPayable(address(wallet2), true);
        wallet.setOperator(ownOp);
        vm.stopPrank();
        assertEq(wallet.operator(), ownOp);
        assertEq(wallet.customOperator(), ownOp);
        assertEq(wallet2.operator(), operator, "other wallets are untouched");

        usdg.mint(address(wallet), 5e6);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 1e6, false);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.open("r1", 1e6);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.settle(1);
        vm.stopPrank();

        vm.startPrank(ownOp);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 3e6, false);
        wallet.open("r2", 1e6);
        wallet.open("r3", 1e6);
        wallet.open("r4", 1e6);
        wallet.settle(1);
        vm.expectRevert(CreatureWallet.NotAccepted.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000); // wallet2 is run by another meter
        wallet.release("r2"); // early release is the custom operator's
        vm.stopPrank();

        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.charge("r1", 1, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.chargeAndSettle("r1", 1, 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.refund("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.payAgent("r1", address(wallet2), 1, "s2", 1);
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r3"); // the factory operator is a stranger here
        vm.stopPrank();

        vm.startPrank(ownOp);
        wallet.charge("r3", 1e6, RCPT);
        wallet.chargeAndSettle("r4", 1e6, 0, RCPT);
        wallet.refund("r1", 1e6, RCPT);
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 3_600_000, "fees still go to the pinned treasury at the pinned markup");

        // Zero goes back to the factory's operator.
        vm.prank(alice);
        wallet.setOperator(address(0));
        assertEq(wallet.operator(), operator);
        vm.prank(ownOp);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.open("r5", 1);
        vm.prank(operator);
        wallet.open("r5", 1);
    }

    function test_the_guardian_pause_applies_to_a_custom_operator() public {
        vm.prank(alice);
        wallet.setOperator(ownOp);
        vm.prank(guardian);
        factory.setOperatorPaused(true);
        vm.startPrank(ownOp);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r1", 1e6, false);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.settle(0);
        vm.stopPrank();
    }

    function test_under_a_lien_the_payee_must_agree_to_the_exact_operator() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);

        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setOperator(ownOp);

        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.consentToOperator(ownOp);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.consentToOperator(ownOp);

        vm.prank(lender);
        wallet.consentToOperator(ownOp);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setOperator(mallory); // not the address agreed to
        vm.prank(alice);
        wallet.setOperator(ownOp);
        assertEq(wallet.operator(), ownOp);

        // The consent was for one change. Going back needs another, for the zero address.
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setOperator(ownOp);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setOperator(address(0));
        vm.prank(lender);
        wallet.consentToOperator(address(0));
        vm.prank(alice);
        wallet.setOperator(address(0));
        assertEq(wallet.operator(), operator);
    }

    function test_a_new_payee_has_agreed_to_nothing_and_no_consent_outlives_the_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(lender);
        wallet.consentToOperator(ownOp);
        vm.prank(lender);
        wallet.setLienPayee(carol);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setOperator(ownOp);

        vm.prank(carol);
        wallet.consentToOperator(ownOp);
        vm.prank(carol);
        wallet.endLien();
        assertEq(wallet.lienOperatorConsent(), bytes32(0));
        // With no lien and no payee, nobody can leave a consent behind for the next lien.
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.consentToOperator(ownOp);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setOperator(ownOp);
    }
}

// =========================================================================
// G. Agents paying agents
// =========================================================================
contract V3PayAgentTest is V3Base {
    event AgentPaid(bytes32 indexed runId, address indexed toWallet, uint256 value, bytes32 subRunId);
    event Paid(bytes32 indexed runId, address indexed payer, uint256 value, bool outside);

    event PayableSet(address indexed toWallet, bool allowed);

    function setUp() public override {
        super.setUp();
        vm.startPrank(alice);
        wallet.setPayable(address(wallet2), true);
        wallet.setPayable(address(wallet3), true);
        vm.stopPrank();
        _pay(5e6, "r1", 3e6); // budget 3.0, reserved 3.6, all 5.0 held
    }

    // ---- who may be paid: the owner's list ----

    function test_nothing_is_payable_until_the_owner_allows_it() public {
        CreatureWallet fresh = _make(alice);
        _payTo(fresh, customer, 5e6, "x", 3e6);
        assertFalse(fresh.payableTo(address(wallet2)));
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotPayable.selector);
        fresh.payAgent("x", address(wallet2), 1e6, "s", 500_000);

        vm.expectEmit(true, false, false, true, address(fresh));
        emit PayableSet(address(wallet2), true);
        vm.prank(alice);
        fresh.setPayable(address(wallet2), true);
        assertTrue(fresh.payableTo(address(wallet2)));
        vm.prank(operator);
        fresh.payAgent("x", address(wallet2), 1e6, "s", 500_000);
        assertEq(_bal(wallet2), 1e6);

        // Allowing one wallet allows no other.
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotPayable.selector);
        fresh.payAgent("x", address(wallet3), 1e6, "s2", 500_000);
    }

    function test_only_the_owner_edits_the_list() public {
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.setPayable(mallory, true);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.setPayable(address(wallet2), true);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.setPayable(address(wallet2), false);
    }

    function test_the_owner_can_take_a_wallet_off_the_list() public {
        vm.expectEmit(true, false, false, true, address(wallet));
        emit PayableSet(address(wallet2), false);
        vm.prank(alice);
        wallet.setPayable(address(wallet2), false);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotPayable.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet3), 1e6, "s", 500_000); // the other one still stands
    }

    function test_only_an_agent_wallet_of_this_factory_can_be_listed() public {
        vm.startPrank(alice);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.setPayable(mallory, true);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.setPayable(address(usdg), true);
        WeightlingsFactory other =
            new WeightlingsFactory(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        (, address foreign) = other.createAgent(mallory, RUN_CAP, DAY_CAP, "s", "", treasury, 2_000);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.setPayable(foreign, true);
        wallet.setPayable(mallory, false); // taking off what was never on is a no-op
        vm.stopPrank();
        assertEq(wallet.payableCount(), 2);
    }

    function test_the_list_can_be_read_on_chain_and_stays_right_as_it_changes() public {
        CreatureWallet w4 = _make(carol);
        CreatureWallet w5 = _make(carol);
        assertEq(wallet.payableCount(), 2);
        assertEq(wallet.payableAt(0), address(wallet2));
        assertEq(wallet.payableAt(1), address(wallet3));

        vm.startPrank(alice);
        wallet.setPayable(address(w4), true);
        wallet.setPayable(address(w5), true);
        wallet.setPayable(address(w4), true); // again: no second entry
        assertEq(wallet.payableCount(), 4);

        wallet.setPayable(address(wallet2), false); // from the front: the last takes its place
        assertEq(wallet.payableCount(), 3);
        assertEq(wallet.payableAt(0), address(w5));
        assertEq(wallet.payableAt(1), address(wallet3));
        assertEq(wallet.payableAt(2), address(w4));
        assertFalse(wallet.payableTo(address(wallet2)));
        assertTrue(wallet.payableTo(address(w5)));

        wallet.setPayable(address(w4), false); // from the end
        wallet.setPayable(address(wallet2), false); // already off
        assertEq(wallet.payableCount(), 2);
        wallet.setPayable(address(w5), false);
        wallet.setPayable(address(wallet3), false);
        assertEq(wallet.payableCount(), 0);
        vm.expectRevert();
        wallet.payableAt(0);
        wallet.setPayable(address(w4), true);
        assertEq(wallet.payableAt(0), address(w4));
        vm.stopPrank();

        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotPayable.selector);
        wallet.payAgent("r1", address(wallet3), 1e6, "s", 500_000);
        vm.prank(operator);
        wallet.payAgent("r1", address(w4), 1e6, "s", 500_000);
    }

    function test_under_a_lien_allowing_needs_the_payees_consent_and_removing_does_not() public {
        CreatureWallet w4 = _make(carol);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);

        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setPayable(address(w4), true);

        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.consentToPayable(address(w4));
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.consentToPayable(address(w4));

        address w5 = address(_make(carol));
        vm.prank(lender);
        wallet.consentToPayable(address(w4));
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setPayable(w5, true); // not the address agreed to
        vm.prank(alice);
        wallet.setPayable(address(w4), true);
        assertTrue(wallet.payableTo(address(w4)));
        assertEq(wallet.lienPayableConsent(), bytes32(0), "the consent was for one addition");
        vm.prank(operator);
        wallet.payAgent("r1", address(w4), 1e6, "s", 500_000);

        // Removing needs nobody's consent, and what was listed before the lien still works.
        vm.startPrank(alice);
        wallet.setPayable(address(w4), false);
        wallet.setPayable(address(wallet2), false);
        // Putting either back is an addition again.
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setPayable(address(w4), true);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setPayable(address(wallet2), true);
        // Saying yes again to one already listed is no addition.
        wallet.setPayable(address(wallet3), true);
        vm.stopPrank();
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet3), 1e6, "s", 500_000);
    }

    function test_a_payable_consent_does_not_outlive_its_payee_or_its_lien() public {
        CreatureWallet w4 = _make(carol);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(lender);
        wallet.consentToPayable(address(w4));
        vm.prank(lender);
        wallet.setLienPayee(carol);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setPayable(address(w4), true);
        vm.prank(carol);
        wallet.consentToPayable(address(w4));
        vm.prank(carol);
        wallet.endLien();
        assertEq(wallet.lienPayableConsent(), bytes32(0));
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienExists.selector);
        wallet.setPayable(address(w4), true);
    }

    // ---- paying ----

    function test_payAgent_moves_the_money_and_opens_a_paid_run_on_the_other_wallet() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.expectEmit(true, true, false, true, address(wallet2));
        emit Paid(key, address(wallet), 1e6, true);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit AgentPaid("r1", address(wallet2), 1e6, "s1");
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);

        // the paying side
        (,,, uint96 amount, uint80 budget, uint80 reserved) = wallet.holds("r1");
        assertEq(amount, 4e6);
        assertEq(budget, 2e6);
        assertEq(reserved, 2_600_000);
        assertEq(wallet.heldTotal(), 4e6);
        assertEq(_bal(wallet), 4e6);
        assertEq(wallet.totalCharged(), 1e6, "the sub-payment is cost, with no markup");
        assertEq(usdg.balanceOf(treasury), 0);
        assertEq(wallet.income(), 5e6);
        assertEq(wallet.profit(), 4e6);
        assertEq(wallet.remainingToday(), DAY_CAP - 3_600_000, "it was already counted against the day");
        assertEq(usdg.allowance(address(wallet), address(wallet2)), 0, "no approval is left behind");

        // the receiving side: a paid run, all of it held
        (,,, uint96 amount2, uint80 budget2, uint80 reserved2) = wallet2.holds(key);
        assertEq(amount2, 1e6);
        assertEq(budget2, 500_000);
        assertEq(reserved2, 600_000);
        (address payer, uint80 value, bool outside,) = wallet2.payments(key);
        assertEq(payer, address(wallet));
        assertEq(value, 1e6);
        assertTrue(outside);
        assertEq(wallet2.heldTotal(), 1e6);
        assertEq(wallet2.withdrawable(), 0, "the receiving owner cannot reach it");
        assertEq(wallet2.externalIncome(), 1e6);
        assertEq(wallet2.remainingToday(), DAY_CAP - 600_000);
        (,,, uint96 raw,,) = wallet2.holds("s1");
        assertEq(raw, 0, "the run is filed under the paying wallet's own range of ids");

        // The receiving wallet's run is billed with its own markup, to its own treasury.
        vm.prank(operator);
        wallet2.charge(key, 500_000, RCPT);
        assertEq(usdg.balanceOf(treasury), 600_000);
        assertEq(wallet2.withdrawable(), 400_000);
    }

    function test_sub_payments_and_the_charge_together_stay_within_the_budget() public {
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.payAgent("r1", address(wallet2), 3e6 + 1, "s1", 1e6);
        wallet.payAgent("r1", address(wallet2), 2e6, "s1", 1e6);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.payAgent("r1", address(wallet2), 1e6 + 1, "s2", 500_000);
        wallet.payAgent("r1", address(wallet3), 400_000, "s2", 100_000);
        // 0.6 of budget is left
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.charge("r1", 600_001, RCPT);
        wallet.charge("r1", 600_000, RCPT);
        vm.stopPrank();
        assertEq(wallet.totalCharged(), 2e6 + 400_000 + 720_000);
        assertEq(usdg.balanceOf(treasury), 720_000);
        assertEq(_bal(wallet), 5e6 - 2_400_000 - 720_000);
        assertEq(wallet.heldTotal(), 0);
        assertEq(wallet.remainingToday(), DAY_CAP - 2_400_000 - 720_000);
    }

    function test_a_run_spent_entirely_on_sub_payments_can_still_be_closed() public {
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 3e6, "s1", 1e6);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.charge("r1", 1, RCPT);
        wallet.refund("r1", 0, RCPT); // the 2.0 that was never budget goes back
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 1_000e6 - 3e6);
        assertEq(wallet.income(), 3e6);
        assertEq(wallet.profit(), 0);
    }

    function test_refund_after_sub_payments_returns_what_is_left_of_the_payment() public {
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        wallet.refund("r1", 1e6, RCPT); // 1.2 to the treasury
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 1_000e6 - 5e6 + 2_800_000);
        assertEq(_bal(wallet), 0);
        assertEq(wallet.income(), 2_200_000);
        assertEq(wallet.profit(), 0);
        assertEq(wallet.externalIncome(), 2_200_000);
    }

    function test_payAgent_restrictions() public {
        usdg.mint(address(wallet), 5e6);
        address unlisted = address(_make(carol));
        vm.startPrank(operator);
        wallet.open("o1", 1e6);

        vm.expectRevert(CreatureWallet.NotPayable.selector);
        wallet.payAgent("r1", unlisted, 1e6, "s", 500_000); // an agent wallet the owner has not listed
        vm.expectRevert(CreatureWallet.NotOpen.selector);
        wallet.payAgent("nope", address(wallet2), 1e6, "s", 500_000); // no open hold
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.payAgent("o1", address(wallet2), 1e6, "s", 500_000); // the hold did not come from pay
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.payAgent("r1", mallory, 1e6, "s", 500_000); // not an agent wallet
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.payAgent("r1", address(usdg), 1e6, "s", 500_000);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.payAgent("r1", address(wallet), 1e6, "s", 500_000); // itself
        vm.expectRevert(CreatureWallet.ZeroCost.selector);
        wallet.payAgent("r1", address(wallet2), 0, "s", 500_000);
        vm.expectRevert(CreatureWallet.Underpaid.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 1e6); // 1.2 with the other wallet's fee
        vm.expectRevert(CreatureWallet.ZeroCost.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 0);
        vm.stopPrank();
        assertEq(wallet.heldTotal(), 5e6 + 1_200_000, "nothing moved");
        assertEq(_bal(wallet2), 0);
    }

    function test_a_wallet_of_another_factory_is_not_an_agent_wallet_here() public {
        WeightlingsFactory other =
            new WeightlingsFactory(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        (, address foreign) = other.createAgent(mallory, RUN_CAP, DAY_CAP, "s", "", treasury, 2_000);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.payAgent("r1", foreign, 1e6, "s", 500_000);
    }

    function test_the_receiving_wallets_pause_and_limits_apply() public {
        vm.prank(bob);
        wallet2.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.Paused.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);

        vm.startPrank(bob);
        wallet2.setPaused(false);
        wallet2.setLimits(500_000, DAY_CAP);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.OverRunCap.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000); // 0.6 is over bob's run limit

        vm.prank(bob);
        wallet2.setLimits(RUN_CAP, 500_000);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.OverDayCap.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        assertEq(_bal(wallet), 5e6);
        assertEq(usdg.allowance(address(wallet), address(wallet2)), 0);
    }

    function test_the_paying_wallets_own_pause_does_not_stop_a_run_already_open() public {
        vm.prank(alice);
        wallet.setPaused(true);
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
    }

    function test_a_sub_run_id_is_used_once_per_paying_wallet() public {
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        vm.stopPrank();
        // Another paying wallet may use the same sub-run id, and neither takes the
        // plain id from the receiving wallet's own meter.
        _payTo(wallet3, customer, 5e6, "x", 3e6);
        vm.prank(alice);
        wallet3.setPayable(address(wallet2), true);
        vm.prank(operator);
        wallet3.payAgent("x", address(wallet2), 1e6, "s", 500_000);
        _payTo(wallet2, customer, 5e6, "s", 1e6);
        assertEq(wallet2.heldTotal(), 7e6);
    }

    function test_only_an_agent_wallet_can_call_the_receiving_door() public {
        usdg.mint(mallory, 5e6);
        vm.startPrank(mallory);
        usdg.approve(address(wallet2), 5e6);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet2.payFromAgent(1e6, "s", 500_000, operator);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet2.payFromAgent(1e6, "s", 500_000, operator);
        // An agent wallet that calls without having approved the money is refused too.
        vm.prank(address(wallet));
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet2.payFromAgent(1e6, "s", 500_000, operator);
        // And the bare implementation takes nothing.
        CreatureWallet impl = CreatureWallet(factory.walletImplementation());
        vm.prank(address(wallet));
        vm.expectRevert();
        impl.payFromAgent(1e6, "s", 500_000, operator);
    }

    event AgentReturned(bytes32 indexed runId, address indexed fromWallet, uint256 amount);

    function test_a_sub_run_refund_goes_back_into_the_paying_run_while_it_is_open() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        (bytes32 parent, uint256 left) = wallet.subs(address(wallet2), key);
        assertEq(parent, bytes32("r1"));
        assertEq(left, 1e6);

        vm.expectEmit(true, true, false, true, address(wallet));
        emit AgentReturned("r1", address(wallet2), 880_000);
        vm.prank(operator);
        wallet2.refund(key, 100_000, RCPT); // 0.12 to the treasury, 0.88 back

        assertEq(_bal(wallet2), 0);
        assertEq(wallet2.externalIncome(), 120_000);
        assertEq(wallet2.totalOut(), 1e6);
        assertEq(usdg.allowance(address(wallet2), address(wallet)), 0);
        (, left) = wallet.subs(address(wallet2), key);
        assertEq(left, 120_000);

        // The paying run has it back: in its hold, in its budget, in its day reservation.
        (,,, uint96 amount, uint80 budget, uint80 reserved) = wallet.holds("r1");
        assertEq(amount, 5e6 - 120_000);
        assertEq(budget, 3e6 - 120_000);
        assertEq(reserved, 3_600_000 - 120_000);
        assertEq(wallet.heldTotal(), 5e6 - 120_000);
        assertEq(_bal(wallet), 5e6 - 120_000);
        assertEq(wallet.withdrawable(), 0, "the owner cannot reach it");
        assertEq(wallet.totalCharged(), 120_000, "only what the sub-run really cost is cost");
        assertEq(wallet.income(), 5e6, "and it was never income");
        assertEq(wallet.externalIncome(), 5e6);
        assertEq(wallet.totalOut(), 120_000);

        // So the customer gets it when the run is refunded.
        vm.prank(operator);
        wallet.refund("r1", 0, RCPT);
        assertEq(usdg.balanceOf(customer), 1_000e6 - 120_000);
    }

    function test_a_sub_run_refund_after_the_paying_run_was_refunded_goes_on_to_the_customer() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        wallet.refund("r1", 1e6, RCPT); // 1.2 to the treasury, 2.8 back to the customer
        assertEq(usdg.balanceOf(customer), 1_000e6 - 5e6 + 2_800_000);
        wallet2.refund(key, 0, RCPT); // the sub-run cost nothing after all
        vm.stopPrank();

        assertEq(usdg.balanceOf(customer), 1_000e6 - 1_200_000, "the customer paid for the run's own cost and nothing else");
        assertEq(_bal(wallet), 0);
        assertEq(_bal(wallet2), 0);
        assertEq(wallet.income(), 1_200_000);
        assertEq(wallet.totalCharged(), 1_200_000);
        assertEq(wallet.profit(), 0);
        assertEq(wallet.externalIncome(), 1_200_000);
        assertEq(wallet.paidBy(customer), 1_200_000);
        assertEq(wallet.totalRefunded(), 3_800_000);
    }

    function test_a_sub_run_refund_to_a_blocked_customer_is_parked_in_the_paying_wallet() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        wallet.refund("r1", 0, RCPT);
        usdg.setBlocked(customer, true);
        wallet2.refund(key, 0, RCPT);
        vm.stopPrank();
        assertEq(wallet.parked(customer), 1e6);
        assertEq(wallet.withdrawable(), 0);
        assertEq(wallet.income(), 0);
    }

    function test_a_sub_run_refund_after_the_paying_run_was_charged_lowers_that_runs_cost() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        wallet.charge("r1", 1e6, RCPT); // 1.2 to the treasury; the rest is the agent's
        assertEq(wallet.profit(), 5e6 - 1e6 - 1_200_000);
        wallet2.refund(key, 0, RCPT);
        vm.stopPrank();

        assertEq(usdg.balanceOf(customer), 995e6, "a charged run sends nothing back to the customer");
        assertEq(_bal(wallet), 5e6 - 1_200_000);
        assertEq(wallet.totalCharged(), 1_200_000, "the cost is taken back, not booked as income");
        assertEq(wallet.income(), 5e6);
        assertEq(wallet.profit(), 5e6 - 1_200_000);
        assertEq(wallet.externalIncome(), 5e6);
        assertEq(wallet.withdrawable(), 5e6 - 1_200_000);
    }

    function test_a_sub_run_return_after_the_paying_runs_early_release_stays_with_the_agent() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        wallet.release("r1"); // early: the money stays with the agent
        wallet2.refund(key, 0, RCPT);
        vm.stopPrank();
        assertEq(_bal(wallet), 5e6);
        assertEq(wallet.totalCharged(), 0);
        assertEq(wallet.profit(), 5e6);
        assertEq(usdg.balanceOf(customer), 995e6);
    }

    function test_only_the_wallet_that_holds_the_sub_run_can_return_and_never_more_than_it_was_paid() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);

        // A stranger, and another agent wallet, have no sub-run of this wallet's to return.
        usdg.mint(mallory, 5e6);
        vm.startPrank(mallory);
        usdg.approve(address(wallet), 5e6);
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.returnFromAgent(key, 1e6);
        vm.stopPrank();
        usdg.mint(address(wallet3), 5e6);
        vm.startPrank(address(wallet3));
        usdg.approve(address(wallet), 5e6);
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.returnFromAgent(key, 1e6);
        vm.stopPrank();

        // The right wallet: not zero, not more than it was paid, not without the money, not twice.
        usdg.mint(address(wallet2), 5e6);
        vm.startPrank(address(wallet2));
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.returnFromAgent(key, 0);
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.returnFromAgent(key, 1e6 + 1);
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.returnFromAgent(key, 1e6); // nothing approved
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.returnFromAgent(bytes32("other"), 1);
        usdg.approve(address(wallet), 5e6);
        wallet.returnFromAgent(key, 1e6);
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.returnFromAgent(key, 1);
        vm.stopPrank();
        assertEq(wallet.totalCharged(), 0);
    }

    // ---- who a wallet takes sub-payments from ----

    function test_a_wallet_run_by_another_meter_cannot_push_runs_into_this_one() public {
        CreatureWallet evil = _make(mallory);
        vm.startPrank(mallory);
        evil.setOperator(mallory);
        evil.setPayable(address(wallet2), true);
        vm.stopPrank();
        usdg.mint(mallory, 5e6);
        _payTo(evil, mallory, 5e6, "m", 3e6);
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotAccepted.selector);
        evil.payAgent("m", address(wallet2), 1e6, "s", 500_000);
        assertEq(wallet2.remainingToday(), DAY_CAP);
        // Lying about the opener is not open to it: the argument comes from the wallet's own code.
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet2.payFromAgent(1e6, "s", 500_000, operator);
    }

    function test_the_same_meter_must_run_both_wallets_and_then_bills_the_sub_run() public {
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        (address opener,,,,,) = wallet2.holds(wallet2.subRunKey(address(wallet), "s"));
        assertEq(opener, operator, "the meter that sent the money is the one that may bill the sub-run");

        // It is the meter that opened the paying RUN that counts, not the paying wallet's meter today.
        vm.prank(alice);
        wallet.setOperator(carol);
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s2", 500_000);
        (opener,,,,,) = wallet2.holds(wallet2.subRunKey(address(wallet), "s2"));
        assertEq(opener, operator);
    }

    function test_a_receiving_wallet_with_another_meter_takes_nothing() public {
        vm.prank(bob);
        wallet2.setOperator(carol); // wallet2 now has its own meter
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotAccepted.selector);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        assertEq(_bal(wallet2), 0);
        assertEq(wallet.heldTotal(), 5e6);
        assertEq(usdg.allowance(address(wallet), address(wallet2)), 0);

        // Back under the same meter, it goes through.
        vm.prank(bob);
        wallet2.setOperator(address(0));
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
    }

    function test_two_wallets_under_the_same_custom_meter_can_pay_each_other() public {
        vm.prank(alice);
        wallet3.setOperator(carol);
        vm.prank(bob);
        wallet2.setOperator(carol);
        vm.prank(alice);
        wallet3.setPayable(address(wallet2), true);
        _payTo(wallet3, customer, 5e6, "x", 3e6); // opened by carol
        bytes32 key = wallet2.subRunKey(address(wallet3), "s");
        vm.startPrank(carol);
        wallet3.payAgent("x", address(wallet2), 1e6, "s", 500_000);
        (address opener,,,,,) = wallet2.holds(key);
        assertEq(opener, carol);
        wallet2.charge(key, 500_000, RCPT);
        vm.stopPrank();
        // The factory's meter has no part in it.
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet3.payAgent("x", address(wallet2), 1e6, "s2", 500_000);
    }

    // ---- a return that USDG will not carry ----

    event ParkedClaimed(address indexed forWhom, address indexed to, uint256 amount);

    function test_a_sub_run_refund_that_cannot_move_stays_owed_to_the_run_and_is_retried() public {
        bytes32 key = wallet2.subRunKey(address(wallet), "s1");
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s1", 500_000);
        usdg.setBlocked(address(wallet), true); // the issuer blocks the paying wallet for a while
        vm.prank(operator);
        wallet2.refund(key, 0, RCPT); // does not fail

        assertEq(wallet2.owedBack(key), 1e6, "owed to that sub-run's paying run");
        assertEq(wallet2.parked(address(wallet)), 0, "not parked as the paying wallet's own money");
        assertEq(wallet2.parkedTotal(), 1e6);
        assertEq(wallet2.withdrawable(), 0, "the receiving owner cannot take it");
        assertEq(wallet2.income(), 0);
        assertEq(usdg.allowance(address(wallet2), address(wallet)), 0);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet2.open("x", 1); // nor can it be set aside for another run
        vm.expectRevert(CreatureWallet.NothingParked.selector);
        wallet.collectParked(address(wallet2)); // nor fetched as plain money

        // While USDG still refuses, the retry fails and changes nothing.
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet2.retryReturn(key);
        assertEq(wallet2.owedBack(key), 1e6);

        usdg.setBlocked(address(wallet), false);
        vm.expectEmit(true, true, false, true, address(wallet2));
        emit ParkedClaimed(address(wallet), address(wallet), 1e6);
        vm.prank(mallory); // anyone
        wallet2.retryReturn(key);

        assertEq(wallet2.owedBack(key), 0);
        assertEq(wallet2.parkedTotal(), 0);
        assertEq(_bal(wallet2), 0);
        assertEq(wallet2.totalOut(), 1e6);
        (,,, uint96 amount, uint80 budget,) = wallet.holds("r1");
        assertEq(amount, 5e6, "it is back in the paying run's hold");
        assertEq(budget, 3e6);
        assertEq(wallet.totalCharged(), 0);
        assertEq(wallet.income(), 5e6);
        assertEq(wallet.withdrawable(), 0);
        vm.expectRevert(CreatureWallet.NothingParked.selector);
        wallet2.retryReturn(key);
        vm.expectRevert(CreatureWallet.NothingParked.selector);
        wallet2.retryReturn("no-such-run");
    }

    function test_lien_money_parked_for_a_payee_that_is_a_wallet_can_be_brought_home() public {
        // wallet3 is the lien payee of wallet2, and USDG blocks it when the lien is ended.
        vm.prank(bob);
        wallet2.setLien(address(wallet3), 10_000, 1e6);
        usdg.mint(address(wallet2), 1e6);
        vm.prank(operator);
        wallet2.settle(type(uint256).max);
        usdg.setBlocked(address(wallet3), true);
        vm.prank(bob);
        wallet2.endLien();
        assertEq(wallet2.parked(address(wallet3)), 1e6);
        usdg.setBlocked(address(wallet3), false);
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet3.collectParked(mallory);
        vm.prank(mallory);
        wallet3.collectParked(address(wallet2));
        assertEq(_bal(wallet3), 1e6);
        assertEq(wallet2.parkedTotal(), 0);
    }

    function test_payAgent_under_a_lien_lowers_profit_and_never_touches_settled_money() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        usdg.mint(address(wallet), 2e6);
        vm.prank(operator);
        wallet.settle(type(uint256).max);
        assertEq(wallet.lienUnpaid(), 2e6);
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 3e6, "s1", 1e6);
        assertEq(wallet.lienUnpaid(), 2e6);
        _backed(wallet);
        assertEq(wallet.settleLien(), 2e6);
    }
}

// =========================================================================
// Kept from version 2
// =========================================================================
contract V3KeptTest is V3Base {
    function test_wallet_ownership_is_two_step() public {
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.transferOwnership(mallory);
        vm.prank(alice);
        wallet.transferOwnership(carol);
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.acceptOwnership();
        vm.prank(carol);
        wallet.acceptOwnership();
        assertEq(wallet.owner(), carol);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.setPaused(true);
    }

    function test_open_and_charge_from_the_balance_work_as_in_v2() public {
        usdg.mint(address(wallet), 500_000);
        vm.startPrank(operator);
        wallet.open("r1", 300_000); // holds $0.36
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet.open("r2", 300_000); // only $0.14 is free
        wallet.open("r3", 100_000);
        vm.expectRevert(CreatureWallet.RunAlreadyCharged.selector);
        wallet.open("r3", 1);
        wallet.charge("r1", 100_000, RCPT);
        wallet.release("r3");
        wallet.open("r3", 100_000); // a released hold from the balance can be opened again, as in v2
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 120_000);
        assertEq(wallet.heldTotal(), 120_000);
        assertEq(wallet.remainingToday(), DAY_CAP - 240_000);
    }

    function test_identity_confirmation_is_refused_without_a_registry() public view {
        bytes memory sig = abi.encode(uint256(1), uint256(2), new bytes(65));
        assertEq(wallet.isValidSignature(bytes32(0), sig), bytes4(0xffffffff));
    }

    function test_identity_confirmation_is_scoped_to_the_registry_statement() public {
        address registry = makeAddr("registry");
        WeightlingsFactory f = new WeightlingsFactory(address(usdg), admin, operator, treasury, 2_000, registry, guardian);
        (, address w) = f.createAgent(alice, RUN_CAP, DAY_CAP, "s", "", treasury, 2_000);
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ERC8004IdentityRegistry"),
                keccak256("1"),
                block.chainid,
                registry
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)"),
                uint256(7),
                w,
                alice,
                uint256(99)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(aliceKey, digest);
        bytes memory sig = abi.encode(uint256(7), uint256(99), abi.encodePacked(r, s, v));
        assertEq(CreatureWallet(w).isValidSignature(digest, sig), bytes4(0x1626ba7e));
        assertEq(CreatureWallet(w).isValidSignature(keccak256("other"), sig), bytes4(0xffffffff));
        bytes memory wrongId = abi.encode(uint256(8), uint256(99), abi.encodePacked(r, s, v));
        assertEq(CreatureWallet(w).isValidSignature(digest, wrongId), bytes4(0xffffffff));
        (v, r, s) = vm.sign(0xB0B, digest);
        bytes memory notOwner = abi.encode(uint256(7), uint256(99), abi.encodePacked(r, s, v));
        assertEq(CreatureWallet(w).isValidSignature(digest, notOwner), bytes4(0xffffffff));
    }

    function test_withdraw_refuses_bad_destinations_and_strangers() public {
        usdg.mint(address(wallet), 1e6);
        vm.prank(mallory);
        vm.expectRevert(CreatureWallet.NotOwner.selector);
        wallet.withdraw(address(usdg), mallory, 1);
        vm.startPrank(alice);
        vm.expectRevert(CreatureWallet.ZeroAddress.selector);
        wallet.withdraw(address(usdg), address(0), 1);
        vm.expectRevert(CreatureWallet.ZeroAddress.selector);
        wallet.withdraw(address(usdg), address(wallet), 1);
        wallet.withdraw(address(usdg), alice, 1e6);
        vm.stopPrank();
        assertEq(wallet.income(), 1e6);
    }
}

// =========================================================================
// Fixes from the independent review
// =========================================================================
contract V3ReviewFixesTest is V3Base {
    address ownOp = makeAddr("own-operator");

    // ---- a hold answers to the meter that opened it ----

    function test_a_hold_stays_with_the_meter_that_opened_it_when_the_owner_names_another() public {
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        _pay(6e6, "r1", 5e6);
        _pay(6e6, "r2", 5e6);
        _pay(6e6, "r3", 5e6);
        _pay(6e6, "r4", 5e6);
        usdg.mint(address(wallet), 5e6);
        vm.prank(operator);
        wallet.open("o1", 1e6);

        vm.prank(alice);
        wallet.setOperator(ownOp);
        assertEq(wallet.operator(), ownOp);

        // The new meter has no power over holds it did not open.
        vm.startPrank(ownOp);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.charge("r1", 1, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.chargeAndSettle("r1", 1, 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.refund("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.payAgent("r1", address(wallet2), 1, "s", 1);
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r1");
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("o1");
        // It is the wallet's meter for everything new.
        wallet.settle(0);
        wallet.open("o2", 1e6);
        wallet.charge("o2", 1e6, RCPT);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r1");

        // The meter that opened them can still do everything with them ...
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 1e6, "s", 500_000);
        wallet.charge("r1", 4e6, RCPT);
        wallet.chargeAndSettle("r2", 5e6, type(uint256).max, RCPT);
        wallet.refund("r3", 1e6, RCPT);
        wallet.release("r4");
        wallet.charge("o1", 1e6, RCPT);
        // ... and nothing else on this wallet any more.
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.settle(0);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.open("o3", 1);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "n", 27, bytes32(0), bytes32(0), "r5", 5e6, false);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.charge("never-opened", 1, RCPT);
        vm.stopPrank();
        assertEq(usdg.balanceOf(treasury), 4_800_000 + 6e6 + 1_200_000 + 1_200_000 + 1_200_000);
    }

    function test_a_new_factory_operator_has_no_power_over_holds_the_old_one_opened() public {
        _pay(6e6, "r1", 5e6);
        vm.prank(admin);
        factory.proposeOperator(carol);
        vm.warp(block.timestamp + 2 days);
        _pay(6e6, "r2", 5e6); // opened the moment before the change
        vm.prank(admin);
        factory.acceptOperator();
        assertEq(wallet.operator(), carol);
        vm.startPrank(carol);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.charge("r2", 1, RCPT);
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r2");
        wallet.release("r1"); // two days old: anyone may, and the customer is refunded
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 1_000e6 - 6e6);
        vm.prank(operator);
        wallet.charge("r2", 5e6, RCPT);
    }

    function test_the_guardian_pause_still_stops_the_meter_that_opened_a_hold() public {
        _pay(6e6, "r1", 5e6);
        vm.prank(alice);
        wallet.setOperator(ownOp);
        vm.prank(guardian);
        factory.setOperatorPaused(true);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.charge("r1", 1, RCPT);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.refund("r1", 0, RCPT);
        vm.expectRevert(CreatureWallet.OperatorPaused.selector);
        wallet.release("r1");
        vm.stopPrank();
    }

    // ---- a payment only the wallet can submit ----

    function test_a_receive_form_payment_is_taken_held_and_recorded() public {
        _payReceive(wallet, customer, 6e6, "r1", 5e6);
        assertEq(_bal(wallet), 6e6);
        assertEq(wallet.heldTotal(), 6e6);
        (address payer, uint80 value, bool outside,) = wallet.payments("r1");
        assertEq(payer, customer);
        assertEq(value, 6e6);
        assertTrue(outside);
        vm.prank(operator);
        wallet.refund("r1", 1e6, RCPT);
        assertEq(usdg.balanceOf(customer), 1_000e6 - 1_200_000);
    }

    function test_a_receive_form_payment_cannot_be_submitted_by_anyone_but_the_wallet() public {
        bytes32 nonce = keccak256("customer-nonce");
        vm.prank(alice); // the owner
        vm.expectRevert(bytes("CallerMustBePayee"));
        usdg.receiveWithAuthorization(customer, address(wallet), 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0));
        vm.prank(mallory); // a stranger
        vm.expectRevert(bytes("CallerMustBePayee"));
        usdg.receiveWithAuthorization(customer, address(wallet), 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0));
        vm.prank(operator); // the meter itself, outside the wallet
        vm.expectRevert(bytes("CallerMustBePayee"));
        usdg.receiveWithAuthorization(customer, address(wallet), 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0));
        // Nor does it pass as a transfer.
        vm.prank(alice);
        vm.expectRevert(bytes("bad signature"));
        usdg.transferWithAuthorization(customer, address(wallet), 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0));
        assertEq(usdg.balanceOf(customer), 1_000e6);
        assertFalse(usdg.authorizationState(customer, nonce));

        vm.prank(operator);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0), "r1", 5e6, true);
        assertEq(wallet.heldTotal(), 6e6);
        assertEq(wallet.withdrawable(), 0);
    }

    function test_each_signature_type_works_only_on_its_own_path() public {
        vm.startPrank(operator);
        // a transfer-type signature (27) on the receive path
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 5e6, true);
        // a receive-type signature (28) on the transfer path
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "n1", 28, bytes32(0), bytes32(0), "r1", 5e6, false);
        assertEq(usdg.balanceOf(customer), 1_000e6);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 5e6, false);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "n2", 28, bytes32(0), bytes32(0), "r2", 5e6, true);
        // a used receive authorization moves nothing the second time
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "n2", 28, bytes32(0), bytes32(0), "r3", 5e6, true);
        vm.stopPrank();
        assertEq(wallet.heldTotal(), 12e6);
    }

    function test_a_receive_form_payment_is_refused_whole_when_the_wallet_cannot_take_the_run() public {
        vm.prank(alice);
        wallet.setPaused(true);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.Paused.selector);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "n", 28, bytes32(0), bytes32(0), "r1", 5e6, true);
        vm.stopPrank();
        vm.prank(alice);
        wallet.setPaused(false);
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.Underpaid.selector);
        wallet.pay(customer, 5e6, 0, block.timestamp + 600, "n", 28, bytes32(0), bytes32(0), "r1", 5e6, true);
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 1_000e6);
        assertFalse(usdg.authorizationState(customer, "n"));
    }

    // ---- the public checkpoint cannot be cancelled by the meter ----

    function test_an_operator_settle_does_not_cancel_a_public_checkpoint_request() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 10e6);
        vm.prank(lender);
        wallet.requestCheckpoint();
        uint64 at = wallet.pendingAt();
        vm.warp(block.timestamp + 1 days - 1);
        _pay(6e6, "r1", 5e6);
        vm.startPrank(operator);
        wallet.settle(0);
        wallet.chargeAndSettle("r1", 1e6, 0, RCPT);
        vm.stopPrank();
        assertEq(wallet.pendingAt(), at, "the request stands");
        vm.warp(block.timestamp + 1);
        wallet.takeCheckpoint();
        assertEq(wallet.pendingAt(), 0, "taking it uses it up");
        assertEq(wallet.settledProfit(), 10e6, "what was asked for: profit on the day of the request");
        assertEq(wallet.lienUnpaid(), 5e6);
        _backed(wallet);
        vm.expectRevert(CreatureWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
    }

    function test_a_settle_then_a_taken_checkpoint_never_passes_the_clamp_or_lowers_the_checkpoint() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        usdg.mint(address(wallet), 4e6);
        wallet.requestCheckpoint(); // asks for 4
        vm.prank(operator);
        wallet.settle(type(uint256).max); // the meter settles all 4 first
        assertEq(wallet.settledProfit(), 4e6);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);

        // More income, some of it held; then the old request (for 4) is taken.
        usdg.mint(address(wallet), 2e6);
        _pay(6e6, "r1", 5e6);
        vm.prank(operator);
        wallet.settle(type(uint256).max); // 6: the held 6 is left out
        assertEq(wallet.settledProfit(), 6e6);
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 6e6, "a smaller request does not pull it down");
        _backed(wallet);

        // A request made while money is held cannot count it when taken.
        wallet.requestCheckpoint(); // asks for 12
        vm.prank(operator);
        wallet.settle(0);
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(CreatureWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
        vm.warp(block.timestamp + 1);
        wallet.takeCheckpoint(); // the hold is still open (nobody released it)
        assertEq(wallet.settledProfit(), 6e6);
        assertEq(wallet.lienUnpaid(), 6e6);
        _backed(wallet);
    }

    function test_setting_or_ending_a_lien_clears_a_pending_request() public {
        wallet.requestCheckpoint();
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        assertEq(wallet.pendingAt(), 0);
        wallet.requestCheckpoint();
        vm.prank(lender);
        wallet.endLien();
        assertEq(wallet.pendingAt(), 0);
        vm.expectRevert(CreatureWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
    }

    function test_a_request_the_meter_blocked_with_a_hold_survives_and_is_taken_later() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 9_999_999);
        vm.prank(lender);
        wallet.requestCheckpoint(); // asks for 9,999,999
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        wallet.open("grief", 8_333_333); // all of the unsettled income, with the fee
        vm.prank(lender);
        wallet.takeCheckpoint(); // moves nothing ...
        assertEq(wallet.settledProfit(), 0);
        assertTrue(wallet.pendingAt() != 0, "... and is not used up");
        vm.expectRevert(CreatureWallet.CheckpointPending.selector);
        wallet.requestCheckpoint();

        // The moment the hold is gone it can be taken, with no second day's wait.
        vm.prank(operator);
        wallet.release("grief");
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 9_999_999);
        assertEq(wallet.pendingAt(), 0);
        assertEq(wallet.lienUnpaid(), 4_999_999);
        _backed(wallet);
    }

    function test_a_surviving_request_settles_what_it_can_each_time_and_never_past_what_was_asked() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        usdg.mint(address(wallet), 4e6);
        wallet.requestCheckpoint(); // asks for 4
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        wallet.open("h", 2_500_000); // holds 3 of the 4
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 1e6, "the part that is not held is settled");
        assertTrue(wallet.pendingAt() != 0);
        wallet.takeCheckpoint(); // again: nothing changes, nothing falls
        assertEq(wallet.settledProfit(), 1e6);

        // Money that arrives after the request is not the request's to settle.
        usdg.mint(address(wallet), 10e6);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 4e6, "up to the figure asked for and no further");
        assertEq(wallet.pendingAt(), 0, "and with that it is used up");
        assertEq(wallet.unsettled(), 10e6);
        _backed(wallet);
        vm.expectRevert(CreatureWallet.NoCheckpoint.selector);
        wallet.takeCheckpoint();
    }

    function test_a_request_is_used_up_when_profit_itself_has_fallen_below_it() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        vm.prank(customer);
        usdg.transfer(address(wallet), 6e6); // income that is not held
        wallet.requestCheckpoint(); // asks for 6
        assertEq(wallet.pendingProfit(), 6e6);
        vm.prank(operator);
        wallet.open("r1", 5e6); // the meter then sets a run's cost aside over it
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint(); // the hold stands in the way
        assertTrue(wallet.pendingAt() != 0);
        vm.prank(operator);
        wallet.charge("r1", 5e6, RCPT); // the run cost all of it
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 0);
        assertEq(wallet.pendingAt(), 0, "there will never be 6 to settle; the request does not linger");
        wallet.requestCheckpoint();
    }

    // ---- factory proposals lapse ----

    function test_an_accept_must_come_within_seven_days_of_becoming_ready() public {
        assertEq(factory.ACCEPT_WINDOW(), 7 days);
        vm.startPrank(admin);
        factory.proposeOperator(carol);
        factory.proposeMarkup(100);
        factory.proposeTreasury(carol);
        factory.proposeGuardian(carol);
        uint256 ready = block.timestamp + 2 days;

        vm.warp(ready + 7 days); // the last moment
        factory.acceptOperator();
        assertEq(factory.operator(), carol);

        vm.warp(ready + 7 days + 1); // one second late
        vm.expectRevert(WeightlingsFactory.Expired.selector);
        factory.acceptMarkup();
        vm.expectRevert(WeightlingsFactory.Expired.selector);
        factory.acceptTreasury();
        vm.expectRevert(WeightlingsFactory.Expired.selector);
        factory.acceptGuardian();
        assertEq(factory.markupBps(), 2_000);

        // Proposed again, it waits again; a lapsed one can also simply be cancelled.
        factory.proposeMarkup(100);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptMarkup();
        factory.cancel("treasury");
        vm.warp(block.timestamp + 2 days);
        factory.acceptMarkup();
        assertEq(factory.markupBps(), 100);
        vm.stopPrank();
    }

    function test_rates_and_network_cost_proposals_lapse_too() public {
        vm.startPrank(admin);
        factory.proposeRate("m", 1, 2); // a first rate: no wait, but it does not keep for ever
        factory.proposeNetworkCost(5);
        vm.warp(block.timestamp + 9 days + 1);
        vm.expectRevert(WeightlingsFactory.Expired.selector);
        factory.acceptRate("m");
        vm.expectRevert(WeightlingsFactory.Expired.selector);
        factory.acceptNetworkCost();
        factory.proposeRate("m", 1, 2);
        factory.acceptRate("m");
        factory.proposeRate("m", 3, 4);
        vm.warp(block.timestamp + 9 days);
        factory.acceptRate("m");
        (uint64 i,) = factory.rates("m");
        assertEq(i, 3);
        vm.stopPrank();
    }

    // ---- insiders' wallets ----

    function test_a_wallet_of_the_lien_payee_is_an_insider() public {
        CreatureWallet lendersWallet = _make(lender);
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        _payTo(lendersWallet, customer, 6e6, "p", 5e6);
        vm.prank(lender);
        lendersWallet.setPayable(address(wallet), true);
        vm.prank(operator);
        lendersWallet.payAgent("p", address(wallet), 1_200_000, "s", 1e6);
        assertEq(wallet.insiderIncome(), 1_200_000);
        assertEq(wallet.externalIncome(), 0);
    }

    // ---- setLien and holds from the balance ----

    function test_setLien_waits_for_holds_from_the_balance_but_not_for_paid_holds() public {
        usdg.mint(address(wallet), 10e6);
        vm.startPrank(operator);
        wallet.open("a", 1e6);
        wallet.open("b", 1e6);
        wallet.open("c", 1e6);
        vm.stopPrank();
        assertEq(wallet.plainHolds(), 3);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.HoldsOpen.selector);
        wallet.setLien(lender, 5_000, 0);

        vm.startPrank(operator);
        wallet.charge("a", 1e6, RCPT);
        wallet.release("b");
        vm.stopPrank();
        assertEq(wallet.plainHolds(), 1);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.HoldsOpen.selector);
        wallet.setLien(lender, 5_000, 0);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice); // the owner need not wait on the meter for more than a day
        wallet.release("c");
        assertEq(wallet.plainHolds(), 0);

        _pay(6e6, "paid", 5e6); // a paid hold does not stand in the way
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        (,,,, uint256 base) = wallet.lien();
        assertEq(base, 10e6 - 1_200_000, "everything that was the owner's is in the base");
        assertEq(wallet.withdrawable(), 10e6 - 1_200_000);
        assertEq(wallet.plainHolds(), 0);
    }
}

// =========================================================================
// Gas. Run with -vv to see the figures.
// =========================================================================
contract V3GasTest is V3Base {
    /// Gas spent inside each call as the caller sees it (gasleft before and after):
    /// the call itself with cold storage and cold accounts, not the 21,000 base
    /// cost of a transaction and not its calldata.
    function test_gas_report() public {
        uint256[10] memory g;
        uint256 t;
        t = gasleft();
        factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        g[0] = t - gasleft();
        t = gasleft();
        factory.createAgent(carol, RUN_CAP, DAY_CAP, keccak256("spec"), "", treasury, 2_000);
        g[1] = t - gasleft();

        vm.startPrank(operator);
        // transfer form: fresh wallet, then a second payment from the same payer
        t = gasleft();
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "a1", 27, bytes32(0), bytes32(0), "r1", 5e6, false);
        g[2] = t - gasleft();
        t = gasleft();
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, "a2", 27, bytes32(0), bytes32(0), "r2", 5e6, false);
        g[3] = t - gasleft();
        // receive form: fresh wallet, then a second payment from the same payer
        t = gasleft();
        wallet2.pay(customer, 6e6, 0, block.timestamp + 600, "b1", 28, bytes32(0), bytes32(0), "r1", 5e6, true);
        g[4] = t - gasleft();
        t = gasleft();
        wallet2.pay(customer, 6e6, 0, block.timestamp + 600, "b2", 28, bytes32(0), bytes32(0), "r2", 5e6, true);
        g[5] = t - gasleft();

        t = gasleft();
        wallet.chargeAndSettle("r1", 4e6, type(uint256).max, RCPT);
        g[6] = t - gasleft();
        t = gasleft();
        wallet.refund("r2", 1e6, RCPT);
        g[7] = t - gasleft();
        t = gasleft();
        wallet2.charge("r1", 4e6, RCPT);
        g[8] = t - gasleft();
        t = gasleft();
        wallet2.refund("r2", 0, RCPT);
        g[9] = t - gasleft();
        vm.stopPrank();

        emit log_named_uint("GAS createAgent (first by this creator)", g[0]);
        emit log_named_uint("GAS createAgent (later)", g[1]);
        emit log_named_uint("GAS pay receiveOnly=false, fresh wallet", g[2]);
        emit log_named_uint("GAS pay receiveOnly=false, warm wallet same payer", g[3]);
        emit log_named_uint("GAS pay receiveOnly=true, fresh wallet", g[4]);
        emit log_named_uint("GAS pay receiveOnly=true, warm wallet same payer", g[5]);
        emit log_named_uint("GAS chargeAndSettle", g[6]);
        emit log_named_uint("GAS refund (cost > 0)", g[7]);
        emit log_named_uint("GAS charge", g[8]);
        emit log_named_uint("GAS refund (cost 0)", g[9]);
    }
}
