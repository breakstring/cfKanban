#!/usr/bin/env node
import { main } from "../../../packages/skill-runtime/src/cli.mjs";

process.exitCode = await main(process.argv.slice(2), { surface: "daily" });
