import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getVenvPythonPath } from "../src/core/kernel/bootstrap.js";
import { KernelManager } from "../src/core/kernel/index.js";
import { buildRlmBootstrapCode } from "../src/core/tools/ipython.js";
import { removeTempDir } from "./utilities.js";

describe("IPython RLM bootstrap", () => {
	it("pre-imports asyncio so the prompt's subagent patterns work without a manual import", () => {
		expect(buildRlmBootstrapCode()).toMatch(/^import asyncio$/m);
	});

	it("gives subagent registry operations the actionable missing-runtime fallback", () => {
		const code = buildRlmBootstrapCode();
		expect(code).toContain('async def find_models(self, query="", limit=8)');
		expect(code).toContain("async def list_subagents(self)");
		expect(code).toContain("async def delete_subagent(self, target)");
		expect(code).toContain("self._raise_missing()");
	});

	it("disables colored output for subprocesses launched by the kernel", () => {
		expect(buildRlmBootstrapCode()).toContain('_prime_agent_os.environ["NO_COLOR"] = "1"');
	});

	it("guards Python skill imports so a broken skill does not abort bootstrap", () => {
		const code = buildRlmBootstrapCode([
			{
				name: "broken-skill",
				importName: "broken_skill",
				packagePath: "/tmp/broken-skill",
				pyprojectPath: "/tmp/broken-skill/pyproject.toml",
			},
		]);

		expect(code).toContain("except Exception as _prime_agent_skill_error");
		expect(code).toContain("_PrimeAgentUnavailableSkill");
		expect(code).toContain("_PRIME_AGENT_SKILL_IMPORT_ERRORS");
		expect(code).toContain("globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill");
	});
});

/** Find a python that can launch an ipykernel, or null to skip. */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		getVenvPythonPath(join(homedir(), ".prime", "agent", "kernel-venv")),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("IPython RLM bootstrap (real kernel)", () => {
	const dir = mkdtempSync(join(tmpdir(), "prime-agent-bootstrap-"));

	afterAll(() => {
		// The kernel's own process can outlive dispose, and Windows refuses to
		// unlink a directory another handle still holds.
		removeTempDir(dir);
	});

	it("binds asyncio in the user namespace", async () => {
		const manager = new KernelManager({ python: python as string, cwd: dir });
		try {
			await manager.start();
			const bootstrap = await manager.execute(buildRlmBootstrapCode());
			expect(bootstrap.status).toBe("ok");

			const result = await manager.execute("_t = asyncio.create_task(asyncio.sleep(0))\nprint(type(_t).__name__)");
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("Task");

			// IPython's `%%bash` magic picks whatever bash it finds on PATH, which on
			// Windows can be WSL's — a separate environment that does not inherit the
			// kernel's. Read the variable from the kernel itself there.
			const noColorCode =
				process.platform === "win32"
					? 'import os, sys; sys.stdout.write(os.environ.get("NO_COLOR", ""))'
					: '%%bash\nprintf %s "$NO_COLOR"';
			const bashResult = await manager.execute(noColorCode);
			expect(bashResult.status).toBe("ok");
			expect(bashResult.stdout).toBe("1");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("emits canonical paths for edits after the kernel changes directories", async () => {
		const firstDir = join(dir, "first");
		const secondDir = join(dir, "second");
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		writeFileSync(join(firstDir, "same.txt"), "old");
		writeFileSync(join(secondDir, "same.txt"), "old");
		const editSkillRoot = join(process.cwd(), "skills", "edit");
		const manager = new KernelManager({
			python: python as string,
			cwd: dir,
			env: { PYTHONPATH: join(editSkillRoot, "src") },
		});
		try {
			await manager.start();
			const bootstrap = await manager.execute(
				buildRlmBootstrapCode([
					{
						name: "edit",
						importName: "edit",
						packagePath: editSkillRoot,
						pyprojectPath: join(editSkillRoot, "pyproject.toml"),
					},
				]),
			);
			expect(bootstrap.status).toBe("ok");

			const first = await manager.execute(
				'import os\nos.chdir("first")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);
			const second = await manager.execute(
				'os.chdir("../second")\nawait edit(path="same.txt", old_str="old", new_str="new")',
			);

			// Match how the edit path is canonicalized in file-mutation-queue: the
			// native realpath. Only that one expands an 8.3 short name, so on a
			// Windows box whose TEMP is short -- the CI runner's is -- the JS
			// realpath disagrees with what the tool actually reports.
			expect(first.diffs?.[0]?.path).toBe(realpathSync.native(join(firstDir, "same.txt")));
			expect(second.diffs?.[0]?.path).toBe(realpathSync.native(join(secondDir, "same.txt")));
			expect(first.diffs?.[0]?.path).not.toBe(second.diffs?.[0]?.path);
		} finally {
			await manager.dispose();
		}
	}, 60_000);
});
