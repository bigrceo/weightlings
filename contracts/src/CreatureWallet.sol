// SPDX-License-Identifier: MIT
// Ported for Weightlings from Zero Lux (MIT, (c) 2026 Zero Lux); see THIRD_PARTY.md. Logic unchanged.
pragma solidity ^0.8.26;

interface IWeightlingsFactoryView {
    function identityRegistry() external view returns (address);
    function operator() external view returns (address);
    function treasury() external view returns (address);
    function markupBps() external view returns (uint16);
    function usdg() external view returns (address);
    function operatorPaused() external view returns (bool);
    function isAgentWallet(address wallet) external view returns (bool);
}

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}

interface ICreatureWallet {
    function owner() external view returns (address);
    function payFromAgent(uint256 value, bytes32 runId, uint256 budget, address opener) external;
    function returnFromAgent(bytes32 subRunKey_, uint256 amount) external;
    function claimParked(address to) external;
}

/// @title CreatureWallet
/// @notice Holds one agent's USDG. Customers pay it directly. A meter (the
///         factory's operator, or one the owner names for this wallet) may bill
///         it for runs, but only to this wallet's treasury, only out of money
///         set aside for that run beforehand, and only inside the limits the
///         owner had set when the run was let in. The owner can take free money
///         out at any time. Treasury and markup are fixed when the wallet is
///         made; later factory changes reach it only if its owner adopts them.
///
///         Profit is a fact anyone can read: `income()` less `totalCharged`.
///         The owner can pledge a share of it to someone else with `setLien`;
///         the pledged share is held back from the owner and anyone may send
///         it to the payee. The lien pays only on *settled* profit, a
///         checkpoint that moves forward as runs are billed.
///
///         What version 3 changes:
///         - A payment taken through `pay` is held WHOLE, with a record of who
///           paid and how much, until the run is charged, refunded or released.
///           `refund` bills the run and sends the rest back to the payer.
///         - The wallet counts income from outside customers apart from income
///           from insiders (its owners past and present, its lien payee, other
///           wallets of the same owner).
///         - Money owed to the lien can no longer be set aside for a run, and
///           the checkpoint is bounded by the contract, not by the meter: it
///           never moves above profit less money still held, and the meter can
///           no longer move it down.
///         - Every charge carries a receipt fingerprint in its event.
///         - The owner may replace the meter for this wallet; the factory's
///           guardian can stop every meter at once. A run stays with the
///           meter that let it in: only the address that opened a hold may
///           charge it, refund it, pay another agent from it or release it
///           early, whoever the wallet's meter is by then.
///         - A run may pay another agent's wallet out of its own budget, if
///           the owner has listed that wallet and the same meter runs both
///           wallets at that moment; that meter then bills the sub-run too.
///           Money a sub-run gives back returns to the run that paid it.
/// @dev    Deployed as a minimal clone by WeightlingsFactory. Threat model: the
///         operator key and everything off chain are untrusted, and so is the
///         owner towards the lien payee and the customer.
///         A stolen operator key can set aside at most `perDayCap` per day (the
///         cap is a UTC calendar day, so two caps across midnight). What it
///         sets aside can go to the treasury, back to the run's own payer, or,
///         NEW IN V3, to another agent wallet of this factory through
///         `payAgent`, but only one the owner has put on this wallet's
///         `payableTo` list (and, under a lien, only with the payee's
///         agreement). So the operator still cannot pick where money goes.
///         `payAgent` is further limited to runs paid through `pay`, to that
///         run's budget, and so to money that arrived with that run's own
///         payment.
///         The limits and the wallet's pause switch apply when a hold is
///         opened, not when it is charged. Anyone can release a hold once it is
///         a day old. A payment that was never billed then goes back to its
///         payer, so the meter must bill every run within a day or the work
///         was free; a hold opened from the balance just becomes free again.
///         `pay` takes the customer's signed payment in one of two EIP-3009
///         forms. With `receiveOnly` the customer signed a
///         ReceiveWithAuthorization, which USDG accepts only from this wallet,
///         so nobody else can submit it and it always arrives with its hold
///         and its payer record. Without it the customer signed a
///         TransferWithAuthorization (what third-party x402 clients sign).
///         That form can be submitted to USDG directly by ANYONE who sees the
///         signature before `pay` lands, the wallet's owner included: the
///         money then arrives with no hold and no record, counts as income
///         but never as outside income, cannot be refunded by this contract,
///         and the owner can withdraw it while `pay` fails. Nothing here can
///         stop that; a customer who wants the hold and the refund must sign
///         the receive form.
///         A lien is only as good as the money that reaches this wallet and
///         the meter that bills it: a hostile meter cannot take settled money,
///         but it can hold the checkpoint back, and its charges, sub-payments
///         and refunds lower the profit a lien is paid from. A payee should
///         not accept a lien on a wallet whose owner controls its meter.
///         A meter can also stand in the owner's way: `setLien` waits while a
///         hold opened with `open` is open, and a meter can keep one open (one
///         unit is enough), opening the next before the last is released. The
///         owner's way out is to pause the wallet, which stops new holds, wait
///         for the last hold to be a day old, release it and set the lien.
///         In the same way a meter that keeps unsettled income inside holds
///         keeps it out of the checkpoint, the public one included, for as
///         long as it can hold it (the day limit bounds how much).
///         Because a hold stays with the address that opened it, replacing a
///         leaked meter key does not take away its power over holds it opened;
///         the guardian's pause does, until those holds time out.
///         The outside-income figures are bookkeeping, not proof: an owner can
///         pay the wallet from a fresh address and be counted as a customer.
contract CreatureWallet {
    address public factory;
    address public owner;
    address public pendingOwner;

    uint128 public perRunCap; // most a single run may cost, fee included
    uint128 public perDayCap; // most all runs may cost in one UTC day, fee included
    bool public paused; // owner switch: no new runs are let in while true; runs already open can still be billed

    address public treasury; // where run charges go; fixed at creation, changed only by adoptTerms
    uint16 public markupBps; // markup on a run's cost; fixed at creation, changed only by adoptTerms

    address public customOperator; // this wallet's own meter; zero = the factory's
    address[] private _payable; // agent wallets a run of this wallet may pay; none unless the owner says so
    mapping(address => uint256) private _payableIndex; // place in _payable, plus one

    mapping(uint256 day => uint256 spent) public spentOnDay;
    mapping(bytes32 runId => bool used) public runCharged; // charged or refunded; final

    uint256 public totalCharged; // lifetime cost: charges with their fee, and payments to other agents

    address public usdg;
    uint256 public totalOut; // USDG this wallet has ever sent out, refunds included
    uint256 public totalRefunded; // USDG given back to payers (sent or parked for them); never income

    struct Lien {
        address payee; // who the pledged share is paid to
        uint16 bps; // share of profit pledged, in hundredths of a percent
        uint128 cap; // most the lien will ever pay; 0 = no cap
        uint128 paid; // paid to the payee so far
        uint256 baseProfit; // settled profit when the lien began
    }

    Lien public lien;

    bytes32 public lienTermsConsent; // the payee's yes to one specific change of treasury and markup
    bytes32 public lienOperatorConsent; // the payee's yes to one specific meter for this wallet
    bytes32 public lienPayableConsent; // the payee's yes to one specific wallet being added to payableTo
    mapping(address => uint256) public parked; // money USDG would not deliver; whoever it is for can claim it
    mapping(bytes32 runId => uint256) public owedBack; // what a sub-run could not give back to the run that paid for it; see retryReturn
    uint256 public parkedTotal; // everything in `parked` and in `owedBack`

    struct Hold {
        address opener; // the meter that let the run in: the only one that may bill it or release it early
        uint32 day; // the UTC day whose limit it counts against
        uint64 openedAt; // 0 = no hold
        uint96 amount; // set aside right now: a whole payment (less what the run paid other agents), or the run's maximum cost
        uint80 budget; // what the run may still cost, before the fee
        uint80 reserved; // what the run may still cost, fee included; counted against `day`
    }

    mapping(bytes32 runId => Hold) public holds;
    uint256 public heldTotal; // everything set aside for runs that are open
    uint256 public plainHolds; // open holds that came from `open`: money with no payer on record
    uint256 public constant HOLD_TIMEOUT = 1 days; // after this anyone may release a hold the meter abandoned

    struct Payment {
        address payer; // zero = this run was not paid through `pay` or by another agent
        uint80 value; // the whole payment
        bool outside; // counted as income from an outside customer when it was paid
        bool refunded; // closed by a refund or a timeout: anything that comes back later is the payer's
    }

    mapping(bytes32 runId => Payment) public payments;

    struct Sub {
        bytes32 runId; // the run of this wallet that paid
        uint256 left; // what it paid and has not had back
    }

    /// What this wallet's runs have paid other agents: by receiving wallet, then by
    /// the id the receiving wallet filed the sub-run under.
    mapping(address toWallet => mapping(bytes32 subRunKey => Sub)) public subs;

    mapping(address => bool) public wasOwner; // every owner this wallet has had, the current one included
    uint256 public externalIncome; // payments from outside customers, net of refunds
    uint256 public insiderIncome; // payments from insiders, net of refunds
    uint256 public payerCount; // outside payers whose payments, net of refunds, are above zero
    mapping(address => uint256) public paidBy; // outside payments by payer, net of refunds
    address public topPayer; // see notePayer
    uint256 public topPayerPaid; // always paidBy[topPayer]

    uint256 public settledProfit; // the checkpoint: profit counted as final
    uint256 public pendingProfit; // a checkpoint someone asked for
    uint64 public pendingAt; // when they asked; 0 = none
    uint256 public constant CHECKPOINT_DELAY = 1 days;

    event Charged(bytes32 indexed runId, uint256 cost, uint256 fee, address indexed treasury, bytes32 receipt);
    event Paid(bytes32 indexed runId, address indexed payer, uint256 value, bool outside);
    event Refunded(bytes32 indexed runId, address indexed payer, uint256 amount, bool parked);
    event AgentPaid(bytes32 indexed runId, address indexed toWallet, uint256 value, bytes32 subRunId);
    event Opened(bytes32 indexed runId, uint256 held);
    event Released(bytes32 indexed runId, uint256 held);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event LimitsSet(uint128 perRunCap, uint128 perDayCap);
    event PausedSet(bool paused);
    event OperatorSet(address indexed operator);
    event PayableSet(address indexed toWallet, bool allowed);
    event AgentReturned(bytes32 indexed runId, address indexed fromWallet, uint256 amount);
    event TermsAdopted(address indexed treasury, uint16 markupBps);
    event LienSet(address indexed payee, uint16 bps, uint128 cap);
    event LienPaid(address indexed payee, uint256 amount);
    event LienEnded(address indexed payee, uint256 paid);
    event LienPayeeSet(address indexed from, address indexed to);
    event Parked(address indexed forWhom, uint256 amount);
    event ParkedClaimed(address indexed forWhom, address indexed to, uint256 amount);
    event Settled(uint256 settledProfit);
    event CheckpointRequested(uint256 profit, uint256 readyAt);
    event OwnershipOffered(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotOperator();
    error OperatorPaused();
    error AlreadyInitialised();
    error Paused();
    error RunAlreadyCharged();
    error OverRunCap();
    error OverDayCap();
    error ZeroAddress();
    error ZeroCost();
    error TransferFailed();
    error TermsChanged();
    error LienExists();
    error NoLien();
    error LienStands();
    error LienOwed();
    error BadLien();
    error CheckpointPending();
    error NoCheckpoint();
    error NotPaid();
    error NotOpen();
    error HoldStands();
    error Underpaid();
    error NotAgent();
    error NotPayable();
    error NotAccepted();
    error HoldsOpen();
    error NothingParked();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Locks the bare implementation so nobody can initialise it.
    constructor() {
        factory = address(1);
    }

    function init(address owner_, uint128 perRunCap_, uint128 perDayCap_) external {
        if (factory != address(0)) revert AlreadyInitialised();
        if (owner_ == address(0)) revert ZeroAddress();
        factory = msg.sender;
        owner = owner_;
        wasOwner[owner_] = true;
        perRunCap = perRunCap_;
        perDayCap = perDayCap_;
        usdg = IWeightlingsFactoryView(msg.sender).usdg();
        treasury = IWeightlingsFactoryView(msg.sender).treasury();
        markupBps = IWeightlingsFactoryView(msg.sender).markupBps();
        emit OwnershipTransferred(address(0), owner_);
        emit LimitsSet(perRunCap_, perDayCap_);
        emit TermsAdopted(treasury, markupBps);
    }

    /// @notice Who may meter this wallet right now: its own operator if the owner
    ///         has named one, otherwise the factory's.
    function operator() public view returns (address) {
        address own = customOperator;
        return own != address(0) ? own : IWeightlingsFactoryView(factory).operator();
    }

    // ---- money in ----

    /// @notice Take a customer's signed USDG payment (EIP-3009) into this wallet and,
    ///         in the same transaction, hold ALL of it for the run, with a record
    ///         of who paid. `budget` is the most the run may cost before the fee;
    ///         the payment must cover it with the fee. If the wallet cannot take
    ///         the run (paused, over a limit, underpaid) nothing is taken.
    ///         `receiveOnly` says which form the customer signed: true for
    ///         ReceiveWithAuthorization, which only this wallet can submit; false
    ///         for TransferWithAuthorization, which anyone can (see the header).
    function pay(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 runId,
        uint256 budget,
        bool receiveOnly
    ) external {
        _onlyOperator();
        uint256 before = _balance();
        bool ok = _submitAuthorization();
        // The arguments were checked when this call was decoded; these two are read
        // again from where they came (the function has too many to reach otherwise).
        address payer;
        uint256 paid;
        assembly ("memory-safe") {
            payer := calldataload(0x04) // from
            paid := calldataload(0x24) // value
        }
        // A signature that was already used is accepted by USDG and moves nothing,
        // so success is not enough: the money has to be here.
        if (!ok || _balance() != before + paid) revert NotPaid();
        _open(runId, budget, paid, payer, msg.sender);
    }

    /// @dev Hands the authorization in `pay`'s own arguments to USDG:
    ///      receiveWithAuthorization (0xef55bec6) when `receiveOnly`, else
    ///      transferWithAuthorization (0xe3ee160e), both taking
    ///      (from, to, value, validAfter, validBefore, nonce, v, r, s) with to = this wallet.
    function _submitAuthorization() private returns (bool ok) {
        address token = usdg;
        assembly ("memory-safe") {
            let m := mload(0x40)
            switch calldataload(0x144) // receiveOnly
            case 0 { mstore(m, shl(224, 0xe3ee160e)) }
            default { mstore(m, shl(224, 0xef55bec6)) }
            calldatacopy(add(m, 0x04), 0x04, 0x20) // from
            mstore(add(m, 0x24), address()) // to
            calldatacopy(add(m, 0x44), 0x24, 0xe0) // value, validAfter, validBefore, nonce, v, r, s
            ok := call(gas(), token, 0, m, 0x124, 0, 0)
        }
    }

    /// @notice The receiving end of `payAgent`. Only another agent wallet of the same
    ///         factory may call. This wallet pulls exactly `value` from the caller
    ///         (which approved it in the same transaction) and records a paid run as
    ///         if a customer had paid through `pay`: the whole amount is held, the
    ///         caller is the payer. The run is filed under `subRunKey(caller, runId)`,
    ///         and that is the id to charge or refund; this wallet's meter of the
    ///         moment is the one that may. This wallet's pause switch and limits
    ///         apply. The guardian's pause is one switch for the whole factory and
    ///         was checked by the paying wallet.
    ///         The payment is taken only if both sides are run by the same meter:
    ///         `opener`, the meter that opened the paying run, must be this
    ///         wallet's meter now, and it becomes the opener of the sub-run's
    ///         hold. So the meter that sent the money is the one that bills it,
    ///         and no wallet run by another meter can push runs in here.
    ///         `opener` is taken on the caller's word: the caller is a wallet of
    ///         the same factory, so it runs this same code, and this code passes
    ///         the opener recorded in the paying hold.
    function payFromAgent(uint256 value, bytes32 runId, uint256 budget, address opener) external {
        if (!IWeightlingsFactoryView(factory).isAgentWallet(msg.sender)) revert NotAgent();
        if (opener != operator()) revert NotAccepted();
        _pull(msg.sender, value);
        _open(subRunKey(msg.sender, runId), budget, value, msg.sender, opener);
    }

    /// @dev Take exactly `amount` of USDG that `from` has approved, or fail.
    function _pull(address from, uint256 amount) private {
        uint256 before = _balance();
        // transferFrom(address,address,uint256)
        (bool ok, bytes memory ret) = usdg.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || _balance() != before + amount) revert NotPaid();
    }

    /// @notice The run id under which this wallet files a run paid by another agent's
    ///         wallet. Each paying wallet has its own range of ids here, so it cannot
    ///         take an id this wallet's meter is about to use for a customer.
    function subRunKey(address payingWallet, bytes32 subRunId) public pure returns (bytes32) {
        return keccak256(abi.encode(payingWallet, subRunId));
    }

    /// @notice Set aside a run's maximum cost from money already in the wallet,
    ///         for a payment that did not come through `pay`. Only money that is
    ///         not held, parked or owed to the lien can be set aside.
    function open(bytes32 runId, uint256 budget) external {
        _onlyOperator();
        _open(runId, budget, 0, address(0), msg.sender);
    }

    /// @dev payer == 0: a hold of the run's maximum cost from free money.
    ///      payer != 0: `value` has just arrived from `payer` and all of it is held.
    function _open(bytes32 runId, uint256 budget, uint256 value, address payer, address opener) private {
        if (paused) revert Paused();
        if (budget == 0) revert ZeroCost();
        // A run id is used once: not while open, not after a charge or refund, and
        // never again once a payment has been recorded under it.
        if (runCharged[runId] || holds[runId].openedAt != 0 || payments[runId].payer != address(0)) {
            revert RunAlreadyCharged();
        }
        uint256 total = budget + (budget * markupBps) / 10_000;
        if (total > perRunCap || total > type(uint80).max) revert OverRunCap();
        uint256 day = block.timestamp / 1 days;
        uint256 spent = spentOnDay[day] + total;
        if (spent > perDayCap) revert OverDayCap();
        uint256 amount = total;
        if (payer != address(0)) {
            if (value < total) revert Underpaid();
            if (value > type(uint80).max) revert OverRunCap();
            amount = value;
        } else {
            plainHolds++;
        }
        // Only money that is not already spoken for can be set aside: not held for
        // another run, not parked, not owed to the lien. For a payment the money
        // arrived in this call, so this says the wallet was whole before it.
        if (_balance() < parkedTotal + heldTotal + lienUnpaid() + amount) revert TransferFailed();
        spentOnDay[day] = spent;
        holds[runId] = Hold(opener, uint32(day), uint64(block.timestamp), uint96(amount), uint80(budget), uint80(total));
        heldTotal += amount;
        emit Opened(runId, amount);

        if (payer != address(0)) {
            bool outside = !_insider(payer);
            payments[runId] = Payment(payer, uint80(value), outside, false);
            if (outside) {
                externalIncome += value;
                uint256 sum = paidBy[payer];
                if (sum == 0) payerCount++;
                sum += value;
                paidBy[payer] = sum;
                if (payer == topPayer || sum > topPayerPaid) {
                    topPayer = payer;
                    topPayerPaid = sum;
                }
            } else {
                insiderIncome += value;
            }
            emit Paid(runId, payer, value, outside);
        }
    }

    /// @dev An insider, judged at the moment of payment: any owner this wallet has
    ///      had, the lien payee, or a wallet of this factory that belongs to one of them.
    function _insider(address payer) private view returns (bool) {
        if (_related(payer)) return true;
        return IWeightlingsFactoryView(factory).isAgentWallet(payer) && _related(ICreatureWallet(payer).owner());
    }

    function _related(address who) private view returns (bool) {
        return wasOwner[who] || who == lien.payee;
    }

    /// @notice Point `topPayer` at `payer` if it has paid more than the payer on
    ///         record. `topPayer` is kept exact as payments arrive. A refund to the
    ///         top payer lowers `topPayerPaid` with it, and if that drops it below
    ///         another payer the wallet cannot know which one without a search, so
    ///         the record stays on the old payer until the larger one pays again or
    ///         anyone calls this. `topPayerPaid` always equals `paidBy(topPayer)`.
    function notePayer(address payer) external {
        uint256 sum = paidBy[payer];
        if (sum > topPayerPaid) {
            topPayer = payer;
            topPayerPaid = sum;
        }
    }

    // ---- release, charge, refund ----

    /// @notice Close a hold without charging. Before the hold is a day old only the
    ///         meter that opened it may do this, and the money stays with the agent: the run cost
    ///         nothing or never happened. Once it is a day old anyone may, the
    ///         guardian's pause notwithstanding, and then a payment that was never
    ///         charged or refunded goes back to whoever paid it, exactly as a
    ///         refund at no cost would send it (parked for them if USDG will not
    ///         deliver). A hold opened from the balance has no payer: its money
    ///         simply becomes free again.
    function release(bytes32 runId) external {
        Hold memory h = holds[runId];
        if (h.openedAt == 0) revert NotOpen();
        bool timedOut = block.timestamp >= h.openedAt + HOLD_TIMEOUT;
        if (!timedOut) {
            if (msg.sender != h.opener) revert HoldStands();
            if (IWeightlingsFactoryView(factory).operatorPaused()) revert OperatorPaused();
        }
        delete holds[runId];
        heldTotal -= h.amount;
        spentOnDay[h.day] -= h.reserved;
        emit Released(runId, h.amount);
        address payer = payments[runId].payer;
        if (payer == address(0)) {
            plainHolds--;
        } else if (timedOut) {
            runCharged[runId] = true; // refunded: final
            payments[runId].refunded = true;
            _giveBack(runId, payer, h.amount);
            _capSettled();
        }
    }

    /// @notice Charge an open run. `cost` is what the run cost in USDG units, never
    ///         more than its budget; this wallet's markup is added on top and the
    ///         total goes to this wallet's treasury. The rest of the hold is freed
    ///         and stays with the agent. `receipt` is published as given.
    function charge(bytes32 runId, uint256 cost, bytes32 receipt) external {
        _charge(runId, cost, receipt, false);
    }

    /// @notice Charge a run and ask for the checkpoint to move to `settledUpTo`.
    ///         The wallet moves it no further than profit less money still held.
    function chargeAndSettle(bytes32 runId, uint256 cost, uint256 settledUpTo, bytes32 receipt) external {
        _charge(runId, cost, receipt, false);
        _checkpoint(settledUpTo);
    }

    /// @notice Bill a run that was paid through `pay` (or by another agent) and give
    ///         the rest of its payment back to whoever paid. `cost` may be zero.
    ///         What goes back is not income. If USDG will not deliver to the payer
    ///         the amount is set aside for them to claim with `claimParked`.
    function refund(bytes32 runId, uint256 cost, bytes32 receipt) external {
        _charge(runId, cost, receipt, true);
    }

    /// @notice Ask for the checkpoint to move to `settledUpTo` without charging a run.
    function settle(uint256 settledUpTo) external {
        _onlyOperator();
        _checkpoint(settledUpTo);
    }

    function _onlyOperator() private view {
        _onlyOpener(address(0));
    }

    /// @dev A hold answers only to the meter that opened it, whoever the wallet's
    ///      meter is now; where there is no hold, to the wallet's meter of the moment.
    function _onlyOpener(address opener) private view {
        if (msg.sender != (opener == address(0) ? operator() : opener)) revert NotOperator();
        if (IWeightlingsFactoryView(factory).operatorPaused()) revert OperatorPaused();
    }

    function _charge(bytes32 runId, uint256 cost, bytes32 receipt, bool giveBack) private {
        Hold memory h = holds[runId];
        _onlyOpener(h.opener);
        if (!giveBack && cost == 0) revert ZeroCost();
        if (h.openedAt == 0) revert NotOpen(); // nothing can be charged that was not set aside first
        address payer = payments[runId].payer;
        if (giveBack && payer == address(0)) revert NotPaid(); // only a recorded payment can be refunded

        uint256 fee = (cost * markupBps) / 10_000;
        uint256 total = cost + fee;
        if (cost > h.budget || total > h.reserved) revert OverRunCap();

        // The hold was checked against the limits and the pause switch when it was
        // opened. Whatever the owner has changed since, this run can still be billed.
        delete holds[runId];
        heldTotal -= h.amount;
        spentOnDay[h.day] -= h.reserved - total;
        runCharged[runId] = true;
        totalCharged += total;
        if (payer == address(0)) plainHolds--;
        else if (giveBack) payments[runId].refunded = true;

        address to = treasury;
        if (total != 0) _send(usdg, to, total);
        emit Charged(runId, cost, fee, to, receipt);

        // A paid hold is never smaller than what the run may cost.
        if (giveBack) _giveBack(runId, payer, h.amount - total);
        _capSettled();
    }

    /// @dev Send `back` of a run's payment to its payer, or park it for them, and
    ///      take it out of every income figure.
    function _giveBack(bytes32 runId, address payer, uint256 back) private {
        if (back == 0) return;
        totalRefunded += back;
        if (payments[runId].outside) {
            externalIncome -= back;
            uint256 left = paidBy[payer] - back;
            paidBy[payer] = left;
            if (left == 0) payerCount--;
            if (payer == topPayer) topPayerPaid = left;
        } else {
            insiderIncome -= back;
        }
        bool sent;
        if (IWeightlingsFactoryView(factory).isAgentWallet(payer)) {
            // Another agent's run paid for this one: hand the money back to that run,
            // not just to that wallet. The paying wallet pulls it and books it. If it
            // cannot be done now it stays owed to that run, to be tried again.
            if (_approve(payer, back)) {
                try ICreatureWallet(payer).returnFromAgent(runId, back) {
                    sent = true;
                    totalOut += back;
                } catch {
                    _approve(payer, 0);
                }
            }
            if (!sent) owedBack[runId] += back;
        } else {
            sent = _trySend(payer, back);
            if (!sent) parked[payer] += back;
        }
        if (!sent) {
            parkedTotal += back;
            emit Parked(payer, back);
        }
        emit Refunded(runId, payer, back, !sent);
    }

    /// @notice Try again to give back what sub-run `runId` owes the run that paid for
    ///         it (USDG would not move it at the time). Anyone may call. The money
    ///         goes the way it would have gone: into the paying run, or on to that
    ///         run's payer. Until this succeeds it is kept apart like parked money.
    function retryReturn(bytes32 runId) external {
        uint256 amount = owedBack[runId];
        if (amount == 0) revert NothingParked();
        address payer = payments[runId].payer;
        owedBack[runId] = 0;
        parkedTotal -= amount;
        totalOut += amount;
        if (!_approve(payer, amount)) revert TransferFailed();
        ICreatureWallet(payer).returnFromAgent(runId, amount);
        emit ParkedClaimed(payer, payer, amount);
    }

    /// @notice Called by the wallet that holds a sub-run this wallet paid for, when
    ///         that sub-run is refunded or times out. `subRunKey_` is the id that
    ///         wallet filed it under. This wallet pulls `amount`, never more than
    ///         the sub-run was paid and has not yet returned, and gives it back to
    ///         the run that paid: into its hold and its budget if it is still open;
    ///         on to that run's own payer if it has since been refunded or timed
    ///         out; otherwise, the run having been billed or released, it stays
    ///         here as a lower cost for that run. It is never counted as income.
    function returnFromAgent(bytes32 subRunKey_, uint256 amount) external {
        Sub storage sub = subs[msg.sender][subRunKey_];
        if (amount == 0 || amount > sub.left) revert NotPaid(); // only the wallet holding that exact sub-run has anything to return
        sub.left -= amount;
        _pull(msg.sender, amount);
        // Undo the sub-payment: it was booked as cost and as money sent.
        totalCharged -= amount;
        totalOut -= amount;
        bytes32 runId = sub.runId;
        emit AgentReturned(runId, msg.sender, amount);
        Hold storage h = holds[runId];
        if (h.openedAt != 0) {
            h.amount += uint96(amount);
            h.budget += uint80(amount);
            h.reserved += uint80(amount);
            heldTotal += amount;
        } else if (payments[runId].refunded) {
            _giveBack(runId, payments[runId].payer, amount);
        }
    }

    function _approve(address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = usdg.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }

    /// @notice Pay another agent's wallet out of an open run that was paid through
    ///         `pay`. `value` comes out of that run's hold and its budget, and counts
    ///         as this run's cost with no markup. The other wallet records it as a
    ///         paid run `subRunId` with `subBudget`, holding all of it, in this same
    ///         transaction; if it will not take the run, nothing moves.
    function payAgent(bytes32 runId, address toWallet, uint256 value, bytes32 subRunId, uint256 subBudget) external {
        Hold storage h = holds[runId];
        address opener = h.opener;
        _onlyOpener(opener);
        if (h.openedAt == 0) revert NotOpen();
        if (payments[runId].payer == address(0)) revert NotPaid();
        if (toWallet == address(this) || !IWeightlingsFactoryView(factory).isAgentWallet(toWallet)) revert NotAgent();
        if (_payableIndex[toWallet] == 0) revert NotPayable();
        if (value == 0) revert ZeroCost();
        if (value > h.budget) revert OverRunCap();
        // reserved >= budget and amount >= reserved, so none of these can go below zero.
        h.budget -= uint80(value);
        h.reserved -= uint80(value);
        h.amount -= uint96(value);
        heldTotal -= value;
        totalCharged += value;
        totalOut += value;
        // So that what the sub-run gives back can find its way to this run again.
        subs[toWallet][keccak256(abi.encode(address(this), subRunId))] = Sub(runId, value);

        // The other wallet pulls exactly `value` or the whole call fails, so the
        // approval is used up before this function returns.
        if (!_approve(toWallet, value)) revert TransferFailed();
        ICreatureWallet(toWallet).payFromAgent(value, subRunId, subBudget, opener);
        _capSettled();
        emit AgentPaid(runId, toWallet, value, subRunId);
    }

    /// @notice What the meter could still set aside today.
    function remainingToday() external view returns (uint256) {
        uint256 spent = spentOnDay[block.timestamp / 1 days];
        return spent >= perDayCap ? 0 : perDayCap - spent;
    }

    // ---- checkpoint ----

    /// @dev The checkpoint only moves up, and never above profit less money still
    ///      held, whatever figure is asked for. A checkpoint someone has asked for
    ///      in public is left standing: the meter cannot cancel it by settling. (Profit that was there before a
    ///      lien began earns the lien nothing and is always counted as settled.)
    function _checkpoint(uint256 asked) private {
        uint256 p = profit();
        uint256 held = heldTotal;
        uint256 next = p > held ? p - held : 0;
        if (asked < next) next = asked;
        if (lien.payee != address(0) && next < lien.baseProfit) next = p < lien.baseProfit ? p : lien.baseProfit;
        if (next > settledProfit) settledProfit = next;
        emit Settled(settledProfit);
    }

    /// @dev Spending lowers profit; the checkpoint can never sit above it.
    function _capSettled() private {
        uint256 p = profit();
        if (settledProfit > p) settledProfit = p;
    }

    /// @notice If the meter has stopped settling, anyone may ask for a checkpoint at
    ///         today's profit and take it after a day. Money still held for a run
    ///         when it is taken is left out, and the request then stays open to be
    ///         taken again later.
    function requestCheckpoint() external {
        if (pendingAt != 0) revert CheckpointPending();
        // Money still held cannot be settled, so it is left out of what is asked for. Otherwise a request made
        // while runs are open would stand above real profit and could later settle unbilled income at once.
        uint256 p = profit();
        pendingProfit = p > heldTotal ? p - heldTotal : 0;
        pendingAt = uint64(block.timestamp);
        emit CheckpointRequested(pendingProfit, block.timestamp + CHECKPOINT_DELAY);
    }

    function takeCheckpoint() external {
        if (pendingAt == 0 || block.timestamp < pendingAt + CHECKPOINT_DELAY) revert NoCheckpoint();
        uint256 asked = pendingProfit;
        _checkpoint(asked);
        // The request is used up once the checkpoint stands at the figure asked for,
        // or at all the profit there is if that has fallen below it. If money held
        // for a run kept it short of that, the request stands and can be taken again
        // when the hold is gone. It never reaches past the figure asked for.
        uint256 p = profit();
        if (settledProfit >= (asked < p ? asked : p)) pendingAt = 0;
    }

    // ---- the record ----

    /// @notice Every USDG this wallet has ever received and not given back to its payer.
    function income() public view returns (uint256) {
        return _balance() + totalOut - totalRefunded;
    }

    /// @notice Lifetime income less lifetime cost.
    function profit() public view returns (uint256) {
        return income() - totalCharged;
    }

    /// @notice Profit not yet counted as final.
    function unsettled() public view returns (uint256) {
        uint256 p = profit();
        return p > settledProfit ? p - settledProfit : 0;
    }

    /// @notice What the lien has earned on settled profit and not yet been paid.
    function lienUnpaid() public view returns (uint256) {
        Lien memory l = lien;
        if (l.payee == address(0)) return 0;
        uint256 p = profit();
        if (p > settledProfit) p = settledProfit;
        uint256 gained = p > l.baseProfit ? p - l.baseProfit : 0;
        uint256 accrued = (gained * l.bps) / 10_000;
        if (l.cap != 0 && accrued > l.cap) accrued = l.cap;
        return accrued > l.paid ? accrued - l.paid : 0;
    }

    /// @notice What the owner can take out in USDG right now: the balance less what
    ///         is parked and held. Under a lien the payee's unpaid share stays
    ///         behind too, and so does income not yet settled (held money is part
    ///         of that and is not counted twice).
    function withdrawable() public view returns (uint256) {
        uint256 bal = _balance();
        uint256 kept = heldTotal;
        if (lien.payee != address(0)) {
            uint256 open_ = unsettled();
            if (open_ > kept) kept = open_;
            kept += lienUnpaid();
        }
        kept += parkedTotal;
        return kept >= bal ? 0 : bal - kept;
    }

    // ---- lien ----

    /// @notice Pledge `bps` of this wallet's profit from now on to `payee`, up to
    ///         `cap` in total (0 = no limit). One lien at a time, and it cannot be
    ///         changed. It ends when the payee releases it, or, by the owner, once
    ///         it has paid its cap. A lien with no cap lasts until its payee lets go.
    ///         Not while a hold opened with `open` is still open (anyone can release
    ///         one after a day). Free money already here stays the owner's. Money held for a run that
    ///         is still open has not been earned yet: what is left of it after the
    ///         run is billed is profit the lien shares in.
    ///         The share is of running profit: money the payee has earned but not
    ///         collected shrinks if later runs lose money, so collect often.
    function setLien(address payee, uint16 bps, uint128 cap) external onlyOwner {
        if (lien.payee != address(0)) revert LienExists();
        if (payee == address(0) || payee == address(this)) revert ZeroAddress();
        if (bps == 0 || bps > 10_000) revert BadLien();
        // A hold opened from the balance may be sitting on the owner's own money, and
        // the lien must not count that as profit to come. Wait until it is closed.
        if (plainHolds != 0) revert HoldsOpen();
        uint256 p = profit();
        uint256 held = heldTotal;
        p = p > held ? p - held : 0;
        lien = Lien(payee, bps, cap, 0, p);
        settledProfit = p;
        pendingAt = 0;
        _clearConsents();
        emit LienSet(payee, bps, cap);
    }

    /// @notice Pay the payee what the lien has earned. Anyone may call.
    function settleLien() external returns (uint256 amount) {
        if (lien.payee == address(0)) revert NoLien();
        amount = lienUnpaid();
        uint256 bal = _balance();
        uint256 spoken = parkedTotal + heldTotal; // set aside for others: never the payee's to take
        bal = bal > spoken ? bal - spoken : 0;
        if (amount > bal) amount = bal;
        if (amount == 0) return 0;
        address payee = lien.payee;
        if (amount > type(uint128).max - lien.paid) revert BadLien();
        lien.paid += uint128(amount);
        _send(usdg, payee, amount);
        emit LienPaid(payee, amount);
    }

    /// @notice End the lien. The payee may release it at any time (call settleLien
    ///         first to collect). The owner may end it once it has paid its cap; the
    ///         last of what it is owed is paid in the same call, and if USDG will
    ///         not deliver to the payee the money is set aside for them to claim.
    function endLien() external {
        Lien memory l = lien;
        if (l.payee == address(0)) revert NoLien();
        if (msg.sender != l.payee) {
            if (msg.sender != owner) revert NotOwner();
            uint256 owed = lienUnpaid();
            uint256 bal = _balance();
            uint256 spoken = parkedTotal + heldTotal;
            if (bal < spoken || owed > bal - spoken) revert LienStands(); // not all there yet
            if (l.cap == 0 || l.paid + owed < l.cap) revert LienStands();
            if (owed != 0) {
                lien.paid = l.paid + uint128(owed); // owed never takes paid past cap
                if (_trySend(l.payee, owed)) {
                    emit LienPaid(l.payee, owed);
                } else {
                    parked[l.payee] += owed;
                    parkedTotal += owed;
                    emit Parked(l.payee, owed);
                }
            }
        }
        uint256 paid = lien.paid;
        delete lien;
        pendingAt = 0;
        _clearConsents();
        emit LienEnded(l.payee, paid);
    }

    /// @notice Collect money that was set aside for the caller (a lien payment or a
    ///         refund USDG would not deliver), to any address.
    function claimParked(address to) external {
        uint256 amount = parked[msg.sender];
        if (amount == 0) revert NothingParked();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        parked[msg.sender] = 0;
        parkedTotal -= amount;
        _send(usdg, to, amount);
        emit ParkedClaimed(msg.sender, to, amount);
    }

    /// @notice Bring into this wallet lien money that another agent's wallet had to
    ///         set aside for it as that wallet's lien payee. Anyone may call; the
    ///         money can only come here. (A sub-run's refund is never parked this
    ///         way: see retryReturn.)
    function collectParked(address fromWallet) external {
        if (!IWeightlingsFactoryView(factory).isAgentWallet(fromWallet)) revert NotAgent();
        ICreatureWallet(fromWallet).claimParked(address(this));
    }

    /// @notice The payee agrees to the owner adopting one specific treasury and markup.
    function consentToTerms(address treasury_, uint16 markupBps_) external {
        if (msg.sender != lien.payee) revert NotOwner(); // with no lien the payee is the zero address, which nobody is
        lienTermsConsent = keccak256(abi.encode(treasury_, markupBps_));
    }

    /// @notice The payee agrees to the owner naming one specific meter for this
    ///         wallet (the zero address: going back to the factory's).
    function consentToOperator(address operator_) external {
        if (msg.sender != lien.payee) revert NotOwner(); // with no lien the payee is the zero address, which nobody is
        lienOperatorConsent = keccak256(abi.encode(operator_));
    }

    /// @notice The payee agrees to the owner letting this wallet's runs pay one
    ///         specific agent wallet.
    function consentToPayable(address toWallet) external {
        if (msg.sender != lien.payee) revert NotOwner(); // with no lien the payee is the zero address, which nobody is
        lienPayableConsent = keccak256(abi.encode(toWallet));
    }

    /// @notice The payee may point the lien at another address, for example if
    ///         USDG will no longer pay the first one.
    function setLienPayee(address to) external {
        address from = lien.payee;
        if (from == address(0)) revert NoLien();
        if (msg.sender != from) revert NotOwner();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        lien.payee = to;
        _clearConsents(); // the new payee has agreed to nothing
        emit LienPayeeSet(from, to);
    }

    function _clearConsents() private {
        lienTermsConsent = bytes32(0);
        lienOperatorConsent = bytes32(0);
        lienPayableConsent = bytes32(0);
    }

    // ---- owner ----

    /// @notice Take any token out at any time, with no delay. USDG is limited to
    ///         `withdrawable`.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        if (token == usdg && amount > withdrawable()) revert LienOwed();
        _send(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    function setLimits(uint128 perRunCap_, uint128 perDayCap_) external onlyOwner {
        perRunCap = perRunCap_;
        perDayCap = perDayCap_;
        emit LimitsSet(perRunCap_, perDayCap_);
    }

    /// @notice Name this wallet's own meter, or pass the zero address to go back to
    ///         the factory's. The one named has exactly the powers the factory's
    ///         operator would have here, and the factory's has none while it stands.
    ///         While a lien stands its payee must first agree to this exact address.
    function setOperator(address operator_) external onlyOwner {
        if (lien.payee != address(0)) {
            if (lienOperatorConsent != keccak256(abi.encode(operator_))) revert LienExists();
            lienOperatorConsent = bytes32(0);
        }
        customOperator = operator_;
        emit OperatorSet(operator_);
    }

    /// @notice Say whether this wallet's runs may pay `toWallet` through `payAgent`.
    ///         Nothing is allowed until the owner allows it, so the meter cannot
    ///         choose where a run's money goes. Taking a wallet off the list is
    ///         always possible. While a lien stands, putting one on needs the
    ///         payee's agreement to that exact address first.
    function setPayable(address toWallet, bool allowed) external onlyOwner {
        uint256 at = _payableIndex[toWallet];
        if (allowed && at == 0) {
            if (!IWeightlingsFactoryView(factory).isAgentWallet(toWallet)) revert NotAgent();
            if (lien.payee != address(0)) {
                if (lienPayableConsent != keccak256(abi.encode(toWallet))) revert LienExists();
                lienPayableConsent = bytes32(0);
            }
            _payable.push(toWallet);
            _payableIndex[toWallet] = _payable.length;
        } else if (!allowed && at != 0) {
            address last = _payable[_payable.length - 1];
            _payable[at - 1] = last;
            _payableIndex[last] = at;
            _payable.pop();
            _payableIndex[toWallet] = 0;
        }
        emit PayableSet(toWallet, allowed);
    }

    function payableTo(address toWallet) external view returns (bool) {
        return _payableIndex[toWallet] != 0;
    }

    /// @notice The whole list of wallets this wallet's runs may pay, for anyone to read.
    function payableCount() external view returns (uint256) {
        return _payable.length;
    }

    function payableAt(uint256 i) external view returns (address) {
        return _payable[i];
    }

    /// @notice Take on the factory's current treasury and markup. The owner names the
    ///         values they mean; if the factory holds anything else, nothing changes.
    ///         While a lien stands its payee must first agree to these exact terms.
    function adoptTerms(address expectedTreasury, uint16 expectedMarkupBps) external onlyOwner {
        if (lien.payee != address(0)) {
            if (lienTermsConsent != keccak256(abi.encode(expectedTreasury, expectedMarkupBps))) revert LienExists();
            lienTermsConsent = bytes32(0);
        }
        IWeightlingsFactoryView f = IWeightlingsFactoryView(factory);
        if (f.treasury() != expectedTreasury || f.markupBps() != expectedMarkupBps) revert TermsChanged();
        treasury = expectedTreasury;
        markupBps = expectedMarkupBps;
        emit TermsAdopted(expectedTreasury, expectedMarkupBps);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        wasOwner[msg.sender] = true;
        pendingOwner = address(0);
    }

    // ---- identity ----

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant AGENT_WALLET_SET_TYPEHASH =
        keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)");

    /// @notice ERC-1271, for one statement only: "this wallet agrees to be the payment
    ///         wallet of agent `agentId` in the ERC-8004 identity registry", signed by
    ///         this wallet's owner. `signature` is abi.encode(agentId, deadline, ownerSig).
    ///         Any other digest is refused, so this can never approve a transfer, a
    ///         permit or anything else on the wallet's behalf.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (uint256 agentId, uint256 deadline, bytes memory ownerSig) = abi.decode(signature, (uint256, uint256, bytes));
        address registry = IWeightlingsFactoryView(factory).identityRegistry();
        if (registry == address(0) || ownerSig.length != 65) return 0xffffffff;
        bytes32 domain = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256("ERC8004IdentityRegistry"), keccak256("1"), block.chainid, registry
            )
        );
        bytes32 structHash = keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH, agentId, address(this), owner, deadline));
        if (keccak256(abi.encodePacked("\x19\x01", domain, structHash)) != digest) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(ownerSig, 0x20))
            s := mload(add(ownerSig, 0x40))
            v := byte(0, mload(add(ownerSig, 0x60)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return 0xffffffff;
        address signer = ecrecover(digest, v, r, s);
        return signer != address(0) && signer == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function _balance() private view returns (uint256) {
        return IERC20Balance(usdg).balanceOf(address(this));
    }

    /// @dev USDG only.
    function _trySend(address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = usdg.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) return false;
        totalOut += amount;
        return true;
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == usdg) totalOut += amount;
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }
}
