import { readFile } from "node:fs/promises";
import solc from "solc";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const privateKey = process.env.MONAD_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? "")) throw new Error("MONAD_PRIVATE_KEY is required");
const sourceURL = new URL("../../contracts/src/SleepBatchAnchor.sol", import.meta.url);
const source = await readFile(sourceURL, "utf8");
const input = {
  language: "Solidity",
  sources: { "SleepBatchAnchor.sol": { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
const artifact = output.contracts["SleepBatchAnchor.sol"].SleepBatchAnchor;
const rpcURL = process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz";
const chain = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcURL] } },
});
const account = privateKeyToAccount(privateKey);
const transport = http(rpcURL);
const publicClient = createPublicClient({ chain, transport });
const balance = await publicClient.getBalance({ address: account.address });
if (balance === 0n) throw new Error(`Test wallet ${account.address} needs MON from https://faucet.monad.xyz`);
const walletClient = createWalletClient({ account, chain, transport });
const transactionHash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: `0x${artifact.evm.bytecode.object}`,
  args: [account.address],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
if (!receipt.contractAddress || receipt.status !== "success") throw new Error("contract deployment failed");
console.log(JSON.stringify({
  network: chain.name,
  chainId: chain.id,
  owner: account.address,
  contractAddress: receipt.contractAddress,
  transactionHash,
}, null, 2));
