const { preset, just } = require("@fluidx/office-bohemia-build-tools/just-preset");
const { task, jestTask, cleanTask } = just;

preset();

task("clean", cleanTask({ paths: ["lib"] }));
task("lint", "linter");
task("test", jestTask({ nodeArgs: ["--experimental-vm-modules"] }));
