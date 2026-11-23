// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {WeightlingsFactory} from "../src/WeightlingsFactory.sol";
import {CreatureWallet} from "../src/CreatureWallet.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {V3Base, MockUSDGV3} from "./CreatureWallet.t.sol";

/// Independent review of CreatureWallet / WeightlingsFactory. Each test was a proof
/// (test_poc_*) that passed while the issue it describes was present. Each has
/// been turned into the same sequence asserting the fixed behaviour (test_fixed_*).
/// The one that is still test_poc_* is collusion between an owner and a meter the
/// owner controls: it is documented, not fixed, and still passes as a proof.
contract ReviewV3Test is V3Base {
    function _auth(CreatureWallet w, address from, uint256 value, bytes32 nonce, bytes32 runId, uint256 budget)
        internal
    {
        w.pay(from, value, 0, block.timestamp + 600, nonce, 27, bytes32(0), bytes32(0), runId, budget, false);
    }

    // ---------------------------------------------------------------------
    // HIGH 1. The owner swapped the wallet's operator while runs were open; the
    // meter that let them in could no longer bill them, the owner's own operator
    // released the holds, and the owner withdrew the customers' payments.
    // FIXED: a hold answers only to the meter that opened it.
    // ---------------------------------------------------------------------
    function test_fixed_owner_swaps_operator_and_dodges_open_charges() public {
        _pay(6e6, "r1", 5e6); // customer pays $6, run may cost $5 + 20%
        _payTo(wallet, customer2, 6e6, "r2", 5e6);
        assertEq(wallet.heldTotal(), 12e6);
        assertEq(wallet.withdrawable(), 0);

        // The work is done off chain. Before the meter bills, the owner acts.
        vm.startPrank(alice);
        wallet.setOperator(alice);
        // The owner's own operator has no power over holds it did not open.
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r1");
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet.release("r2");
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.charge("r1", 1, RCPT);
        vm.expectRevert(CreatureWallet.NotOperator.selector);
        wallet.refund("r2", 0, RCPT);
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
        vm.stopPrank();
        assertEq(wallet.heldTotal(), 12e6, "both payments are still held");

        // The meter that let the runs in bills one and refunds the other.
        vm.startPrank(operator);
        wallet.charge("r1", 5e6, RCPT);
        wallet.refund("r2", 0, RCPT);
        vm.stopPrank();

        assertEq(usdg.balanceOf(treasury), 6e6, "the treasury was paid for the run");
        assertEq(wallet.totalCharged(), 6e6);
        assertEq(usdg.balanceOf(customer2), 1_000e6, "and the other customer has the whole payment back");
        assertEq(usdg.balanceOf(alice), 0);
        assertEq(wallet.withdrawable(), 0, "nothing was left over for the owner on a run billed in full");
    }

    /// The same swap with a meter that never comes back: after a day anyone releases
    /// the holds and the customers, not the owner, get the money.
    function test_fixed_owner_swaps_operator_and_the_meter_goes_quiet() public {
        _pay(6e6, "r1", 5e6);
        _payTo(wallet, customer2, 6e6, "r2", 5e6);
        vm.prank(alice);
        wallet.setOperator(alice);
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(alice);
        wallet.release("r1");
        wallet.release("r2");
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 1_000e6);
        assertEq(usdg.balanceOf(customer2), 1_000e6);
        assertEq(wallet.withdrawable(), 0);
    }

    // ---------------------------------------------------------------------
    // HIGH 2. Whoever saw the customer's signed authorization before `pay`
    // landed could hand it to USDG directly; the money arrived with no hold and
    // no payer record and the owner withdrew it.
    // FIXED for payments signed in the receive form (`receiveOnly`): only the
    // wallet can submit them. The transfer form is kept for third-party clients
    // and is still exposed; the second test below shows that, as the header says.
    // ---------------------------------------------------------------------
    function test_fixed_owner_front_runs_pay_and_keeps_the_payment() public {
        bytes32 nonce = keccak256("customer-nonce");
        uint256 before = usdg.balanceOf(customer);

        // The customer signed a ReceiveWithAuthorization (v = 28 in the stand-in).
        vm.startPrank(alice);
        vm.expectRevert(bytes("CallerMustBePayee"));
        usdg.receiveWithAuthorization(
            customer, address(wallet), 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0)
        );
        // It is not a transfer authorization either.
        vm.expectRevert(bytes("bad signature"));
        usdg.transferWithAuthorization(
            customer, address(wallet), 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0)
        );
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), before, "nothing has moved");

        vm.prank(operator);
        wallet.pay(customer, 6e6, 0, block.timestamp + 600, nonce, 28, bytes32(0), bytes32(0), "r1", 5e6, true);

        assertEq(usdg.balanceOf(customer), before - 6e6, "customer paid");
        assertEq(wallet.heldTotal(), 6e6, "all of it is held");
        assertEq(wallet.withdrawable(), 0, "the owner cannot take it");
        (address payer,,,) = wallet.payments("r1");
        assertEq(payer, customer, "there is a record, so there is a refund path");
        assertEq(wallet.externalIncome(), 6e6);
        vm.prank(operator);
        wallet.refund("r1", 0, RCPT);
        assertEq(usdg.balanceOf(customer), before);
    }

    /// NOT FIXED, and stated in the wallet's header: a payment signed in the transfer
    /// form can still be submitted by anyone who sees it first.
    function test_known_a_transfer_form_payment_can_still_be_front_run() public {
        bytes32 nonce = keccak256("customer-nonce");
        vm.startPrank(alice);
        usdg.transferWithAuthorization(
            customer, address(wallet), 6e6, 0, block.timestamp + 600, nonce, 27, bytes32(0), bytes32(0)
        );
        wallet.withdraw(address(usdg), alice, 6e6);
        vm.stopPrank();
        vm.startPrank(operator);
        vm.expectRevert(CreatureWallet.NotPaid.selector);
        _auth(wallet, customer, 6e6, nonce, "r1", 5e6);
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice), 6e6);
    }

    // ---------------------------------------------------------------------
    // MEDIUM 3. Anyone could make a wallet, name themselves its operator, and
    // push "paid runs" into ANY other wallet through payAgent -> payFromAgent,
    // filling the victim's day cap, then take everything back a day later.
    // FIXED: a wallet takes a sub-payment only from a run opened by its own
    // meter. (Round two removed the owner's list that could override this.)
    // ---------------------------------------------------------------------
    function test_fixed_any_agent_wallet_fills_a_victims_day_cap_for_free() public {
        (, address e) = factory.createAgent(
            mallory, type(uint128).max, type(uint128).max, bytes32(0), "", treasury, 2_000
        );
        CreatureWallet evil = CreatureWallet(e);
        usdg.mint(mallory, 60e6);

        vm.startPrank(mallory);
        evil.setOperator(mallory);
        evil.setPayable(address(wallet), true);
        _auth(evil, mallory, 60e6, "m-nonce", "m", 50e6);

        vm.expectRevert(CreatureWallet.NotAccepted.selector);
        evil.payAgent("m", address(wallet), 10e6, bytes32(uint256(1)), 8_333_333);
        vm.expectRevert(CreatureWallet.NotAccepted.selector);
        evil.payAgent("m", address(wallet), 2, bytes32(uint256(2)), 1);
        // The receiving door itself is for agent wallets only, so it cannot be called
        // with a made-up opener.
        vm.expectRevert(CreatureWallet.NotAgent.selector);
        wallet.payFromAgent(10e6, bytes32(uint256(3)), 8_333_333, operator);
        vm.stopPrank();

        assertEq(wallet.remainingToday(), DAY_CAP, "the victim's day limit is untouched");
        assertEq(wallet.externalIncome(), 0, "and its outside-income figure is not inflated");
        assertEq(usdg.balanceOf(address(wallet)), 0);

        // A real customer is served.
        vm.startPrank(operator);
        _auth(wallet, customer, 2e6, "c-nonce", "real-run", 1e6);
        vm.stopPrank();
        assertEq(wallet.heldTotal(), 2e6);
    }

    // ---------------------------------------------------------------------
    // MEDIUM 4. Any call to `settle` cleared a checkpoint a stranger had asked
    // for, so a hostile meter calling settle(0) once a day froze new income.
    // FIXED: only taking the checkpoint (or setting or ending a lien) clears it.
    // ---------------------------------------------------------------------
    function test_fixed_operator_cancels_every_public_checkpoint_with_settle_zero() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 10e6); // income with no run attached

        vm.prank(lender);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days - 1);
        vm.prank(operator);
        wallet.settle(0); // moves nothing, cancels nothing
        assertEq(wallet.settledProfit(), 0);
        assertTrue(wallet.pendingAt() != 0, "the request stands");
        vm.warp(block.timestamp + 1);
        vm.prank(operator);
        wallet.settle(0); // even in the same block as the take
        wallet.takeCheckpoint();

        assertEq(wallet.settledProfit(), 10e6);
        assertEq(wallet.lienUnpaid(), 5e6, "the lender is owed its half of $10 of profit");
        assertEq(wallet.settleLien(), 5e6);
        assertEq(wallet.withdrawable(), 5e6, "and the owner can take the other half");
        _backed(wallet);

        // It keeps working, day after day, whatever the meter does.
        for (uint256 d = 0; d < 3; d++) {
            usdg.mint(address(wallet), 2e6);
            vm.prank(lender);
            wallet.requestCheckpoint();
            vm.warp(block.timestamp + 1 days);
            vm.prank(operator);
            wallet.settle(0);
            wallet.takeCheckpoint();
            assertEq(wallet.settleLien(), 1e6);
        }
    }

    // ---------------------------------------------------------------------
    // LOW 5. A proposal never expired.
    // FIXED: it lapses seven days after it becomes ready.
    // ---------------------------------------------------------------------
    function test_fixed_stale_factory_proposal_is_accepted_at_once_much_later() public {
        vm.prank(admin);
        factory.proposeOperator(mallory);
        vm.warp(block.timestamp + 400 days);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.Expired.selector);
        factory.acceptOperator();
        assertEq(factory.operator(), operator);
        assertEq(wallet.operator(), operator);

        // Whoever holds the owner key today has to give the notice period again.
        vm.prank(admin);
        factory.proposeOperator(mallory);
        vm.prank(admin);
        vm.expectRevert(WeightlingsFactory.TooEarly.selector);
        factory.acceptOperator();
    }

    // ---------------------------------------------------------------------
    // LOW 6. A wallet belonging to a PAST owner was counted as an outside
    // customer. FIXED: a wallet is an insider if its owner is one.
    // ---------------------------------------------------------------------
    function test_fixed_a_past_owners_wallet_counts_as_an_outside_customer() public {
        vm.prank(alice);
        wallet.transferOwnership(carol);
        vm.prank(carol);
        wallet.acceptOwnership();
        assertTrue(wallet.wasOwner(alice));

        // alice's other wallet pays the one she used to own.
        _payTo(wallet3, customer, 6e6, "p", 5e6);
        vm.prank(alice);
        wallet3.setPayable(address(wallet), true);
        vm.prank(operator);
        wallet3.payAgent("p", address(wallet), 1_200_000, "s", 1e6);
        assertEq(wallet.externalIncome(), 0, "not outside income");
        assertEq(wallet.insiderIncome(), 1_200_000);
        assertEq(wallet.topPayer(), address(0));
        assertEq(wallet.payerCount(), 0);

        // The same as alice herself paying.
        usdg.mint(alice, 2e6);
        _payTo(wallet, alice, 1_200_000, "direct", 1e6);
        assertEq(wallet.externalIncome(), 0);
        assertEq(wallet.insiderIncome(), 2_400_000);

        // A stranger's wallet is still an outside customer.
        _payTo(wallet2, customer, 6e6, "q", 5e6);
        vm.prank(bob);
        wallet2.setPayable(address(wallet), true);
        vm.prank(operator);
        wallet2.payAgent("q", address(wallet), 1_200_000, "s", 1e6);
        assertEq(wallet.externalIncome(), 1_200_000);
    }

    // ---------------------------------------------------------------------
    // LOW 7. A meter that opened holds on the owner's own money just before the
    // owner's setLien turned that money into profit the lien shared in.
    // FIXED: setLien waits until no hold from the balance is open.
    // ---------------------------------------------------------------------
    function test_fixed_holds_opened_before_setLien_pledge_the_owners_old_money() public {
        usdg.mint(address(wallet), 10e6); // the owner's money, here before any lien
        vm.prank(operator);
        wallet.open("grief", 5e6); // holds $6 of it
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.HoldsOpen.selector);
        wallet.setLien(lender, 5_000, 0);

        vm.prank(operator);
        wallet.release("grief");
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        (,,,, uint256 base) = wallet.lien();
        assertEq(base, 10e6, "base is the $10 that was already there");

        vm.prank(operator);
        wallet.settle(type(uint256).max);
        assertEq(wallet.lienUnpaid(), 0);
        assertEq(wallet.settleLien(), 0);
        assertEq(usdg.balanceOf(lender), 0, "the lender is paid nothing from money earned before the lien");
        assertEq(wallet.withdrawable(), 10e6);
    }

    // ---------------------------------------------------------------------
    // LOW 8. The part of a payment a run had passed to another agent never
    // returned to the customer when everything timed out.
    // FIXED: what a sub-run gives back goes to the run that paid for it, and on
    // to that run's payer when the run has itself been refunded or timed out.
    // ---------------------------------------------------------------------
    function test_fixed_timed_out_run_never_returns_the_sub_paid_part_to_the_customer() public {
        uint256 before = usdg.balanceOf(customer);
        _pay(6e6, "r1", 5e6);
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 2e6, "s", 1e6);

        // The meter goes quiet. Everything times out; strangers release it all.
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(mallory);
        wallet.release("r1");
        wallet2.release(wallet2.subRunKey(address(wallet), "s"));
        vm.stopPrank();

        assertEq(usdg.balanceOf(treasury), 0, "no run was ever billed");
        assertEq(usdg.balanceOf(customer), before, "the customer has every unit back");
        assertEq(wallet.withdrawable(), 0);
        assertEq(usdg.balanceOf(address(wallet)), 0);
        assertEq(usdg.balanceOf(address(wallet2)), 0);
        assertEq(wallet.income(), 0);
        assertEq(wallet.totalCharged(), 0);
        assertEq(wallet.externalIncome(), 0);
    }

    /// The same with the releases the other way round: the sub-run times out first
    /// and its money goes back into the paying run's hold, then to the customer.
    function test_fixed_timed_out_sub_run_first_then_its_paying_run() public {
        uint256 before = usdg.balanceOf(customer);
        _pay(6e6, "r1", 5e6);
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 2e6, "s", 1e6);
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(mallory);
        wallet2.release(wallet2.subRunKey(address(wallet), "s"));
        assertEq(wallet.heldTotal(), 6e6, "back in the paying run's hold");
        assertEq(wallet.withdrawable(), 0);
        wallet.release("r1");
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), before);
        assertEq(wallet.income(), 0);
    }

    // ---------------------------------------------------------------------
    // COLLUSION (documented in the header; NOT FIXED, still a proof). The owner
    // names their own meter and lists their second wallet before the lien. A
    // real customer's payment then leaves through payAgent, where no lien
    // stands. Of a $6 payment for a run that cost nothing the lender, at 50%,
    // sees $0.50 instead of $3. What has changed: a lender can now read on chain,
    // before lending, that the wallet has its own meter and whom it may pay.
    // ---------------------------------------------------------------------
    function test_poc_collusion_owner_meter_routes_customer_money_around_the_lien() public {
        vm.startPrank(alice);
        wallet.setOperator(alice);
        wallet3.setOperator(alice);
        wallet.setPayable(address(wallet3), true);
        wallet.setLien(lender, 5_000, 0);
        vm.stopPrank();

        // What the lender can see before it lends.
        assertEq(wallet.customOperator(), alice, "the wallet's meter is its owner");
        assertEq(wallet.payableCount(), 1);
        assertEq(wallet.payableAt(0), address(wallet3));
        assertEq(CreatureWallet(wallet.payableAt(0)).owner(), alice, "and the one wallet it may pay is the owner's too");

        _payTo(wallet, customer, 6e6, "r1", 5e6);

        vm.startPrank(alice);
        wallet.payAgent("r1", address(wallet3), 5e6, "s1", 4e6);
        wallet3.release(wallet3.subRunKey(address(wallet), "s1")); // early release: the money stays in wallet3
        wallet3.withdraw(address(usdg), alice, 5e6);
        wallet.release("r1"); // what is left of the payment becomes profit
        wallet.settle(type(uint256).max);
        vm.stopPrank();

        assertEq(usdg.balanceOf(alice), 5e6);
        assertEq(wallet.lienUnpaid(), 500_000);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    // =====================================================================
    // ROUND TWO
    // =====================================================================

    // ---------------------------------------------------------------------
    // R2-1 (Low; Medium 4 only partly closed). `settle` no longer clears a
    // public request, but the checkpoint that is taken still leaves out ALL
    // held money, and the meter can hold free money with `open`. It opens a
    // hold over the unsettled income just before the request matures and
    // releases it straight after. The public checkpoint moves by nothing.
    // Bounded by the day limit, and repeatable every day.
    // ---------------------------------------------------------------------
    /// FIXED: a request that a hold kept short of its figure is not used up. It is
    /// taken again, with no new day's wait, the moment the hold is gone.
    function test_fixed2_meter_voids_the_public_checkpoint_with_a_plain_hold() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 9_999_999); // income with no run attached

        vm.prank(lender);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        wallet.open(bytes32(uint256(1)), 8_333_333); // $9.999999 with the fee: all of the unsettled income
        vm.prank(lender);
        wallet.takeCheckpoint(); // goes through, moves nothing ...
        assertEq(wallet.settledProfit(), 0);
        assertTrue(wallet.pendingAt() != 0, "... and the request stands");
        vm.prank(operator);
        wallet.release(bytes32(uint256(1))); // the meter has to let go to get its day limit back
        vm.prank(lender);
        wallet.takeCheckpoint();

        assertEq(wallet.settledProfit(), 9_999_999);
        assertEq(wallet.lienUnpaid(), 4_999_999, "the lender is owed its half");
        assertEq(wallet.withdrawable(), 5_000_000, "and the owner can take the rest");
        assertEq(wallet.pendingAt(), 0);
        _backed(wallet);
    }

    /// What is left of R2-1, stated in the wallet's header: while the meter keeps the
    /// income inside a hold, no checkpoint can count it. The hold is real money set
    /// aside within the day limit, and each one can be released by anyone after a
    /// day, so the lender needs to land one take in a moment between holds.
    function test_known2_income_inside_a_standing_hold_stays_out_of_the_checkpoint() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);
        usdg.mint(address(wallet), 9_999_999);
        vm.prank(lender);
        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        wallet.open(bytes32(uint256(1)), 8_333_333);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 0);
        // A day later a stranger can release that hold and take the checkpoint at once.
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(mallory);
        wallet.release(bytes32(uint256(1)));
        wallet.takeCheckpoint();
        vm.stopPrank();
        assertEq(wallet.settledProfit(), 9_999_999);
    }

    // ---------------------------------------------------------------------
    // R2-3 (Medium). High 1 again, one wallet further on. The factory's meter
    // pays wallet2 out of a run of `wallet` and expects to meter the sub-run.
    // wallet2's owner has listed `wallet` with setAccepts and named their own
    // meter (in advance, or by front-running the payAgent). payFromAgent takes
    // the money by the list and files the hold under wallet2's meter of the
    // moment. The factory's meter can neither bill nor refund it; wallet2's
    // owner releases it early and withdraws.
    // ---------------------------------------------------------------------
    /// FIXED: agents pay agents only when the same meter runs both wallets at that
    /// moment, and that meter is the one that may bill the sub-run. There is no list
    /// that lets a wallet with another meter take the money.
    function test_fixed2_receiving_owner_takes_a_sub_payment_by_naming_their_own_meter() public {
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true); // alice trusts the agent, as metered by the factory
        _pay(6e6, "r1", 5e6);

        vm.prank(bob); // front-runs the meter's payAgent
        wallet2.setOperator(bob);

        bytes32 key = wallet2.subRunKey(address(wallet), "s");
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.NotAccepted.selector);
        wallet.payAgent("r1", address(wallet2), 5e6, "s", 4e6);
        assertEq(usdg.balanceOf(address(wallet2)), 0, "nothing reached wallet2");
        assertEq(wallet.heldTotal(), 6e6);
        (address opener,, uint64 openedAt,,,) = wallet2.holds(key);
        assertEq(opener, address(0));
        assertEq(openedAt, 0);

        // The other order: the payment lands first, then bob names his own meter.
        vm.prank(bob);
        wallet2.setOperator(address(0));
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 5e6, "s", 4e6);
        vm.startPrank(bob);
        wallet2.setOperator(bob);
        vm.expectRevert(CreatureWallet.HoldStands.selector);
        wallet2.release(key);
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet2.withdraw(address(usdg), bob, 1);
        vm.stopPrank();

        // The meter that sent the money can still bill the sub-run, or give it all back.
        vm.startPrank(operator);
        wallet2.refund(key, 0, RCPT);
        wallet.refund("r1", 0, RCPT);
        vm.stopPrank();
        assertEq(usdg.balanceOf(bob), 0);
        assertEq(usdg.balanceOf(customer), 1_000e6, "the customer has everything back");
    }

    // ---------------------------------------------------------------------
    // R2-4 (Low; Low 8 only partly closed). If USDG will not move the money at
    // the moment a sub-run is refunded (either wallet on the block list), the
    // refund is parked for the paying WALLET. collectParked later brings it
    // home as plain money: it is not put back into the run, not forwarded to
    // the customer, and the owner withdraws it.
    // ---------------------------------------------------------------------
    /// FIXED: what a sub-run cannot give back at the time stays owed to the run that
    /// paid for it. Anyone can have it tried again, and it then goes where it would
    /// have gone: into the paying run, or on to the customer.
    function test_fixed2_a_parked_sub_refund_comes_home_as_the_owners_free_money() public {
        _pay(6e6, "r1", 5e6);
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        vm.prank(operator);
        wallet.payAgent("r1", address(wallet2), 2e6, "s", 1e6);
        bytes32 key = wallet2.subRunKey(address(wallet), "s");

        usdg.setBlocked(address(wallet), true); // the issuer blocks the paying wallet for a while
        vm.warp(block.timestamp + 1 days);
        wallet2.release(key);
        assertEq(wallet2.parked(address(wallet)), 0, "not parked as the paying wallet's own money");
        assertEq(wallet2.owedBack(key), 2e6, "owed to the run that paid");
        assertEq(wallet2.withdrawable(), 0);
        usdg.setBlocked(address(wallet), false);

        wallet.release("r1"); // timed out: the customer gets what is left of the hold
        assertEq(usdg.balanceOf(customer), 998e6);
        vm.expectRevert(CreatureWallet.NothingParked.selector);
        wallet.collectParked(address(wallet2)); // there is nothing to bring home as plain money
        vm.prank(mallory);
        wallet2.retryReturn(key);

        assertEq(usdg.balanceOf(customer), 1_000e6, "the customer has the sub-payment too");
        assertEq(wallet.totalCharged(), 0, "and the cost is reversed");
        assertEq(wallet.income(), 0);
        assertEq(wallet.withdrawable(), 0);
        assertEq(usdg.balanceOf(address(wallet)), 0);
        assertEq(usdg.balanceOf(address(wallet2)), 0);
        assertEq(wallet2.parkedTotal(), 0);
        vm.prank(alice);
        vm.expectRevert(CreatureWallet.LienOwed.selector);
        wallet.withdraw(address(usdg), alice, 1);
    }

    /// The same, retried while the paying run is still open: back into its hold.
    function test_fixed2_a_retried_sub_refund_goes_back_into_an_open_paying_run() public {
        _pay(6e6, "r1", 5e6);
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        bytes32 key = wallet2.subRunKey(address(wallet), "s");
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 2e6, "s", 1e6);
        usdg.setBlocked(address(wallet), true);
        wallet2.refund(key, 0, RCPT);
        usdg.setBlocked(address(wallet), false);
        vm.stopPrank();
        wallet2.retryReturn(key);
        assertEq(wallet.heldTotal(), 6e6);
        assertEq(wallet.totalCharged(), 0);
        vm.prank(operator);
        wallet.refund("r1", 0, RCPT);
        assertEq(usdg.balanceOf(customer), 1_000e6);
    }

    // ---------------------------------------------------------------------
    // R2-2 (Note). `plainHolds` gives the meter a veto over setLien: a hold of
    // one unit is enough, and it can be opened again every time the last one
    // is released. The owner's way out is to pause the wallet for a day.
    // ---------------------------------------------------------------------
    function test_poc2_meter_blocks_setLien_with_a_one_unit_hold() public {
        usdg.mint(address(wallet), 10);
        for (uint256 d = 0; d < 3; d++) {
            bytes32 id = bytes32(d + 1);
            vm.prank(operator);
            wallet.open(id, 1);
            vm.prank(alice);
            vm.expectRevert(CreatureWallet.HoldsOpen.selector);
            wallet.setLien(lender, 5_000, 0);
            vm.warp(block.timestamp + 1 days);
            vm.prank(operator); // front-runs the release + setLien the owner would send
            wallet.open(bytes32(d + 100), 1);
            wallet.release(id);
            vm.prank(alice);
            vm.expectRevert(CreatureWallet.HoldsOpen.selector);
            wallet.setLien(lender, 5_000, 0);
            vm.prank(operator);
            wallet.release(bytes32(d + 100));
        }
        assertEq(wallet.plainHolds(), 0);

        // The owner's way out, as the header says: pause, wait out the last hold, release, set the lien.
        vm.prank(operator);
        wallet.open("last", 1);
        vm.prank(alice);
        wallet.setPaused(true);
        vm.prank(operator);
        vm.expectRevert(CreatureWallet.Paused.selector);
        wallet.open("one-more", 1);
        vm.warp(block.timestamp + 1 days);
        vm.startPrank(alice);
        wallet.release("last");
        wallet.setLien(lender, 5_000, 0);
        wallet.setPaused(false);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // R2 check (sound). Three wallets in a chain, everything times out, and the
    // returns arrive in the worst order: the first run is closed before either
    // sub-run. The customer is made whole and every book goes back to zero.
    // ---------------------------------------------------------------------
    function test_poc2_sound_three_wallet_chain_returns_everything_to_the_customer() public {
        vm.prank(alice);
        wallet.setPayable(address(wallet2), true);
        vm.prank(bob);
        wallet2.setPayable(address(wallet3), true);

        _pay(10e6, "r1", 8e6);
        bytes32 ks = wallet2.subRunKey(address(wallet), "s");
        bytes32 kt = wallet3.subRunKey(address(wallet2), "t");
        vm.startPrank(operator);
        wallet.payAgent("r1", address(wallet2), 5e6, "s", 4e6);
        wallet2.payAgent(ks, address(wallet3), 3e6, "t", 2e6);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        vm.startPrank(mallory);
        wallet.release("r1");
        assertEq(usdg.balanceOf(customer), 995e6);
        wallet2.release(ks);
        assertEq(usdg.balanceOf(customer), 997e6);
        wallet3.release(kt);
        vm.stopPrank();
        assertEq(usdg.balanceOf(customer), 1_000e6, "customer whole");

        CreatureWallet[3] memory ws = [wallet, wallet2, wallet3];
        for (uint256 i = 0; i < 3; i++) {
            assertEq(_bal(ws[i]), 0);
            assertEq(ws[i].totalCharged(), 0);
            assertEq(ws[i].income(), 0);
            assertEq(ws[i].externalIncome() + ws[i].insiderIncome(), 0);
            assertEq(ws[i].payerCount(), 0);
            assertEq(ws[i].heldTotal(), 0);
        }
        // Day limits: what was sub-paid stays counted against the paying wallets' day.
        assertEq(wallet.remainingToday(), DAY_CAP);
    }

    // R2 check (sound). `pay` reads `from` straight from calldata; a `from` with
    // dirty upper bits is refused before anything is recorded.
    function test_poc2_sound_pay_refuses_a_dirty_from_word() public {
        bytes memory data = abi.encodeWithSelector(
            CreatureWallet.pay.selector,
            customer, uint256(6e6), uint256(0), block.timestamp + 600, bytes32("n"), uint8(27), bytes32(0), bytes32(0),
            bytes32("r1"), uint256(5e6), false
        );
        assembly {
            let w := mload(add(data, 0x24))
            mstore(add(data, 0x24), or(w, shl(200, 1)))
        }
        vm.prank(operator);
        (bool ok,) = address(wallet).call(data);
        assertFalse(ok, "dirty from accepted");
    }

    // =====================================================================
    // ROUND THREE
    // =====================================================================

    // ---------------------------------------------------------------------
    // R3-1 (Low). A checkpoint request records raw profit, money still held
    // for open runs included, and never expires. If those runs are refunded,
    // the request is left standing above real profit: a loaded checkpoint that
    // can be taken at once, any time later. Money that then arrives without a
    // hold (a direct transfer the meter means to cover with `open`) is settled
    // in the same block, before the run is billed, and the lender is paid its
    // share of the gross. The one-day wait is skipped.
    // ---------------------------------------------------------------------
    function test_fixed3_a_stale_request_settles_unbilled_income_at_once() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);

        _pay(6e6, "r1", 5e6);
        vm.prank(lender);
        wallet.requestCheckpoint(); // all $6 is held, so the request now asks for nothing
        assertEq(wallet.pendingProfit(), 0, "held money is left out of the request");
        vm.prank(operator);
        wallet.refund("r1", 0, RCPT);
        vm.warp(block.timestamp + 10 days);

        vm.prank(customer2);
        usdg.transfer(address(wallet), 6e6); // a payment that came straight in; its run is not billed yet
        vm.startPrank(lender);
        wallet.takeCheckpoint();
        assertEq(wallet.settledProfit(), 0, "the old request settles none of the new, unbilled money");
        assertEq(wallet.settleLien(), 0);
        vm.stopPrank();
        assertEq(usdg.balanceOf(lender), 0);

        // The meter can still set the run's whole cost aside and bill it.
        vm.startPrank(operator);
        wallet.open("r2", 5e6);
        wallet.charge("r2", 5e6, RCPT);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // R3-2 (Low; R2-1 still open against a meter that is a contract). The
    // request now stands until the hold is gone, but the hold never has to be
    // gone: the meter releases the old hold and opens a new one in one
    // transaction, well inside the day, so no hold ever times out and there is
    // no moment at which the checkpoint can be taken.
    // ---------------------------------------------------------------------
    function test_poc3_a_contract_meter_rolls_its_hold_and_the_request_never_completes() public {
        RollingMeterR3 meter = new RollingMeterR3();
        WeightlingsFactory f2 =
            new WeightlingsFactory(address(usdg), admin, address(meter), treasury, 2_000, address(0), guardian);
        (, address w_) = f2.createAgent(alice, RUN_CAP, DAY_CAP, bytes32(0), "", treasury, 2_000);
        CreatureWallet w = CreatureWallet(w_);

        vm.prank(alice);
        w.setLien(lender, 5_000, 0);
        usdg.mint(address(w), 9_999_999);
        vm.prank(lender);
        w.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        meter.roll(w, bytes32(0), bytes32(uint256(1)), 8_333_333);

        for (uint256 d = 1; d <= 8; d++) {
            vm.startPrank(lender);
            w.takeCheckpoint();
            vm.expectRevert(CreatureWallet.HoldStands.selector);
            w.release(bytes32(d));
            vm.stopPrank();
            assertEq(w.settledProfit(), 0);
            vm.warp(block.timestamp + 23 hours);
            meter.roll(w, bytes32(d), bytes32(d + 1), 8_333_333);
        }
        assertEq(w.lienUnpaid(), 0, "eight days on the lender is owed nothing");
        assertEq(w.withdrawable(), 0, "and the owner can take nothing");
        vm.prank(lender);
        vm.expectRevert(CreatureWallet.CheckpointPending.selector);
        w.requestCheckpoint();
    }
}

contract RollingMeterR3 {
    function roll(CreatureWallet w, bytes32 oldId, bytes32 newId, uint256 budget) external {
        if (oldId != bytes32(0)) w.release(oldId);
        w.open(newId, budget);
    }
}

/// Round two: a handler that filters nothing. Every call is sent as fuzzed and may
/// revert; only the properties below are asserted.
contract RawHandlerR2 is Test {
    MockUSDGV3 public usdg;
    WeightlingsFactory public factory;
    CreatureWallet[3] public w;
    address[3] public owners;
    address[3] public altOwners;
    address[3] public customers;
    address[2] public payees;
    address[3] public ops;
    address public guardian;
    address public treasury;
    mapping(uint256 => bytes32[]) internal ids;
    uint256 internal seq;
    mapping(string => uint256) public okBy;

    constructor(MockUSDGV3 u, WeightlingsFactory f, address[3] memory w_, address guardian_) {
        usdg = u;
        factory = f;
        guardian = guardian_;
        treasury = f.treasury();
        ops[0] = f.operator();
        ops[1] = makeAddr("r2-op1");
        ops[2] = makeAddr("r2-op2");
        for (uint256 i = 0; i < 3; i++) {
            w[i] = CreatureWallet(w_[i]);
            owners[i] = w[i].owner();
            altOwners[i] = makeAddr(string.concat("r2-alt-", vm.toString(i)));
            customers[i] = makeAddr(string.concat("r2-cust-", vm.toString(i)));
        }
        payees[0] = makeAddr("r2-payee0");
        payees[1] = makeAddr("r2-payee1");
        for (uint256 i = 0; i < 3; i++) {
            for (uint256 j = 0; j < 3; j++) {
                if (i == j) continue;
                vm.prank(owners[i]);
                w[i].setPayable(address(w[j]), true);
            }
        }
    }

    function holderSum() external view returns (uint256 sum) {
        for (uint256 i = 0; i < 3; i++) {
            sum += usdg.balanceOf(address(w[i])) + usdg.balanceOf(owners[i]) + usdg.balanceOf(altOwners[i])
                + usdg.balanceOf(customers[i]);
            if (owners[i] == altOwners[i]) sum -= usdg.balanceOf(owners[i]);
        }
        sum += usdg.balanceOf(payees[0]) + usdg.balanceOf(payees[1]) + usdg.balanceOf(treasury);
    }

    function sumHolds(uint256 i) external view returns (uint256 held, uint256 plain) {
        bytes32[] storage a = ids[i];
        for (uint256 k = 0; k < a.length; k++) {
            (,, uint64 openedAt, uint96 amount,,) = w[i].holds(a[k]);
            if (openedAt == 0) continue;
            held += amount;
            (address payer,,,) = w[i].payments(a[k]);
            if (payer == address(0)) plain++;
        }
    }

    function _mix(uint256 x) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(x)));
    }

    mapping(uint256 => uint256) public returnsSeen;

    function _countReturns() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("AgentReturned(bytes32,address,uint256)");
        for (uint256 k = 0; k < logs.length; k++) {
            if (logs[k].topics[0] != sig) continue;
            for (uint256 i = 0; i < 3; i++) {
                if (logs[k].emitter == address(w[i])) returnsSeen[i]++;
            }
        }
    }

    function _new(uint256 i) internal returns (bytes32 id) {
        id = bytes32(++seq);
        ids[i].push(id);
    }

    /// Three times in four an id whose hold is open (searched from a fuzzed place),
    /// otherwise any recent id, used up or not.
    function _pick(uint256 i, uint256 s) internal returns (bytes32) {
        uint256 n = ids[i].length;
        if (n == 0) return _new(i);
        if (s % 4 != 0) {
            uint256 start = (s >> 2) % n;
            uint256 span = n < 40 ? n : 40;
            for (uint256 k = 0; k < span; k++) {
                bytes32 id = ids[i][(start + n - k) % n];
                (,, uint64 openedAt,,,) = w[i].holds(id);
                if (openedAt != 0) return id;
            }
        }
        uint256 win = n < 8 ? n : 8;
        return ids[i][n - 1 - ((s >> 2) % win)];
    }

    function _meter(uint256 i, uint256 s) internal view returns (address) {
        uint256 k = s % 8;
        if (k < 6) return w[i].operator();
        if (k == 6) return ops[(s >> 3) % 3];
        return customers[0];
    }

    function _holdActor(uint256 i, bytes32 id, uint256 s) internal view returns (address) {
        uint256 k = s % 8;
        if (k < 5) {
            (address opener,,,,,) = w[i].holds(id);
            return opener == address(0) ? w[i].operator() : opener;
        }
        return _meter(i, s);
    }

    function pay(uint256 s, uint256 b, uint256 x, bool recv) external {
        s = _mix(s);
        b = _mix(b);
        x = _mix(x);
        uint256 i = s % 3;
        address from = (s >> 8) % 4 == 3 ? owners[i] : customers[(s >> 8) % 4];
        uint256 budget = bound(b, 1, 9e6);
        uint256 value = (s >> 16) % 8 == 0 ? bound(x, 0, 12e6) : budget + (budget * 2_000) / 10_000 + bound(x, 0, 4e6);
        usdg.mint(from, value);
        bytes memory head = abi.encode(from, value, uint256(0), block.timestamp + 600, bytes32(++seq));
        bytes memory rest = abi.encode(recv ? uint8(28) : uint8(27), bytes32(0), bytes32(0), _new(i), budget, recv);
        bytes memory data = bytes.concat(CreatureWallet.pay.selector, head, rest);
        vm.prank(_meter(i, s >> 24));
        (bool ok,) = address(w[i]).call(data);
        if (ok) okBy["pay"]++;
    }

    function open(uint256 s, uint256 b) external {
        s = _mix(s);
        b = _mix(b);
        uint256 i = s % 3;
        bytes32 id = (s >> 8) % 6 == 0 ? _pick(i, s >> 16) : _new(i);
        address op = _meter(i, s >> 24);
        vm.prank(op);
        try w[i].open(id, bound(b, 0, 9e6)) {
            okBy["open"]++;
        } catch {}
    }

    function charge(uint256 s, uint256 c, bool settleToo) external {
        s = _mix(s);
        c = _mix(c);
        uint256 i = s % 3;
        bytes32 id = _pick(i, s >> 8);
        address op = _holdActor(i, id, s >> 24);
        (,,,, uint80 budgetNow,) = w[i].holds(id);
        uint256 cost = bound(c, 0, uint256(budgetNow) + 1);
        vm.prank(op);
        if (settleToo) {
            try w[i].chargeAndSettle(id, cost, type(uint256).max, bytes32(0)) {
                okBy["charge"]++;
            } catch {}
        } else {
            try w[i].charge(id, cost, bytes32(0)) {
                okBy["charge"]++;
            } catch {}
        }
    }

    function refund(uint256 s, uint256 c) external {
        s = _mix(s);
        c = _mix(c);
        uint256 i = s % 3;
        bytes32 id = _pick(i, s >> 8);
        address op = _holdActor(i, id, s >> 24);
        (,,,, uint80 budgetNow,) = w[i].holds(id);
        uint256 cost = (s >> 40) % 2 == 0 ? 0 : bound(c, 0, uint256(budgetNow) + 1);
        vm.recordLogs();
        vm.prank(op);
        try w[i].refund(id, cost, bytes32(0)) {
            okBy["refund"]++;
        } catch {}
        _countReturns();
    }

    function release(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        bytes32 id = _pick(i, s >> 8);
        address op = _holdActor(i, id, s >> 24);
        vm.recordLogs();
        vm.prank(op);
        try w[i].release(id) {
            okBy["release"]++;
        } catch {}
        _countReturns();
    }

    function payAgent(uint256 s, uint256 v, uint256 sb) external {
        s = _mix(s);
        v = _mix(v);
        sb = _mix(sb);
        uint256 i = s % 3;
        uint256 to = (i + 1 + (s >> 4) % 2) % 3;
        bytes32 id = _pick(i, s >> 8);
        address op = _holdActor(i, id, s >> 24);
        (,,,, uint80 budgetNow,) = w[i].holds(id);
        uint256 value = bound(v, 0, uint256(budgetNow) + 1);
        uint256 subBudget = bound(sb, 0, value);
        bytes32 sub = bytes32(++seq);
        ids[to].push(w[to].subRunKey(address(w[i]), sub));
        vm.prank(op);
        try w[i].payAgent(id, address(w[to]), value, sub, subBudget) {
            okBy["payAgent"]++;
        } catch {}
    }

    function settle(uint256 s, uint256 upTo) external {
        s = _mix(s);
        upTo = _mix(upTo);
        uint256 i = s % 3;
        address op = _meter(i, s >> 24);
        vm.prank(op);
        try w[i].settle(s % 2 == 0 ? type(uint256).max : bound(upTo, 0, 100e6)) {
            okBy["settle"]++;
        } catch {}
    }

    function requestCheckpoint(uint256 s) external {
        s = _mix(s);
        try w[s % 3].requestCheckpoint() {} catch {}
    }

    function takeCheckpoint(uint256 s) external {
        s = _mix(s);
        try w[s % 3].takeCheckpoint() {
            okBy["takeCheckpoint"]++;
        } catch {}
    }

    function withdraw(uint256 s, uint256 a) external {
        s = _mix(s);
        a = _mix(a);
        uint256 i = s % 3;
        uint256 amount = (s >> 8) % 2 == 0 ? w[i].withdrawable() : bound(a, 0, usdg.balanceOf(address(w[i])));
        vm.prank(owners[i]);
        try w[i].withdraw(address(usdg), owners[i], amount) {
            okBy["withdraw"]++;
        } catch {}
    }

    function setLien(uint256 s, uint256 bps, uint256 cap) external {
        s = _mix(s);
        bps = _mix(bps);
        cap = _mix(cap);
        uint256 i = s % 3;
        uint256 k = (s >> 8) % 3;
        address payee = k == 2 ? address(w[(i + 1) % 3]) : payees[k];
        uint128 cap_ = (s >> 16) % 3 == 0 ? 0 : uint128(bound(cap, 1, 20e6));
        vm.prank(owners[i]);
        try w[i].setLien(payee, uint16(bound(bps, 1, 10_000)), cap_) {
            okBy["setLien"]++;
        } catch {}
    }

    mapping(uint256 => uint256) public lienPaidSeen;

    function settleLien(uint256 s) external {
        s = _mix(s);
        try w[s % 3].settleLien() returns (uint256 a) {
            lienPaidSeen[s % 3] += a;
        } catch {}
    }

    function endLien(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        (address payee,,,,) = w[i].lien();
        vm.prank((s >> 8) % 2 == 0 ? payee : owners[i]);
        try w[i].endLien() {
            okBy["endLien"]++;
        } catch {}
    }

    function warp(uint256 s) external {
        s = _mix(s);
        vm.warp(block.timestamp + bound(s, 30 minutes, 30 hours));
    }

    function toggleBlock(uint256 s) external {
        s = _mix(s);
        uint256 k = s % 6;
        address who = k < 3 ? customers[k] : k == 3 ? payees[0] : k == 4 ? address(w[(s >> 8) % 3]) : treasury;
        usdg.setBlocked(who, (s >> 16) % 8 == 1);
    }

    function claimParked(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        uint256 k = (s >> 8) % 5;
        address who = k < 3 ? customers[k] : payees[k - 3];
        vm.prank(who);
        try w[i].claimParked(who) {
            okBy["claimParked"]++;
        } catch {}
    }

    function collectParked(uint256 s) external {
        s = _mix(s);
        try w[s % 3].collectParked(address(w[(s >> 8) % 3])) {
            okBy["collectParked"]++;
        } catch {}
    }

    function setOperator(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        address next = (s >> 8) % 3 == 0 ? address(0) : ops[1 + (s >> 16) % 2];
        (address payee,,,,) = w[i].lien();
        if (payee != address(0) && (s >> 24) % 2 == 0) {
            vm.prank(payee);
            try w[i].consentToOperator(next) {} catch {}
        }
        vm.prank(owners[i]);
        try w[i].setOperator(next) {
            okBy["setOperator"]++;
        } catch {}
    }

    function guardianPause(uint256 s) external {
        s = _mix(s);
        vm.prank(guardian);
        factory.setOperatorPaused(s % 10 == 1);
    }

    function donate(uint256 s, uint256 a) external {
        s = _mix(s);
        a = _mix(a);
        usdg.mint(address(w[s % 3]), bound(a, 0, 5e6));
    }

    function setLimits(uint256 s, uint256 r, uint256 d) external {
        s = _mix(s);
        r = _mix(r);
        d = _mix(d);
        uint256 i = s % 3;
        vm.prank(owners[i]);
        if ((s >> 8) % 8 == 0) w[i].setLimits(uint128(bound(r, 0, 12e6)), uint128(bound(d, 0, 80e6)));
        else w[i].setLimits(uint128(bound(r, 4e6, 12e6)), uint128(bound(d, 30e6, 80e6)));
    }

    function setPausedOwner(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        vm.prank(owners[i]);
        w[i].setPaused((s >> 8) % 12 == 1);
    }

    function toggleLists(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        address other = address(w[(i + 1 + (s >> 4) % 2) % 3]);
        bool on = (s >> 8) % 3 != 0;
        vm.prank(owners[i]);
        try w[i].setPayable(other, on) {} catch {}
    }

    /// Added with the round-two fixes: anyone retries a sub-run's stuck return.
    function retryReturn(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        uint256 n = ids[i].length;
        if (n == 0) return;
        vm.recordLogs();
        try w[i].retryReturn(ids[i][(s >> 8) % n]) {
            okBy["retryReturn"]++;
        } catch {}
        _countReturns();
    }

    function handOver(uint256 s) external {
        s = _mix(s);
        uint256 i = s % 3;
        vm.prank(owners[i]);
        w[i].transferOwnership(altOwners[i]);
        vm.prank(altOwners[i]);
        w[i].acceptOwnership();
        (owners[i], altOwners[i]) = (altOwners[i], owners[i]);
    }

    // The same actions again under other names, so the fuzzer picks them more often.
    function pay2(uint256 s, uint256 b, uint256 x, bool recv) external {
        this.pay(s, b, x, recv);
    }

    function pay3(uint256 s, uint256 b, uint256 x, bool recv) external {
        this.pay(s, b, x, recv);
    }

    function payAgent2(uint256 s, uint256 v, uint256 sb) external {
        this.payAgent(s, v, sb);
    }

    function payAgent3(uint256 s, uint256 v, uint256 sb) external {
        this.payAgent(s, v, sb);
    }

    function payAgent4(uint256 s, uint256 v, uint256 sb) external {
        this.payAgent(s, v, sb);
    }

    function refund2(uint256 s, uint256 c) external {
        this.refund(s, c);
    }

    function release2(uint256 s) external {
        this.release(s);
    }

    function release3(uint256 s) external {
        this.release(s);
    }

    function charge2(uint256 s, uint256 c, bool settleToo) external {
        this.charge(s, c, settleToo);
    }
}

/// forge-config: default.invariant.runs = 200
/// forge-config: default.invariant.depth = 500
/// forge-config: default.invariant.fail-on-revert = false
contract ReviewV3RawInvariantTest is Test {
    MockUSDGV3 usdg;
    WeightlingsFactory factory;
    RawHandlerR2 h;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDGV3();
        address treasury = makeAddr("r2-treasury");
        address guardian = makeAddr("r2-guardian");
        factory = new WeightlingsFactory(
            address(usdg), makeAddr("r2-admin"), makeAddr("r2-op0"), treasury, 2_000, address(0), guardian
        );
        address[3] memory ws;
        for (uint256 i = 0; i < 3; i++) {
            (, ws[i]) = factory.createAgent(
                makeAddr(string.concat("r2-owner-", vm.toString(i))), 10e6, 60e6, bytes32(0), "", treasury, 2_000
            );
        }
        h = new RawHandlerR2(usdg, factory, ws, guardian);
        targetContract(address(h));
    }

    function afterInvariant() public {
        string[9] memory names = ["pay", "open", "charge", "refund", "release", "payAgent", "withdraw", "setLien", "takeCheckpoint"];
        for (uint256 k = 0; k < names.length; k++) {
            emit log_named_uint(names[k], h.okBy(names[k]));
        }
        for (uint256 i = 0; i < 3; i++) {
            CreatureWallet x = h.w(i);
            emit log_named_uint("  charged", x.totalCharged());
            emit log_named_uint("  refunded", x.totalRefunded());
            emit log_named_uint("  parked", x.parkedTotal());
            emit log_named_uint("  held", x.heldTotal());
            emit log_named_uint("  returns", h.returnsSeen(i));
            emit log_named_uint("  lien paid", h.lienPaidSeen(i));
        }
    }

    function invariant_poc2_raw_solvency_books_and_conservation() public view {
        for (uint256 i = 0; i < 3; i++) {
            CreatureWallet x = h.w(i);
            uint256 bal = usdg.balanceOf(address(x));
            uint256 owed = x.heldTotal() + x.parkedTotal() + x.lienUnpaid(); // a revert here is a bricked wallet
            assertGe(bal, owed, "balance < held + parked + lien owed");
            assertLe(x.settledProfit(), x.profit(), "checkpoint above profit");
            assertLe(x.withdrawable(), bal - owed, "withdrawable reaches owed money");
            assertLe(x.externalIncome() + x.insiderIncome(), x.income(), "payer income above income");
            (uint256 held, uint256 plain) = h.sumHolds(i);
            assertEq(held, x.heldTotal(), "heldTotal != sum of holds");
            assertEq(plain, x.plainHolds(), "plainHolds out of step");
            for (uint256 j = 0; j < 3; j++) {
                assertEq(usdg.allowance(address(x), address(h.w(j))), 0, "an approval was left standing");
            }
        }
        assertEq(h.holderSum(), usdg.minted(), "USDG not conserved");
    }
}
