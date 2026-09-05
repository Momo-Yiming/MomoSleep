// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SleepRewardToken} from "../src/SleepRewardToken.sol";

contract TokenCaller {
    function mint(SleepRewardToken token, address recipient, bytes32 commitment) external returns (bool) {
        try token.mintSleepReward(recipient, 390, commitment) {
            return true;
        } catch {
            return false;
        }
    }
}

contract SleepRewardTokenTest {
    function testOwnerMintsOneRewardAndTokenTransfers() public {
        SleepRewardToken token = new SleepRewardToken(address(this));
        address recipient = address(0xBEEF);
        bytes32 commitment = sha256("sleep-claim");
        uint256 amount = token.mintSleepReward(recipient, 390, commitment);

        require(amount == 390 ether, "wrong mint amount");
        require(token.totalSupply() == amount, "wrong total supply");
        require(token.balanceOf(recipient) == amount, "wrong recipient balance");
        require(token.usedCommitments(commitment), "commitment not consumed");
        require(token.hasMinted(recipient), "recipient not marked");
    }

    function testDuplicateClaimAndRecipientAreRejected() public {
        SleepRewardToken token = new SleepRewardToken(address(this));
        bytes32 first = sha256("first");
        token.mintSleepReward(address(0xBEEF), 390, first);

        try token.mintSleepReward(address(0xCAFE), 390, first) {
            revert("duplicate commitment accepted");
        } catch {}
        try token.mintSleepReward(address(0xBEEF), 390, sha256("second")) {
            revert("duplicate recipient accepted");
        } catch {}
    }

    function testOnlyOwnerCanMintAndLimitsAreEnforced() public {
        SleepRewardToken token = new SleepRewardToken(address(this));
        TokenCaller caller = new TokenCaller();
        require(!caller.mint(token, address(0xBEEF), sha256("unauthorized")), "unauthorized mint accepted");

        try token.mintSleepReward(address(0xBEEF), 1_001, sha256("too-many")) {
            revert("oversized mint accepted");
        } catch {}
    }
}
