import { spawn } from "child_process";

const child = spawn(
  "codex",
  [
    "exec",
    "--model",
    "gpt-5.6-terra",
    "Write a typescript function to sort an array",
  ],
  {
    stdio: "pipe",
  }
);

child.stdout.on("data", (d) => {
  process.stdout.write(d);
});

child.stderr.on("data", (d) => {
  process.stderr.write(d);
});

child.on("close", (code) => {
  console.log("Exited:", code);
});
