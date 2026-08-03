import { spawn } from "node:child_process";

const prompt = "Write a TypeScript function to sort an array";

const child = spawn(
  "codex",
  ["exec", "--model", "gpt-5.6-terra", prompt],
  {
    stdio: ["pipe", "pipe", "pipe"],
  },
);

// Tell Codex there is no additional stdin content.
child.stdin.end();

child.stdout.on("data", (data: Buffer) => {
  process.stdout.write(data);
});

child.stderr.on("data", (data: Buffer) => {
  process.stderr.write(data);
});

child.on("error", (error) => {
  console.error("Failed to start Codex:", error);
});

child.on("close", (code) => {
  console.log(`Codex exited with code ${code}`);
});
