import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    // Optional: point to a local solc binary or soljson.js when the compiler
    // list cannot be downloaded (e.g. restricted CI or sandboxed networks).
    ...(process.env.SOLC_PATH ? { path: process.env.SOLC_PATH } : {}),
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  test: {
    solidity: {
      fuzz: {
        runs: 256,
      },
    },
  },
});
