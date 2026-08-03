import { exec } from 'child_process';

// Use 'codex exec' or pass prompts via standard arguments
const prompt = "Write a typescript function to sort an array";

exec(`codex exec --model gpt-5.6-terra "${prompt}"`, (error, stdout, stderr) => {
    if (error) {
        console.error(`Execution Error: ${error.message}`);
        return;
    }
    if (stderr) {
        console.error(`CLI Stderr: ${stderr}`);
        return;
    }
    console.log(`Codex Output:\n${stdout}`);
});

