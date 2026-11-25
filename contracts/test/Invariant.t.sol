// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AntworkFest} from "../src/AntworkFest.sol";
import {MockAntwork} from "../src/mocks/MockAntwork.sol";

/// Drives the contract with several players over many days: funding, passes, claims (single and many), time and
/// expiries. Every call is wrapped in try/catch: a revert with one of the contract's documented errors is fine,
/// anything else (a Panic such as an underflow, an empty revert) is recorded and fails the run.
contract Handler is Test {
    uint256 constant WAD = 1e18;
    AntworkFest public f;
    MockAntwork public tok;
    uint256 internal attesterKey;
    address[] public actors;

    /// the clock, kept here: under via-ir a test may reuse an earlier block.timestamp after vm.warp
    uint256 public clock;
    uint256 public maxDay;
    uint256 public ghostPaidEth;
    uint256 public ghostPaidToken;
    uint256 public ghostFundedEth;
    uint256 public ghostFundedToken;
    uint256 public ghostBurned;
    uint256 public unexpected;
    uint256 public okClaims;
    uint256 public okExpires;
    mapping(bytes4 => uint256) public calls;

    constructor(AntworkFest f_, MockAntwork tok_, uint256 key_, address[] memory actors_, uint256 clock_) {
        f = f_;
        tok = tok_;
        attesterKey = key_;
        actors = actors_;
        clock = clock_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _allowed(bytes memory err) internal pure returns (bool) {
        if (err.length < 4) return false;
        bytes4 s = bytes4(err);
        return s == AntworkFest.AlreadyClaimed.selector || s == AntworkFest.OverClaimed.selector
            || s == AntworkFest.WindowClosed.selector || s == AntworkFest.DayNotOver.selector
            || s == AntworkFest.WindowOpen.selector || s == AntworkFest.NotClosed.selector
            || s == AntworkFest.AlreadyExpired.selector || s == AntworkFest.BadCount.selector;
    }

    function _bad(bytes memory err) internal {
        if (_allowed(err)) return;
        unexpected++;
        emit log_named_bytes("UNEXPECTED REVERT", err);
    }

    function _sig(address who, uint256 day, uint256 share) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, f.voucherDigest(who, day, share));
        return abi.encodePacked(r, s, v);
    }

    /// a day that has ended, up to 34 days back (some of them past their window)
    function _pastDay(uint256 seed) internal view returns (bool ok, uint256 day) {
        uint256 today = f.currentDay();
        if (today == 0) return (false, 0);
        uint256 span = today < 34 ? today : 34;
        return (true, today - 1 - (seed % span));
    }

    // ------------------------------------------------------------------ actions

    function fundEth(uint256 seed, uint256 amount) external {
        calls[this.fundEth.selector]++;
        address a = _actor(seed);
        amount = bound(amount, 1, 100 ether);
        vm.deal(a, a.balance + amount);
        vm.prank(a);
        try f.fund{value: amount}(bytes32(seed)) {
            ghostFundedEth += amount;
        } catch (bytes memory err) {
            _bad(err);
        }
    }

    function fundToken(uint256 seed, uint256 amount) external {
        calls[this.fundToken.selector]++;
        address a = _actor(seed);
        amount = bound(amount, 1, 1_000_000e18);
        tok.mint(a, amount);
        vm.prank(a);
        try f.fundToken(bytes32(seed), amount) {
            ghostFundedToken += amount;
        } catch (bytes memory err) {
            _bad(err);
        }
    }

    function buyPass(uint256 seed, uint256 n) external {
        calls[this.buyPass.selector]++;
        address a = _actor(seed);
        n = bound(n, 1, 12);
        tok.mint(a, n * 10_000e18);
        uint256 before = f.passUntil(a);
        vm.prank(a);
        try f.buyPass(n) returns (uint256 until) {
            ghostBurned += n * 10_000e18;
            uint256 from = before > clock ? before : clock;
            if (until != from + n * 30 days) {
                unexpected++;
                emit log("pass end is not max(now, old end) + n * 30 days");
            }
        } catch (bytes memory err) {
            _bad(err);
        }
    }

    function claim(uint256 seed, uint256 daySeed, uint256 share) external {
        calls[this.claim.selector]++;
        (bool ok, uint256 day) = _pastDay(daySeed);
        if (!ok) return;
        address a = _actor(seed);
        share = seed % 3 == 0 ? bound(share, 1, WAD) : bound(share, 1, WAD / 5);
        bytes memory sig = _sig(a, day, share);
        uint256 balE = a.balance;
        uint256 balT = tok.balanceOf(a);
        vm.prank(a);
        try f.claim(day, share, sig) returns (uint256 e, uint256 t) {
            ghostPaidEth += e;
            ghostPaidToken += t;
            okClaims++;
            if (day > maxDay) maxDay = day;
            if (a.balance != balE + e || tok.balanceOf(a) != balT + t) {
                unexpected++;
                emit log("claim paid something else than it returned");
            }
        } catch (bytes memory err) {
            _bad(err);
        }
    }

    function claimMany(uint256 seed, uint256 daySeed, uint256 share) external {
        calls[this.claimMany.selector]++;
        uint256 n = 1 + (seed % 4);
        uint256[] memory d = new uint256[](n);
        uint256[] memory s = new uint256[](n);
        bytes[] memory g = new bytes[](n);
        address a = _actor(seed >> 8);
        for (uint256 i; i < n; ++i) {
            (bool ok, uint256 day) = _pastDay(uint256(keccak256(abi.encode(daySeed, i))));
            if (!ok) return;
            d[i] = day;
            s[i] = bound(uint256(keccak256(abi.encode(share, i))), 1, WAD / 5);
            g[i] = _sig(a, day, s[i]);
        }
        vm.prank(a);
        try f.claimMany(d, s, g) returns (uint256 e, uint256 t) {
            ghostPaidEth += e;
            ghostPaidToken += t;
            okClaims += n;
            for (uint256 i; i < n; ++i) {
                if (d[i] > maxDay) maxDay = d[i];
            }
        } catch (bytes memory err) {
            _bad(err);
        }
    }

    function expire(uint256 daySeed) external {
        calls[this.expire.selector]++;
        uint256 today = f.currentDay();
        uint256 day;
        if (today >= 32 && daySeed % 4 != 0) {
            // mostly the days whose window just ended, where closed days are waiting
            uint256 span = today - 31 < 10 ? today - 31 : 10;
            day = today - 32 - ((daySeed >> 2) % span);
        } else {
            bool ok;
            (ok, day) = _pastDay(daySeed);
            if (!ok) return;
        }
        try f.expire(day) {
            okExpires++;
        } catch (bytes memory err) {
            _bad(err);
        }
    }

    function warp(uint256 secs) external {
        calls[this.warp.selector]++;
        clock += bound(secs, 10 minutes, 9 days);
        vm.warp(clock);
    }
}

/// The money invariants: the contract holds exactly the reserve plus what closed days still owe, in ETH and in the
/// token; nothing is created or lost; no day pays more than its pot; every burn reached the dead address.
contract InvariantTest is Test {
    uint256 constant WAD = 1e18;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    AntworkFest f;
    MockAntwork tok;
    Handler h;

    function setUp() public {
        uint256 t0 = 1_800_000_000;
        vm.warp(t0);
        (address attester, uint256 key) = makeAddrAndKey("attester");
        address owner = makeAddr("owner");
        f = new AntworkFest(owner, attester);
        tok = new MockAntwork("Antwork", "ANTWORK", 18);
        vm.prank(owner);
        f.setToken(address(tok));
        address[] memory actors = new address[](5);
        for (uint256 i; i < 5; ++i) {
            actors[i] = makeAddr(string.concat("player", vm.toString(i)));
            vm.prank(actors[i]);
            tok.approve(address(f), type(uint256).max);
        }
        h = new Handler(f, tok, key, actors, t0);
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = Handler.fundEth.selector;
        sel[1] = Handler.fundToken.selector;
        sel[2] = Handler.buyPass.selector;
        sel[3] = Handler.claim.selector;
        sel[4] = Handler.claim.selector; // claims twice as often
        sel[5] = Handler.claimMany.selector;
        sel[6] = Handler.expire.selector;
        sel[7] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// contract ETH balance == reserveEth + the unpaid ETH of closed, unexpired days (and the same for the token),
    /// with the sum over days computed here from dayInfo, not from the contract's own openEth/openToken.
    function invariant_balancesAreReservePlusOpenPots() public view {
        uint256 sumEth;
        uint256 sumTok;
        uint256 last = h.maxDay();
        for (uint256 d; d <= last; ++d) {
            AntworkFest.DayInfo memory i = f.dayInfo(d);
            if (i.closed && !i.expired) {
                sumEth += i.potEth - i.paidEth;
                sumTok += i.potToken - i.paidToken;
            }
        }
        assertEq(address(f).balance, f.reserveEth() + sumEth, "ETH balance");
        assertEq(tok.balanceOf(address(f)), f.reserveToken() + sumTok, "token balance");
        assertEq(f.openEth(), sumEth, "openEth");
        assertEq(f.openToken(), sumTok, "openToken");
    }

    function invariant_nothingCreatedOrLost() public view {
        assertEq(f.totalFundedEth(), h.ghostFundedEth());
        assertEq(f.totalFundedToken(), h.ghostFundedToken());
        assertEq(f.totalPaidEth(), h.ghostPaidEth());
        assertEq(f.totalPaidToken(), h.ghostPaidToken());
        assertEq(f.totalFundedEth(), f.reserveEth() + f.openEth() + f.totalPaidEth());
        assertEq(f.totalFundedToken(), f.reserveToken() + f.openToken() + f.totalPaidToken());
    }

    function invariant_noDayPaysMoreThanItsPot() public view {
        uint256 last = h.maxDay();
        for (uint256 d; d <= last; ++d) {
            AntworkFest.DayInfo memory i = f.dayInfo(d);
            assertLe(i.claimedShare, WAD);
            if (!i.closed) {
                assertEq(i.paidEth, 0);
                assertEq(i.claims, 0);
                continue;
            }
            assertLe(i.paidEth, i.potEth);
            assertLe(i.paidToken, i.potToken);
            assertLe(i.paidEth, (i.potEth * i.claimedShare) / WAD);
        }
    }

    function invariant_burnsReachedTheDeadAddress() public view {
        assertEq(tok.balanceOf(DEAD), f.totalBurned());
        assertEq(f.totalBurned(), h.ghostBurned());
        assertEq(f.totalBurned(), f.passes() * 10_000e18);
    }

    function invariant_noUnexpectedReverts() public view {
        assertEq(h.unexpected(), 0);
    }

    /// Totals over one run, to see that runs reach paid claims and expiries (forge test -vv shows them).
    function afterInvariant() external {
        emit log_named_uint("paid claims", h.okClaims());
        emit log_named_uint("expiries", h.okExpires());
        emit log_named_uint("days", f.currentDay());
    }
}
