// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SleepBatchAnchor} from "../src/SleepBatchAnchor.sol";

contract UnauthorizedCaller {
    function anchor(SleepBatchAnchor target, bytes32 batchId, bytes32 root) external returns (bool) {
        try target.anchorBatch(batchId, root, 1, 1) {
            return true;
        } catch {
            return false;
        }
    }
}

contract SleepBatchAnchorTest {
    function testAnchorAndVerifySingleLeaf() public {
        SleepBatchAnchor target = new SleepBatchAnchor(address(this));
        bytes32 batchId = keccak256("2026-09-04");
        bytes32 commitment = sha256("private-sleep-claim");
        bytes32 root = sha256(abi.encodePacked(bytes1(uint8(0)), commitment));
        target.anchorBatch(batchId, root, 1, 1);

        bytes32[] memory siblings = new bytes32[](0);
        require(target.verifyInclusion(batchId, commitment, siblings, 0), "valid proof rejected");
        require(!target.verifyInclusion(batchId, sha256("tampered"), siblings, 0), "tampered proof accepted");
    }

    function testDuplicateBatchIsRejected() public {
        SleepBatchAnchor target = new SleepBatchAnchor(address(this));
        bytes32 batchId = keccak256("batch");
        target.anchorBatch(batchId, sha256("root"), 1, 1);
        try target.anchorBatch(batchId, sha256("other-root"), 1, 1) {
            revert("duplicate batch accepted");
        } catch {}
    }

    function testOnlyOwnerCanAnchor() public {
        SleepBatchAnchor target = new SleepBatchAnchor(address(this));
        UnauthorizedCaller caller = new UnauthorizedCaller();
        require(!caller.anchor(target, keccak256("batch"), sha256("root")), "unauthorized anchor accepted");
    }
}
