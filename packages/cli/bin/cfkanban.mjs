#!/usr/bin/env node
import { main } from '../src/main.mjs';
process.exitCode=await main();
