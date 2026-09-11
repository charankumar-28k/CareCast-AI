import { cpSync, rmSync, mkdirSync } from "node:fs";

// Clean and recreate dist/
try { rmSync("dist", { recursive: true, force: true }); } catch {}
mkdirSync("dist", { recursive: true });

// Copy everything from .output/public to dist/
cpSync(".output/public", "dist", { recursive: true });

console.log("✓ Copied .output/public → dist/");
