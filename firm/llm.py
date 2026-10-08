"""Ava's brain. Two ways to reach Claude:
  claude-code : runs the Claude Code CLI in headless mode, using your Claude Max plan (no API key)
  claude      : the Anthropic API with ANTHROPIC_API_KEY (pay-as-you-go)
Both return a dict that matches the JSON schema you pass in."""
import json
import os
import shutil
import subprocess
import tempfile

from .config import LLM, LLM_MODEL


def find_claude():
    exe = shutil.which("claude")
    if exe:
        return exe
    for guess in (os.path.join(os.path.expanduser("~"), ".local", "bin", "claude.exe"),
                  os.path.join(os.path.expanduser("~"), ".local", "bin", "claude")):
        if os.path.exists(guess):
            return guess
    return None


class LLMError(RuntimeError):
    pass


class Brain:
    def __init__(self):
        self.mode = LLM
        self.exe = find_claude() if self.mode == "claude-code" else None
        if self.mode == "claude-code" and not self.exe:
            self.mode = "off"
        self.client = None
        if self.mode == "claude":
            import anthropic
            self.anthropic = anthropic
            self.client = anthropic.Anthropic()
        # an empty folder to run in, so Claude Code doesn't pick up any project files
        self.cwd = os.path.join(tempfile.gettempdir(), "jb_capital_ava")
        os.makedirs(self.cwd, exist_ok=True)

    @property
    def enabled(self):
        return self.mode in ("claude-code", "claude")

    def ask(self, system: str, prompt: str, schema: dict, timeout=300, web=False) -> dict:
        """Blocking. Run it in a thread. web=True lets Claude search/read the web first (Claude Code mode)."""
        if self.mode == "claude-code":
            return self._claude_code(system, prompt, schema, timeout, web)
        if self.mode == "claude":
            return self._api(system, prompt, schema)
        raise LLMError("Ava is off")

    def _claude_code(self, system, prompt, schema, timeout, web=False):
        tools = ["--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch"] if web else ["--tools", ""]
        cmd = [self.exe, "-p", "--output-format", "json", *tools, "--no-session-persistence",
               "--strict-mcp-config", "--system-prompt", system, "--json-schema", json.dumps(schema)]
        try:
            r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8",
                               timeout=timeout, cwd=self.cwd,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired:
            raise LLMError("Claude Code took too long")
        try:
            out = json.loads(r.stdout)
        except json.JSONDecodeError:
            raise LLMError(f"Claude Code error: {(r.stderr or r.stdout)[:120]}")
        if out.get("is_error"):
            raise LLMError(str(out.get("result", "unknown error"))[:160])
        if isinstance(out.get("structured_output"), dict):
            return out["structured_output"]
        try:
            return json.loads(out.get("result", ""))
        except json.JSONDecodeError:
            raise LLMError("answer wasn't valid JSON")

    def _api(self, system, prompt, schema):
        a = self.anthropic
        kwargs = dict(model=LLM_MODEL, max_tokens=8000, system=system,
                      output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
                      messages=[{"role": "user", "content": prompt}])
        try:
            try:  # server-side fallback: a declined request is retried on a recommended model
                resp = self.client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], extra_body={"fallbacks": "default"}, **kwargs)
            except a.BadRequestError:
                resp = self.client.messages.create(**kwargs)
        except a.AuthenticationError:
            raise LLMError("no valid API key (set ANTHROPIC_API_KEY)")
        except a.RateLimitError:
            raise LLMError("rate limited")
        except a.APIStatusError as e:
            raise LLMError(f"API error {e.status_code}")
        except a.APIConnectionError:
            raise LLMError("network error")
        if resp.stop_reason == "refusal":
            raise LLMError("request was declined")
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            raise LLMError("answer wasn't valid JSON")
