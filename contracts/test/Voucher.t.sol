// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {AntworkFest} from "../src/AntworkFest.sol";

/// The attester's vouchers: EIP-712 Voucher(address account,uint256 day,uint256 share) under the domain
/// (AntworkFest, 1, chainId, this contract). Every way a voucher can be wrong, and the digest the realm signs.
contract VoucherTest is Base {
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant VOUCHER_TYPEHASH = keccak256("Voucher(address account,uint256 day,uint256 share)");
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // secp256k1 order

    string constant FIXTURE = "../server/test/fixtures/voucher-digest.json";

    function setUp() public override {
        super.setUp();
        _fundEth(carol, 30 ether);
        _toDay(2, 0);
    }

    function _expectBad(address who, uint256 day, uint256 share, bytes memory sig) internal {
        vm.prank(who);
        vm.expectRevert(AntworkFest.BadSignature.selector);
        f.claim(day, share, sig);
    }

    function _digestByHand(address vc, uint256 chainId, address account, uint256 day, uint256 share)
        internal
        pure
        returns (bytes32)
    {
        bytes32 ds = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("AntworkFest"), keccak256("1"), chainId, vc));
        bytes32 sh = keccak256(abi.encode(VOUCHER_TYPEHASH, account, day, share));
        return keccak256(abi.encodePacked("\x19\x01", ds, sh));
    }

    // ------------------------------------------------------------------ the good one

    function test_goodVoucherPays() public {
        (uint256 eth,) = _claim(alice, 1, 0.5e18);
        assertEq(eth, 0.5 ether);
    }

    function test_digestIsPlainEip712() public view {
        assertEq(
            f.voucherDigest(alice, 1, 0.5e18), _digestByHand(address(f), block.chainid, alice, 1, 0.5e18)
        );
    }

    // ------------------------------------------------------------------ wrong vouchers

    function test_wrongSigner() public {
        (, uint256 other) = makeAddrAndKey("not the attester");
        _expectBad(alice, 1, WAD, _sigWith(other, f, alice, 1, WAD));
    }

    function test_ownerIsNotTheAttester() public {
        (address o2, uint256 ok2) = makeAddrAndKey("owner with key");
        AntworkFest g = new AntworkFest(o2, attester);
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        g.fund{value: 1 ether}(bytes32(0));
        vm.warp(block.timestamp + DAY);
        bytes memory sig = _sigWith(ok2, g, alice, 0, WAD);
        vm.prank(alice);
        vm.expectRevert(AntworkFest.BadSignature.selector);
        g.claim(0, WAD, sig);
    }

    function test_wrongAccount() public {
        // bob's voucher sent by alice
        _expectBad(alice, 1, WAD, _sig(bob, 1, WAD));
        // and bob can still use it
        (uint256 eth,) = _claim(bob, 1, WAD);
        assertEq(eth, 1 ether);
    }

    function test_wrongDayOrShare() public {
        _expectBad(alice, 0, 0.5e18, _sig(alice, 1, 0.5e18));
        _expectBad(alice, 1, 0.6e18, _sig(alice, 1, 0.5e18));
    }

    function test_otherChainId() public {
        // a literal, not block.chainid: under via-ir the compiler may read block.chainid again after vm.chainId
        uint256 here = 31337;
        assertEq(block.chainid, here);
        // signed for chain 1, sent here
        vm.chainId(1);
        bytes memory forChain1 = _sig(alice, 1, WAD);
        vm.chainId(here);
        _expectBad(alice, 1, WAD, forChain1);
        // signed here, sent after the chain id changed (a fork of the chain)
        bytes memory forHere = _sig(alice, 1, WAD);
        vm.chainId(4663);
        _expectBad(alice, 1, WAD, forHere);
        // on 4663 a voucher made for 4663 works
        (uint256 eth,) = _claim(alice, 1, WAD);
        assertEq(eth, 1 ether);
    }

    function test_otherContract() public {
        AntworkFest g = new AntworkFest(owner, attester);
        _expectBad(alice, 1, WAD, _sigWith(attesterKey, g, alice, 1, WAD));
    }

    function test_replay() public {
        bytes memory sig = _sig(alice, 1, 0.25e18);
        vm.prank(alice);
        f.claim(1, 0.25e18, sig);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.AlreadyClaimed.selector, 1));
        f.claim(1, 0.25e18, sig);
        // the same voucher cannot be used by anyone else either
        _expectBad(bob, 1, 0.25e18, sig);
    }

    function test_afterTheWindow() public {
        bytes memory sig = _sig(alice, 1, WAD);
        vm.warp(f.claimDeadline(1));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.WindowClosed.selector, 1));
        f.claim(1, WAD, sig);
    }

    function test_beforeTheDayEnds() public {
        bytes memory sig = _sig(alice, 2, WAD);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AntworkFest.DayNotOver.selector, 2));
        f.claim(2, WAD, sig);
        _toDay(3, 0);
        vm.prank(alice);
        f.claim(2, WAD, sig);
    }

    function test_malformedSignatures() public {
        bytes memory good = _sig(alice, 1, WAD);
        (bytes32 r, bytes32 s) = abi.decode(good, (bytes32, bytes32));
        uint8 v = uint8(good[64]);
        _expectBad(alice, 1, WAD, "");
        _expectBad(alice, 1, WAD, abi.encodePacked(r, s)); // 64 bytes (short form is refused)
        _expectBad(alice, 1, WAD, abi.encodePacked(good, uint8(0))); // 66 bytes
        _expectBad(alice, 1, WAD, abi.encodePacked(r, s, v - 27)); // v of 0 or 1
        _expectBad(alice, 1, WAD, abi.encodePacked(bytes32(0), bytes32(0), uint8(27)));
        _expectBad(alice, 1, WAD, abi.encodePacked(keccak256("r"), keccak256("s"), uint8(28)));
        // the high-s twin of a valid signature (same signer, malleated) is refused
        bytes32 s2 = bytes32(N - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        _expectBad(alice, 1, WAD, abi.encodePacked(r, s2, v2));
        // and the original still works
        vm.prank(alice);
        f.claim(1, WAD, good);
    }

    // ------------------------------------------------------------------ the digest fixture shared with the realm

    /// Voucher for account 0x1111..., day 3, share 0.25e18 on chain 4663 at verifyingContract 0x2222...: the
    /// contract's own _hashTypedDataV4 (its code placed at 0x2222... with vm.etch, run with chain id 4663) must
    /// equal the digest computed by hand and, when the realm has written it, realm/test/fixtures/voucher-digest.json.
    function test_digestFixture_print() public pure {
        address account = 0x1111111111111111111111111111111111111111;
        address vc = 0x2222222222222222222222222222222222222222;
        bytes32 d = _digestByHand(vc, 4663, account, 3, 250000000000000000);
        console2.log("voucher digest (account 0x1111.., day 3, share 0.25e18, chain 4663, contract 0x2222..)");
        console2.logBytes32(d);
    }

    function test_digestFixture() public {
        address account = 0x1111111111111111111111111111111111111111;
        address vc = 0x2222222222222222222222222222222222222222;
        uint256 day = 3;
        uint256 share = 250000000000000000;
        uint256 chainId = 4663;

        bytes32 hand = _digestByHand(vc, chainId, account, day, share);
        vm.chainId(chainId);
        AntworkFest impl = new AntworkFest(owner, attester);
        vm.etch(vc, address(impl).code);
        AntworkFest at = AntworkFest(payable(vc));
        bytes32 onchain = at.voucherDigest(account, day, share);
        assertEq(onchain, hand, "contract digest differs from the EIP-712 digest by hand");
        bytes32 ds = at.domainSeparator();
        console2.log("domainSeparator");
        console2.logBytes32(ds);
        console2.log("structHash");
        console2.logBytes32(keccak256(abi.encode(VOUCHER_TYPEHASH, account, day, share)));
        console2.log("digest");
        console2.logBytes32(onchain);

        // VOUCHER_FIXTURE (tests of this test only) points it at another copy under deployments/
        string memory path = vm.envOr("VOUCHER_FIXTURE", string(FIXTURE));
        if (!vm.exists(path)) {
            console2.log("no realm fixture yet at", path, "- comparison skipped");
            vm.skip(true);
            return;
        }
        string memory j = vm.readFile(path);
        // the fixture must describe this same voucher (server/test/voucher.test.js writes message, domain, hashes)
        if (vm.keyExistsJson(j, ".message")) {
            assertEq(vm.parseJsonAddress(j, ".message.account"), account, "fixture account");
            assertEq(vm.parseJsonUint(j, ".message.day"), day, "fixture day");
            assertEq(vm.parseJsonUint(j, ".message.share"), share, "fixture share");
        }
        if (vm.keyExistsJson(j, ".domain")) {
            assertEq(vm.parseJsonString(j, ".domain.name"), "AntworkFest", "fixture domain name");
            assertEq(vm.parseJsonString(j, ".domain.version"), "1", "fixture domain version");
            assertEq(vm.parseJsonUint(j, ".domain.chainId"), chainId, "fixture chainId");
            assertEq(vm.parseJsonAddress(j, ".domain.verifyingContract"), vc, "fixture verifyingContract");
        }
        if (vm.keyExistsJson(j, ".voucherTypehash")) {
            assertEq(vm.parseJsonBytes32(j, ".voucherTypehash"), VOUCHER_TYPEHASH, "fixture voucher typehash");
        }
        if (vm.keyExistsJson(j, ".domainSeparator")) {
            assertEq(vm.parseJsonBytes32(j, ".domainSeparator"), ds, "fixture domainSeparator");
        }
        if (vm.keyExistsJson(j, ".structHash")) {
            assertEq(
                vm.parseJsonBytes32(j, ".structHash"),
                keccak256(abi.encode(VOUCHER_TYPEHASH, account, day, share)),
                "fixture structHash"
            );
        }
        assertEq(vm.parseJsonBytes32(j, ".digest"), onchain, "the realm's digest differs from the contract's");
    }
}
