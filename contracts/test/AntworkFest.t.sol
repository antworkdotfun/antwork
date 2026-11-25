// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base} from "./Base.t.sol";
import {AntworkFest} from "../src/AntworkFest.sol";
import {MockAntwork} from "../src/mocks/MockAntwork.sol";
import {FeeToken, NoDecimals, EthRefuser, Reenterer} from "./mocks/Mocks.sol";

/// Every function and every revert of AntworkFest, one behaviour per test.
contract AntworkFestTest is Base {
    event PassBought(address indexed account, uint256 n, uint256 until, uint256 burned);
    event Funded(bytes32 indexed crew, address indexed from, uint256 eth, uint256 token);
    event DayClosed(uint256 indexed day, uint256 potEth, uint256 potToken);
    event Claimed(uint256 indexed day, address indexed account, uint256 share, uint256 eth, uint256 token);
    event Expired(uint256 indexed day, uint256 eth, uint256 token);
    event TokenSet(address indexed token);
    event AttesterSet(address indexed previous, address indexed attester);

    // ------------------------------------------------------------------ constructor and constants

    function test_constructor_genesisIsUtcMidnightOfTheDeployDay() public view {
        assertEq(f.genesis(), T0);
        assertEq(f.genesis() % DAY, 0);
        assertEq(f.currentDay(), 0);
        assertEq(f.owner(), owner);
        assertEq(f.attester(), attester);
        assertEq(f.token(), address(0));
        assertEq(f.pendingOwner(), address(0));
    }

    function test_constructor_atExactMidnight() public {
        vm.warp(T0 + 7 * DAY);
        AntworkFest g = new AntworkFest(owner, attester);
        assertEq(g.genesis(), T0 + 7 * DAY);
        vm.warp(T0 + 8 * DAY - 1);
        AntworkFest h = new AntworkFest(owner, attester);
        assertEq(h.genesis(), T0 + 7 * DAY);
    }

    function test_constructor_refusesZeroAttester() public {
        vm.expectRevert(AntworkFest.ZeroAddress.selector);
        new AntworkFest(owner, address(0));
    }

    function test_constructor_refusesZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new AntworkFest(address(0), attester);
    }

    function test_constructor_emitsAttesterSet() public {
        vm.expectEmit(true, true, false, false);
        emit AttesterSet(address(0), attester);
        new AntworkFest(owner, attester);
    }

    function test_constants() public view {
        assertEq(f.DAY(), 86_400);
        assertEq(f.PASS_PRICE(), 10_000e18);
        assertEq(f.PASS_LENGTH(), 30 days);
        assertEq(f.MAX_PASSES(), 12);
        assertEq(f.DRIP_DIVISOR(), 30);
        assertEq(f.CLAIM_WINDOW(), 30 days);
        assertEq(f.WAD(), 1e18);
        assertEq(f.BURN(), DEAD);
        assertEq(f.VOUCHER_TYPEHASH(), keccak256("Voucher(address account,uint256 day,uint256 share)"));
    }

    function test_codeFitsRobinhoodChain() public view {
        // Robinhood Chain takes contract code up to 98,304 bytes (foundry.toml code_size_limit); this one is far below
        // even the 24,576 of Ethereum mainnet, so it deploys anywhere.
        assertLt(address(f).code.length, 24_576);
    }

    function test_eip712Domain() public view {
        (bytes1 fields, string memory name, string memory version, uint256 chainId, address vc,,) = f.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "AntworkFest");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(f));
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AntworkFest"),
                keccak256("1"),
                block.chainid,
                address(f)
            )
        );
        assertEq(f.domainSeparator(), ds);
    }

    // ------------------------------------------------------------------ owner: token

    function test_setToken_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        f.setToken(address(tok));
    }

    function test_setToken_once() public {
        vm.expectEmit(true, false, false, false);
        emit TokenSet(address(tok));
        _setToken();
        assertEq(f.token(), address(tok));
        MockAntwork other = new MockAntwork("Other", "OTHER", 18);
        vm.prank(owner);
        vm.expectRevert(AntworkFest.TokenAlreadySet.selector);
        f.setToken(address(other));
        vm.prank(owner);
        vm.expectRevert(AntworkFest.TokenAlreadySet.selector);
        f.setToken(address(tok));
    }

    function test_setToken_refusesZeroAndNonContracts() public {
        vm.startPrank(owner);
        vm.expectRevert(AntworkFest.BadToken.selector);
        f.setToken(address(0));
        vm.expectRevert(AntworkFest.BadToken.selector);
        f.setToken(alice);
        vm.stopPrank();
    }

    function test_setToken_refusesOtherDecimals() public {
        MockAntwork six = new MockAntwork("Six", "SIX", 6);
        vm.prank(owner);
        vm.expectRevert(AntworkFest.BadToken.selector);
        f.setToken(address(six));
    }

    function test_setToken_refusesNoDecimals() public {
        NoDecimals nd = new NoDecimals();
        vm.prank(owner);
        vm.expectRevert(AntworkFest.BadToken.selector);
        f.setToken(address(nd));
    }

    // ------------------------------------------------------------------ owner: attester and ownership

    function test_setAttester_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        f.setAttester(alice);
    }

    function test_setAttester_refusesZero() public {
        vm.prank(owner);
        vm.expectRevert(AntworkFest.ZeroAddress.selector);
        f.setAttester(address(0));
    }

    function test_setAttester_oldVouchersStopNewOnesWork() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        bytes memory oldSig = _sig(alice, 0, WAD / 2);
        (address a2, uint256 k2) = makeAddrAndKey("attester 2");
        vm.expectEmit(true, true, false, false);
        emit AttesterSet(attester, a2);
        vm.prank(owner);
        f.setAttester(a2);
        assertEq(f.attester(), a2);
        vm.prank(alice);
        vm.expectRevert(AntworkFest.BadSignature.selector);
        f.claim(0, WAD / 2, oldSig);
        bytes memory newSig = _sigWith(k2, f, alice, 0, WAD / 2);
        vm.prank(alice);
        (uint256 eth,) = f.claim(0, WAD / 2, newSig);
        assertEq(eth, 0.5 ether);
    }

    function test_ownership_twoStep() public {
        vm.prank(owner);
        f.transferOwnership(bob);
        assertEq(f.owner(), owner);
        assertEq(f.pendingOwner(), bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        f.acceptOwnership();
        vm.prank(bob);
        f.acceptOwnership();
        assertEq(f.owner(), bob);
        assertEq(f.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        f.setAttester(alice);
    }

    // ------------------------------------------------------------------ passes

    function test_buyPass_needsTheToken() public {
        vm.prank(alice);
        vm.expectRevert(AntworkFest.NoToken.selector);
        f.buyPass(1);
    }

    function test_buyPass_countBounds() public {
        _setToken();
        vm.startPrank(alice);
        vm.expectRevert(AntworkFest.BadCount.selector);
        f.buyPass(0);
        vm.expectRevert(AntworkFest.BadCount.selector);
        f.buyPass(13);
        f.buyPass(12);
        vm.stopPrank();
        assertEq(f.passUntil(alice), block.timestamp + 12 * 30 days);
    }

    function test_buyPass_burnsToDeadAndStartsNow() public {
        _setToken();
        uint256 before = tok.balanceOf(alice);
        vm.expectEmit(true, false, false, true);
        emit PassBought(alice, 1, block.timestamp + 30 days, PRICE);
        vm.prank(alice);
        uint256 until = f.buyPass(1);
        assertEq(until, block.timestamp + 30 days);
        assertEq(f.passUntil(alice), until);
        assertEq(tok.balanceOf(alice), before - PRICE);
        assertEq(tok.balanceOf(DEAD), PRICE);
        assertEq(tok.balanceOf(address(f)), 0, "the contract keeps nothing");
        assertEq(f.totalBurned(), PRICE);
        assertEq(f.passes(), 1);
        assertTrue(f.hasPass(alice));
        assertFalse(f.hasPass(bob));
    }

    function test_buyPass_stacksOnTheRunningOne() public {
        _setToken();
        vm.prank(alice);
        uint256 a = f.buyPass(1);
        vm.warp(block.timestamp + 10 days);
        vm.prank(alice);
        uint256 b = f.buyPass(2);
        assertEq(b, a + 60 days);
        assertEq(f.totalBurned(), 3 * PRICE);
        assertEq(f.passes(), 3);
        assertEq(tok.balanceOf(DEAD), 3 * PRICE);
    }

    function test_buyPass_afterExpiryStartsFromNow() public {
        _setToken();
        vm.prank(alice);
        uint256 a = f.buyPass(1);
        vm.warp(a);
        assertFalse(f.hasPass(alice), "ends exactly at passUntil");
        vm.warp(a + 5 days);
        vm.prank(alice);
        uint256 b = f.buyPass(1);
        assertEq(b, a + 5 days + 30 days);
    }

    function test_buyPass_needsAllowanceAndBalance() public {
        _setToken();
        vm.prank(alice);
        tok.approve(address(f), PRICE - 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(f), PRICE - 1, PRICE)
        );
        f.buyPass(1);
        address poor = makeAddr("poor");
        vm.prank(poor);
        tok.approve(address(f), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, poor, 0, PRICE));
        f.buyPass(1);
    }

    // ------------------------------------------------------------------ funding

    function test_fund_creditsTheReserve() public {
        vm.expectEmit(true, true, false, true);
        emit Funded(bytes32("HACKHALL"), alice, 2 ether, 0);
        _fundEth(alice, 2 ether);
        assertEq(f.reserveEth(), 2 ether);
        assertEq(f.totalFundedEth(), 2 ether);
        assertEq(address(f).balance, 2 ether);
    }

    function test_fund_refusesZero() public {
        vm.prank(alice);
        vm.expectRevert(AntworkFest.NothingSent.selector);
        f.fund{value: 0}(bytes32("X"));
    }

    function test_fund_worksBeforeTheToken() public {
        assertEq(f.token(), address(0));
        _fundEth(alice, 1 ether);
        assertEq(f.reserveEth(), 1 ether);
    }

    function test_receive_isFundingWithNoCrew() public {
        vm.expectEmit(true, true, false, true);
        emit Funded(bytes32(0), bob, 1 ether, 0);
        vm.prank(bob);
        (bool ok,) = address(f).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(f.reserveEth(), 1 ether);
        vm.prank(bob);
        (ok,) = address(f).call{value: 0}("");
        assertFalse(ok, "zero is refused");
    }

    function test_fundToken_needsTheToken() public {
        vm.prank(alice);
        vm.expectRevert(AntworkFest.NoToken.selector);
        f.fundToken(bytes32("X"), 1e18);
    }

    function test_fundToken_refusesZero() public {
        _setToken();
        vm.prank(alice);
        vm.expectRevert(AntworkFest.NothingSent.selector);
        f.fundToken(bytes32("X"), 0);
    }

    function test_fundToken_creditsTheReserve() public {
        _setToken();
        vm.expectEmit(true, true, false, true);
        emit Funded(bytes32("HACKHALL"), alice, 0, 500e18);
        _fundToken(alice, 500e18);
        assertEq(f.reserveToken(), 500e18);
        assertEq(f.totalFundedToken(), 500e18);
        assertEq(tok.balanceOf(address(f)), 500e18);
    }

    function test_fundToken_creditsWhatArrived() public {
        FeeToken ft = new FeeToken();
        AntworkFest g = new AntworkFest(owner, attester);
        vm.prank(owner);
        g.setToken(address(ft));
        ft.mint(alice, 1000e18);
        vm.startPrank(alice);
        ft.approve(address(g), type(uint256).max);
        g.fundToken(bytes32("X"), 100e18);
        vm.stopPrank();
        assertEq(g.reserveToken(), 90e18);
        assertEq(ft.balanceOf(address(g)), 90e18);
    }

    // ------------------------------------------------------------------ claims: the day and the share

    function test_claim_refusesTheDayInProgress() public {
        _fundEth(carol, 30 ether);
        bytes memory sig = _sig(alice, 0, WAD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.DayNotOver.selector, 0));
        f.claim(0, WAD, sig);
        _toDay(0, DAY - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.DayNotOver.selector, 0));
        f.claim(0, WAD, sig);
        _toDay(1, 0);
        vm.prank(alice);
        f.claim(0, WAD, sig);
    }

    function test_claim_refusesFutureDays() public {
        bytes memory sig = _sig(alice, 5, WAD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.DayNotOver.selector, 5));
        f.claim(5, WAD, sig);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.DayNotOver.selector, type(uint256).max));
        f.claim(type(uint256).max, WAD, sig);
    }

    function test_claim_refusesBadShares() public {
        _toDay(1, 0);
        bytes memory s0 = _sig(alice, 0, 0);
        bytes memory s1 = _sig(alice, 0, WAD + 1);
        vm.startPrank(alice);
        vm.expectRevert(AntworkFest.BadShare.selector);
        f.claim(0, 0, s0);
        vm.expectRevert(AntworkFest.BadShare.selector);
        f.claim(0, WAD + 1, s1);
        vm.stopPrank();
    }

    function test_claim_windowEndsThirtyDaysAfterTheDay() public {
        _fundEth(carol, 30 ether);
        uint256 deadline = f.claimDeadline(0);
        assertEq(deadline, f.genesis() + DAY + 30 days);
        bytes memory sa = _sig(alice, 0, WAD / 2);
        bytes memory sb = _sig(bob, 0, WAD / 2);
        vm.warp(deadline - 1);
        vm.prank(alice);
        f.claim(0, WAD / 2, sa);
        vm.warp(deadline);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.WindowClosed.selector, 0));
        f.claim(0, WAD / 2, sb);
    }

    function test_claim_onceAndOnlyOncePerAccountAndDay() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        _claim(alice, 0, WAD / 4);
        assertTrue(f.claimed(0, alice));
        bytes memory sig = _sig(alice, 0, WAD / 4);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.AlreadyClaimed.selector, 0));
        f.claim(0, WAD / 4, sig);
        // another share for the same day is refused too
        bytes memory sig2 = _sig(alice, 0, WAD / 8);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.AlreadyClaimed.selector, 0));
        f.claim(0, WAD / 8, sig2);
    }

    function test_claim_sharesOfADayNeverPassOne() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        _claim(alice, 0, 0.6e18);
        bytes memory sig = _sig(bob, 0, 0.5e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.OverClaimed.selector, 0));
        f.claim(0, 0.5e18, sig);
        _claim(bob, 0, 0.4e18); // exactly up to one
        assertEq(f.dayInfo(0).claimedShare, WAD);
        assertEq(f.dayInfo(0).paidEth, 1 ether);
        assertEq(f.openEth(), 0);
    }

    // ------------------------------------------------------------------ claims: the money

    function test_claim_firstClaimClosesTheDay() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        bytes memory sig = _sig(alice, 0, 0.25e18);
        vm.expectEmit(true, false, false, true);
        emit DayClosed(0, 1 ether, 0);
        vm.expectEmit(true, true, false, true);
        emit Claimed(0, alice, 0.25e18, 0.25 ether, 0);
        uint256 before = alice.balance;
        vm.prank(alice);
        (uint256 eth, uint256 t) = f.claim(0, 0.25e18, sig);
        assertEq(eth, 0.25 ether);
        assertEq(t, 0);
        assertEq(alice.balance, before + 0.25 ether);
        assertEq(f.reserveEth(), 29 ether);
        assertEq(f.openEth(), 0.75 ether);
        assertEq(f.totalPaidEth(), 0.25 ether);
        AntworkFest.DayInfo memory d = f.dayInfo(0);
        assertTrue(d.closed);
        assertEq(d.potEth, 1 ether);
        assertEq(d.paidEth, 0.25 ether);
        assertEq(d.claimedShare, 0.25e18);
        assertEq(d.claims, 1);
        assertEq(address(f).balance, f.reserveEth() + f.openEth());
    }

    function test_claim_laterClaimsUseTheSamePot() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        _claim(alice, 0, 0.25e18);
        _fundEth(carol, 300 ether); // more funding after the day closed changes nothing for it
        (uint256 eth,) = _claim(bob, 0, 0.5e18);
        assertEq(eth, 0.5 ether);
        assertEq(f.dayInfo(0).potEth, 1 ether);
        assertEq(f.reserveEth(), 329 ether);
    }

    function test_claim_potIsTakenAtTheFirstClaimNotAtTheDayEnd() public {
        _fundEth(carol, 30 ether);
        _toDay(3, 0);
        _fundEth(carol, 30 ether); // days 0..2 are over but nobody claimed: they took nothing
        assertEq(f.reserveEth(), 60 ether);
        (uint256 eth,) = _claim(alice, 1, WAD);
        assertEq(eth, 2 ether);
        assertEq(f.reserveEth(), 58 ether);
        (eth,) = _claim(alice, 0, WAD);
        assertEq(eth, uint256(58 ether) / 30);
    }

    function test_claim_paysTheTokenPotToo() public {
        _setToken();
        _fundEth(carol, 3 ether);
        _fundToken(carol, 3000e18);
        _toDay(1, 0);
        uint256 tb = tok.balanceOf(alice);
        (uint256 eth, uint256 t) = _claim(alice, 0, 0.5e18);
        assertEq(eth, 0.05 ether);
        assertEq(t, 50e18);
        assertEq(tok.balanceOf(alice), tb + 50e18);
        assertEq(f.reserveToken(), 2900e18);
        assertEq(f.openToken(), 50e18);
        assertEq(f.totalPaidToken(), 50e18);
        assertEq(tok.balanceOf(address(f)), f.reserveToken() + f.openToken());
    }

    function test_claim_emptyPotPaysZeroButCountsTheClaim() public {
        _toDay(1, 0);
        (uint256 eth, uint256 t) = _claim(alice, 0, WAD / 2);
        assertEq(eth, 0);
        assertEq(t, 0);
        assertTrue(f.dayInfo(0).closed);
        assertTrue(f.claimed(0, alice));
    }

    function test_claim_aDayNobodyClaimsTakesNothing() public {
        _fundEth(carol, 30 ether);
        _toDay(100, 0);
        assertEq(f.reserveEth(), 30 ether);
        assertEq(f.openEth(), 0);
        AntworkFest.DayInfo memory d = f.dayInfo(5);
        assertFalse(d.closed);
        assertFalse(d.claimable, "its window is over");
        assertEq(d.potEth, 0, "and it can no longer take anything");
    }

    function test_claim_refusingEthRevertsTheClaim() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        EthRefuser r = new EthRefuser();
        bytes memory sig = _sig(address(r), 0, WAD);
        vm.expectRevert(AntworkFest.EthTransferFailed.selector);
        r.claim(f, 0, WAD, sig);
        assertFalse(f.claimed(0, address(r)));
        assertEq(f.reserveEth(), 30 ether, "all undone");
    }

    function test_claim_reentryFromThePaymentIsRefused() public {
        _fundEth(carol, 30 ether);
        _toDay(5, 0);
        Reenterer r = new Reenterer();
        for (uint8 mode = 1; mode <= 3; ++mode) {
            uint256 day = mode - 1;
            bytes memory sig = _sig(address(r), day, 0.1e18);
            r.arm(f, day, 0.1e18, sig, mode);
            r.go();
            assertTrue(r.reverted(), "the inner call failed");
            assertEq(r.reason(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            assertEq(f.dayInfo(day).claims, 1);
        }
    }

    // ------------------------------------------------------------------ claimMany

    function test_claimMany_paysTheSum() public {
        _setToken();
        _fundEth(carol, 30 ether);
        _fundToken(carol, 30_000e18);
        _toDay(3, 0);
        uint256[] memory d = new uint256[](3);
        uint256[] memory s = new uint256[](3);
        bytes[] memory g = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            d[i] = i;
            s[i] = WAD;
            g[i] = _sig(alice, i, WAD);
        }
        uint256 before = alice.balance;
        vm.prank(alice);
        (uint256 eth, uint256 t) = f.claimMany(d, s, g);
        // 1/30 of what is left, three times
        uint256 re = 30 ether;
        uint256 rt = 30_000e18;
        uint256 we;
        uint256 wt;
        for (uint256 i; i < 3; ++i) {
            we += re / 30;
            wt += rt / 30;
            re -= re / 30;
            rt -= rt / 30;
        }
        assertEq(eth, we);
        assertEq(t, wt);
        assertEq(alice.balance, before + eth);
        assertEq(f.reserveEth(), re);
        assertEq(f.reserveToken(), rt);
        assertTrue(f.claimed(0, alice) && f.claimed(1, alice) && f.claimed(2, alice));
    }

    function test_claimMany_refusesEmptyAndMismatch() public {
        uint256[] memory d = new uint256[](0);
        uint256[] memory s = new uint256[](0);
        bytes[] memory g = new bytes[](0);
        vm.prank(alice);
        vm.expectRevert(AntworkFest.BadCount.selector);
        f.claimMany(d, s, g);
        d = new uint256[](2);
        s = new uint256[](1);
        g = new bytes[](2);
        vm.prank(alice);
        vm.expectRevert(AntworkFest.LengthMismatch.selector);
        f.claimMany(d, s, g);
        s = new uint256[](2);
        g = new bytes[](1);
        vm.prank(alice);
        vm.expectRevert(AntworkFest.LengthMismatch.selector);
        f.claimMany(d, s, g);
    }

    function test_claimMany_oneBadVoucherUndoesAll() public {
        _fundEth(carol, 30 ether);
        _toDay(3, 0);
        uint256[] memory d = new uint256[](2);
        uint256[] memory s = new uint256[](2);
        bytes[] memory g = new bytes[](2);
        d[0] = 0;
        s[0] = WAD;
        g[0] = _sig(alice, 0, WAD);
        d[1] = 1;
        s[1] = WAD;
        g[1] = _sig(bob, 1, WAD); // for another account
        vm.prank(alice);
        vm.expectRevert(AntworkFest.BadSignature.selector);
        f.claimMany(d, s, g);
        assertFalse(f.claimed(0, alice));
        assertFalse(f.dayInfo(0).closed);
        assertEq(f.reserveEth(), 30 ether);
    }

    function test_claimMany_sameDayTwiceIsRefused() public {
        _fundEth(carol, 30 ether);
        _toDay(3, 0);
        uint256[] memory d = new uint256[](2);
        uint256[] memory s = new uint256[](2);
        bytes[] memory g = new bytes[](2);
        d[0] = 1;
        d[1] = 1;
        s[0] = WAD / 4;
        s[1] = WAD / 4;
        g[0] = _sig(alice, 1, WAD / 4);
        g[1] = g[0];
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.AlreadyClaimed.selector, 1));
        f.claimMany(d, s, g);
    }

    // ------------------------------------------------------------------ expire

    function test_expire_returnsTheUnpaidRest() public {
        _setToken();
        _fundEth(carol, 30 ether);
        _fundToken(carol, 300e18);
        _toDay(1, 0);
        _claim(alice, 0, 0.25e18);
        assertEq(f.openEth(), 0.75 ether);
        vm.warp(f.claimDeadline(0));
        vm.expectEmit(true, false, false, true);
        emit Expired(0, 0.75 ether, 7.5e18);
        vm.prank(bob); // anyone
        (uint256 eth, uint256 t) = f.expire(0);
        assertEq(eth, 0.75 ether);
        assertEq(t, 7.5e18);
        assertEq(f.openEth(), 0);
        assertEq(f.openToken(), 0);
        assertEq(f.reserveEth(), 29.75 ether);
        assertEq(f.reserveToken(), 297.5e18);
        assertTrue(f.dayInfo(0).expired);
        assertFalse(f.dayInfo(0).claimable);
        assertEq(address(f).balance, f.reserveEth());
    }

    function test_expire_refusesWhileTheWindowIsOpen() public {
        _fundEth(carol, 30 ether);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.WindowOpen.selector, 0));
        f.expire(0);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.WindowOpen.selector, type(uint256).max));
        f.expire(type(uint256).max);
        _toDay(1, 0);
        _claim(alice, 0, 0.25e18);
        vm.warp(f.claimDeadline(0) - 1);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.WindowOpen.selector, 0));
        f.expire(0);
    }

    function test_expire_refusesADayThatNeverClosed() public {
        _fundEth(carol, 30 ether);
        vm.warp(f.claimDeadline(0));
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.NotClosed.selector, 0));
        f.expire(0);
    }

    function test_expire_once() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        _claim(alice, 0, 0.25e18);
        vm.warp(f.claimDeadline(0));
        f.expire(0);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.AlreadyExpired.selector, 0));
        f.expire(0);
    }

    function test_expire_fullyClaimedDayReturnsOnlyDust() public {
        vm.deal(carol, 31);
        vm.prank(carol);
        f.fund{value: 31}(bytes32(0)); // pot of 1 wei: shares of a third each round down to zero
        _toDay(1, 0);
        _claim(alice, 0, WAD / 3);
        _claim(bob, 0, WAD / 3);
        _claim(carol, 0, WAD / 3);
        assertEq(f.dayInfo(0).paidEth, 0);
        vm.warp(f.claimDeadline(0));
        (uint256 eth,) = f.expire(0);
        assertEq(eth, 1);
        assertEq(f.reserveEth(), 31);
    }

    function test_expire_thenClaimIsRefused() public {
        _fundEth(carol, 30 ether);
        _toDay(1, 0);
        _claim(alice, 0, 0.25e18);
        vm.warp(f.claimDeadline(0));
        f.expire(0);
        bytes memory sig = _sig(bob, 0, 0.25e18);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.WindowClosed.selector, 0));
        f.claim(0, 0.25e18, sig);
    }

    // ------------------------------------------------------------------ views

    function test_currentDay_turnsAtUtcMidnight() public {
        _toDay(0, DAY - 1);
        assertEq(f.currentDay(), 0);
        _toDay(1, 0);
        assertEq(f.currentDay(), 1);
        _toDay(365, 12 hours);
        assertEq(f.currentDay(), 365);
    }

    function test_dayInfo_beforeAndAfterClose() public {
        _fundEth(carol, 30 ether);
        AntworkFest.DayInfo memory d = f.dayInfo(0);
        assertEq(d.day, 0);
        assertEq(d.start, T0);
        assertEq(d.end, T0 + DAY);
        assertEq(d.claimUntil, T0 + DAY + 30 days);
        assertFalse(d.ended);
        assertFalse(d.claimable);
        assertFalse(d.closed);
        assertEq(d.potEth, 1 ether, "the pot it would take now");
        _toDay(1, 0);
        d = f.dayInfo(0);
        assertTrue(d.ended);
        assertTrue(d.claimable);
        _claim(alice, 0, 0.1e18);
        _fundEth(carol, 30 ether);
        d = f.dayInfo(0);
        assertTrue(d.closed);
        assertEq(d.potEth, 1 ether, "fixed once closed");
        assertEq(d.paidEth, 0.1 ether);
        assertEq(f.dayInfo(1).potEth, uint256(59 ether) / 30);
    }

    function test_quote_matchesTheClaim() public {
        _setToken();
        _fundEth(carol, 7 ether);
        _fundToken(carol, 777e18);
        _toDay(2, 0);
        (uint256 qe, uint256 qt) = f.quote(1, 0.3e18);
        (uint256 eth, uint256 t) = _claim(alice, 1, 0.3e18);
        assertEq(qe, eth);
        assertEq(qt, t);
        (qe, qt) = f.quote(1, 0.7e18);
        (eth, t) = _claim(bob, 1, 0.7e18);
        assertEq(qe, eth);
        assertEq(qt, t);
    }

    function test_quote_zeroWhenTheClaimWouldBeRefused() public {
        _fundEth(carol, 30 ether);
        (uint256 e,) = f.quote(0, WAD);
        assertEq(e, 0, "day not over");
        _toDay(1, 0);
        (e,) = f.quote(0, 0);
        assertEq(e, 0, "zero share");
        (e,) = f.quote(0, WAD + 1);
        assertEq(e, 0, "share over one");
        _claim(alice, 0, 0.9e18);
        (e,) = f.quote(0, 0.2e18);
        assertEq(e, 0, "over the day's one");
        (e,) = f.quote(0, 0.1e18);
        assertEq(e, 0.1 ether);
        vm.warp(f.claimDeadline(0));
        (e,) = f.quote(0, 0.1e18);
        assertEq(e, 0, "window over");
        (e,) = f.quote(type(uint256).max, 1);
        assertEq(e, 0, "a far future day");
    }

    function test_status_isTheWholeContract() public {
        _setToken();
        _fundEth(carol, 30 ether);
        _fundToken(carol, 300e18);
        vm.prank(alice);
        f.buyPass(2);
        _toDay(1, 3);
        _claim(bob, 0, 0.5e18);
        vm.prank(owner);
        f.transferOwnership(carol);
        AntworkFest.Status memory s = f.status();
        assertEq(s.token, address(tok));
        assertEq(s.owner, owner);
        assertEq(s.pendingOwner, carol);
        assertEq(s.attester, attester);
        assertEq(s.genesis, T0);
        assertEq(s.currentDay, 1);
        assertEq(s.timestamp, block.timestamp);
        assertEq(s.reserveEth, 29 ether);
        assertEq(s.reserveToken, 290e18);
        assertEq(s.openEth, 0.5 ether);
        assertEq(s.openToken, 5e18);
        assertEq(s.nextPotEth, uint256(29 ether) / 30);
        assertEq(s.nextPotToken, uint256(290e18) / 30);
        assertEq(s.totalFundedEth, 30 ether);
        assertEq(s.totalFundedToken, 300e18);
        assertEq(s.totalPaidEth, 0.5 ether);
        assertEq(s.totalPaidToken, 5e18);
        assertEq(s.totalBurned, 2 * PRICE);
        assertEq(s.passes, 2);
    }

    function test_claimed_bitsAcrossWords() public {
        _fundEth(carol, 30 ether);
        _toDay(257, 0);
        _claim(alice, 255, WAD / 2);
        assertTrue(f.claimed(255, alice));
        assertFalse(f.claimed(256, alice));
        assertFalse(f.claimed(254, alice));
        assertFalse(f.claimed(255, bob));
        _claim(alice, 256, WAD / 2);
        assertTrue(f.claimed(256, alice));
        assertTrue(f.claimed(255, alice));
        bytes memory sig = _sig(alice, 256, WAD / 4);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.AlreadyClaimed.selector, 256));
        f.claim(256, WAD / 4, sig);
    }

    function test_claim_potAbove128BitsIsCappedAndTheRestStays() public {
        _setToken();
        uint256 huge = uint256(type(uint128).max) * 40;
        tok.mint(carol, huge);
        _fundToken(carol, huge);
        _toDay(1, 0);
        (, uint256 t) = _claim(alice, 0, WAD);
        assertEq(t, type(uint128).max);
        assertEq(f.dayInfo(0).potToken, type(uint128).max);
        assertEq(f.reserveToken(), huge - type(uint128).max);
        assertEq(tok.balanceOf(address(f)), f.reserveToken() + f.openToken());
    }
}
