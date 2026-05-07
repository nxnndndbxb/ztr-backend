const { ethers } = require('ethers');

// Environment variable se RPC URL lein
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC_URL);

const USDT_CONTRACT_ADDRESS = "0x55d398326f99059fF775485246999027B3197955";
const USDT_ABI = [
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const ADMIN_WALLET = process.env.ADMIN_WALLET;

// Function to verify a USDT transaction on the blockchain
async function verifyUsdtTransaction(txHash, fromAddress, expectedAmount) {
  try {
    const txReceipt = await provider.getTransactionReceipt(txHash);
    if (!txReceipt || txReceipt.status !== 1) { // status 1 matlab transaction successful
      throw new Error("Transaction failed on the blockchain or was not found.");
    }

    const usdtContract = new ethers.Contract(USDT_CONTRACT_ADDRESS, USDT_ABI, provider);
    const usdtDecimals = await usdtContract.decimals();
    const expectedAmountWei = ethers.parseUnits(expectedAmount.toString(), Number(usdtDecimals));

    let transferLogFound = false;
    for (const log of txReceipt.logs) {
      if (log.address.toLowerCase() === USDT_CONTRACT_ADDRESS.toLowerCase()) {
        try {
          const parsedLog = usdtContract.interface.parseLog(log);
          if (parsedLog && parsedLog.name === "Transfer") {
            const [from, to, value] = parsedLog.args;
            if (
              from.toLowerCase() === fromAddress.toLowerCase() &&
              to.toLowerCase() === ADMIN_WALLET.toLowerCase() &&
              BigInt(value) >= BigInt(expectedAmountWei)
            ) {
              transferLogFound = true;
              break;
            }
          }
        } catch (e) {
          // Jo log match nahi karte, unhe ignore karein
        }
      }
    }

    if (!transferLogFound) {
      throw new Error(`Payment verification failed. Expected ${expectedAmount} USDT from ${fromAddress} to ${ADMIN_WALLET}.`);
    }

    return true; // Verification Successful
  } catch (error) {
    console.error(`Error verifying transaction ${txHash}:`, error);
    throw new Error(error.message || "Could not verify transaction.");
  }
}

module.exports = { verifyUsdtTransaction };