// 3. Run the agent via the JS API
import { run, codex} from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const sandboxEnv: Record<string, string> = {};
for (const key of ["OPENAI_API_KEY","OPENAI_PROJECT_ID","OPENAI_ORG_ID"]) {
  const value = process.env[key];
  if (value) sandboxEnv[key] = value;
}

await run({
  agent: codex("gpt-5.4"),
  sandbox: docker(), // or podman(), vercel(), or your own provider
  promptFile: ".sandcastle/prompt.md",
});
