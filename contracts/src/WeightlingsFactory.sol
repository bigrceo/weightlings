// SPDX-License-Identifier: MIT
// Ported for Weightlings from Zero Lux (MIT, (c) 2026 Zero Lux); see THIRD_PARTY.md. Logic unchanged.
pragma solidity ^0.8.26;

import {CreatureWallet} from "./CreatureWallet.sol";

/// @dev The ERC-8004 identity registry: one token per agent, pointing at its card.
interface IIdentityRegistry {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title WeightlingsFactory
/// @notice Registers agents and deploys one wallet per agent. Holds the settings
///         wallets read: who may meter runs (operator), where run charges go
///         (treasury), the markup on a run's cost, and a switch that stops every
///         meter at once. It also publishes the price list the meter bills by.
/// @dev    This contract never holds money. Each wallet copies the treasury and
///         markup when it is made and keeps them until its own owner adopts new
///         ones. Every setting here changes in two steps, two days apart, so a
///         stolen owner key cannot change anything at once: it is proposed in
///         public, the owner can cancel it, and it lapses if it is not
///         accepted within a week of becoming ready. The one thing that happens at
///         once, apart from the first publication of a price (a model's first
///         rate, the first network cost; prices bind nothing on chain), is the
///         pause: the guardian (or the owner) can stop all meters
///         immediately, and only the guardian can start them again. The
///         guardian can do nothing else. The price list is for reading only; no
///         wallet uses it, and nothing on chain holds the meter to it.
contract WeightlingsFactory {
    uint16 public constant MAX_MARKUP_BPS = 5_000; // 50%
    uint256 public constant DELAY = 2 days;
    uint256 public constant ACCEPT_WINDOW = 7 days; // a change not accepted this long after it became ready must be proposed again

    // Keys of the pending changes. A rate's key is rateKey(model).
    bytes32 public constant OPERATOR = "operator";
    bytes32 public constant MARKUP = "markup";
    bytes32 public constant TREASURY = "treasury";
    bytes32 public constant GUARDIAN = "guardian";
    bytes32 public constant NETWORK_COST = "networkCost";

    address public immutable usdg;
    address public immutable walletImplementation;
    address public immutable identityRegistry; // ERC-8004; zero if this chain has none

    address public owner;
    address public pendingOwner;
    address public operator;
    address public treasury;
    uint16 public markupBps; // for wallets made from now on
    address public guardian;
    bool public operatorPaused; // while true no wallet of this factory lets any meter act

    struct Rate {
        uint64 inPerToken; // price of one input token, in millionths of a USDG unit (1e-12 USDG)
        uint64 outPerToken; // price of one output token, same unit
    }

    mapping(bytes32 model => Rate) public rates;
    mapping(bytes32 model => bool) public rateSet; // a rate has been published for this model before
    uint256 public networkCost; // flat network cost billed per run, in USDG units (1e-6 USDG)
    bool public networkCostSet; // a network cost has been published before

    struct Pending {
        uint256 value; // the proposed value, as a number
        uint64 readyAt; // when it may be accepted; 0 = nothing pending
    }

    mapping(bytes32 key => Pending) public pending;

    struct Agent {
        address wallet;
        address creator;
        bytes32 specHash; // hash of the agent's published spec
        uint64 createdAt;
        bool hasIdentity;
        uint256 identityId; // its ERC-8004 id, when hasIdentity
    }

    bool private _registering;

    Agent[] private _agents;
    mapping(address wallet => uint256 idPlusOne) public agentIdOf;
    mapping(address creator => uint256 count) public createdBy;

    event AgentCreated(uint256 indexed id, address indexed wallet, address indexed creator, bytes32 specHash);
    event IdentityRegistered(uint256 indexed id, uint256 indexed identityId);
    event Proposed(bytes32 indexed key, uint256 value, uint256 effectiveAt);
    event Cancelled(bytes32 indexed key);
    event OperatorSet(address indexed operator);
    event MarkupSet(uint16 markupBps);
    event TreasurySet(address indexed treasury);
    event GuardianSet(address indexed guardian);
    event RateSet(bytes32 indexed model, uint64 inPerToken, uint64 outPerToken);
    event NetworkCostSet(uint256 networkCost);
    event OperatorPausedSet(bool paused, address indexed by);
    event OwnershipOffered(address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotGuardian();
    error ZeroAddress();
    error MarkupTooHigh();
    error TooEarly();
    error Expired();
    error NothingPending();
    error TermsChanged();
    error BadIdentity();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address usdg_,
        address owner_,
        address operator_,
        address treasury_,
        uint16 markupBps_,
        address identityRegistry_,
        address guardian_
    ) {
        if (
            usdg_ == address(0) || owner_ == address(0) || operator_ == address(0) || treasury_ == address(0)
                || guardian_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (markupBps_ > MAX_MARKUP_BPS) revert MarkupTooHigh();
        usdg = usdg_;
        identityRegistry = identityRegistry_;
        owner = owner_;
        operator = operator_;
        treasury = treasury_;
        markupBps = markupBps_;
        guardian = guardian_;
        walletImplementation = address(new CreatureWallet());
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorSet(operator_);
        emit TreasurySet(treasury_);
        emit MarkupSet(markupBps_);
        emit GuardianSet(guardian_);
    }

    /// @notice Anyone may put an agent on the line. `agentOwner` owns its wallet.
    ///         The wallet takes the factory's treasury and markup as they stand;
    ///         the call fails if they are not what the caller expects.
    ///         Pass an `agentURI` to also give it an ERC-8004 identity, owned by
    ///         `agentOwner`; pass an empty string to skip that.
    function createAgent(
        address agentOwner,
        uint128 perRunCap,
        uint128 perDayCap,
        bytes32 specHash,
        string calldata agentURI,
        address expectedTreasury,
        uint16 expectedMarkupBps
    ) external returns (uint256 id, address wallet) {
        // The wallet keeps these for life, so the caller names what they expect.
        if (treasury != expectedTreasury || markupBps != expectedMarkupBps) revert TermsChanged();
        id = _agents.length;
        wallet = _clone(walletImplementation, keccak256(abi.encode(msg.sender, createdBy[msg.sender]++)));
        CreatureWallet(wallet).init(agentOwner, perRunCap, perDayCap);
        _agents.push(Agent(wallet, msg.sender, specHash, uint64(block.timestamp), false, 0));
        agentIdOf[wallet] = id + 1;
        emit AgentCreated(id, wallet, msg.sender, specHash);

        if (bytes(agentURI).length != 0 && identityRegistry != address(0)) {
            _registering = true;
            uint256 identityId = IIdentityRegistry(identityRegistry).register(agentURI);
            _registering = false;
            if (IIdentityRegistry(identityRegistry).ownerOf(identityId) != address(this)) revert BadIdentity();
            IIdentityRegistry(identityRegistry).transferFrom(address(this), agentOwner, identityId);
            _agents[id].hasIdentity = true;
            _agents[id].identityId = identityId;
            emit IdentityRegistered(id, identityId);
        }
    }

    /// @dev The registry mints the identity here before it is passed to the
    ///      agent's owner. Safe transfers are refused at any other time. A token
    ///      pushed here with a plain transfer cannot be recovered.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (!_registering || msg.sender != identityRegistry) revert NotOwner();
        return 0x150b7a02;
    }

    function agentCount() external view returns (uint256) {
        return _agents.length;
    }

    function agent(uint256 id) external view returns (Agent memory) {
        return _agents[id];
    }

    function isAgentWallet(address wallet) external view returns (bool) {
        return agentIdOf[wallet] != 0;
    }

    // ---- the pause ----

    /// @notice Stop or restart every meter on every wallet of this factory, at once.
    ///         The guardian may do both. The owner may stop them but not restart
    ///         them, so a stolen owner key cannot undo the guardian's stop.
    function setOperatorPaused(bool paused_) external {
        if (msg.sender != guardian && (msg.sender != owner || !paused_)) revert NotGuardian();
        operatorPaused = paused_;
        emit OperatorPausedSet(paused_, msg.sender);
    }

    // ---- settings: propose, wait two days, accept ----

    function proposeOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        _propose(OPERATOR, uint160(operator_));
    }

    function acceptOperator() external onlyOwner {
        operator = address(uint160(_take(OPERATOR, false)));
        emit OperatorSet(operator);
    }

    function proposeMarkup(uint16 markupBps_) external onlyOwner {
        if (markupBps_ > MAX_MARKUP_BPS) revert MarkupTooHigh();
        _propose(MARKUP, markupBps_);
    }

    function acceptMarkup() external onlyOwner {
        markupBps = uint16(_take(MARKUP, false));
        emit MarkupSet(markupBps);
    }

    function proposeTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        _propose(TREASURY, uint160(treasury_));
    }

    function acceptTreasury() external onlyOwner {
        treasury = address(uint160(_take(TREASURY, false)));
        emit TreasurySet(treasury);
    }

    function proposeGuardian(address guardian_) external onlyOwner {
        if (guardian_ == address(0)) revert ZeroAddress();
        _propose(GUARDIAN, uint160(guardian_));
    }

    function acceptGuardian() external onlyOwner {
        guardian = address(uint160(_take(GUARDIAN, false)));
        emit GuardianSet(guardian);
    }

    /// @notice The key under which a change to `model`'s rate is pending.
    function rateKey(bytes32 model) public pure returns (bytes32) {
        return keccak256(abi.encode("rate", model));
    }

    function proposeRate(bytes32 model, uint64 inPerToken, uint64 outPerToken) external onlyOwner {
        _propose(rateKey(model), (uint256(inPerToken) << 64) | outPerToken);
    }

    /// @notice The first rate ever published for a model may be accepted straight
    ///         after it is proposed; every later change waits the two days.
    function acceptRate(bytes32 model) external onlyOwner {
        uint256 v = _take(rateKey(model), !rateSet[model]);
        rateSet[model] = true;
        Rate memory r = Rate(uint64(v >> 64), uint64(v));
        rates[model] = r;
        emit RateSet(model, r.inPerToken, r.outPerToken);
    }

    function proposeNetworkCost(uint256 networkCost_) external onlyOwner {
        _propose(NETWORK_COST, networkCost_);
    }

    /// @notice The first network cost ever published may be accepted straight after
    ///         it is proposed; every later change waits the two days.
    function acceptNetworkCost() external onlyOwner {
        networkCost = _take(NETWORK_COST, !networkCostSet);
        networkCostSet = true;
        emit NetworkCostSet(networkCost);
    }

    /// @notice Drop a pending change. `key` is one of the constants above, or rateKey(model).
    function cancel(bytes32 key) external onlyOwner {
        if (pending[key].readyAt == 0) revert NothingPending();
        delete pending[key];
        emit Cancelled(key);
    }

    /// @dev One pending value per setting. Proposing again replaces it and restarts the wait.
    function _propose(bytes32 key, uint256 value) private {
        uint256 at = block.timestamp + DELAY;
        pending[key] = Pending(value, uint64(at));
        emit Proposed(key, value, at);
    }

    /// @dev `noWait` is true only for the first publication of a rate or of the network cost.
    function _take(bytes32 key, bool noWait) private returns (uint256 value) {
        Pending memory p = pending[key];
        if (p.readyAt == 0) revert NothingPending();
        if (!noWait && block.timestamp < p.readyAt) revert TooEarly();
        if (block.timestamp > uint256(p.readyAt) + ACCEPT_WINDOW) revert Expired();
        delete pending[key];
        return p.value;
    }

    // ---- ownership ----

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

    /// @dev EIP-1167 minimal proxy, created with CREATE2.
    function _clone(address implementation, bytes32 salt) private returns (address instance) {
        assembly ("memory-safe") {
            mstore(0x00, or(shr(0xe8, shl(0x60, implementation)), 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000))
            mstore(0x20, or(shl(0x78, implementation), 0x5af43d82803e903d91602b57fd5bf3))
            instance := create2(0, 0x09, 0x37, salt)
        }
        if (instance == address(0)) revert ZeroAddress();
    }
}
