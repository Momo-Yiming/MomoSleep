// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Capped ERC-20 test token for the overseas sleep-reward demo.
/// @dev Health data never belongs on-chain. A salted claim commitment is used only once.
contract SleepRewardToken {
    error Unauthorized();
    error InvalidInput();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ClaimAlreadyMinted();
    error RecipientAlreadyMinted();
    error SupplyCapExceeded();

    string public constant name = "MOMO Sleep Test Token";
    string public constant symbol = "SLEEP";
    uint8 public constant decimals = 18;
    uint256 public constant MAX_POINTS_PER_MINT = 1_000;
    uint256 public constant MAX_SUPPLY = 20_000 * 10 ** 18;

    address public owner;
    uint256 public totalSupply;
    mapping(address account => uint256) public balanceOf;
    mapping(address account => mapping(address spender => uint256)) public allowance;
    mapping(bytes32 claimCommitment => bool) public usedCommitments;
    mapping(address recipient => bool) public hasMinted;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event SleepRewardMinted(
        address indexed recipient,
        bytes32 indexed claimCommitment,
        uint256 points,
        uint256 tokenAmount
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

    function mintSleepReward(
        address recipient,
        uint256 points,
        bytes32 claimCommitment
    ) external onlyOwner returns (uint256 amount) {
        if (recipient == address(0) || claimCommitment == bytes32(0) || points == 0 || points > MAX_POINTS_PER_MINT) {
            revert InvalidInput();
        }
        if (usedCommitments[claimCommitment]) revert ClaimAlreadyMinted();
        if (hasMinted[recipient]) revert RecipientAlreadyMinted();

        amount = points * 10 ** decimals;
        if (totalSupply + amount > MAX_SUPPLY) revert SupplyCapExceeded();

        usedCommitments[claimCommitment] = true;
        hasMinted[recipient] = true;
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
        emit SleepRewardMinted(recipient, claimCommitment, points, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert InvalidInput();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidInput();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidInput();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
