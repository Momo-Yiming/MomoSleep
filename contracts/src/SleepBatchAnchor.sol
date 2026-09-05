// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stores only aggregate Merkle roots. No user address or health data belongs here.
contract SleepBatchAnchor {
    error Unauthorized();
    error InvalidInput();
    error BatchAlreadyAnchored();

    struct Batch {
        bytes32 merkleRoot;
        uint32 scoringVersion;
        uint32 claimCount;
        uint64 anchoredAt;
    }

    address public owner;
    mapping(bytes32 batchId => Batch) public batches;

    event BatchAnchored(
        bytes32 indexed batchId,
        bytes32 indexed merkleRoot,
        uint32 scoringVersion,
        uint32 claimCount,
        uint64 anchoredAt
    );
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidInput();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function anchorBatch(
        bytes32 batchId,
        bytes32 merkleRoot,
        uint32 scoringVersion,
        uint32 claimCount
    ) external onlyOwner {
        if (batchId == bytes32(0) || merkleRoot == bytes32(0) || scoringVersion == 0 || claimCount == 0) {
            revert InvalidInput();
        }
        if (batches[batchId].anchoredAt != 0) revert BatchAlreadyAnchored();

        uint64 anchoredAt = uint64(block.timestamp);
        batches[batchId] = Batch(merkleRoot, scoringVersion, claimCount, anchoredAt);
        emit BatchAnchored(batchId, merkleRoot, scoringVersion, claimCount, anchoredAt);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidInput();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    /// @dev Uses the same SHA-256 domain separation as SleepMerkleTree in the iOS app.
    function verifyInclusion(
        bytes32 batchId,
        bytes32 commitment,
        bytes32[] calldata siblings,
        uint256 siblingOnLeftBits
    ) external view returns (bool) {
        bytes32 value = sha256(abi.encodePacked(bytes1(uint8(0)), commitment));
        for (uint256 index = 0; index < siblings.length; index++) {
            bool siblingOnLeft = (siblingOnLeftBits & (uint256(1) << index)) != 0;
            value = siblingOnLeft
                ? sha256(abi.encodePacked(bytes1(uint8(1)), siblings[index], value))
                : sha256(abi.encodePacked(bytes1(uint8(1)), value, siblings[index]));
        }
        return value == batches[batchId].merkleRoot;
    }
}
