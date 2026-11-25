// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title AntworkFest
 * @notice The on-chain side of Antwork Fest, a browser game on Robinhood Chain (antwork.fun). It does two things: it
 * sells FESTIVAL PASSES by burning the game token, and it keeps the FESTIVAL POT, which pays out every UTC day to the
 * players by the Festival Points the game counted.
 *
 * FESTIVAL PASSES. Once the owner names the game token ($ANTWORK), a pass costs PASS_PRICE (10,000 whole tokens) and
 * runs PASS_LENGTH (30 days). `buyPass(n)` buys n passes at once (1 to MAX_PASSES). The tokens go straight from the
 * buyer to the dead address 0x...dEaD: they are burned, not kept by this contract, the owner or anyone. Passes stack:
 * a new one starts when the one already held ends (or now, if none is running).
 *
 * THE FESTIVAL POT. Anyone can put ETH (`fund`) or the game token (`fundToken`) into the pot, in the name of a crew.
 * The crew id is only a label for the game's board: all funding goes into one shared reserve. Nobody can take the
 * reserve out: not the owner, not the attester, not this contract's deployer. Money leaves only as daily payouts.
 *
 * FESTIVAL DAYS. Day 0 starts at `genesis`, UTC midnight of the deploy day; every day is DAY (86,400 seconds) long.
 * During a day the game counts Festival Points. After the day ends, the game's signer (the ATTESTER) signs a voucher
 * for each player: their SHARE of that day's pot, as a fraction with 18 decimals (1e18 = the whole pot). The shares
 * the game signs for one day add up to at most 1e18, and this contract enforces that limit too.
 *
 * HOW A DAY'S POT IS MADE. A day takes nothing from the reserve until someone claims it. The first claim of a day
 * CLOSES it: the day's pot is set to 1/DRIP_DIVISOR (1/30) of the ETH reserve and 1/30 of the token reserve at that
 * moment, and those amounts move out of the reserve into the day's pot. A day nobody claims never closes and takes
 * nothing. Because each pot is a fraction of what is left, the reserve never empties by itself.
 *
 * CLAIMING. A player sends the voucher with `claim` (or several with `claimMany`) and receives pot * share / 1e18
 * of the day's ETH pot and of its token pot. Each account can claim each day once. A day can be claimed from the
 * moment it ends until CLAIM_WINDOW (30 days) after it ends.
 *
 * EXPIRY. When a closed day's claim window is over, anyone may call `expire(day)`: whatever that day's pot did not
 * pay out goes back into the reserve, for later days.
 *
 * WHAT THE OWNER CAN DO: name the game token once (it can never be changed afterwards), and change the attester.
 * Ownership moves in two steps (the new owner must accept).
 * WHAT THE OWNER CANNOT DO: withdraw the reserve or a pot, change the pass price or length, the pot fraction, the
 * claim window or the day length, pause anything, or upgrade this contract. There is no admin withdrawal, no pause
 * and no proxy.
 *
 * WHAT THIS CONTRACT DOES NOT DO: it does not promise any amount. Payouts are only what was funded into the pot,
 * split by the shares the game signs. It holds no price, makes no trades and pays no interest.
 *
 * TRUST. The attester decides the shares. This contract checks the signature, the day, the claim window and the
 * 1e18 limit per day; it cannot check that the game counted the points fairly. Vouchers are checked against the
 * attester at the time of the claim: when the owner changes the attester, vouchers signed by the old one stop
 * working and the game must sign them again.
 */
contract AntworkFest is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ fixed rules

    /// Length of one festival day, in seconds. Festival days are UTC days.
    uint256 public constant DAY = 1 days;
    /// Game tokens one Festival Pass burns: 10,000 whole tokens of 18 decimals.
    uint256 public constant PASS_PRICE = 10_000e18;
    /// How long one Festival Pass lasts.
    uint256 public constant PASS_LENGTH = 30 days;
    /// The most passes one `buyPass` call can buy.
    uint256 public constant MAX_PASSES = 12;
    /// A day's pot is the reserve divided by this, taken when the day is first claimed.
    uint256 public constant DRIP_DIVISOR = 30;
    /// How long after its end a day can be claimed.
    uint256 public constant CLAIM_WINDOW = 30 days;
    /// A share of 1e18 is the whole pot of a day.
    uint256 public constant WAD = 1e18;
    /// Where pass tokens go: an address nobody holds the key to. Sent there, they are gone for good.
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    /// EIP-712 type of the voucher the attester signs.
    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(address account,uint256 day,uint256 share)");

    /// Start of day 0: UTC midnight of the day this contract was deployed.
    uint256 public immutable genesis;

    // ------------------------------------------------------------------ state

    /// The game token. Zero until the owner names it; then fixed for good.
    IERC20 private _token;
    /// The game's voucher signer.
    address public attester;

    /// When each account's Festival Pass runs out (a unix time; in the past or zero = no pass).
    mapping(address => uint256) public passUntil;
    /// Game tokens burned by passes, in all.
    uint256 public totalBurned;
    /// Passes bought, in all (each is PASS_LENGTH of festival).
    uint256 public passes;

    /// ETH in the pot that no day has taken yet.
    uint256 public reserveEth;
    /// Game tokens in the pot that no day has taken yet.
    uint256 public reserveToken;
    /// ETH sitting in closed days' pots, not paid out and not expired yet.
    uint256 public openEth;
    /// Game tokens sitting in closed days' pots, not paid out and not expired yet.
    uint256 public openToken;
    /// ETH ever put into the pot.
    uint256 public totalFundedEth;
    /// Game tokens ever put into the pot (what actually arrived).
    uint256 public totalFundedToken;

    /// One festival day's pot, in three storage slots. A pot is at most 2^128 - 1 base units of each asset (far above
    /// any real supply); anything a day would take above that simply stays in the reserve.
    struct Pot {
        uint128 eth; // the day's ETH pot, set when it closed
        uint128 token; // the day's token pot, set when it closed
        uint128 paidEth; // ETH paid out of it so far
        uint128 paidToken; // tokens paid out of it so far
        uint64 claimedShare; // sum of the shares claimed, at most 1e18
        uint32 claims; // number of claims
        bool closed; // the first claim happened and the pot was taken from the reserve
        bool expired; // the window ended and the unpaid rest went back to the reserve
    }

    mapping(uint256 => Pot) internal _pots;
    /// Which days each account has claimed: one bit per day, 256 days per word.
    mapping(address => mapping(uint256 => uint256)) internal _claimedDays;

    // ------------------------------------------------------------------ views (shapes)

    /// Everything about one festival day, for the game client.
    struct DayInfo {
        uint256 day;
        uint256 start; // unix time the day starts
        uint256 end; // unix time the day ends (claims open)
        uint256 claimUntil; // claims are accepted while block.timestamp < claimUntil
        bool ended;
        bool claimable; // ended, window open, not expired
        bool closed;
        bool expired;
        uint256 potEth; // closed: the pot; not closed: what it would be if it closed now (0 once the window is over)
        uint256 potToken;
        uint256 paidEth;
        uint256 paidToken;
        uint256 claimedShare;
        uint256 claims;
    }

    /// The whole contract at a glance, for the game client and the site.
    struct Status {
        address token;
        address owner;
        address pendingOwner;
        address attester;
        uint256 genesis;
        uint256 currentDay;
        uint256 timestamp;
        uint256 reserveEth;
        uint256 reserveToken;
        uint256 openEth;
        uint256 openToken;
        uint256 nextPotEth; // reserveEth / 30: the pot of a day closed now
        uint256 nextPotToken;
        uint256 totalFundedEth;
        uint256 totalFundedToken;
        uint256 totalPaidEth;
        uint256 totalPaidToken;
        uint256 totalBurned;
        uint256 passes;
    }

    // ------------------------------------------------------------------ events

    event PassBought(address indexed account, uint256 n, uint256 until, uint256 burned);
    event Funded(bytes32 indexed crew, address indexed from, uint256 eth, uint256 token);
    event DayClosed(uint256 indexed day, uint256 potEth, uint256 potToken);
    event Claimed(uint256 indexed day, address indexed account, uint256 share, uint256 eth, uint256 token);
    event Expired(uint256 indexed day, uint256 eth, uint256 token);
    event TokenSet(address indexed token);
    event AttesterSet(address indexed previous, address indexed attester);

    // ------------------------------------------------------------------ errors

    error ZeroAddress();
    error TokenAlreadySet();
    error BadToken();
    error NoToken();
    error BadCount();
    error NothingSent();
    error BadShare();
    error LengthMismatch();
    error DayNotOver(uint256 day);
    error WindowClosed(uint256 day);
    error WindowOpen(uint256 day);
    error AlreadyClaimed(uint256 day);
    error BadSignature();
    error OverClaimed(uint256 day);
    error NotClosed(uint256 day);
    error AlreadyExpired(uint256 day);
    error EthTransferFailed();

    /// @param owner_ the owner (can name the token once and change the attester)
    /// @param attester_ the game's voucher signer
    constructor(address owner_, address attester_) Ownable(owner_) EIP712("AntworkFest", "1") {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        genesis = block.timestamp - (block.timestamp % DAY);
        emit AttesterSet(address(0), attester_);
    }

    // ------------------------------------------------------------------ owner

    /// Name the game token, once. It must be an ERC-20 with 18 decimals. Nobody can change it afterwards.
    function setToken(address token_) external onlyOwner {
        if (address(_token) != address(0)) revert TokenAlreadySet();
        if (token_ == address(0) || token_.code.length == 0) revert BadToken();
        try IERC20Metadata(token_).decimals() returns (uint8 d) {
            if (d != 18) revert BadToken();
        } catch {
            revert BadToken();
        }
        _token = IERC20(token_);
        emit TokenSet(token_);
    }

    /// Change the game's voucher signer. Unclaimed vouchers signed by the old one stop working.
    function setAttester(address attester_) external onlyOwner {
        if (attester_ == address(0)) revert ZeroAddress();
        emit AttesterSet(attester, attester_);
        attester = attester_;
    }

    // ------------------------------------------------------------------ festival passes

    /// Burn n * PASS_PRICE game tokens for n * PASS_LENGTH of festival, added after the pass already held (or from
    /// now). Approve this contract for the tokens first. The tokens go to BURN, not to this contract.
    /// @return until the new end of the caller's pass
    function buyPass(uint256 n) external nonReentrant returns (uint256 until) {
        IERC20 t = _token;
        if (address(t) == address(0)) revert NoToken();
        if (n == 0 || n > MAX_PASSES) revert BadCount();
        uint256 from = passUntil[msg.sender];
        if (from < block.timestamp) from = block.timestamp;
        until = from + n * PASS_LENGTH;
        passUntil[msg.sender] = until;
        uint256 burned = n * PASS_PRICE;
        totalBurned += burned;
        passes += n;
        emit PassBought(msg.sender, n, until, burned);
        t.safeTransferFrom(msg.sender, BURN, burned);
    }

    /// Whether an account holds a running Festival Pass now.
    function hasPass(address account) external view returns (bool) {
        return passUntil[account] > block.timestamp;
    }

    // ------------------------------------------------------------------ the festival pot

    /// Put ETH into the pot in the name of a crew (a label only; zero for none). It joins the shared reserve.
    function fund(bytes32 crew) external payable {
        _fundEth(crew);
    }

    /// Plain ETH sent to this contract is funding with no crew label.
    receive() external payable {
        _fundEth(bytes32(0));
    }

    /// Put game tokens into the pot in the name of a crew. Approve this contract first. The reserve is credited with
    /// what actually arrived (the balance difference), not with `amount`.
    function fundToken(bytes32 crew, uint256 amount) external nonReentrant {
        IERC20 t = _token;
        if (address(t) == address(0)) revert NoToken();
        if (amount == 0) revert NothingSent();
        uint256 before = t.balanceOf(address(this));
        t.safeTransferFrom(msg.sender, address(this), amount);
        uint256 got = t.balanceOf(address(this)) - before;
        if (got == 0) revert NothingSent();
        reserveToken += got;
        totalFundedToken += got;
        emit Funded(crew, msg.sender, 0, got);
    }

    function _fundEth(bytes32 crew) internal {
        if (msg.value == 0) revert NothingSent();
        reserveEth += msg.value;
        totalFundedEth += msg.value;
        emit Funded(crew, msg.sender, msg.value, 0);
    }

    // ------------------------------------------------------------------ daily payouts

    /// Claim one festival day with the attester's voucher for the caller. Pays the caller pot * share / 1e18 of the
    /// day's ETH pot and of its token pot. The first claim of a day closes it (see the contract notes).
    /// @param day the festival day (0 = the deploy day)
    /// @param share the caller's share of that day's pot, 1e18 = all of it
    /// @param signature the attester's EIP-712 signature of Voucher(caller, day, share)
    function claim(uint256 day, uint256 share, bytes calldata signature)
        external
        nonReentrant
        returns (uint256 eth, uint256 tokenAmount)
    {
        (eth, tokenAmount) = _claim(day, share, signature);
        _pay(eth, tokenAmount);
    }

    /// Claim several festival days in one transaction. Same rules as `claim` for each; all or nothing.
    function claimMany(uint256[] calldata dayList, uint256[] calldata shares, bytes[] calldata signatures)
        external
        nonReentrant
        returns (uint256 eth, uint256 tokenAmount)
    {
        uint256 n = dayList.length;
        if (n == 0) revert BadCount();
        if (shares.length != n || signatures.length != n) revert LengthMismatch();
        for (uint256 i; i < n; ++i) {
            (uint256 e, uint256 t) = _claim(dayList[i], shares[i], signatures[i]);
            eth += e;
            tokenAmount += t;
        }
        _pay(eth, tokenAmount);
    }

    /// Return what a closed day did not pay out to the reserve, once its claim window is over. Anyone may call it.
    function expire(uint256 day) external nonReentrant returns (uint256 eth, uint256 tokenAmount) {
        if (day >= currentDay() || block.timestamp < claimDeadline(day)) revert WindowOpen(day);
        Pot storage p = _pots[day];
        if (!p.closed) revert NotClosed(day);
        if (p.expired) revert AlreadyExpired(day);
        p.expired = true;
        eth = uint256(p.eth) - p.paidEth;
        tokenAmount = uint256(p.token) - p.paidToken;
        openEth -= eth;
        openToken -= tokenAmount;
        reserveEth += eth;
        reserveToken += tokenAmount;
        emit Expired(day, eth, tokenAmount);
    }

    function _claim(uint256 day, uint256 share, bytes calldata signature)
        internal
        returns (uint256 eth, uint256 tokenAmount)
    {
        if (share == 0 || share > WAD) revert BadShare();
        if (day >= currentDay()) revert DayNotOver(day);
        if (block.timestamp >= claimDeadline(day)) revert WindowClosed(day);
        if (claimed(day, msg.sender)) revert AlreadyClaimed(day);
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecoverCalldata(voucherDigest(msg.sender, day, share), signature);
        if (err != ECDSA.RecoverError.NoError || signer != attester) revert BadSignature();

        Pot storage p = _pots[day];
        uint256 potEth;
        uint256 potToken;
        if (p.closed) {
            potEth = p.eth;
            potToken = p.token;
        } else {
            potEth = _cap(reserveEth / DRIP_DIVISOR);
            potToken = _cap(reserveToken / DRIP_DIVISOR);
            p.closed = true;
            p.eth = uint128(potEth);
            p.token = uint128(potToken);
            reserveEth -= potEth;
            reserveToken -= potToken;
            openEth += potEth;
            openToken += potToken;
            emit DayClosed(day, potEth, potToken);
        }
        uint256 sum = uint256(p.claimedShare) + share;
        if (sum > WAD) revert OverClaimed(day);
        p.claimedShare = uint64(sum);
        p.claims += 1;
        _claimedDays[msg.sender][day >> 8] |= 1 << (day & 255);

        // Rounded down, so the claims of a day can never add up to more than its pot.
        eth = (potEth * share) / WAD;
        tokenAmount = (potToken * share) / WAD;
        p.paidEth += uint128(eth);
        p.paidToken += uint128(tokenAmount);
        openEth -= eth;
        openToken -= tokenAmount;
        emit Claimed(day, msg.sender, share, eth, tokenAmount);
    }

    function _cap(uint256 amount) internal pure returns (uint256) {
        return amount > type(uint128).max ? type(uint128).max : amount;
    }

    function _pay(uint256 eth, uint256 tokenAmount) internal {
        if (tokenAmount > 0) _token.safeTransfer(msg.sender, tokenAmount);
        if (eth > 0) {
            (bool ok,) = payable(msg.sender).call{value: eth}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    // ------------------------------------------------------------------ views

    /// The game token (zero until the owner names it).
    function token() external view returns (address) {
        return address(_token);
    }

    /// Whether `account` has claimed `day`.
    function claimed(uint256 day, address account) public view returns (bool) {
        return (_claimedDays[account][day >> 8] >> (day & 255)) & 1 == 1;
    }

    /// ETH ever paid out: everything funded that is neither in the reserve nor in an open pot.
    function totalPaidEth() public view returns (uint256) {
        return totalFundedEth - reserveEth - openEth;
    }

    /// Game tokens ever paid out.
    function totalPaidToken() public view returns (uint256) {
        return totalFundedToken - reserveToken - openToken;
    }

    /// The festival day now: 0 on the deploy day, then one more every UTC midnight.
    function currentDay() public view returns (uint256) {
        return (block.timestamp - genesis) / DAY;
    }

    /// Claims of `day` are accepted while block.timestamp is below this.
    function claimDeadline(uint256 day) public view returns (uint256) {
        return genesis + (day + 1) * DAY + CLAIM_WINDOW;
    }

    /// The EIP-712 digest the attester signs for Voucher(account, day, share) on this contract and chain.
    function voucherDigest(address account, uint256 day, uint256 share) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, account, day, share)));
    }

    /// The EIP-712 domain separator (name AntworkFest, version 1, this chain, this contract).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// Everything about one festival day.
    function dayInfo(uint256 day) external view returns (DayInfo memory d) {
        Pot storage p = _pots[day];
        d.day = day;
        d.start = genesis + day * DAY;
        d.end = d.start + DAY;
        d.claimUntil = d.end + CLAIM_WINDOW;
        d.ended = block.timestamp >= d.end;
        d.claimable = d.ended && block.timestamp < d.claimUntil && !p.expired;
        d.closed = p.closed;
        d.expired = p.expired;
        if (p.closed) {
            d.potEth = p.eth;
            d.potToken = p.token;
        } else if (block.timestamp < d.claimUntil) {
            d.potEth = _cap(reserveEth / DRIP_DIVISOR);
            d.potToken = _cap(reserveToken / DRIP_DIVISOR);
        }
        d.paidEth = p.paidEth;
        d.paidToken = p.paidToken;
        d.claimedShare = p.claimedShare;
        d.claims = p.claims;
    }

    /// What a claim of `share` for `day` would pay now (ETH, tokens). Zero when such a claim would be refused for
    /// a reason of the day itself (not ended, window over, share out of range or over the day's 1e18). It does not
    /// check the voucher or whether the account already claimed (see `claimed`).
    function quote(uint256 day, uint256 share) external view returns (uint256 eth, uint256 tokenAmount) {
        if (share == 0 || share > WAD || day >= currentDay() || block.timestamp >= claimDeadline(day)) return (0, 0);
        Pot storage p = _pots[day];
        uint256 potEth;
        uint256 potToken;
        if (p.closed) {
            if (uint256(p.claimedShare) + share > WAD) return (0, 0);
            potEth = p.eth;
            potToken = p.token;
        } else {
            potEth = _cap(reserveEth / DRIP_DIVISOR);
            potToken = _cap(reserveToken / DRIP_DIVISOR);
        }
        eth = (potEth * share) / WAD;
        tokenAmount = (potToken * share) / WAD;
    }

    /// The whole contract at a glance.
    function status() external view returns (Status memory s) {
        s.token = address(_token);
        s.owner = owner();
        s.pendingOwner = pendingOwner();
        s.attester = attester;
        s.genesis = genesis;
        s.currentDay = currentDay();
        s.timestamp = block.timestamp;
        s.reserveEth = reserveEth;
        s.reserveToken = reserveToken;
        s.openEth = openEth;
        s.openToken = openToken;
        s.nextPotEth = _cap(reserveEth / DRIP_DIVISOR);
        s.nextPotToken = _cap(reserveToken / DRIP_DIVISOR);
        s.totalFundedEth = totalFundedEth;
        s.totalFundedToken = totalFundedToken;
        s.totalPaidEth = totalPaidEth();
        s.totalPaidToken = totalPaidToken();
        s.totalBurned = totalBurned;
        s.passes = passes;
    }
}
