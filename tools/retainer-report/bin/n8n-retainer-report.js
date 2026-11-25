#!/usr/bin/env node
"use strict";
require("../src/cli")
  .main(process.argv.slice(2), process.env)
  .then((code) => {
    process.exitCode = code || 0;
  });
