// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {WeightlingsFactory} from "../src/WeightlingsFactory.sol";
import {CreatureWallet} from "../src/CreatureWallet.sol";
import {MockUSDGV3} from "./CreatureWallet.t.sol";

/// Drives two CreatureWallet wallets of one factory with bounded random actions and
/// keeps its own books for each. Every action takes a seed that picks the wallet.
///
/// Two modes:
///  - strict: the meter behaves as the wallet's comments say it should. Every hold
///    is covered by money that arrives in the same action and the checkpoint is
///    only ever asked to move to "profit less money still held".
///  - loose (strict = false): the meter and everyone else may do anything the
///    contract lets them: open holds against money already in the wallet, ask for
///    any checkpoint figure, request and take checkpoints, pause, swap the
///    wallet's operator, stop every meter through the guardian.
///
/// No action reverts: each one either goes through or returns early and is counted
/// as skipped, so the test contracts run with fail-on-revert switched on.
contract WalletHandlerV3 is Test {
    CreatureWallet[2] public wallets;
    address[2] public owners;
    MockUSDGV3 public usdg;
    WeightlingsFactory public factory;
    address public factoryOperator;
    address public guardian;
    address public treasury;
    bool public strict;

    CreatureWallet public evil; // a third wallet of the same factory: its owner is its own meter and nobody's friend
    address public evilOwner;
    address[4] public ownerPool; // every address that may come to own one of the two wallets
    mapping(uint256 => mapping(address => bool)) internal everOwner;

    address internal stranger = makeAddr("inv3-stranger");
    address[3] public customers; // customers[2] is the one USDG sometimes blocks
    address[3] public payees;
    address[2] internal ownOps;

    // ---- ghost books, per wallet ----
    mapping(uint256 => uint256) public gIn; // every USDG that reached the wallet
    mapping(uint256 => uint256) public gRefunded; // given back to payers: sent, or parked for them
    mapping(uint256 => uint256) public gRefundSent; // of that, delivered at once
    mapping(uint256 => uint256) public gParkedNow; // of that, parked and not yet claimed
    mapping(uint256 => uint256) public gParkedClaimed; // of that, parked and since claimed
    mapping(uint256 => uint256) public gCharged; // sent to the treasury, fee included
    mapping(uint256 => uint256) public gSub; // paid to the other agent's wallet
    mapping(uint256 => uint256) public gLienPaid;
    mapping(uint256 => uint256) public gWithdrawn;
    mapping(uint256 => uint256) public gHeld; // sum of holds the handler believes are open
    mapping(uint256 => uint256) public gPlain; // open holds that came from `open`
    mapping(uint256 => uint256) public gPayIn; // paid in through pay / payFromAgent
    mapping(uint256 => uint256) public gPayOut; // refunds + charges + sub-payments of those runs
    mapping(uint256 => uint256) public gPayHeld; // what is still held for those runs
    mapping(uint256 => uint256) public gExternal; // outside payments, net of refunds
    mapping(uint256 => uint256) public gInsider; // insider payments, net of refunds
    uint256 public gRefundOutside; // refunds that left both wallets (to customers and owners)

    struct Run {
        bool paid; // came through pay or payFromAgent
        bool outside;
        address payer;
        uint256 value; // the payment
        uint256 budgetLeft;
        uint256 holdNow;
        uint256 reserved; // budget + fee when opened
        uint256 spent; // treasury charges + sub-payments
        uint256 back; // refunded
        uint256 closes; // charges + refunds that went through
        bool refunded; // closed by a refund or a timeout
    }

    mapping(uint256 => mapping(bytes32 => bytes32)) internal parentOf; // a sub-run's paying run, on the other wallet
    mapping(uint256 => mapping(bytes32 => uint256)) internal stuckOwed; // what a sub-run could not give back yet
    mapping(uint256 => bytes32[]) internal stuck; // the sub-runs with something in `stuckOwed`

    mapping(uint256 => mapping(bytes32 => Run)) internal runs;
    mapping(uint256 => bytes32[]) internal openRuns;
    mapping(uint256 => mapping(bytes32 => uint256)) internal openIndex; // 1-based
    mapping(uint256 => bytes32[]) internal closedRuns; // charged or refunded
    mapping(uint256 => bytes32[]) internal paidRuns; // every run that came with a payment

    mapping(uint256 => uint256) public lienCapNow; // cap of the lien that stands (0 = none)
    mapping(uint256 => uint256) public lienPaidNow;
    uint256 public liensSet;
    uint256 public capsReached;

    // ---- things that must never happen; each is asserted false by the test ----
    bool public closedTwice; // a second charge/refund, a re-open or a release of a closed run went through
    bool public spentOverLimit; // a run cost more than its budget with the fee, or more than its payment
    bool public lienPaidOverCap;
    bool public withdrewOwedMoney; // after a withdrawal the wallet held less than holds + parked + lien owed
    bool public withdrewOverLimit; // a withdrawal above withdrawable() went through
    bool public strangerReleasedEarly;
    bool public actedWhilePaused; // an operator action went through under the guardian's pause
    bool public wrongOperatorActed; // the factory operator acted on a wallet with its own operator
    bool public underpaidAccepted; // a payment smaller than the run's maximum cost was taken
    bool public paidUnlisted; // a run paid a wallet its owner had not listed, or one was listed under a lien without consent
    bool public frontRan; // a receive-form payment was submitted by someone other than the wallet
    bool public openerBypassed; // a meter that did not open a hold acted on it
    bool public hostilePushed; // a wallet run by another meter, and not listed, pushed a run in
    bool public lienOverPlainHolds; // a lien was set while a hold from the balance was open
    bool public refundMisdelivered; // a refund neither reached its payer nor was parked for them
    string public lastBreach;

    uint256 internal seq;

    // ---- call counters ----
    string[] public actions;
    mapping(string => uint256) public done;
    mapping(string => uint256) public skipped;

    constructor(
        CreatureWallet w0,
        CreatureWallet w1,
        CreatureWallet evil_,
        MockUSDGV3 usdg_,
        WeightlingsFactory factory_,
        address guardian_,
        bool strict_
    ) {
        wallets[0] = w0;
        wallets[1] = w1;
        owners[0] = w0.owner();
        owners[1] = w1.owner();
        evil = evil_;
        evilOwner = evil_.owner();
        ownerPool = [owners[0], owners[1], makeAddr("inv3-owner-2"), makeAddr("inv3-owner-3")];
        everOwner[0][owners[0]] = true;
        everOwner[1][owners[1]] = true;
        usdg = usdg_;
        factory = factory_;
        factoryOperator = factory_.operator();
        guardian = guardian_;
        treasury = w0.treasury();
        strict = strict_;
        for (uint256 i = 0; i < 3; i++) {
            customers[i] = makeAddr(string.concat("inv3-customer-", vm.toString(i)));
            payees[i] = makeAddr(string.concat("inv3-payee-", vm.toString(i)));
        }
        ownOps[0] = makeAddr("inv3-own-operator-0");
        ownOps[1] = makeAddr("inv3-own-operator-1");
        string[35] memory names = [
            "payAndOpen",
            "fundAndOpen",
            "charge",
            "chargeAndSettle",
            "refund",
            "payAgent",
            "rechargeProbe",
            "release",
            "withdraw",
            "setLien",
            "settleLien",
            "endLienPayee",
            "endLienOwner",
            "warp",
            "settle",
            "setLimits",
            "toggleBlock",
            "claimParked",
            "setPaused",
            "openFromBalance",
            "requestCheckpoint",
            "takeCheckpoint",
            "setOperator",
            "guardianPause",
            "notePayer",
            "lowerOpenRaise",
            "togglePayable",
            "releaseTimedOutPayment",
            "transferOwnership",
            "setLienPayee",
            "blockedSubRefund",
            "retryReturn",
            "hostilePush",
            "frontRunReceive",
            "frontRunTransfer"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            actions.push(names[i]);
        }
    }

    // ---- views for the test contracts ----

    function actionCount() external view returns (uint256) {
        return actions.length;
    }

    function closedRunCount(uint256 w) external view returns (uint256) {
        return closedRuns[w].length;
    }

    function closedRunAt(uint256 w, uint256 i) external view returns (bytes32) {
        return closedRuns[w][i];
    }

    function paidRunCount(uint256 w) external view returns (uint256) {
        return paidRuns[w].length;
    }

    function paidRunAt(uint256 w, uint256 i) external view returns (bytes32) {
        return paidRuns[w][i];
    }

    function runOf(uint256 w, bytes32 id) external view returns (Run memory) {
        return runs[w][id];
    }

    // ---- helpers ----

    function _bal(uint256 w) internal view returns (uint256) {
        return usdg.balanceOf(address(wallets[w]));
    }

    function _lienPayee(uint256 w) internal view returns (address payee) {
        (payee,,,,) = wallets[w].lien();
    }

    function _breach(string memory what) internal {
        lastBreach = what;
    }

    function _newId() internal returns (bytes32) {
        return keccak256(abi.encode("run", ++seq));
    }

    function _opener(uint256 w, bytes32 id) internal view returns (address opener) {
        (opener,,,,,) = wallets[w].holds(id);
    }

    /// 0 or 1 for one of the two wallets, 2 for anything else.
    function _walletIndex(address who) internal view returns (uint256) {
        return who == address(wallets[0]) ? 0 : who == address(wallets[1]) ? 1 : 2;
    }

    /// The rule the wallet is meant to apply, worked out here from the handler's own
    /// record: an insider is any owner the wallet has had, its lien payee, or a
    /// wallet that belongs to one of those.
    function _expectOutside(uint256 w, address payer) internal view returns (bool) {
        address payee = _lienPayee(w);
        if (everOwner[w][payer] || (payee != address(0) && payer == payee)) return false;
        uint256 x = _walletIndex(payer);
        if (x < 2 && (everOwner[w][owners[x]] || owners[x] == payee)) return false;
        return true;
    }

    function _stopped() internal view returns (bool) {
        return factory.operatorPaused();
    }

    /// The largest budget the wallet would let in right now, fee included in the limits.
    function _maxBudget(uint256 w) internal view returns (uint256) {
        uint256 room = wallets[w].perRunCap();
        uint256 today = wallets[w].remainingToday();
        if (today < room) room = today;
        return (room * 10_000) / (10_000 + wallets[w].markupBps());
    }

    function _total(uint256 w, uint256 budget) internal view returns (uint256) {
        return budget + (budget * wallets[w].markupBps()) / 10_000;
    }

    function _recordOpen(uint256 w, bytes32 id, uint256 budget, uint256 hold) internal {
        (address opener,,, uint96 held, uint80 budgetHeld, uint80 reserved) = wallets[w].holds(id);
        assertEq(opener, wallets[w].operator(), "hold does not name the meter that opened it");
        assertEq(held, hold, "hold opened for the wrong amount");
        assertEq(budgetHeld, budget, "hold opened with the wrong budget");
        assertEq(reserved, _total(w, budget), "hold reserved the wrong amount");
        Run storage r = runs[w][id];
        r.budgetLeft = budget;
        r.holdNow = hold;
        r.reserved = reserved;
        gHeld[w] += hold;
        if (!r.paid) gPlain[w]++;
        openRuns[w].push(id);
        openIndex[w][id] = openRuns[w].length;
    }

    function _recordPayment(uint256 w, bytes32 id, address payer, uint256 value) internal {
        Run storage r = runs[w][id];
        r.paid = true;
        r.payer = payer;
        r.value = value;
        r.outside = _expectOutside(w, payer);
        (address onChainPayer, uint80 onChainValue, bool outside,) = wallets[w].payments(id);
        assertEq(onChainPayer, payer, "payer recorded wrong");
        assertEq(onChainValue, value, "payment recorded wrong");
        assertEq(outside, r.outside, "payer classified wrong");
        gIn[w] += value;
        gPayIn[w] += value;
        gPayHeld[w] += value;
        if (r.outside) gExternal[w] += value;
        else gInsider[w] += value;
        paidRuns[w].push(id);
    }

    function _forgetOpen(uint256 w, bytes32 id) internal {
        uint256 i = openIndex[w][id];
        bytes32 last = openRuns[w][openRuns[w].length - 1];
        openRuns[w][i - 1] = last;
        openIndex[w][last] = i;
        openRuns[w].pop();
        openIndex[w][id] = 0;
        Run storage r = runs[w][id];
        gHeld[w] -= r.holdNow;
        if (r.paid) gPayHeld[w] -= r.holdNow;
        else gPlain[w]--;
        r.holdNow = 0;
    }

    function _pick(uint256 w, uint256 seed) internal view returns (bytes32 id, bool ok) {
        uint256 n = openRuns[w].length;
        if (n == 0) return (bytes32(0), false);
        return (openRuns[w][seed % n], true);
    }

    /// An open run that fits, starting the search at a random place: `paid` asks for
    /// one that came with a payment, `withBudget` for one that can still be charged.
    function _pickFit(uint256 w, uint256 seed, bool paid, bool withBudget) internal view returns (bytes32 id, bool ok) {
        uint256 n = openRuns[w].length;
        for (uint256 i = 0; i < n; i++) {
            id = openRuns[w][(seed % n + i) % n];
            Run storage r = runs[w][id];
            if ((!paid || r.paid) && (!withBudget || r.budgetLeft != 0)) return (id, true);
        }
        return (bytes32(0), false);
    }

    // ---- money in, hold opened ----

    /// A signed payment arrives through `pay`, in either form, and all of it is
    /// held. The payer is a customer or any address that owns, has owned or may come
    /// to own one of the wallets.
    function payAndOpen(uint256 wSeed, uint256 budgetSeed, uint256 valueSeed, uint256 payerSeed) external {
        uint256 w = wSeed % 2;
        uint256 maxBudget = _maxBudget(w);
        if (wallets[w].paused() || _stopped() || maxBudget == 0) {
            skipped["payAndOpen"]++;
            return;
        }
        uint256 budget = bound(budgetSeed, 1, maxBudget > 50e6 ? 50e6 : maxBudget);
        uint256 total = _total(w, budget);
        address payer = payerSeed % 7 < 3 ? customers[payerSeed % 7] : ownerPool[payerSeed % 7 - 3];
        bool receiveOnly = (payerSeed >> 8) % 2 == 0;
        bytes32 id = _newId();

        // A payment one unit short of the run's maximum cost must be refused.
        if (!strict && total > 1) {
            if (_pay(w, stranger, total - 1, ~id, id, budget, receiveOnly)) {
                underpaidAccepted = true;
                _breach("an underpaid run was let in");
            }
            vm.prank(stranger);
            usdg.transfer(address(0xdead), total - 1); // keep the books simple: burn what was not taken
        }

        uint256 value = total + bound(valueSeed, 0, 20e6);
        require(_pay(w, payer, value, id, id, budget, receiveOnly), "pay refused");
        _recordPayment(w, id, payer, value);
        _recordOpen(w, id, budget, value);
        done["payAndOpen"]++;
    }

    function _pay(uint256 w, address payer, uint256 value, bytes32 nonce, bytes32 id, uint256 budget, bool receiveOnly)
        internal
        returns (bool ok)
    {
        usdg.mint(payer, value);
        address op = wallets[w].operator();
        uint8 v = receiveOnly ? 28 : 27;
        vm.prank(op);
        try wallets[w].pay(payer, value, 0, block.timestamp + 600, nonce, v, bytes32(0), bytes32(0), id, budget, receiveOnly) {
            ok = true;
        } catch {}
    }

    /// Loose mode only: someone who has seen the customer's signed payment tries to
    /// hand it to USDG before the meter's `pay` lands. In the receive form nobody
    /// can: the owner, the meter and a stranger are each refused, and `pay` then
    /// goes through with the hold and the record. In the transfer form the owner
    /// can, and this is the known gap: the money arrives with no hold, `pay` fails,
    /// and it is plain income.
    function frontRunPay(uint256 wSeed, uint256 budgetSeed, bool receiveOnly) external {
        uint256 w = wSeed % 2;
        uint256 maxBudget = _maxBudget(w);
        string memory name = receiveOnly ? "frontRunReceive" : "frontRunTransfer";
        if (wallets[w].paused() || _stopped() || maxBudget == 0) {
            skipped[name]++;
            return;
        }
        uint256 budget = bound(budgetSeed, 1, maxBudget > 50e6 ? 50e6 : maxBudget);
        uint256 value = _total(w, budget) + 1e6;
        bytes32 id = _newId();
        address payer = customers[0];
        if (receiveOnly) {
            usdg.mint(payer, value);
            address[3] memory thieves = [owners[w], wallets[w].operator(), stranger];
            for (uint256 i = 0; i < 3; i++) {
                vm.prank(thieves[i]);
                try usdg.receiveWithAuthorization(
                    payer, address(wallets[w]), value, 0, block.timestamp + 600, id, 28, bytes32(0), bytes32(0)
                ) {
                    frontRan = true;
                    _breach("a receive-form payment was submitted by someone other than the wallet");
                } catch {}
            }
            vm.prank(payer);
            usdg.transfer(address(0xdead), value); // _pay mints its own
            require(_pay(w, payer, value, id, id, budget, true), "pay refused");
            _recordPayment(w, id, payer, value);
            _recordOpen(w, id, budget, value);
        } else {
            usdg.mint(payer, value);
            vm.prank(owners[w]);
            usdg.transferWithAuthorization(
                payer, address(wallets[w]), value, 0, block.timestamp + 600, id, 27, bytes32(0), bytes32(0)
            );
            gIn[w] += value; // it is in the wallet, unheld and unrecorded
            if (_pay(w, payer, value, id, id, budget, false)) {
                frontRan = true;
                _breach("pay went through on an authorization that was already used");
            }
            vm.prank(payer);
            usdg.transfer(address(0xdead), value); // what _pay minted and could not take
            (address recorded,,,) = wallets[w].payments(id);
            assertEq(recorded, address(0), "a front-run payment was recorded");
        }
        done[name]++;
    }

    /// The payment arrives some other way (a plain transfer), then the meter opens
    /// the hold with `open`. The transfer covers the whole hold.
    function fundAndOpen(uint256 wSeed, uint256 budgetSeed, uint256 extraSeed) external {
        uint256 w = wSeed % 2;
        uint256 maxBudget = _maxBudget(w);
        if (wallets[w].paused() || _stopped() || maxBudget == 0) {
            skipped["fundAndOpen"]++;
            return;
        }
        uint256 budget = bound(budgetSeed, 1, maxBudget > 50e6 ? 50e6 : maxBudget);
        uint256 total = _total(w, budget);
        uint256 value = total + bound(extraSeed, 0, 20e6);
        bytes32 id = _newId();
        usdg.mint(address(wallets[w]), value);
        gIn[w] += value;
        address op = wallets[w].operator();
        vm.prank(op);
        wallets[w].open(id, budget);
        _recordOpen(w, id, budget, total);
        done["fundAndOpen"]++;
    }

    /// Loose mode only: the meter tries to open a hold, with no new money, against
    /// everything in the wallet that is not held or parked. It does not hold back
    /// what the lien is owed: the wallet has to. What the wallet lets through is
    /// recorded; property 2 then says whether it should have.
    function openFromBalance(uint256 wSeed, uint256 budgetSeed) external {
        if (_tryOpenFromBalance(wSeed % 2, budgetSeed)) done["openFromBalance"]++;
        else skipped["openFromBalance"]++;
    }

    function _tryOpenFromBalance(uint256 w, uint256 budgetSeed) internal returns (bool) {
        CreatureWallet wallet = wallets[w];
        uint256 maxBudget = _maxBudget(w);
        uint256 spoken = wallet.parkedTotal() + wallet.heldTotal();
        uint256 free = _bal(w) > spoken ? _bal(w) - spoken : 0;
        uint256 freeBudget = (free * 10_000) / (10_000 + wallet.markupBps());
        if (freeBudget < maxBudget) maxBudget = freeBudget;
        if (wallet.paused() || _stopped() || maxBudget == 0) return false;
        uint256 budget = bound(budgetSeed, 1, maxBudget);
        bytes32 id = _newId();
        address op = wallet.operator();
        vm.prank(op);
        try wallet.open(id, budget) {
            _recordOpen(w, id, budget, _total(w, budget));
            return true;
        } catch {
            return false;
        }
    }

    /// Loose mode only: the way round a checkpoint that could be moved down. The
    /// meter asks for the checkpoint at zero, opens a hold on whatever that seems
    /// to free, and asks for the checkpoint at everything again.
    function lowerOpenRaise(uint256 wSeed, uint256 budgetSeed) external {
        uint256 w = wSeed % 2;
        if (_stopped()) {
            skipped["lowerOpenRaise"]++;
            return;
        }
        address op = wallets[w].operator();
        vm.prank(op);
        wallets[w].settle(0);
        _tryOpenFromBalance(w, budgetSeed);
        vm.prank(op);
        wallets[w].settle(type(uint256).max);
        done["lowerOpenRaise"]++;
    }

    // ---- charge, refund ----

    function charge(uint256 wSeed, uint256 runSeed, uint256 costSeed) external {
        uint256 w = wSeed % 2;
        (bytes32 id, bool ok) = _pickFit(w, runSeed, false, true);
        if (!ok || _stopped()) {
            skipped["charge"]++;
            return;
        }
        uint256 cost = bound(costSeed, 1, runs[w][id].budgetLeft);
        address opener = _opener(w, id);
        _mustNotBypass(w, id, opener);
        uint256 before = usdg.balanceOf(treasury);
        vm.prank(opener);
        wallets[w].charge(id, cost, keccak256(abi.encode(id, cost)));
        _recordClose(w, id, usdg.balanceOf(treasury) - before, 0);
        done["charge"]++;
    }

    /// Every meter that did not open this hold, the wallet's current one and its
    /// owner included, must be refused when it tries to bill it or release it early.
    function _mustNotBypass(uint256 w, bytes32 id, address opener) internal {
        CreatureWallet wallet = wallets[w];
        address[5] memory others = [wallet.operator(), factoryOperator, ownOps[0], ownOps[1], owners[w]];
        (,, uint64 openedAt,,,) = wallet.holds(id);
        bool young = block.timestamp < uint256(openedAt) + wallet.HOLD_TIMEOUT();
        for (uint256 i = 0; i < 5; i++) {
            if (others[i] == opener) continue;
            vm.startPrank(others[i]);
            try wallet.charge(id, 1, bytes32(0)) {
                openerBypassed = true;
            } catch {}
            try wallet.refund(id, 0, bytes32(0)) {
                openerBypassed = true;
            } catch {}
            try wallet.payAgent(id, address(wallets[1 - w]), 1, bytes32(uint256(id) ^ 1), 1) {
                openerBypassed = true;
            } catch {}
            if (young) {
                try wallet.release(id) {
                    openerBypassed = true;
                } catch {}
            }
            vm.stopPrank();
        }
        if (openerBypassed) _breach("a meter that did not open a hold acted on it");
    }

    /// Charge and ask for a checkpoint. strict: at profit after the charge less what
    /// is still held. loose: half the time at any figure at all.
    function chargeAndSettle(uint256 wSeed, uint256 runSeed, uint256 costSeed, uint256 settleSeed) external {
        uint256 w = wSeed % 2;
        (bytes32 id, bool ok) = _pickFit(w, runSeed, false, true);
        if (!ok || _stopped() || runs[w][id].budgetLeft == 0) {
            skipped["chargeAndSettle"]++;
            return;
        }
        uint256 cost = bound(costSeed, 1, runs[w][id].budgetLeft);
        uint256 upTo;
        {
            uint256 profitAfter = wallets[w].profit() - _total(w, cost);
            uint256 heldAfter = wallets[w].heldTotal() - runs[w][id].holdNow;
            upTo = profitAfter > heldAfter ? profitAfter - heldAfter : 0;
            if (!strict && settleSeed % 2 == 1) upTo = bound(settleSeed, 0, profitAfter * 2 + 1);
        }
        uint256 before = usdg.balanceOf(treasury);
        address op = _opener(w, id);
        vm.prank(op);
        wallets[w].chargeAndSettle(id, cost, upTo, keccak256(abi.encode(id, cost)));
        _recordClose(w, id, usdg.balanceOf(treasury) - before, 0);
        done["chargeAndSettle"]++;
    }

    /// Bill a paid run (the cost may be nothing) and give the rest back.
    function refund(uint256 wSeed, uint256 runSeed, uint256 costSeed) external {
        uint256 w = wSeed % 2;
        (bytes32 id, bool ok) = _pickFit(w, runSeed, true, false);
        if (!ok || _stopped() || !runs[w][id].paid) {
            skipped["refund"]++;
            return;
        }
        uint256 holdNow = runs[w][id].holdNow;
        uint256 cost = bound(costSeed, 0, runs[w][id].budgetLeft);
        uint256 before = usdg.balanceOf(treasury);
        address op = _opener(w, id);
        vm.prank(op);
        wallets[w].refund(id, cost, keccak256(abi.encode(id, cost)));
        uint256 total = usdg.balanceOf(treasury) - before;
        runs[w][id].refunded = true;
        _recordClose(w, id, total, holdNow - total);
        _bookGiveBack(w, id, holdNow - total);
        done["refund"]++;
    }

    /// What the wallet is meant to do with money a run gives back, in the books:
    /// to an outside payer it is sent, or parked if USDG has blocked them. To one of
    /// the two wallets it is a sub-run giving money back to the run that paid for
    /// it: that run's cost is undone, and the money goes into its hold if it is
    /// open, on to ITS payer if it was refunded or timed out, and otherwise stays.
    function _bookGiveBack(uint256 w, bytes32 id, uint256 back) internal {
        if (back == 0) return;
        Run storage r = runs[w][id];
        gRefunded[w] += back;
        if (r.outside) gExternal[w] -= back;
        else gInsider[w] -= back;
        r.back += back;
        gPayOut[w] += back;
        uint256 a = _walletIndex(r.payer);
        if (a == 2) {
            if (usdg.blocked(r.payer)) {
                gParkedNow[w] += back;
            } else {
                gRefundSent[w] += back;
                gRefundOutside += back;
            }
            return;
        }
        if (usdg.blocked(r.payer)) {
            // The paying wallet cannot be paid just now: owed to its run, to be retried.
            gParkedNow[w] += back;
            if (stuckOwed[w][id] == 0) stuck[w].push(id);
            stuckOwed[w][id] += back;
            return;
        }
        gRefundSent[w] += back;
        _bookReturn(w, id, back);
    }

    /// The paying wallet's side of a return: the sub-payment's cost is undone, and
    /// the money goes into the paying run if it is open, on to its payer if it was
    /// refunded or timed out, and otherwise stays as that run's lower cost.
    function _bookReturn(uint256 w, bytes32 id, uint256 back) internal {
        uint256 a = _walletIndex(runs[w][id].payer);
        bytes32 parent = parentOf[w][id];
        Run storage pr = runs[a][parent];
        gSub[a] -= back;
        pr.spent -= back;
        gPayOut[a] -= back;
        if (openIndex[a][parent] != 0) {
            pr.holdNow += back;
            pr.budgetLeft += back;
            gHeld[a] += back;
            gPayHeld[a] += back;
        } else if (pr.refunded) {
            _bookGiveBack(a, parent, back);
        }
    }

    function _recordClose(uint256 w, bytes32 id, uint256 total, uint256 back) internal {
        Run storage r = runs[w][id];
        _forgetOpen(w, id);
        r.closes++;
        r.spent += total;
        r.budgetLeft = 0;
        gCharged[w] += total;
        if (r.paid) gPayOut[w] += total;
        if (r.closes == 1) closedRuns[w].push(id);
        if (r.closes > 1) {
            closedTwice = true;
            _breach("run charged or refunded twice");
        }
        if (r.spent > r.reserved || (r.paid && r.spent + back > r.value)) {
            spentOverLimit = true;
            _breach("run cost more than its limit or its payment");
        }
    }

    /// A run that was charged or refunded must refuse everything from then on.
    function rechargeProbe(uint256 wSeed, uint256 runSeed, uint256 costSeed) external {
        uint256 w = wSeed % 2;
        uint256 n = closedRuns[w].length;
        if (n == 0 || _stopped()) {
            skipped["rechargeProbe"]++;
            return;
        }
        bytes32 id = closedRuns[w][runSeed % n];
        CreatureWallet wallet = wallets[w];
        uint256 cost = bound(costSeed, 1, 50e6);
        // Make sure a lack of money is never the reason the wallet says no.
        usdg.mint(address(wallet), 60e6);
        gIn[w] += 60e6;

        vm.startPrank(wallet.operator());
        try wallet.charge(id, cost, bytes32(0)) {
            closedTwice = true;
            _breach("second charge went through");
        } catch {}
        try wallet.refund(id, 0, bytes32(0)) {
            closedTwice = true;
            _breach("closed run was refunded");
        } catch {}
        try wallet.open(id, 1) {
            closedTwice = true;
            _breach("closed run was opened again");
        } catch {}
        try wallet.release(id) {
            closedTwice = true;
            _breach("closed run was released");
        } catch {}
        try wallet.payAgent(id, address(wallets[1 - w]), 1, _newId(), 1) {
            closedTwice = true;
            _breach("closed run paid another agent");
        } catch {}
        vm.stopPrank();
        done["rechargeProbe"]++;
    }

    // ---- agents paying agents ----

    /// A paid run on one wallet pays the other wallet out of its budget. It goes
    /// through only if the paying owner has listed the other wallet, and the other
    /// wallet takes it: the meter that opened the paying run is the other wallet's
    /// meter, or the other owner has listed the paying wallet.
    function payAgent(uint256 wSeed, uint256 runSeed, uint256 valueSeed, uint256 subSeed) external {
        uint256 w = wSeed % 2;
        uint256 to = 1 - w;
        (bytes32 id, bool ok) = _pickFit(w, runSeed, true, true);
        if (!ok || _stopped() || wallets[to].paused()) {
            skipped["payAgent"]++;
            return;
        }
        address op = _opener(w, id);
        if (!_subPayAllowed(w, id, op)) {
            skipped["payAgent"]++;
            return;
        }
        uint256 value = bound(valueSeed, 1, runs[w][id].budgetLeft);
        uint256 maxSub = (value * 10_000) / (10_000 + wallets[to].markupBps());
        if (_maxBudget(to) < maxSub) maxSub = _maxBudget(to);
        if (maxSub == 0) {
            skipped["payAgent"]++;
            return;
        }
        _doPayAgent(w, id, op, value, bound(subSeed, 1, maxSub));
        done["payAgent"]++;
    }

    /// Whether the wallets should let this sub-payment through; if not, it is tried
    /// and must be refused.
    function _subPayAllowed(uint256 w, bytes32 id, address op) internal returns (bool) {
        uint256 to = 1 - w;
        bool listed = wallets[w].payableTo(address(wallets[to]));
        bool taken = op == wallets[to].operator();
        if (listed && taken) return true;
        vm.prank(op);
        try wallets[w].payAgent(id, address(wallets[to]), 1, _newId(), 1) {
            if (!listed) paidUnlisted = true;
            else hostilePushed = true;
            _breach("a sub-payment went through that should have been refused");
        } catch {}
        return false;
    }

    function _doPayAgent(uint256 w, bytes32 id, address op, uint256 value, uint256 subBudget) internal {
        uint256 to = 1 - w;
        Run storage r = runs[w][id];
        bytes32 subId = _newId();

        // One unit over the run's remaining budget must be refused.
        vm.prank(op);
        try wallets[w].payAgent(id, address(wallets[to]), r.budgetLeft + 1, subId, 1) {
            spentOverLimit = true;
            _breach("a sub-payment over the budget went through");
        } catch {}

        vm.prank(op);
        wallets[w].payAgent(id, address(wallets[to]), value, subId, subBudget);
        assertEq(usdg.allowance(address(wallets[w]), address(wallets[to])), 0, "an approval was left behind");

        r.budgetLeft -= value;
        r.holdNow -= value;
        r.spent += value;
        gSub[w] += value;
        gHeld[w] -= value;
        gPayHeld[w] -= value;
        gPayOut[w] += value;

        bytes32 key = wallets[to].subRunKey(address(wallets[w]), subId);
        parentOf[to][key] = id;
        // It arrives as a payment but is not new money to the pair of wallets.
        _recordPayment(to, key, address(wallets[w]), value);
        _recordOpen(to, key, subBudget, value);
    }

    /// Loose mode only: the hostile third wallet, whose owner is its own meter and
    /// has listed both wallets, takes a real payment and tries to push a run into
    /// one of them. Neither runs under its meter and neither has listed it, so it
    /// must be refused; the payment is then refunded and leaves the picture.
    function hostilePush(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        if (_stopped()) {
            skipped["hostilePush"]++;
            return;
        }
        bytes32 id = _newId();
        usdg.mint(evilOwner, 3e6);
        vm.startPrank(evilOwner);
        evil.pay(evilOwner, 3e6, 0, block.timestamp + 600, id, 27, bytes32(0), bytes32(0), id, 2e6, false);
        try evil.payAgent(id, address(wallets[w]), bound(seed, 1, 2e6), _newId(), 1) {
            hostilePushed = true;
            _breach("a wallet run by another meter pushed a run in");
        } catch {}
        // Nor can it claim to be run by the victim's meter: the door is for wallets only.
        try wallets[w].payFromAgent(1, id, 1, wallets[w].operator()) {
            hostilePushed = true;
            _breach("a stranger called the receiving door");
        } catch {}
        evil.refund(id, 0, bytes32(0));
        usdg.transfer(address(0xdead), 3e6);
        vm.stopPrank();
        done["hostilePush"]++;
    }

    /// USDG blocks the paying wallet at the moment one of its sub-runs is refunded,
    /// so the money cannot go back. It must stay owed to that run (kept like parked
    /// money, out of everyone's reach) until a retry carries it home.
    function blockedSubRefund(uint256 wSeed, uint256 runSeed, bool retryNow) external {
        uint256 w = wSeed % 2;
        (bytes32 id, bool ok) = _pickFit(w, runSeed, true, false);
        if (!ok || _stopped() || _walletIndex(runs[w][id].payer) == 2) {
            skipped["blockedSubRefund"]++;
            return;
        }
        uint256 holdNow = runs[w][id].holdNow;
        address op = _opener(w, id);
        usdg.setBlocked(runs[w][id].payer, true);
        vm.prank(op);
        wallets[w].refund(id, 0, bytes32(0));
        runs[w][id].refunded = true;
        _recordClose(w, id, 0, holdNow);
        _bookGiveBack(w, id, holdNow); // booked as owed, because the payer is blocked
        // While it is still blocked a retry must fail and change nothing.
        if (holdNow != 0) {
            try wallets[w].retryReturn(id) {
                refundMisdelivered = true;
                _breach("a return went through to a blocked wallet");
            } catch {}
            assertEq(wallets[w].owedBack(id), holdNow, "a stuck return is not recorded against its sub-run");
            assertEq(wallets[w].parked(runs[w][id].payer), 0, "a stuck return was parked as the paying wallet's own money");
        }
        usdg.setBlocked(runs[w][id].payer, false);
        done["blockedSubRefund"]++;
        if (retryNow) _retry(w, id);
    }

    /// Anyone retries a stuck return; it then goes where it would have gone.
    function retryReturn(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        uint256 n = stuck[w].length;
        if (n == 0) {
            skipped["retryReturn"]++;
            return;
        }
        uint256 k = seed % n;
        bytes32 id = stuck[w][k];
        stuck[w][k] = stuck[w][n - 1];
        stuck[w].pop();
        _retry(w, id);
    }

    function _retry(uint256 w, bytes32 id) internal {
        uint256 amount = stuckOwed[w][id];
        if (amount == 0) return;
        stuckOwed[w][id] = 0;
        vm.prank(stranger);
        wallets[w].retryReturn(id);
        gParkedNow[w] -= amount;
        gParkedClaimed[w] += amount;
        _bookReturn(w, id, amount);
        done["retryReturn"]++;
    }

    // ---- release ----

    /// A young hold can be released only by the operator, and the money stays with
    /// the agent. An old one can be released by anyone, pause or no pause, and a
    /// payment that was never billed goes back to its payer.
    function release(uint256 wSeed, uint256 runSeed, bool byStranger) external {
        uint256 w = wSeed % 2;
        (bytes32 id, bool ok) = _pick(w, runSeed);
        if (!ok) {
            skipped["release"]++;
            return;
        }
        CreatureWallet wallet = wallets[w];
        (,, uint64 openedAt,,,) = wallet.holds(id);
        address who = _opener(w, id);
        if (block.timestamp >= uint256(openedAt) + wallet.HOLD_TIMEOUT()) {
            if (byStranger) who = stranger;
            if (runs[w][id].paid) {
                _releaseTimedOutPayment(w, id, who);
                done["releaseTimedOutPayment"]++;
                return;
            }
        } else {
            // A young hold: nobody but the operator, and not even the operator under the guardian's pause.
            vm.prank(stranger);
            try wallet.release(id) {
                strangerReleasedEarly = true;
                _breach("stranger released a young hold");
                _forgetOpen(w, id);
                return;
            } catch {}
            if (_stopped()) {
                vm.prank(who);
                try wallet.release(id) {
                    actedWhilePaused = true;
                    _breach("operator released a young hold while paused");
                    _forgetOpen(w, id);
                    return;
                } catch {}
                skipped["release"]++;
                return;
            }
        }
        uint256 balBefore = _bal(w);
        vm.prank(who);
        wallet.release(id);
        assertEq(_bal(w), balBefore, "a release that is not a timed-out payment moved money");
        _forgetOpen(w, id);
        done["release"]++;
    }

    function _releaseTimedOutPayment(uint256 w, bytes32 id, address who) internal {
        uint256 before = usdg.balanceOf(treasury);
        uint256 holdNow = runs[w][id].holdNow;
        vm.prank(who);
        wallets[w].release(id);
        assertEq(usdg.balanceOf(treasury), before, "a timed-out release paid the treasury");
        runs[w][id].refunded = true;
        _recordClose(w, id, 0, holdNow);
        _bookGiveBack(w, id, holdNow);
    }

    // ---- owner ----

    function withdraw(uint256 wSeed, uint256 amountSeed) external {
        uint256 w = wSeed % 2;
        CreatureWallet wallet = wallets[w];
        uint256 limit = wallet.withdrawable();

        // One more than the limit must always be refused.
        vm.prank(owners[w]);
        try wallet.withdraw(address(usdg), owners[w], limit + 1) {
            withdrewOverLimit = true;
            _breach("withdrew more than withdrawable()");
            gWithdrawn[w] += limit + 1;
            return;
        } catch {}

        if (limit == 0) {
            skipped["withdraw"]++;
            return;
        }
        uint256 amount = bound(amountSeed, 1, limit);
        vm.prank(owners[w]);
        wallet.withdraw(address(usdg), owners[w], amount);
        gWithdrawn[w] += amount;
        if (_bal(w) < wallet.heldTotal() + wallet.parkedTotal() + wallet.lienUnpaid()) {
            withdrewOwedMoney = true;
            _breach("withdrawal left less than holds + parked + lien owed");
        }
        done["withdraw"]++;
    }

    function setLien(uint256 wSeed, uint256 payeeSeed, uint16 bpsSeed, uint128 capSeed) external {
        uint256 w = wSeed % 2;
        if (_lienPayee(w) != address(0)) {
            skipped["setLien"]++;
            return;
        }
        if (gPlain[w] != 0) {
            // A hold from the balance is open: the lien has to wait.
            vm.prank(owners[w]);
            try wallets[w].setLien(payees[payeeSeed % 3], 5_000, 0) {
                lienOverPlainHolds = true;
                _breach("a lien was set while a hold from the balance was open");
            } catch {}
            skipped["setLien"]++;
            return;
        }
        uint16 bps = uint16(bound(bpsSeed, 1, 10_000));
        // No cap a quarter of the time; otherwise a cap, half of them small enough to be reached.
        uint128 cap = capSeed % 4 == 0 ? 0 : uint128(bound(capSeed, 1, capSeed % 4 == 1 ? 100e6 : 3e6));
        vm.prank(owners[w]);
        wallets[w].setLien(payees[payeeSeed % 3], bps, cap);
        lienCapNow[w] = cap;
        lienPaidNow[w] = 0;
        liensSet++;
        done["setLien"]++;
    }

    function setPaused(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        vm.prank(owners[w]);
        wallets[w].setPaused(seed % 8 == 0);
        done["setPaused"]++;
    }

    function setLimits(uint256 wSeed, uint128 runSeed, uint128 daySeed) external {
        uint256 w = wSeed % 2;
        vm.prank(owners[w]);
        wallets[w].setLimits(uint128(bound(runSeed, 1e6, 100e6)), uint128(bound(daySeed, 10e6, 1_000e6)));
        done["setLimits"]++;
    }

    /// The owner names the wallet's own operator, or goes back to the factory's.
    /// Under a lien the payee agrees first. Afterwards the operator that was
    /// replaced must be refused.
    function setOperator(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        CreatureWallet wallet = wallets[w];
        address next = seed % 3 == 0 ? address(0) : ownOps[seed % 2];
        address payee = _lienPayee(w);
        if (payee != address(0)) {
            vm.prank(owners[w]);
            try wallet.setOperator(next) {
                wrongOperatorActed = true;
                _breach("operator changed under a lien without the payee's consent");
            } catch {}
            vm.prank(payee);
            wallet.consentToOperator(next);
        }
        vm.prank(owners[w]);
        wallet.setOperator(next);

        address now_ = wallet.operator();
        address[3] memory others = [factoryOperator, ownOps[0], ownOps[1]];
        for (uint256 i = 0; i < 3; i++) {
            if (others[i] == now_) continue;
            vm.prank(others[i]);
            try wallet.settle(0) {
                wrongOperatorActed = true;
                _breach("an operator that is not this wallet's acted on it");
            } catch {}
        }
        done["setOperator"]++;
    }

    /// Loose mode only: the owner takes the other wallet off its list of wallets a
    /// run may pay, or puts it back. Under a lien, putting it back must be refused
    /// until the payee agrees; taking it off never needs anyone.
    function togglePayable(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        CreatureWallet wallet = wallets[w];
        address other = address(wallets[1 - w]);
        bool allow = seed % 3 != 0;
        address payee = _lienPayee(w);
        if (allow && !wallet.payableTo(other) && payee != address(0)) {
            vm.prank(owners[w]);
            try wallet.setPayable(other, true) {
                paidUnlisted = true;
                _breach("a wallet was listed under a lien without the payee's consent");
            } catch {}
            vm.prank(payee);
            wallet.consentToPayable(other);
        }
        vm.prank(owners[w]);
        wallet.setPayable(other, allow);
        done["togglePayable"]++;
    }

    /// The guardian stops every meter one time in ten and restarts them otherwise.
    /// While stopped, each operator action is tried on each wallet and must be refused.
    function guardianPause(uint256 seed) external {
        bool on = seed % 10 == 0;
        vm.prank(guardian);
        factory.setOperatorPaused(on);
        if (on) {
            for (uint256 w = 0; w < 2; w++) {
                CreatureWallet wallet = wallets[w];
                bytes32 id = openRuns[w].length != 0 ? openRuns[w][seed % openRuns[w].length] : bytes32("none");
                vm.startPrank(wallet.operator());
                try wallet.settle(0) {
                    actedWhilePaused = true;
                } catch {}
                try wallet.open(_newId(), 1) {
                    actedWhilePaused = true;
                } catch {}
                vm.stopPrank();
                address opener = _opener(w, id);
                vm.startPrank(opener == address(0) ? wallet.operator() : opener);
                try wallet.charge(id, 1, bytes32(0)) {
                    actedWhilePaused = true;
                } catch {}
                try wallet.chargeAndSettle(id, 1, 0, bytes32(0)) {
                    actedWhilePaused = true;
                } catch {}
                try wallet.refund(id, 0, bytes32(0)) {
                    actedWhilePaused = true;
                } catch {}
                try wallet.payAgent(id, address(wallets[1 - w]), 1, _newId(), 1) {
                    actedWhilePaused = true;
                } catch {}
                vm.stopPrank();
            }
            if (actedWhilePaused) _breach("an operator action went through under the guardian's pause");
        }
        done["guardianPause"]++;
    }

    /// Loose mode only: the wallet changes hands, to any address in the pool.
    function transferOwnership(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        address to = ownerPool[seed % 4];
        if (to == owners[w]) {
            skipped["transferOwnership"]++;
            return;
        }
        vm.prank(owners[w]);
        wallets[w].transferOwnership(to);
        vm.prank(to);
        wallets[w].acceptOwnership();
        // The owner that was has no say any more.
        vm.prank(owners[w]);
        try wallets[w].setPaused(true) {
            withdrewOverLimit = true;
            _breach("a past owner still acted as owner");
        } catch {}
        owners[w] = to;
        everOwner[w][to] = true;
        done["transferOwnership"]++;
    }

    /// Loose mode only: the lien payee points the lien at another address.
    function setLienPayee(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        address payee = _lienPayee(w);
        if (payee == address(0)) {
            skipped["setLienPayee"]++;
            return;
        }
        vm.prank(payee);
        wallets[w].setLienPayee(payees[seed % 3]);
        done["setLienPayee"]++;
    }

    // ---- lien ----

    function settleLien(uint256 wSeed) external {
        uint256 w = wSeed % 2;
        address payee = _lienPayee(w);
        if (payee == address(0)) {
            skipped["settleLien"]++;
            return;
        }
        uint256 before = usdg.balanceOf(payee);
        vm.prank(stranger);
        uint256 amount = wallets[w].settleLien();
        assertEq(usdg.balanceOf(payee) - before, amount, "settleLien returned a different amount than it sent");
        _recordLienPaid(w, amount);
        done["settleLien"]++;
    }

    function _recordLienPaid(uint256 w, uint256 amount) internal {
        gLienPaid[w] += amount;
        lienPaidNow[w] += amount;
        if (amount != 0 && lienCapNow[w] != 0 && lienPaidNow[w] == lienCapNow[w]) capsReached++;
        if (lienCapNow[w] != 0 && lienPaidNow[w] > lienCapNow[w]) {
            lienPaidOverCap = true;
            _breach("lien paid over its cap");
        }
    }

    function endLienByPayee(uint256 wSeed) external {
        uint256 w = wSeed % 2;
        address payee = _lienPayee(w);
        if (payee == address(0)) {
            skipped["endLienPayee"]++;
            return;
        }
        vm.prank(payee);
        wallets[w].endLien();
        lienCapNow[w] = 0;
        lienPaidNow[w] = 0;
        done["endLienPayee"]++;
    }

    /// The owner may end a lien only once it has paid its cap; otherwise the wallet says no.
    function endLienByOwner(uint256 wSeed) external {
        uint256 w = wSeed % 2;
        address payee = _lienPayee(w);
        if (payee == address(0)) {
            skipped["endLienOwner"]++;
            return;
        }
        (,, uint128 cap, uint128 paidBefore,) = wallets[w].lien();
        uint256 owed = wallets[w].lienUnpaid();
        uint256 before = usdg.balanceOf(payee);
        vm.prank(owners[w]);
        try wallets[w].endLien() {
            assertTrue(cap != 0 && uint256(paidBefore) + owed >= cap, "owner ended a lien that had not paid its cap");
            _recordLienPaid(w, usdg.balanceOf(payee) - before);
            lienCapNow[w] = 0;
            lienPaidNow[w] = 0;
            done["endLienOwner"]++;
        } catch {
            skipped["endLienOwner"]++;
        }
    }

    // ---- checkpoint and time ----

    /// Ask for a checkpoint without a charge. strict: at profit less what is held.
    function settle(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        if (_stopped()) {
            skipped["settle"]++;
            return;
        }
        uint256 p = wallets[w].profit();
        uint256 held = wallets[w].heldTotal();
        uint256 upTo = p > held ? p - held : 0;
        if (!strict && seed % 2 == 1) upTo = bound(seed, 0, p * 2 + 1);
        address op = wallets[w].operator();
        vm.prank(op);
        wallets[w].settle(upTo);
        done["settle"]++;
    }

    function requestCheckpoint(uint256 wSeed) external {
        uint256 w = wSeed % 2;
        if (wallets[w].pendingAt() != 0) {
            skipped["requestCheckpoint"]++;
            return;
        }
        vm.prank(stranger);
        wallets[w].requestCheckpoint();
        done["requestCheckpoint"]++;
    }

    function takeCheckpoint(uint256 wSeed) external {
        uint256 w = wSeed % 2;
        uint256 at = wallets[w].pendingAt();
        if (at == 0 || block.timestamp < at + wallets[w].CHECKPOINT_DELAY()) {
            skipped["takeCheckpoint"]++;
            return;
        }
        vm.prank(stranger);
        wallets[w].takeCheckpoint();
        done["takeCheckpoint"]++;
    }

    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 10 minutes, 36 hours));
        done["warp"]++;
    }

    // ---- a payer USDG will not pay ----

    function toggleBlock(uint256 seed) external {
        usdg.setBlocked(customers[2], seed % 3 == 0);
        done["toggleBlock"]++;
    }

    function claimParked(uint256 wSeed) external {
        uint256 w = wSeed % 2;
        address who = customers[2];
        uint256 amount = wallets[w].parked(who);
        if (amount == 0 || usdg.blocked(who)) {
            skipped["claimParked"]++;
            return;
        }
        vm.prank(who);
        wallets[w].claimParked(who);
        gParkedNow[w] -= amount;
        gParkedClaimed[w] += amount;
        gRefundOutside += amount;
        done["claimParked"]++;
    }

    /// Anyone points the top-payer record at any payer; it must never end up wrong.
    function notePayer(uint256 wSeed, uint256 seed) external {
        uint256 w = wSeed % 2;
        address who = seed % 4 < 3 ? customers[seed % 4] : owners[1 - w];
        vm.prank(stranger);
        wallets[w].notePayer(who);
        done["notePayer"]++;
    }
}

/// The properties, checked after every handler call, on both wallets.
abstract contract WalletInvariantsV3 is Test {
    MockUSDGV3 usdg;
    WeightlingsFactory factory;
    CreatureWallet[2] wallets;
    WalletHandlerV3 handler;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");
    CreatureWallet evil;

    function _deploy(bool strict) internal {
        vm.warp(1_800_000_000);
        usdg = new MockUSDGV3();
        factory = new WeightlingsFactory(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        (, address w0) = factory.createAgent(alice, 100e6, 1_000e6, keccak256("spec"), "", treasury, 2_000);
        (, address w1) = factory.createAgent(bob, 100e6, 1_000e6, keccak256("spec"), "", treasury, 2_000);
        wallets[0] = CreatureWallet(w0);
        wallets[1] = CreatureWallet(w1);
        // Each owner lets its wallet's runs pay the other wallet.
        vm.prank(alice);
        wallets[0].setPayable(w1, true);
        vm.prank(bob);
        wallets[1].setPayable(w0, true);
        // A third wallet nobody trusts: its owner is its own meter and lists both others.
        (, address e) =
            factory.createAgent(mallory, type(uint128).max, type(uint128).max, keccak256("spec"), "", treasury, 2_000);
        evil = CreatureWallet(e);
        vm.startPrank(mallory);
        evil.setOperator(mallory);
        evil.setPayable(w0, true);
        evil.setPayable(w1, true);
        vm.stopPrank();
        handler = new WalletHandlerV3(wallets[0], wallets[1], evil, usdg, factory, guardian, strict);
        targetContract(address(handler));
    }

    function _bal(uint256 w) internal view returns (uint256) {
        return usdg.balanceOf(address(wallets[w]));
    }

    // 1. Money set aside for open runs is always in the wallet.
    function _holdsAreBacked() internal view {
        for (uint256 w = 0; w < 2; w++) {
            assertGe(_bal(w), wallets[w].heldTotal(), "balance < heldTotal");
            assertEq(wallets[w].heldTotal(), handler.gHeld(w), "heldTotal != sum of open holds");
            assertEq(wallets[w].plainHolds(), handler.gPlain(w), "plainHolds != open holds from the balance");
        }
    }

    // 2. ... and so is what the lien payee is still owed, and anything parked. In
    // version 3 this holds whatever the meter does.
    function _holdsAndLienAreBacked() internal view {
        for (uint256 w = 0; w < 2; w++) {
            assertGe(
                _bal(w),
                wallets[w].heldTotal() + wallets[w].parkedTotal() + wallets[w].lienUnpaid(),
                "balance < heldTotal + parkedTotal + lienUnpaid"
            );
            assertLe(wallets[w].settledProfit(), wallets[w].profit(), "checkpoint above profit");
        }
    }

    // 2 (owner's side). No withdrawal ever left the wallet short, and none above
    // withdrawable() ever went through.
    function _ownerNeverTookOwedMoney() internal view {
        assertFalse(handler.withdrewOwedMoney(), "a withdrawal left less than holds + lien owed");
        assertFalse(handler.withdrewOverLimit(), "a withdrawal above withdrawable() went through");
    }

    // 3. The owner's limit never reaches into held or parked money.
    function _withdrawableIsFree() internal view {
        for (uint256 w = 0; w < 2; w++) {
            uint256 bal = _bal(w);
            uint256 kept = wallets[w].heldTotal() + wallets[w].parkedTotal() + wallets[w].lienUnpaid();
            assertLe(wallets[w].withdrawable(), bal > kept ? bal - kept : 0, "withdrawable reaches kept money");
        }
    }

    // 4. A run is charged or refunded once, never both, within its limit; and the
    // switches hold: no operator action under the guardian's pause, none by an
    // operator that is not the wallet's, no underpaid run.
    function _runsClosedOnce() internal view {
        assertFalse(handler.closedTwice(), handler.lastBreach());
        assertFalse(handler.spentOverLimit(), handler.lastBreach());
        assertFalse(handler.strangerReleasedEarly(), "a stranger released a young hold");
        assertFalse(handler.actedWhilePaused(), handler.lastBreach());
        assertFalse(handler.wrongOperatorActed(), handler.lastBreach());
        assertFalse(handler.underpaidAccepted(), "an underpaid run was let in");
        assertFalse(handler.refundMisdelivered(), "a refund went astray");
        assertFalse(handler.paidUnlisted(), handler.lastBreach());
        assertFalse(handler.frontRan(), handler.lastBreach());
        assertFalse(handler.openerBypassed(), handler.lastBreach());
        assertFalse(handler.hostilePushed(), handler.lastBreach());
        assertFalse(handler.lienOverPlainHolds(), handler.lastBreach());
        for (uint256 w = 0; w < 2; w++) {
            uint256 n = handler.closedRunCount(w);
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = handler.closedRunAt(w, i);
                WalletHandlerV3.Run memory r = handler.runOf(w, id);
                assertEq(r.closes, 1, "run closed more than once");
                assertLe(r.spent, r.reserved, "run cost more than was reserved for it");
                assertTrue(wallets[w].runCharged(id), "closed run not marked");
                (,, uint64 openedAt,,,) = wallets[w].holds(id);
                assertEq(openedAt, 0, "closed run still has a hold");
            }
        }
    }

    // 5. The books.
    function _booksAgree() internal view {
        uint256 charged;
        for (uint256 w = 0; w < 2; w++) {
            CreatureWallet wallet = wallets[w];
            uint256 out = handler.gCharged(w) + handler.gSub(w) + handler.gWithdrawn(w) + handler.gLienPaid(w)
                + handler.gRefundSent(w) + handler.gParkedClaimed(w);
            assertEq(wallet.income(), handler.gIn(w) - handler.gRefunded(w), "income != paid in less refunds");
            assertEq(wallet.totalCharged(), handler.gCharged(w) + handler.gSub(w), "totalCharged != charges + sub-payments");
            assertEq(wallet.profit(), wallet.income() - wallet.totalCharged(), "profit != income - totalCharged");
            assertEq(_bal(w), handler.gIn(w) - out, "balance != in - out");
            assertEq(wallet.totalOut(), out, "totalOut != everything sent");
            assertEq(wallet.totalRefunded(), handler.gRefunded(w), "totalRefunded != refunds");
            assertEq(wallet.parkedTotal(), handler.gParkedNow(w), "parkedTotal != refunds parked");
            assertEq(
                handler.gRefunded(w),
                handler.gRefundSent(w) + handler.gParkedNow(w) + handler.gParkedClaimed(w),
                "refunds != sent + parked + claimed"
            );
            charged += handler.gCharged(w);
        }
        assertEq(usdg.balanceOf(treasury), charged, "treasury did not receive exactly the charges");
    }

    // 6. A lien never pays more than its cap.
    function _lienWithinCap() internal view {
        assertFalse(handler.lienPaidOverCap(), "a lien paid over its cap");
        for (uint256 w = 0; w < 2; w++) {
            (address payee,, uint128 cap, uint128 paid,) = wallets[w].lien();
            if (payee != address(0)) {
                assertEq(paid, handler.lienPaidNow(w), "lien.paid != what the payee received");
                if (cap != 0) assertLe(paid, cap, "lien.paid > cap");
            }
        }
    }

    // 7. For runs that came with a payment: refunds + charges (sub-payments
    // included) + what is still held never exceed what was paid in, in total and
    // run by run.
    function _paidRunsNeverCostMoreThanTheyBrought() internal view {
        for (uint256 w = 0; w < 2; w++) {
            assertLe(handler.gPayOut(w) + handler.gPayHeld(w), handler.gPayIn(w), "paid runs gave out more than came in");
            uint256 n = handler.paidRunCount(w);
            uint256 heldSum;
            for (uint256 i = 0; i < n; i++) {
                bytes32 id = handler.paidRunAt(w, i);
                WalletHandlerV3.Run memory r = handler.runOf(w, id);
                (,,, uint96 held,,) = wallets[w].holds(id);
                assertEq(held, r.holdNow, "a paid run's hold is not what the books say");
                assertLe(r.spent + r.back + held, r.value, "a paid run gave out more than its payment");
                heldSum += held;
            }
            assertEq(heldSum, handler.gPayHeld(w), "paid holds != sum");
        }
    }

    // 8. Income counted from payers never exceeds income, and matches the books.
    function _payerIncomeWithinIncome() internal view {
        for (uint256 w = 0; w < 2; w++) {
            CreatureWallet wallet = wallets[w];
            assertLe(wallet.externalIncome() + wallet.insiderIncome(), wallet.income(), "payer income > income");
            assertEq(wallet.externalIncome(), handler.gExternal(w), "externalIncome != outside payments less refunds");
            assertEq(wallet.insiderIncome(), handler.gInsider(w), "insiderIncome != insider payments less refunds");
            assertEq(wallet.topPayerPaid(), wallet.paidBy(wallet.topPayer()), "topPayerPaid != paidBy(topPayer)");
            // Everyone who can be an outside payer in this test: the customers, every
            // address in the owner pool, and the other wallet.
            uint256 sum = wallet.paidBy(address(wallets[1 - w]));
            uint256 count = sum != 0 ? 1 : 0;
            for (uint256 i = 0; i < 7; i++) {
                uint256 paid = wallet.paidBy(i < 3 ? handler.customers(i) : handler.ownerPool(i - 3));
                sum += paid;
                if (paid != 0) count++;
            }
            assertEq(sum, wallet.externalIncome(), "sum of paidBy != externalIncome");
            assertEq(count, wallet.payerCount(), "payerCount != payers with a balance");
        }
    }

    // 9. Across both wallets no USDG appears or disappears: everything minted is in
    // a wallet, in the treasury, with a lien payee, withdrawn by an owner, or
    // refunded to a payer. (The handler burns what it mints for payments it
    // expects to be refused; that sits at 0xdead.)
    function _usdgIsConserved() internal view {
        uint256 payees;
        for (uint256 i = 0; i < 3; i++) {
            payees += usdg.balanceOf(handler.payees(i));
        }
        uint256 lienPaid = handler.gLienPaid(0) + handler.gLienPaid(1);
        uint256 withdrawn = handler.gWithdrawn(0) + handler.gWithdrawn(1);
        assertEq(payees, lienPaid, "payees hold something other than lien payments");
        assertEq(
            usdg.minted() - usdg.balanceOf(address(0xdead)),
            _bal(0) + _bal(1) + usdg.balanceOf(treasury) + payees + withdrawn + handler.gRefundOutside(),
            "minted != wallets + treasury + payees + withdrawn + refunded"
        );
        // The same from the token's side: the payers hold exactly their refunds.
        uint256 payers;
        for (uint256 i = 0; i < 7; i++) {
            payers += usdg.balanceOf(i < 3 ? handler.customers(i) : handler.ownerPool(i - 3));
        }
        assertEq(usdg.balanceOf(address(evil)) + usdg.balanceOf(mallory), 0, "the hostile wallet came away with something");
        assertEq(payers, withdrawn + handler.gRefundOutside(), "payers and owners hold something else");
    }

    /// Set INV_SUMMARY=true to print, under the last run's logs (-vv), running totals
    /// over every run so far: calls of each kind that went through, and calls skipped
    /// because there was nothing to act on. Totals are carried between runs in
    /// process environment variables; without INV_SUMMARY this does nothing.
    function afterInvariant() public {
        if (!vm.envOr("INV_SUMMARY", false)) return;
        string memory mode = handler.strict() ? "strict " : "loose ";
        uint256 n = handler.actionCount();
        for (uint256 i = 0; i < n; i++) {
            string memory a = handler.actions(i);
            console.log(
                string.concat("SUMMARY3 ", mode, a), _tally(a, "_done", handler.done(a)), _tally(a, "_skip", handler.skipped(a))
            );
        }
        console.log(string.concat("SUMMARY3 ", mode, "liensSet"), _tally("liensSet", "", handler.liensSet()));
        console.log(
            string.concat("SUMMARY3 ", mode, "lienPaidUSDG"),
            _tally("lienPaid", "", handler.gLienPaid(0) + handler.gLienPaid(1))
        );
        console.log(string.concat("SUMMARY3 ", mode, "capsReached"), _tally("capsReached", "", handler.capsReached()));
    }

    function _tally(string memory name, string memory kind, uint256 add) private returns (uint256 total) {
        string memory key = string.concat("INV3_TALLY_", handler.strict() ? "S_" : "L_", name, kind);
        total = vm.envOr(key, uint256(0)) + add;
        vm.setEnv(key, vm.toString(total));
    }

    function invariant_1_balance_covers_holds() public view {
        _holdsAreBacked();
    }

    function invariant_2_balance_covers_holds_and_lien_owed() public view {
        _holdsAndLienAreBacked();
        _ownerNeverTookOwedMoney();
    }

    function invariant_3_withdrawable_never_reaches_held_money() public view {
        _withdrawableIsFree();
    }

    function invariant_4_a_run_is_charged_or_refunded_once_and_within_its_limit() public view {
        _runsClosedOnce();
    }

    function invariant_5_books_agree() public view {
        _booksAgree();
    }

    function invariant_6_lien_never_pays_over_its_cap() public view {
        _lienWithinCap();
    }

    function invariant_7_paid_runs_never_give_out_more_than_was_paid_in() public view {
        _paidRunsNeverCostMoreThanTheyBrought();
    }

    function invariant_8_payer_income_never_exceeds_income() public view {
        _payerIncomeWithinIncome();
    }

    function invariant_9_usdg_is_conserved_across_both_wallets() public view {
        _usdgIsConserved();
    }
}

/// The meter behaves as documented: every hold is covered by money that arrives
/// with it and the checkpoint is only asked to move to profit less held money.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 150
/// forge-config: default.invariant.fail-on-revert = true
contract InvariantV3Test is WalletInvariantsV3 {
    function setUp() public {
        _deploy(true);
        bytes4[] memory s = new bytes4[](18);
        s[0] = WalletHandlerV3.payAndOpen.selector;
        s[1] = WalletHandlerV3.fundAndOpen.selector;
        s[2] = WalletHandlerV3.charge.selector;
        s[3] = WalletHandlerV3.chargeAndSettle.selector;
        s[4] = WalletHandlerV3.refund.selector;
        s[5] = WalletHandlerV3.payAgent.selector;
        s[6] = WalletHandlerV3.rechargeProbe.selector;
        s[7] = WalletHandlerV3.release.selector;
        s[8] = WalletHandlerV3.withdraw.selector;
        s[9] = WalletHandlerV3.setLien.selector;
        s[10] = WalletHandlerV3.settleLien.selector;
        s[11] = WalletHandlerV3.endLienByPayee.selector;
        s[12] = WalletHandlerV3.endLienByOwner.selector;
        s[13] = WalletHandlerV3.warp.selector;
        s[14] = WalletHandlerV3.settle.selector;
        s[15] = WalletHandlerV3.setLimits.selector;
        s[16] = WalletHandlerV3.toggleBlock.selector;
        s[17] = WalletHandlerV3.claimParked.selector;
        targetSelector(FuzzSelector(address(handler), s));
    }
}

/// The meter, the owners, the guardian and strangers do anything the contract
/// allows: holds opened against money already in the wallet, any checkpoint figure
/// asked for, checkpoints requested and taken by anyone, wallets paused, operators
/// swapped, every meter stopped. All nine properties are enforced here, property 2
/// included, with no switch to turn it off.
/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 150
/// forge-config: default.invariant.fail-on-revert = true
contract InvariantV3LooseTest is WalletInvariantsV3 {
    function setUp() public {
        _deploy(false);
    }
}

/// The four gaps the loose run found in version 2 (InvariantV2FindingsTest), as the
/// same fixed sequences against version 3. Each now asserts the safe behaviour.
contract InvariantV3FindingsTest is Test {
    MockUSDGV3 usdg;
    WeightlingsFactory factory;
    CreatureWallet wallet;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address lender = makeAddr("lender");
    address customer = makeAddr("customer");

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDGV3();
        factory = new WeightlingsFactory(address(usdg), admin, operator, treasury, 2_000, address(0), guardian);
        (, address w) = factory.createAgent(alice, 100e6, 1_000e6, keccak256("spec"), "", treasury, 2_000);
        wallet = CreatureWallet(w);
        usdg.mint(customer, 100e6);
    }

    function _bal() internal view returns (uint256) {
        return usdg.balanceOf(address(wallet));
    }

    function _property2() internal view {
        assertGe(_bal(), wallet.heldTotal() + wallet.parkedTotal() + wallet.lienUnpaid(), "property 2");
    }

    /// V2: a hold could be opened on the payee's unpaid share and billed, leaving
    /// the payee owed money the wallet no longer had. V3: the hold is refused and
    /// the payee collects its share in full.
    function test_fixed_a_hold_cannot_be_opened_on_money_owed_to_the_lien() public {
        vm.prank(alice);
        wallet.setLien(lender, 5_000, 0);

        usdg.mint(address(wallet), 1e6);
        vm.prank(operator);
        wallet.settle(1e6);
        assertEq(wallet.lienUnpaid(), 500_000);

        vm.prank(alice);
        wallet.withdraw(address(usdg), alice, 500_000);
        assertEq(wallet.withdrawable(), 0);
        assertEq(_bal(), 500_000, "all that is left is the lender's half");

        vm.prank(operator);
        vm.expectRevert(CreatureWallet.TransferFailed.selector);
        wallet.open("r1", 400_000);
        _property2();

        assertEq(wallet.settleLien(), 500_000);
        assertEq(usdg.balanceOf(lender), 500_000, "the lender has all of its $0.50");
        assertEq(usdg.balanceOf(alice), 500_000);
    }

    /// V2: the meter could move the checkpoint over money still held for an
    /// unbilled run. V3: the wallet stops the checkpoint at profit less held.
    function test_fixed_the_meter_cannot_settle_over_money_still_held() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);

        vm.prank(operator);
        wallet.pay(customer, 600_000, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 500_000, false);
        assertEq(wallet.heldTotal(), 600_000);

        vm.prank(operator);
        wallet.settle(600_000);
        assertEq(wallet.settledProfit(), 0);
        assertEq(wallet.lienUnpaid(), 0);
        _property2();

        assertEq(wallet.settleLien(), 0);
        vm.prank(operator);
        wallet.charge("r1", 500_000, bytes32(0));
        assertEq(wallet.lienUnpaid(), 0);
        _property2();
    }

    /// V2: the same early checkpoint paid the lender out of the owner's own money
    /// a share of profit the run's bill then wiped out. V3: nothing is paid early.
    function test_fixed_an_early_checkpoint_does_not_pay_the_lien_from_the_owners_money() public {
        usdg.mint(address(wallet), 1e6);
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        assertEq(wallet.withdrawable(), 1e6);

        vm.prank(operator);
        wallet.pay(customer, 600_000, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 500_000, false);
        vm.prank(operator);
        wallet.settle(1_600_000);

        assertEq(wallet.settleLien(), 0, "the lender collects nothing");
        _property2();

        vm.prank(operator);
        wallet.charge("r1", 500_000, bytes32(0));
        (,,,, uint256 baseProfit) = wallet.lien();
        assertEq(wallet.profit(), baseProfit, "the lien has earned nothing");
        assertEq(usdg.balanceOf(lender), 0, "and the lender holds nothing");
        assertEq(wallet.withdrawable(), 1e6, "the owner's $1.00 is still $1.00");
    }

    /// V2: a checkpoint anyone could take a day later counted an open hold's money
    /// as final profit. V3: held money is left out when the checkpoint is taken.
    function test_fixed_a_taken_checkpoint_does_not_count_held_money() public {
        vm.prank(alice);
        wallet.setLien(lender, 10_000, 0);
        vm.prank(operator);
        wallet.pay(customer, 600_000, 0, block.timestamp + 600, "n1", 27, bytes32(0), bytes32(0), "r1", 500_000, false);

        wallet.requestCheckpoint();
        vm.warp(block.timestamp + 1 days);
        wallet.takeCheckpoint();

        assertEq(wallet.heldTotal(), 600_000, "the hold is still open");
        assertEq(wallet.lienUnpaid(), 0);
        _property2();
        assertEq(wallet.settleLien(), 0);
    }
}
