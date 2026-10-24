// Deploys mock oracles + CommSwap to the local Hardhat node and writes frontend/config.js
// Usage:  npx hardhat run scripts/deploy.js --network localhost
//         (set SEED=1 to pre-register Alice/Bob/Carol and create one demo proposal)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const P = (x) => ethers.parseUnits(String(x), 8);

const CONFIG = {
  registrationFee: ethers.parseEther("0.01"),
  gracePeriod: 60, // seconds (demo). Production: e.g. 2 days
  minPeriod: 120, // seconds (demo). Production: 7 days (weekly)
  selectionWindow: 600, // seconds after accept deadline for the creator to pick
};

const COMMODITIES = [
  { symbol: "GOLD", desc: "GOLD / ETH (per unit)", price: "1.00" },
  { symbol: "SILVER", desc: "SILVER / ETH (per unit)", price: "0.50" },
  { symbol: "CRUDE", desc: "CRUDE OIL / ETH (per unit)", price: "0.25" },
];

async function main() {
  const [admin, alice, bob, carol] = await ethers.getSigners();
  console.log("Admin / oracle reporter:", admin.address);

  const Feed = await ethers.getContractFactory("MockV3Aggregator");
  const Swap = await ethers.getContractFactory("CommSwap");

  const swap = await Swap.deploy(CONFIG.registrationFee, CONFIG.gracePeriod, CONFIG.minPeriod, CONFIG.selectionWindow);
  await swap.waitForDeployment();
  console.log("CommSwap:", await swap.getAddress());

  const feeds = [];
  for (const c of COMMODITIES) {
    const f = await Feed.deploy(8, P(c.price), c.desc);
    await f.waitForDeployment();
    await (await swap.addCommodity(c.symbol, await f.getAddress(), 86400)).wait();
    feeds.push({ symbol: c.symbol, address: await f.getAddress() });
    console.log(`  ${c.symbol} feed: ${await f.getAddress()} @ ${c.price} ETH`);
  }

  // Give each feed some price history so the collateral formula has data to work with
  // (max move per settlement window over past rounds). Advances local chain time.
  const HISTORY = {
    GOLD: ["0.96", "0.98", "1.02", "0.99", "1.03", "1.05", "1.01", "0.97", "1.00"],
    SILVER: ["0.47", "0.49", "0.52", "0.51", "0.48", "0.50"],
    CRUDE: ["0.22", "0.24", "0.27", "0.26", "0.23", "0.25"],
  };
  const fc = feeds.map((f) => Feed.attach(f.address));
  const steps = Math.max(...Object.values(HISTORY).map((h) => h.length));
  for (let i = 0; i < steps; i++) {
    await hre.network.provider.send("evm_increaseTime", [60]);
    for (let k = 0; k < COMMODITIES.length; k++) {
      const h = HISTORY[COMMODITIES[k].symbol];
      const idx = i - (steps - h.length);
      if (idx >= 0) await (await fc[k].updateAnswer(P(h[idx]))).wait();
    }
  }
  console.log("Seeded oracle price history (" + steps + " rounds, 60s apart)");

  if (process.env.SEED) {
    for (const u of [alice, bob, carol]) await (await swap.connect(u).register({ value: CONFIG.registrationFee })).wait();
    await (await swap.connect(alice).createRequest(0, 10, true, 180, 3, 86400, { value: ethers.parseEther("3") })).wait();
    console.log("Seeded: Alice, Bob, Carol registered; Alice proposed GOLD x10, LONG, 3 x 180s, 3 ETH collateral");
  }

  const art = (n) => hre.artifacts.readArtifactSync(n).abi;
  const out = {
    rpc: "http://127.0.0.1:8545",
    chainId: 31337,
    commSwap: await swap.getAddress(),
    feeds,
    abi: { CommSwap: art("CommSwap"), Feed: art("MockV3Aggregator") },
    config: { ...CONFIG, registrationFee: CONFIG.registrationFee.toString() },
  };
  const fe = path.join(__dirname, "..", "frontend");
  fs.writeFileSync(path.join(fe, "config.js"), "window.COMMSWAP_CONFIG = " + JSON.stringify(out, null, 2) + ";\n");

  // ship ethers locally so the DApp works with no internet
  const umd = path.join(__dirname, "..", "node_modules", "ethers", "dist", "ethers.umd.min.js");
  fs.copyFileSync(umd, path.join(fe, "ethers.umd.min.js"));
  console.log("\nWrote frontend/config.js. Open frontend/index.html in your browser.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
