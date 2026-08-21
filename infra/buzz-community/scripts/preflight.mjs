import { assertEnvironment } from "./config.mjs";

assertEnvironment();
console.log("Preflight passed: all required secret names and value shapes are valid.");
